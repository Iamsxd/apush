const {safeParse} = require('../utils');
const syslog = require('./syslog');
class DeliveryQueue {
    constructor(store,pusher) { this.store=store; this.pusher=pusher; this.stopped=false; this.conn=null; this.lockName='apush_delivery_'+require('node:crypto').createHash('sha256').update(require('../config').db.database).digest('hex').slice(0,32); }
    start() { this.running=this.loop(); }
    async stop() { this.stopped=true; if (this.timer) { clearTimeout(this.timer); this.wake?.(); } await this.running; }
    async sleep(ms) { if (!this.stopped) await new Promise(resolve=>{this.wake=resolve;this.timer=setTimeout(resolve,ms);}); }
    async loop() {
        while (!this.stopped) {
            try {
                if (!this.conn) {
                    const conn=await this.store.pool.getConnection();
                    const [[lock]]=await conn.query("SELECT GET_LOCK(?,0) AS acquired",[this.lockName]);
                    if (!lock.acquired) { conn.release(); await this.sleep(1000); continue; }
                    this.conn=conn;
                    await conn.query("UPDATE delivery_tasks SET status=IF(attempts>=3,'failed','pending'),error='上次投递被中断',updated_at=? WHERE status='processing'",[Date.now()]);
                }
                const conn=this.conn, now=Date.now();
                const [rows]=await conn.query("SELECT t.* FROM delivery_tasks t LEFT JOIN push_channels c ON c.id=t.channel_id WHERE t.status='pending' AND t.attempts<3 AND t.ready_at<=? AND COALESCE(c.gateway_next_send_at,0)<=? ORDER BY t.id LIMIT 1",[now,now]);
                if (!rows.length) { await this.sleep(200); continue; }
                const task=rows[0];
                const [claim]=await conn.query("UPDATE delivery_tasks SET status='processing',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'",[now,task.id]);
                if (!claim.affectedRows) continue;
                const [channels]=await conn.query('SELECT * FROM push_channels WHERE id=?',[task.channel_id]);
                let result;
                if (!channels[0]?.enabled) result={success:false,retryable:false,error:'通道已删除或禁用',duration_ms:0};
                else {
                    if (channels[0].type==='wecom-bot') {
                        // Shared webhook may be configured in several channel records.
                        const url=safeParse(channels[0].config,{}).webhook_url;
                        await conn.query("UPDATE push_channels SET gateway_next_send_at=? WHERE type='wecom-bot' AND JSON_UNQUOTE(JSON_EXTRACT(config,'$.webhook_url'))=?",[now+3100,url]);
                    }
                    result=await this.pusher.send(task.channel_id,safeParse(task.payload,{}),task.rule_name,task.message_id,{},task.rule_template);
                }
                const attempts=task.attempts+1;
                const status=result.success?'success':result.retryable && attempts<3?'pending':'failed';
                await conn.beginTransaction();
                try {
                    await conn.query('UPDATE delivery_tasks SET status=?,ready_at=?,error=?,updated_at=? WHERE id=?',[status,Date.now()+attempts*2000,result.error||null,Date.now(),task.id]);
                    await conn.query('INSERT INTO delivery_logs (message_id,channel_id,channel_type,channel_name,status,http_status,error_msg,duration_ms) VALUES (?,?,?,?,?,?,?,?)',[task.message_id,task.channel_id,task.channel_type,task.channel_name,result.success?'success':'failed',result.success?200:result.http_status||null,result.error||null,result.duration_ms||0]);
                    await conn.commit();
                } catch (e) { await conn.rollback(); throw e; }
                if (!result.success) syslog.warn('投递'+(status==='pending'?'待重试':'失败'),`${task.channel_alias}: ${result.error}`);
            } catch (e) {
                syslog.error('队列暂时不可用',e.code||e.name);
                this.conn?.destroy(); this.conn=null;
                await this.sleep(2000);
            }
        }
        if (this.conn) { try { await this.conn.query("SELECT RELEASE_LOCK(?)",[this.lockName]); } finally { this.conn.release(); this.conn=null; } }
    }
}
module.exports = DeliveryQueue;
