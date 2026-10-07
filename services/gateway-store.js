const crypto = require('node:crypto');
const {safeParse} = require('../utils');
const {GatewayError,hash,keyConfig,configured,tokenRE} = require('./gateway-model');
class GatewayStore {
    constructor(pool) { this.pool = pool; }
    async migrate() {
        const [columns] = await this.pool.query('SHOW COLUMNS FROM push_channels');
        const names = columns.map(c=>c.Field);
        if (!names.includes('alias')) await this.pool.query('ALTER TABLE push_channels ADD COLUMN alias VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE');
        if (!names.includes('enabled')) await this.pool.query('ALTER TABLE push_channels ADD COLUMN enabled TINYINT NOT NULL DEFAULT 1');
        if (!names.includes('gateway_next_send_at')) await this.pool.query('ALTER TABLE push_channels ADD COLUMN gateway_next_send_at BIGINT NOT NULL DEFAULT 0');
        await this.pool.query("UPDATE push_channels SET alias=CONCAT('ch_',id) WHERE alias IS NULL");
        for (const sql of [
            `CREATE TABLE IF NOT EXISTS gateway_keys (id CHAR(36) CHARACTER SET ascii PRIMARY KEY,name VARCHAR(100) NOT NULL,token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,prefix VARCHAR(12) NOT NULL,allowed JSON NOT NULL,defaults JSON NOT NULL,active TINYINT NOT NULL DEFAULT 1,created_at BIGINT NOT NULL) ENGINE=InnoDB`,
            `CREATE TABLE IF NOT EXISTS gateway_requests (id CHAR(36) CHARACTER SET ascii PRIMARY KEY,key_id CHAR(36) CHARACTER SET ascii NOT NULL,message_id INT NOT NULL,level VARCHAR(10) NOT NULL,channels JSON NOT NULL,idempotency_key VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,body_hash CHAR(64) NOT NULL,created_at BIGINT NOT NULL,UNIQUE KEY request_once(key_id,idempotency_key),FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE) ENGINE=InnoDB`,
            `CREATE TABLE IF NOT EXISTS delivery_tasks (id BIGINT AUTO_INCREMENT PRIMARY KEY,message_id INT NOT NULL,channel_id INT NOT NULL,channel_alias VARCHAR(32),channel_name VARCHAR(128),channel_type VARCHAR(32),payload JSON NOT NULL,rule_name VARCHAR(128),rule_template TEXT,status ENUM('pending','processing','success','failed') NOT NULL DEFAULT 'pending',attempts INT NOT NULL DEFAULT 0,ready_at BIGINT NOT NULL DEFAULT 0,error TEXT,updated_at BIGINT NOT NULL DEFAULT 0,FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,INDEX task_ready(status,ready_at),INDEX task_message(message_id)) ENGINE=InnoDB`
        ]) await this.pool.query(sql);
    }
    keyRow(row) { if (!row) return null; const {token_hash,...r}=row; return {...r,allowed:safeParse(r.allowed,[]),defaults:safeParse(r.defaults,[]),active:!!r.active}; }
    async authenticate(token) {
        if (typeof token !== 'string' || !tokenRE.test(token)) return null;
        const [rows]=await this.pool.query('SELECT * FROM gateway_keys WHERE token_hash=? AND active=1',[hash(token)]);
        return this.keyRow(rows[0]);
    }
    async createKey(value, token) {
        const c=keyConfig(value); token=token || 'SCT'+crypto.randomBytes(32).toString('base64url');
        if (!tokenRE.test(token)) throw new GatewayError(400,'密钥格式无效');
        const id=crypto.randomUUID();
        await this.pool.query('INSERT INTO gateway_keys (id,name,token_hash,prefix,allowed,defaults,created_at) VALUES (?,?,?,?,?,?,?)',[id,c.name,hash(token),token.slice(0,11),JSON.stringify(c.allowed),JSON.stringify(c.defaults),Date.now()]);
        return {id,...c,token,prefix:token.slice(0,11),active:true};
    }
    async listKeys() { const [rows]=await this.pool.query('SELECT * FROM gateway_keys ORDER BY created_at DESC'); return rows.map(r=>this.keyRow(r)); }
    async revokeKey(id) { await this.pool.query('UPDATE gateway_keys SET active=0 WHERE id=?',[id]); }
    async transaction(fn) {
        const conn=await this.pool.getConnection();
        try { await conn.beginTransaction(); const result=await fn(conn); await conn.commit(); return result; }
        catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    }
    async insertMessage(conn,notif,sourceId,ruleName,forwarded) {
        const [r]=await conn.query('INSERT INTO messages (source_id,title,content,app_name,app_id,url,metadata,raw_body,icon_base64,rule_name,action) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[
            sourceId,notif.title||'',notif.message||'',notif.appName||'',notif.appID||'',notif.url||'',JSON.stringify(notif.metadata||{}),(notif.rawBody||'').slice(0,16000),notif.icon||null,ruleName||null,forwarded?'forwarded':'blocked'
        ]); return r.insertId;
    }
    async insertTasks(conn,messageId,notif,channels,ruleName,templates={}) {
        for (const channel of channels) await conn.query('INSERT INTO delivery_tasks (message_id,channel_id,channel_alias,channel_name,channel_type,payload,rule_name,rule_template) VALUES (?,?,?,?,?,?,?,?)',[
            messageId,channel.id,channel.alias,channel.name,channel.type,JSON.stringify(notif),ruleName,templates[channel.id]||null
        ]);
    }
    async enqueue(key,body,idempotency) {
        if (idempotency != null && (typeof idempotency !== 'string' || !idempotency.trim() || [...idempotency].length>128)) throw new GatewayError(400,'Idempotency-Key 无效');
        const digest=hash(JSON.stringify(body));
        return this.transaction(async conn=>{
            // Lock the key to serialize concurrent idempotency submissions and revocations.
            const [keys]=await conn.query('SELECT * FROM gateway_keys WHERE id=? AND active=1 FOR UPDATE',[key.id]);
            if (!keys.length) throw new GatewayError(401,'密钥无效');
            const current=this.keyRow(keys[0]);
            if (body.channels.some(x=>!current.allowed.includes(x))) throw new GatewayError(403,'渠道未授权');
            if (idempotency) {
                const [existing]=await conn.query('SELECT * FROM gateway_requests WHERE key_id=? AND idempotency_key=?',[key.id,idempotency]);
                if (existing.length) { if (existing[0].body_hash!==digest) throw new GatewayError(409,'幂等键对应的内容不同'); return {id:existing[0].id,duplicate:true}; }
            }
            const [channels]=await conn.query('SELECT * FROM push_channels WHERE alias IN (?) ORDER BY id FOR UPDATE',[body.channels]);
            if (channels.length !== body.channels.length || channels.some(c=>!c.enabled || !configured(c))) throw new GatewayError(422,'目标渠道未启用或未配置完整');
            const id=crypto.randomUUID();
            const notif={title:body.title,message:body.message,appName:'Gateway',appID:key.id,source_id:'gateway',metadata:{level:body.level},level:body.level};
            const messageId=await this.insertMessage(conn,notif,'gateway','统一接口',true);
            await conn.query('INSERT INTO gateway_requests (id,key_id,message_id,level,channels,idempotency_key,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?)',[id,key.id,messageId,body.level,JSON.stringify(body.channels),idempotency??null,digest,Date.now()]);
            await this.insertTasks(conn,messageId,notif,channels,'统一接口');
            return {id,duplicate:false};
        });
    }
    async enqueueRule(notif,sourceId,rule) {
        return this.transaction(async conn=>{
            const targets=safeParse(rule?.target_channel_ids,[]);
            const [channels]=targets.length ? await conn.query('SELECT * FROM push_channels WHERE id IN (?) ORDER BY id FOR UPDATE',[targets]) : [[]];
            for (const target of targets) if (!channels.some(c=>c.id===Number(target))) channels.push({id:Number(target),alias:`ch_${target}`,name:'已删除的通道',type:'unknown'});
            const id=await this.insertMessage(conn,notif,sourceId,rule?.name,!!rule);
            await this.insertTasks(conn,id,{...notif,source_id:sourceId},channels,rule?.name,safeParse(rule?.channel_templates,{}));
            return id;
        });
    }
    async message(id,keyId) {
        const [rows]=await this.pool.query('SELECT r.id,r.level,r.channels,r.created_at,r.message_id,m.title,m.content AS message FROM gateway_requests r JOIN messages m ON m.id=r.message_id WHERE r.id=?'+(keyId?' AND r.key_id=?':''),keyId?[id,keyId]:[id]);
        if (!rows.length) return null;
        const r=rows[0]; r.channels=safeParse(r.channels,[]);
        const [tasks]=await this.pool.query('SELECT channel_alias AS channel,status,attempts,error,updated_at FROM delivery_tasks WHERE message_id=? ORDER BY id',[r.message_id]);
        r.deliveries=tasks; delete r.message_id;
        r.status=tasks.length && tasks.every(t=>t.status==='success') ? 'delivered' : tasks.every(t=>['success','failed'].includes(t.status)) ? (tasks.some(t=>t.status==='success')?'partial':'failed') : 'queued';
        return r;
    }
    async listTasks() { const [rows]=await this.pool.query('SELECT t.id,t.message_id,t.channel_alias,t.channel_name,t.status,t.attempts,t.error,t.updated_at,m.title,m.created_at FROM delivery_tasks t JOIN messages m ON m.id=t.message_id ORDER BY t.id DESC LIMIT 100'); return rows; }
}
module.exports = GatewayStore;
