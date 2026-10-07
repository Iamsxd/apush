"""One bounded integration run, only internal HTTP sink; no provider messages."""
import json, urllib.request, urllib.error, sys, time, subprocess
base=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:17067'
access=json.load(open('/srv/vps/vps-deployment/pushhub/secrets/access.json'))
def call(path, body=None, headers=None, method=None):
    data=json.dumps(body).encode() if body is not None else None
    r=urllib.request.Request(base+path,data,{'Content-Type':'application/json',**(headers or {})},method=method)
    try:
        with urllib.request.urlopen(r,timeout=15) as response: return response.status,json.load(response)
    except urllib.error.HTTPError as e:
        raw=e.read()
        try: return e.code,json.loads(raw)
        except ValueError: return e.code,{}
status,_=call('/api/send',{'title':'未授权','message':'验证'})
assert status==401, f'gateway missing: expected401 got{status}'
_,login=call('/api/manager/auth',{'password':access['admin_password']})
admin={'x-auth-token':login['token']}
sink_container='oracle-apush-stage-app-1'
sink_code="""const fs=require('fs');const http=require('http');let seen=[];fs.writeFileSync('/tmp/gateway-sink.pid',String(process.pid));fs.writeFileSync('/tmp/gateway-seen.json','[]');http.createServer((req,res)=>{if(req.method==='GET'){res.end('ok');return;}let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const p=JSON.parse(raw);p._auth=req.headers.authorization;seen.push(p);fs.writeFileSync('/tmp/gateway-seen.json',JSON.stringify(seen));res.writeHead(p.title==='重试验证'&&seen.filter(x=>x.title==='重试验证').length===1?503:200);res.end('{}');});}).listen(17668,'127.0.0.1');"""
subprocess.run(['docker','exec','-d',sink_container,'node','-e',sink_code],check=True)
subprocess.run(['docker','exec',sink_container,'node','-e',"fetch('http://127.0.0.1:17668').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],check=True)
_,channel=call('/api/manager/channels',{'name':'部署内部接收端','alias':'verify_sink','type':'ntfy','enabled':True,'config':{'server_url':'http://127.0.0.1:17668','topic':'verify','token':'internal-test-token'}} ,admin)
assert channel.get('success'),channel
_,key=call('/api/manager/gateway/keys',{'name':'部署验证','allowed':['verify_sink'],'defaults':['verify_sink']},admin)
assert 'token' in key,key
sender={'Authorization':'Bearer '+key['token']}
rule_id=None
source_id=None
try:
    _,saved_channels=call('/api/manager/channels',headers=admin)
    saved=next(c for c in saved_channels if c['id']==channel['id'])
    assert saved['config']['token']==''
    assert call('/api/manager/channels/test',{'id':saved['id'],'type':saved['type'],'name':saved['name'],'alias':saved['alias'],'config':saved['config']},admin)[0]==200
    call('/api/manager/sources',{'name':'部署验证来源','path':'gateway_verify','auth_token':key['token']},admin)
    _,sources=call('/api/manager/sources',headers=admin)
    source_id=next(x['id'] for x in sources if x['path']=='gateway_verify')
    rule={'name':'部署内部规则验证','source_id':'gateway_verify','target_channel_ids':[channel['id'],2147483646],'active_days':'1,2,3,4,5,6,0','logic_type':'AND','is_active':True}
    _,created=call('/api/manager/rules',rule,admin);rule_id=created['id']
    assert call('/api/manager/rules/'+str(rule_id),rule,admin,method='PUT')[0]==200
    assert call('/api/webhook/gateway_verify',{'title':'原规则验证','content':'保留原来的解析和规则'},sender)[0]==200
    status,job=call('/api/send',{'title':'统一验证','message':'中文消息'},dict(sender,**{'Idempotency-Key':'deploy-once'}))
    assert status==202,job
    status,duplicate=call('/api/send',{'title':'统一验证','message':'中文消息'},dict(sender,**{'Idempotency-Key':'deploy-once'}))
    assert duplicate['request_id']==job['request_id'] and duplicate['duplicate']
    assert call('/api/send',{'title':'拒绝','message':'权限验证','channels':['wecom']},sender)[0]==403
    status,compat=call('/'+key['token']+'.send',{'title':'兼容验证','desp':'Server酱中文'})
    assert status==202 and compat['code']==0,compat
    _,retry=call('/api/send',{'title':'重试验证','message':'先503后成功'},sender)
    deadline=time.time()+20
    while time.time()<deadline:
        _,state=call('/api/messages/'+retry['request_id'],headers=sender)
        if state.get('status')=='delivered': break
        time.sleep(.3)
    assert state['status']=='delivered' and state['deliveries'][0]['attempts']==2,state
    seen=json.loads(subprocess.check_output(['docker','exec',sink_container,'cat','/tmp/gateway-seen.json']))
    assert [x['title'] for x in seen].count('统一验证')==1 and any(x['title']=='兼容验证' for x in seen) and any(x['title']=='原规则验证' for x in seen),seen
    assert any(x.get('_auth')=='Bearer internal-test-token' and x['title']=='测试通知 - aPush' for x in seen)
    _,tasks=call('/api/manager/gateway/tasks',headers=admin)
    assert any(x['title']=='原规则验证' and x['status']=='failed' and x['channel_name']=='已删除的通道' for x in tasks)
    assert call('/api/messages/'+job['request_id'],headers={'Authorization':'Bearer '+access['api_key']})[0]==404
    print('PASS: unified / Server酱 / legacy rules / scope / idempotency / ntfy sink / retries / saved credentials')
finally:
    if rule_id: call('/api/manager/rules/'+str(rule_id),headers=admin,method='DELETE')
    if source_id: call('/api/manager/sources/'+str(source_id),headers=admin,method='DELETE')
    call('/api/manager/gateway/keys/'+key['id'],headers=admin,method='DELETE')
    call('/api/manager/channels/'+str(channel['id']),headers=admin,method='DELETE')
    subprocess.run(['docker','exec',sink_container,'node','-e',"process.kill(Number(require('fs').readFileSync('/tmp/gateway-sink.pid','utf8')))"],check=True)
