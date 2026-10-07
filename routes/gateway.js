const express = require('express');
const {GatewayError,normalizeMessage} = require('../services/gateway-model');
function publicRoutes(store) {
    const router=express.Router();
    router.use(express.urlencoded({extended:false,limit:'64kb'}));
    router.all(['/api/send',/^\/(SCT[A-Za-z0-9_-]{20,100})\.send$/, /^\/api\/messages\/([a-f0-9-]{36})$/],async(req,res,next)=>{
        try {
            const compat=/^\/(SCT[A-Za-z0-9_-]{20,100})\.send$/.exec(req.path);
            const token=compat?.[1] || /^Bearer\s+(\S+)$/i.exec(req.headers.authorization||'')?.[1];
            const key=await store.authenticate(token);
            if (!key) throw new GatewayError(401,'密钥无效');
            const status=/^\/api\/messages\/([a-f0-9-]{36})$/.exec(req.path);
            if (status) {
                if (req.method!=='GET') throw new GatewayError(405,'请使用GET');
                const job=await store.message(status[1],key.id);
                if (!job) throw new GatewayError(404,'消息不存在');
                return res.json(job);
            }
            if (!(compat ? ['GET','POST'].includes(req.method) : req.method==='POST')) throw new GatewayError(405,'请求方法不支持');
            const input=compat ? {...(req.body||{}),...req.query} : req.body;
            const body=normalizeMessage(compat ? {...input,message:input.desp??input.message??''} : input,key);
            const job=await store.enqueue(key,body,req.headers['idempotency-key']);
            res.status(202).json(compat ? {code:0,message:'已入队',data:{pushid:job.id},request_id:job.id,status:'queued',duplicate:job.duplicate} : {request_id:job.id,status:'queued',duplicate:job.duplicate});
        } catch(e) { next(e); }
    });
    return router;
}
function adminRoutes(store) {
    const router=express.Router();
    router.get('/keys',async(req,res)=>res.json(await store.listKeys()));
    router.post('/keys',async(req,res)=>res.status(201).json(await store.createKey(req.body)));
    router.delete('/keys/:id',async(req,res)=>{await store.revokeKey(req.params.id);res.json({success:true});});
    router.get('/tasks',async(req,res)=>res.json(await store.listTasks()));
    return router;
}
module.exports = {publicRoutes,adminRoutes};
