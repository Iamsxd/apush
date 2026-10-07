const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let adminToken=localStorage.getItem('apush_token')||'';
async function api(path,method='GET',body) {
    const response=await fetch('/api/manager/'+path,{method,headers:{'x-auth-token':adminToken,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();
    if(response.status===401){$('#login').hidden=false;$('#panel').hidden=true;throw new Error('请登录管理后台');}
    if(!response.ok) throw new Error(data.error||'请求失败');
    return data;
}
function notice(error){$('#notice').textContent=error?.message||'';}
async function refresh(){
    try {
        const [keys,channels,tasks]=await Promise.all([api('gateway/keys'),api('channels'),api('gateway/tasks')]);
        $('#login').hidden=true;$('#panel').hidden=false;notice();
        $('#keys').innerHTML=keys.length?`<div class="scroll"><table><thead><tr><th>名称</th><th>允许渠道</th><th>默认渠道</th><th>状态</th><th></th></tr></thead><tbody>${keys.map(k=>`<tr><td>${esc(k.name)}<br><small>${esc(k.prefix)}…</small></td><td>${esc(k.allowed.join(', '))}</td><td>${esc(k.defaults.join(', '))}</td><td>${k.active?'有效':'已撤销'}</td><td>${k.active?`<button class="danger" data-revoke="${esc(k.id)}">撤销</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:'暂无密钥';
        $('#channel-choices').innerHTML=channels.map(c=>`<div class="choice"><span>${esc(c.name)} · <code>${esc(c.alias)}</code> · ${c.enabled&&c.configured?'可用':'待配置或禁用'}</span><label><input type="checkbox" name="allowed" value="${esc(c.alias)}">允许</label><label><input type="checkbox" name="defaults" value="${esc(c.alias)}">默认</label></div>`).join('');
        const status={pending:'等待',processing:'投递中',success:'成功',failed:'失败'};
        $('#tasks').innerHTML=tasks.length?tasks.map(t=>`<tr><td>${esc(t.title)}<br><small>#${esc(t.message_id)}</small></td><td>${esc(t.channel_name)}<br><code>${esc(t.channel_alias)}</code></td><td>${esc(status[t.status]||t.status)}</td><td>${esc(t.attempts)} / 3</td><td>${esc(t.error||'—')}</td></tr>`).join(''):'<tr><td colspan="5">暂无投递任务。先配置通道，再接入程序。</td></tr>';
    }catch(e){notice(e);}
}
$('#login-form').onsubmit=async event=>{event.preventDefault();try{const result=await api('auth','POST',{password:new FormData(event.target).get('password')});adminToken=result.token||'';localStorage.setItem('apush_token',adminToken);event.target.reset();await refresh();}catch(e){notice(e);}};
$('#key-form').onsubmit=async event=>{event.preventDefault();try{const form=new FormData(event.target);const result=await api('gateway/keys','POST',{name:form.get('name'),allowed:form.getAll('allowed'),defaults:form.getAll('defaults')});$('#token').textContent=result.token;$('#new-key').hidden=false;event.target.reset();await refresh();}catch(e){notice(e);}};
$('#keys').onclick=async event=>{const id=event.target.dataset.revoke;if(id&&confirm('撤销后，这个程序将无法继续发送。确定撤销？')){try{await api('gateway/keys/'+id,'DELETE');await refresh();}catch(e){notice(e);}}};
$('#refresh').onclick=refresh;
$('#hide-token').onclick=()=>{$('#token').textContent='';$('#new-key').hidden=true;};
$('#send-example').textContent=`curl '${location.origin}/api/send' \\\n  -H 'Authorization: Bearer <完整api_key>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"title":"Codex","message":"任务已经执行完成","level":"normal","channels":["wecom"]}'`;
$('#compat-example').textContent=`curl --get '${location.origin}/<完整api_key>.send' \\\n  --data-urlencode 'title=任务完成' \\\n  --data-urlencode 'desp=Codex任务执行完毕'`;
refresh();
