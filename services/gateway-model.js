const crypto = require('node:crypto');
const {safeParse} = require('../utils');
class GatewayError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const aliasRE = /^[a-z][a-z0-9_-]{1,31}$/;
const tokenRE = /^SCT[A-Za-z0-9_-]{20,100}$/;
const secretFields = ['webhook_url','bark_key','secret','bot_token','smtp_pass','token','headers'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function aliases(value) {
    if (!Array.isArray(value) || !value.length || value.length > 50 || value.some(x=>typeof x !== 'string' || !aliasRE.test(x))) throw new GatewayError(400,'渠道列表无效');
    return [...new Set(value)];
}
function keyConfig(value) {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new GatewayError(400,'密钥名称无效');
    const allowed = aliases(value.allowed), defaults = aliases(value.defaults);
    if (defaults.some(x=>!allowed.includes(x))) throw new GatewayError(400,'默认渠道必须在授权范围内');
    return {name:value.name.trim(),allowed,defaults};
}
function normalizeMessage(value, key) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500 || typeof value.message !== 'string' || !value.message.trim() || value.message.length > 10000) throw new GatewayError(400,'title/message 必须是非空字符串，长度限制为500/10000');
    const level = value.level ?? 'normal';
    if (!['low','normal','high','critical'].includes(level)) throw new GatewayError(400,'level 无效');
    const channels = aliases(value.channels ?? key.defaults);
    if (channels.some(x=>!key.allowed.includes(x))) throw new GatewayError(403,'密钥没有目标渠道权限');
    return {title:value.title.trim(),message:value.message,level,channels};
}
function configured(channel) {
    const c = safeParse(channel.config, {});
    const required = {bark:['bark_key'],wecom:['corp_id','agent_id','secret'],'wecom-bot':['webhook_url'],tg:['bot_token','chat_id'],email:['smtp_host','smtp_user','smtp_pass','to'],webhook:['webhook_url'],ntfy:['server_url','topic'],dingtalk:['webhook_url'],feishu:['webhook_url']}[channel.type];
    return !!required && required.every(k=>typeof c[k] === 'string' ? !!c[k].trim() : !!c[k]);
}
function redactChannel(channel) {
    const config = {...safeParse(channel.config,{})};
    const saved_secrets = secretFields.filter(k=>config[k]);
    for (const key of secretFields) if (key in config) config[key] = '';
    return {...channel,enabled:!!channel.enabled,config,saved_secrets,configured:configured(channel)};
}
function mergeChannel(value, old) {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128 || !['bark','wecom','wecom-bot','tg','email','webhook','ntfy','dingtalk','feishu'].includes(value.type)) throw new GatewayError(400,'通道名称或类型无效');
    const alias = value.alias || old?.alias || `ch_${crypto.randomBytes(5).toString('hex')}`;
    if (!aliasRE.test(alias)) throw new GatewayError(400,'别名须为2–32位小写字母、数字、下划线或短横线，以字母开头');
    if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)) throw new GatewayError(400,'config 无效');
    const config = {...value.config};
    if (old?.type === value.type) for (const key of secretFields) if (config[key] === '' || config[key] === undefined) { const prior = safeParse(old.config,{})[key]; if (prior !== undefined) config[key] = prior; }
    for (const key of ['webhook_url','server_url']) if (config[key]) {
        let url; try { url = new URL(config[key]); } catch { throw new GatewayError(400,`${key} 地址无效`); }
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new GatewayError(400,`${key} 必须是 HTTP(S) 地址`);
    }
    if (value.type === 'ntfy' && config.topic && !/^[A-Za-z0-9_-]{1,128}$/.test(config.topic)) throw new GatewayError(400,'ntfy topic 无效');
    if (typeof config.headers === 'string' && config.headers) { try { config.headers = JSON.parse(config.headers); } catch { throw new GatewayError(400,'Webhook headers 必须是 JSON 对象'); } }
    if (config.headers && (typeof config.headers !== 'object' || Array.isArray(config.headers) || Object.entries(config.headers).some(([k,v])=>!k || typeof v !== 'string' || /[\r\n]/.test(k+v)))) throw new GatewayError(400,'Webhook headers 无效');
    return {...value,alias,config,enabled:value.enabled === undefined ? !!(old?.enabled ?? true) : !!value.enabled};
}
module.exports = {GatewayError,hash,aliases,keyConfig,normalizeMessage,configured,redactChannel,mergeChannel,tokenRE};
