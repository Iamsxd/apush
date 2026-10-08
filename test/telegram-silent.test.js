const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('Telegram low-priority notifications are silent; normal and urgent retain alerts', async () => {
    const original = Module._load;
    const sent = [];
    const db = {query:async sql => sql.startsWith('SELECT') ? [[{
        id:1, name:'Telegram',type:'tg',enabled:1, config:{bot_token:'test',chat_id:'123'},
        template:'<b>{{title}}</b>\n\n{{content}}'
    }]] : [{insertId:1}]};
    Module._load = function(name,parent,...rest) {
        if (parent?.filename.endsWith('pusher.js')) {
            if (name==='axios') return {create:()=>({post:async(url,body)=>{sent.push(body);return {data:{ok:true}};}})};
            if (name==='../db') return db;
            if (name==='./mailer') return {sendMail:async()=>{}};
        }
        return original.call(this,name,parent,...rest);
    };
    try {
        delete require.cache[require.resolve('../services/pusher')];
        const pusher = require('../services/pusher');
        for (const level of ['low','normal','high']) {
            const notif={title:'Notice',message:'Body',level,metadata:{level}};
            assert.equal((await pusher.sendWithConfig('tg',{bot_token:'test',chat_id:'123'},notif,'test')).ok,true);
            assert.equal(sent.at(-1).disable_notification,level==='low');
            assert.equal((await pusher.send(1,notif,'test',1)).success,true);
            assert.equal(sent.at(-1).disable_notification,level==='low');
        }
    } finally {Module._load=original;}
});
