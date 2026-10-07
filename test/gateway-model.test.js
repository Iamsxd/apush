const test = require('node:test');
const assert = require('node:assert/strict');
test('scoped sender normalization and atomic target validation', () => {
    const { normalizeMessage, keyConfig } = require('../services/gateway-model');
    const key = keyConfig({name:'NAS',allowed:['wecom','ntfy'],defaults:['wecom']});
    assert.deepEqual(normalizeMessage({title:'任务',message:'完成'},key).channels,['wecom']);
    assert.throws(()=>normalizeMessage({title:'任务',message:'完成',channels:['telegram']},key),e=>e.status===403);
    assert.throws(()=>normalizeMessage({title:'任务',message:'完成',channels:[]},key),e=>e.status===400);
    assert.throws(()=>normalizeMessage({title:'任务',message:'完成',level:'oops'},key),e=>e.status===400);
    assert.throws(()=>keyConfig({name:'NAS',allowed:['ntfy'],defaults:['wecom']}));
});
test('secret editing preserves credentials without revealing them', () => {
    const { redactChannel, mergeChannel } = require('../services/gateway-model');
    const old={id:2,name:'企业微信',type:'wecom-bot',alias:'wecom',enabled:1,config:{webhook_url:'https://example.com/key',msgtype:'text'}};
    assert.equal(redactChannel(old).config.webhook_url,'');
    assert.equal(mergeChannel({...old,config:{webhook_url:'',msgtype:'markdown'}},old).config.webhook_url,old.config.webhook_url);
    assert.throws(()=>mergeChannel({...old,alias:'invalid space'},old));
});
