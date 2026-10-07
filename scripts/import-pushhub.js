// Run once with a protected export from the previous independent PushHub.
const fs=require('node:fs');
const db=require('../db');
const GatewayStore=require('../services/gateway-store');
const {configured,hash}=require('../services/gateway-model');
const {safeParse}=require('../utils');
const store=new GatewayStore(db);
const types={wecom:'wecom-bot',wecom_app:'wecom',telegram:'tg',bark:'bark',ntfy:'ntfy',email:'email',webhook:'webhook'};
function convert(type,c){
    if(type==='bark') return {bark_key:c.device_key,server_url:c.server_url};
    if(type==='email') return {smtp_host:c.host,smtp_port:c.port,smtp_user:c.username,smtp_pass:c.password,to:c.to};
    if(type==='wecom_app') return {corp_id:c.corp_id,agent_id:c.agent_id,secret:c.secret,user_id:c.to_user,wecom_msgtype:'text'};
    return {...c,...(type==='wecom'?{msgtype:'text'}:{})};
}
async function main(){
    const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    await store.migrate();
    await store.transaction(async conn=>{
        for(const ch of data.channels){
            if(!types[ch.type]) continue;
            const [aliases]=await conn.query('SELECT id FROM push_channels WHERE alias=?',[ch.alias]);
            if(aliases.length) continue;
            const [candidates]=await conn.query('SELECT * FROM push_channels WHERE type=? ORDER BY id',[types[ch.type]]);
            // Reuse only an unassigned original channel, leaving explicit aliases intact.
            const old=candidates.find(c=>c.alias===`ch_${c.id}`);
            const config=old ? {...safeParse(old.config,{})} : {};
            for(const [k,v] of Object.entries(convert(ch.type,ch.config))) if(v!==''&&v!==undefined&&v!==null) config[k]=v;
            const merged={type:types[ch.type],config};
            const enabled=!!ch.enabled || (!!old && configured(merged));
            if(old) await conn.query('UPDATE push_channels SET alias=?,enabled=?,config=? WHERE id=?',[ch.alias,enabled?1:0,JSON.stringify(config),old.id]);
            else await conn.query('INSERT INTO push_channels (name,type,config,alias,enabled) VALUES (?,?,?,?,?)',[ch.name,merged.type,JSON.stringify(config),ch.alias,enabled?1:0]);
        }
        for(const key of data.keys) await conn.query('INSERT IGNORE INTO gateway_keys (id,name,token_hash,prefix,allowed,defaults,active,created_at) VALUES (?,?,?,?,?,?,?,?)',[key.id,key.name,key.token_hash,key.prefix,typeof key.allowed==='string'?key.allowed:JSON.stringify(key.allowed),typeof key.defaults==='string'?key.defaults:JSON.stringify(key.defaults),key.active?1:0,key.created_at]);
    });
    console.log('Imported channel configuration and sender key hashes; no secrets printed.');
}
main().then(()=>db.end()).catch(async e=>{console.error(e.code||e.name);await db.end();process.exitCode=1;});
