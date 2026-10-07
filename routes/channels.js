const express = require('express');
const router = express.Router();
const db = require('../db');
const pusher = require('../services/pusher');
const {GatewayError,redactChannel,mergeChannel} = require('../services/gateway-model');
router.get('/',async(req,res)=>{
    const [rows]=await db.query('SELECT * FROM push_channels ORDER BY id DESC');
    res.json(rows.map(redactChannel));
});
async function save(req,res,next) {
    try {
        const [rows]=req.params.id ? await db.query('SELECT * FROM push_channels WHERE id=?',[req.params.id]) : [[]];
        if (req.params.id && !rows.length) throw new GatewayError(404,'通道不存在');
        const c=mergeChannel(req.body,rows[0]);
        const values=[c.name,c.type,JSON.stringify(c.config),c.template||null,c.alias,c.enabled?1:0];
        if (req.params.id) { await db.query('UPDATE push_channels SET name=?,type=?,config=?,template=?,alias=?,enabled=? WHERE id=?',[...values,req.params.id]); res.json({success:true,id:Number(req.params.id)}); }
        else { const [r]=await db.query('INSERT INTO push_channels (name,type,config,template,alias,enabled) VALUES (?,?,?,?,?,?)',values); res.json({success:true,id:r.insertId}); }
    } catch(e) { if(e.code==='ER_DUP_ENTRY') e=new GatewayError(409,'渠道别名已存在'); next(e); }
}
router.post('/',save);
router.put('/:id',save);
router.delete('/:id',async(req,res)=>{
    const conn=await db.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('SELECT id FROM push_channels WHERE id=? FOR UPDATE',[req.params.id]);
        const [pending]=await conn.query("SELECT id FROM delivery_tasks WHERE channel_id=? AND status IN ('pending','processing') LIMIT 1",[req.params.id]);
        if (pending.length) throw new GatewayError(409,'通道仍有待投递消息');
        await conn.query('DELETE FROM push_channels WHERE id=?',[req.params.id]);
        await conn.commit();
    } catch(e) {await conn.rollback();throw e;} finally {conn.release();}
    res.json({success:true});
});
router.post('/test',async(req,res)=>{
    const [rows]=req.body.id ? await db.query('SELECT * FROM push_channels WHERE id=?',[req.body.id]) : [[]];
    const c=mergeChannel({...req.body,name:req.body.name||'测试'},rows[0]);
    const notif={title:'测试通知 - aPush',message:'用于验证通道配置的测试通知',appID:'apush_test',appName:'aPush',metadata:{}};
    await pusher.sendWithConfig(c.type,c.config,notif,'测试通知',null,{},c.template||null);
    res.json({success:true});
});
module.exports=router;
