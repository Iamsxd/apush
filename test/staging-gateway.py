"""One bounded integration run, only internal HTTP sink; no provider messages."""
import json, urllib.request, urllib.error, sys, time, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
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
seen=[]
class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        seen.append(payload)
        self.send_response(503 if payload.get('title')=='重试验证' and sum(x.get('title')=='重试验证' for x in seen)==1 else 200)
        self.end_headers(); self.wfile.write(b'{}')
    def log_message(self,*args): pass
server=HTTPServer(('0.0.0.0',17668),Sink)
threading.Thread(target=server.serve_forever,daemon=True).start()
_,channel=call('/api/manager/channels',{'name':'部署内部接收端','alias':'verify_sink','type':'ntfy','enabled':True,'config':{'server_url':'http://host.docker.internal:17668','topic':'verify'}} ,admin)
assert channel.get('success'),channel
_,key=call('/api/manager/gateway/keys',{'name':'部署验证','allowed':['verify_sink'],'defaults':['verify_sink']},admin)
assert 'token' in key,key
sender={'Authorization':'Bearer '+key['token']}
try:
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
    assert [x['title'] for x in seen].count('统一验证')==1 and any(x['title']=='兼容验证' for x in seen),seen
    assert call('/api/messages/'+job['request_id'],headers={'Authorization':'Bearer '+access['api_key']})[0]==404
    print('PASS: unified / Server酱 / scope / idempotency / ntfy sink / retries')
finally:
    call('/api/manager/gateway/keys/'+key['id'],headers=admin,method='DELETE')
    call('/api/manager/channels/'+str(channel['id']),headers=admin,method='DELETE')
    server.shutdown()
