const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const auth = require('./services/auth');

const db = require('./db');

const app = express();
const port = config.port;

app.use(cors());
app.use(bodyParser.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth: 登录/验证接口不受保护
app.post('/api/manager/auth', auth.loginHandler(config));
app.get('/api/manager/check', auth.checkHandler(config));

// 管理接口密码保护
app.use('/api/manager', auth.middleware(config));

const GatewayStore = require('./services/gateway-store');
const DeliveryQueue = require('./services/delivery-queue');
const gateway = new GatewayStore(db);
const queue = new DeliveryQueue(gateway, require('./services/pusher'));
const {publicRoutes,adminRoutes} = require('./routes/gateway');
app.use(publicRoutes(gateway));
app.use('/api/manager/gateway',adminRoutes(gateway));
app.get('/health',async(req,res)=>{await db.query('SELECT 1');res.json({ok:true,app:'apush-gateway'});});

app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/manager/rules', require('./routes/rules'));
app.use('/api/manager/channels', require('./routes/channels'));
app.use('/api/manager/sources', require('./routes/sources'));
app.use('/api/manager/messages', require('./routes/messages'));
app.use('/api/manager/system-logs', require('./routes/system-logs'));
app.use('/api/manager', require('./routes/stats'));

const syslog = require('./services/syslog');

app.use((err,req,res,next)=>{
    if (res.headersSent) return next(err);
    const status=err.status || 500;
    res.status(status).json({error:status<500 ? err.message : '服务暂时不可用'});
});

let server;
gateway.migrate().then(()=>{
    queue.start();
    server = app.listen(port, () => {
    syslog.info('服务启动', `端口 ${port}`);
    console.log(`
    ======================================
    🚀 aPush 系统已就绪
    🔗 服务地址: http://localhost:${config.port}
    📡 监听端口: ${port}
    --------------------------------------
    `);
    });
}).catch(err=>{console.error('Gateway migration failed:',err.code||err.name);process.exit(1);});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function shutdown(signal) {
    syslog.info('服务关闭', `收到 ${signal}`);
    console.log(`\n🛑 收到 ${signal}，正在优雅关闭...`);
    await new Promise(resolve=>server ? server.close(resolve) : resolve());
    await queue.stop();
    try { await db.end(); console.log('✅ 数据库连接池已释放'); } catch (e) {}
    process.exit(0);
}
