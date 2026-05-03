export const chatScript = `
(function(){
var V=acquireVsCodeApi();
var msgs=document.getElementById('messages'),q=document.getElementById('q'),go=document.getElementById('go'),stopBtn=document.getElementById('stop'),cbtn=document.getElementById('cbtn'),mdl=document.getElementById('mdl'),idx=document.getElementById('idx');
var settingsBtn=document.getElementById('settingsBtn'),settings=document.getElementById('settings'),modeEl=document.getElementById('mode');
var modelSel=document.getElementById('modelSel'),modelCustom=document.getElementById('modelCustom'),apiKey=document.getElementById('apiKey'),keyStatus=document.getElementById('keyStatus');
var tavilyKey=document.getElementById('tavilyKey'),tavilyStatus=document.getElementById('tavilyStatus');
var saveCfg=document.getElementById('saveCfg'),closeCfg=document.getElementById('closeCfg');
var historyBtn=document.getElementById('historyBtn'),workspaceBtn=document.getElementById('workspaceBtn'),historyEl=document.getElementById('history'),histList=document.getElementById('histList'),histEmpty=document.getElementById('histEmpty'),closeHist=document.getElementById('closeHist');
var cur=null,fullText='',busy=false,tools={},edits={},mode='agent',uiHasTavily=false,renderTimer=0;
var MODELS={
  openai:['gpt-5.4','gpt-5.4-mini','gpt-5.4-nano','gpt-5-codex','gpt-5.3-codex','gpt-5.1-codex-max','gpt-5.1-codex-mini','gpt-5','gpt-4.1'],
  anthropic:['claude-opus-4-7','claude-sonnet-4-6','claude-haiku-4-5','claude-opus-4-6','claude-sonnet-4-5','claude-opus-4-5'],
  google:['gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-3.1-flash-lite-preview','gemini-2.5-pro','gemini-2.5-flash']
};
var uiProvider='openai',uiHasKey={openai:false,anthropic:false,google:false};
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&quot;'});}
function linkifyFiles(h){
  return h.replace(/(^|[\\s\\(\\[\\{&quot;'])((?:[A-Za-z0-9_.@+\\-]+\\/)+(?:[A-Za-z0-9_.@+\\-]+))(?::([0-9]+)(?:-([0-9]+))?)?/g,function(_,pre,p,line,end){
    var base=p.split('/').pop()||'';if(base.indexOf('.')<0)return _;
    var label=p+(line?':'+line+(end?'-'+end:''):'');
    return pre+'<a class="file-link" data-open="'+esc(p)+'" data-line="'+esc(line||'')+'">'+esc(label)+'</a>';
  });
}
function md(s){
  var parts=[],i=0,re=/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,m;
  while((m=re.exec(s))){parts.push({t:'p',v:s.slice(i,m.index)});parts.push({t:'c',lang:m[1]||'',v:m[2]});i=m.index+m[0].length;}
  parts.push({t:'p',v:s.slice(i)});
  return parts.map(function(p){
    if(p.t==='c'){var id='c'+Math.random().toString(36).slice(2,8);
      return '<div class="code-bar"><span class="lang">'+esc(p.lang)+'</span><span class="acts"><button data-cp="'+id+'">Copy</button><button data-ins="'+id+'">Insert</button></span></div><pre><code id="'+id+'">'+esc(p.v.replace(/\\n$/,''))+'</code></pre>';
    }
    var h=esc(p.v),codes=[];
    h=h.replace(/\`([^\`]+)\`/g,function(_,c){codes.push('<code>'+c+'</code>');return '%%OC_CODE_'+(codes.length-1)+'%%';});
    h=h.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
    h=h.replace(/(^|[^*])\\*([^*\\n]+)\\*/g,'$1<em>$2</em>');
    h=h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
    h=h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
    h=h.replace(/^# (.+)$/gm,'<h1>$1</h1>');
    h=h.replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>');
    h=h.replace(/^[\\-\\*] (.+)$/gm,'<li>$1</li>');
    h=h.replace(/(<li>.+<\\/li>\\n?)+/g,function(m){return '<ul>'+m+'</ul>'});
    h=linkifyFiles(h);
    h=h.replace(/%%OC_CODE_([0-9]+)%%/g,function(_,i){return codes[Number(i)]||'';});
    h=h.replace(/\\n\\n/g,'</p><p>');
    h=h.replace(/\\n/g,'<br>');
    return '<p>'+h+'</p>';
  }).join('');
}
function scroll(){msgs.scrollTop=msgs.scrollHeight}
function shortPath(p){var parts=String(p||'').split(/[\\/]+/).filter(Boolean);return parts.length?parts[parts.length-1]:'No workspace'}
function removeWelcome(){var w=document.getElementById('wel');if(w)w.remove()}
function addUser(t){removeWelcome();var d=document.createElement('div');d.className='msg user';d.textContent=t;msgs.appendChild(d);scroll()}
function renderCurrent(){if(!cur)return;cur.innerHTML=md(fullText);scroll()}
function startBot(){removeWelcome();var d=document.createElement('div');d.className='msg bot streaming';msgs.appendChild(d);cur=d;fullText='';scroll()}
function chunk(t){if(!cur)startBot();fullText+=t;if(!renderTimer){renderTimer=requestAnimationFrame(function(){renderTimer=0;renderCurrent();});}}
function finalize(){if(renderTimer){cancelAnimationFrame(renderTimer);renderTimer=0}if(cur){cur.classList.remove('streaming');cur.innerHTML=md(fullText)||'<em class="empty">(no response)</em>';cur=null;fullText=''}setBusy(false);scroll()}
function showError(t){if(cur){cur.remove();cur=null}var d=document.createElement('div');d.className='notice err';d.textContent='Error: '+t;msgs.appendChild(d);setBusy(false);scroll()}
function notice(t,cls){var d=document.createElement('div');d.className='notice'+(cls?' '+cls:'');d.textContent=t;msgs.appendChild(d);scroll()}
function setBusy(b){busy=b;go.style.display=b?'none':'flex';stopBtn.style.display=b?'inline-flex':'none'}
function renderToolBody(args,summary){
  var rows='';
  if(args)for(var k in args){var v=args[k];if(typeof v!=='string')v=JSON.stringify(v);rows+='<div><span class="k">'+esc(k)+':</span>'+esc(v.length>280?v.slice(0,280)+'…':v)+'</div>';}
  if(summary)rows+='<pre>'+esc(summary)+'</pre>';
  return rows||'<div class="k">no arguments</div>';
}
function sealCurrentBubble(){
  if(!cur)return;
  cur.innerHTML=md(fullText)||'<em class="empty">(thinking\u2026)</em>';
  cur=null;fullText='';
}
function toolUpdate(id,name,status,label,summary,args){
  var t=tools[id];
  if(!t){sealCurrentBubble();t=document.createElement('div');t.className='tool running';t.innerHTML='<div class="hdr"><span class="spin"></span><span class="name"></span><span class="chev">\u25b8</span></div><div class="body"></div>';msgs.appendChild(t);tools[id]=t;var h=t.querySelector('.hdr');h.onclick=function(){t.classList.toggle('open')};}
  t.classList.remove('running','complete','error');t.classList.add(status);
  var nm=t.querySelector('.name');nm.textContent=label;
  if(status!=='running'){var sp=t.querySelector('.spin');if(sp)sp.outerHTML='<span class="dot">\u25cf</span>'}
  t.querySelector('.body').innerHTML=renderToolBody(args,summary);
  scroll();
}
function renderTaskPlan(plan){
  sealCurrentBubble();
  var el=document.createElement('div');el.className='task-plan open';
  el.innerHTML='<div class="hdr"><span class="dot">●</span><span class="name">Agent task plan</span><span class="chev">▾</span></div><ol>'+plan.map(function(p){return '<li>'+esc(p)+'</li>'}).join('')+'</ol>';
  el.querySelector('.hdr').onclick=function(){el.classList.toggle('open')};msgs.appendChild(el);scroll();
}
function agentStep(step,status){
  var id='agent-step-'+step,el=document.getElementById(id);
  if(!el){sealCurrentBubble();el=document.createElement('div');el.id=id;el.className='agent-step running';el.innerHTML='<span class="spin"></span><span class="txt"></span>';msgs.appendChild(el)}
  el.className='agent-step '+status;el.querySelector('.txt').textContent='Reasoning step '+(step+1)+' '+(status==='running'?'running':'complete');
  if(status==='complete'){var sp=el.querySelector('.spin');if(sp)sp.outerHTML='<span class="dot">●</span>'}scroll();
}
function fmtDiff(d){
  if(!d)return '<span class="ctx">(no changes)</span>';
  return esc(d).split('\\n').map(function(l){
    if(l.indexOf('@@')===0)return '<span class="l hunk">'+l+'</span>';
    if(l.indexOf('+++')===0||l.indexOf('---')===0)return '<span class="l ctx">'+l+'</span>';
    if(l.charAt(0)==='+')return '<span class="l add">'+l+'</span>';
    if(l.charAt(0)==='-')return '<span class="l rem">'+l+'</span>';
    return '<span class="l ctx">'+l+'</span>';
  }).join('');
}
function addEdit(e){
  if(edits[e.id])return;
  sealCurrentBubble();
  var el=document.createElement('div');el.className='edit open';el.dataset.path=e.path;
  var title=e.kind==='create'?'Created':e.kind==='remove'?'Deleted':'Edited';
  var count=e.replacedOccurrences?' ('+e.replacedOccurrences+')':'';
  el.innerHTML='<div class="hdr"><span class="kind '+e.kind+'">'+e.kind+'</span><span class="path">'+esc(e.path)+'</span><span>'+title+count+'</span><span class="chev">▾</span></div><div class="body"><div class="diff">'+fmtDiff(e.diff)+'</div><div class="acts"><button data-open="'+esc(e.path)+'">Open file</button><button data-copy-diff="'+e.id+'">Copy diff</button></div></div>';
  el.querySelector('.hdr').onclick=function(){el.classList.toggle('open')};
  el._diff=e.diff;
  edits[e.id]=el;msgs.appendChild(el);scroll();
}
function send(text){
  var t=(text!=null?text:q.value).trim();if(!t||busy)return;
  if(t==='/clear'){V.postMessage({type:'clear'});q.value='';return}
  if(t==='/model'){toggleSettings(true);q.value='';return}
  if(t==='/key'){toggleSettings(true);q.value='';setTimeout(function(){apiKey.focus()},50);return}
  setBusy(true);if(!text){q.value='';q.style.height='auto'}
  addUser(t);
  if(mode==='agent'){V.postMessage({type:'query',text:t,mode:'agent'});}
  else{V.postMessage({type:'query',text:t,mode:'search'});}
}
function renderSearchResults(results){
  if(!results||!results.length){var e=document.createElement('div');e.className='sr-empty';e.textContent='No matches found.';msgs.appendChild(e);scroll();return}
  results.forEach(function(r){
    var el=document.createElement('div');el.className='sr';
    var loc=esc(r.path)+':'+r.startLine+'-'+r.endLine;
    var scorePct=(r.score*100).toFixed(1)+'%';
    var lines=(r.contents||'').split('\\n').map(function(l,i){return String(r.startLine+i).padStart(5)+' │ '+l}).join('\\n');
    el.innerHTML='<div class="hdr"><span class="path">'+loc+'</span><span class="score">'+scorePct+'</span><span class="chev">▸</span></div><pre>'+esc(lines)+'</pre>';
    var hdr=el.querySelector('.hdr');
    hdr.onclick=function(e){
      if(e.target.classList.contains('path')){V.postMessage({type:'openFile',path:r.path,line:r.startLine});return}
      el.classList.toggle('open');
    };
    msgs.appendChild(el);
  });
  scroll();
}
function toggleSettings(show){
  var willShow=show!=null?show:settings.hasAttribute('hidden');
  if(willShow){settings.removeAttribute('hidden');V.postMessage({type:'getConfig'});}
  else{settings.setAttribute('hidden','');}
}
function rebuildModelOptions(){
  var list=MODELS[uiProvider]||[];
  modelSel.innerHTML=list.map(function(m){return '<option value="'+esc(m)+'">'+esc(m)+'</option>'}).join('');
}
function setProviderUI(p){
  uiProvider=p;
  var pills=settings.querySelectorAll('.set-tabs .pill');
  pills.forEach(function(b){b.classList.toggle('active',b.dataset.provider===p)});
  rebuildModelOptions();
  updateKeyStatus();
}
function updateKeyStatus(){
  var has=!!uiHasKey[uiProvider];
  keyStatus.className='key-status '+(has?'set':'unset');
  keyStatus.textContent=has?'set':'not set';
  apiKey.placeholder=has?'•••••• (leave blank to keep current)':'sk-… (stored in VS Code SecretStorage)';
  apiKey.value='';
  tavilyStatus.className='key-status '+(uiHasTavily?'set':'unset');
  tavilyStatus.textContent=uiHasTavily?'set':'not set';
  tavilyKey.placeholder=uiHasTavily?'•••••• (leave blank to keep current)':'tvly-… (for web-search tool)';
  tavilyKey.value='';
}
function relTime(ts){
  var d=Date.now()-ts;var s=Math.floor(d/1000);
  if(s<60)return 'just now';
  var m=Math.floor(s/60);if(m<60)return m+'m ago';
  var h=Math.floor(m/60);if(h<24)return h+'h ago';
  var dy=Math.floor(h/24);if(dy<7)return dy+'d ago';
  return new Date(ts).toLocaleDateString();
}
function renderHistory(sessions,currentId){
  if(!sessions||!sessions.length){histList.innerHTML='';histEmpty.removeAttribute('hidden');return}
  histEmpty.setAttribute('hidden','');
  histList.innerHTML=sessions.map(function(s){
    var active=s.id===currentId?' active':'';
    var meta=(s.messageCount||0)+' msg · '+relTime(s.updatedAt);
    return '<div class="hist-item'+active+'" data-id="'+esc(s.id)+'"><div class="hist-main"><div class="hist-ttl">'+esc(s.title||'Untitled')+'</div><div class="hist-meta">'+esc(meta)+'</div></div><button class="hist-del" data-del="'+esc(s.id)+'" title="Delete">🗑</button></div>';
  }).join('');
}
function toggleHistory(show){
  var willShow=show!=null?show:historyEl.hasAttribute('hidden');
  if(willShow){historyEl.removeAttribute('hidden');V.postMessage({type:'listHistory'})}
  else historyEl.setAttribute('hidden','');
}
function replaySession(session){
  msgs.innerHTML='';cur=null;fullText='';setBusy(false);tools={};edits={};
  if(!session.messages||!session.messages.length){
    msgs.innerHTML='<div class="welcome" id="wel"><div class="wel-title">'+esc(session.title||'Chat')+'</div><div class="wel-sub">Empty conversation \u2014 send a message to continue.</div></div>';
    return;
  }
  session.messages.forEach(function(m){
    if(m.role==='user'){addUser(m.text)}
    else{var d=document.createElement('div');d.className='msg bot';d.innerHTML=md(m.text);msgs.appendChild(d)}
  });
  scroll();
}
function setMode(m){
  mode=m==='search'?'search':'agent';
  modeEl.dataset.mode=mode;
  modeEl.querySelectorAll('.mode-opt').forEach(function(o){o.classList.toggle('active',o.dataset.mode===mode)});
  q.placeholder=mode==='search'?'Search the codebase (raw snippets, no LLM)…':'Ask anything, or describe an edit…  (Enter to send, Shift+Enter newline)';
  V.postMessage({type:'setMode',mode:mode});
}
msgs.addEventListener('click',function(e){
  var t=e.target;
  if(t.dataset&&t.dataset.cp){var c=document.getElementById(t.dataset.cp);if(c)V.postMessage({type:'copyText',text:c.textContent});}
  else if(t.dataset&&t.dataset.ins){var c=document.getElementById(t.dataset.ins);if(c)V.postMessage({type:'insertCode',code:c.textContent});}
  else if(t.dataset&&t.dataset.open){V.postMessage({type:'openFile',path:t.dataset.open,line:Number(t.dataset.line||0)});}
  else if(t.dataset&&t.dataset['copyDiff']){var ed=edits[t.dataset['copyDiff']];if(ed&&ed._diff)V.postMessage({type:'copyText',text:ed._diff});}
  else if(t.classList&&t.classList.contains('chip')&&t.dataset.prompt){send(t.dataset.prompt);}
});
go.onclick=function(){send()};
stopBtn.onclick=function(){V.postMessage({type:'cancel'});setBusy(false);if(cur){finalize()};notice('Stopped',null)};
cbtn.onclick=function(){V.postMessage({type:'newSession'})};
mdl.onclick=function(){toggleSettings()};
settingsBtn.onclick=function(){toggleSettings()};
historyBtn.onclick=function(){toggleHistory()};
workspaceBtn.onclick=function(){V.postMessage({type:'chooseIndexWorkspace'})};
idx.onclick=function(){V.postMessage({type:'chooseIndexWorkspace'})};
closeHist.onclick=function(){toggleHistory(false)};
closeCfg.onclick=function(){toggleSettings(false)};
saveCfg.onclick=function(){
  var model=(modelCustom.value.trim())||modelSel.value;
  if(!model){notice('Select or enter a model',null);return}
  V.postMessage({type:'setLLMSelection',provider:uiProvider,model:model});
  if(apiKey.value){V.postMessage({type:'saveLLMKey',provider:uiProvider,apiKey:apiKey.value});apiKey.value=''}
  if(tavilyKey.value){V.postMessage({type:'setWebSearchKey',apiKey:tavilyKey.value});tavilyKey.value=''}
  notice('Saved '+uiProvider+' · '+model,null);
  toggleSettings(false);
};
histList.addEventListener('click',function(e){
  var t=e.target;
  if(t.dataset&&t.dataset.del){V.postMessage({type:'deleteHistory',id:t.dataset.del});e.stopPropagation();return}
  var item=t.closest&&t.closest('.hist-item');
  if(item&&item.dataset.id){V.postMessage({type:'loadHistory',id:item.dataset.id});toggleHistory(false)}
});
settings.addEventListener('click',function(e){
  var t=e.target;
  if(t.classList&&t.classList.contains('pill')&&t.dataset.provider){setProviderUI(t.dataset.provider)}
});
modelSel.addEventListener('change',function(){modelCustom.value=''});
modeEl.addEventListener('click',function(e){
  var t=e.target;if(t.classList&&t.classList.contains('mode-opt')&&t.dataset.mode)setMode(t.dataset.mode);
});
q.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};
q.oninput=function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,140)+'px'};
window.addEventListener('message',function(e){
  var m=e.data;
  if(m.type==='chunk')chunk(m.text);
  else if(m.type==='done'){finalize();tools={}}
  else if(m.type==='error')showError(m.text);
  else if(m.type==='tool_update')toolUpdate(m.id,m.name,m.status,m.label,m.summary,m.args);
	  else if(m.type==='task_plan')renderTaskPlan(m.plan||[]);
	  else if(m.type==='agent_step')agentStep(m.step||0,m.status||'running');
  else if(m.type==='edit')addEdit(m.edit);
  else if(m.type==='retry')notice('Retrying (attempt '+m.attempt+', '+Math.round(m.delayMs)+'ms): '+m.reason,null);
  else if(m.type==='compaction')notice('Compacted '+m.dropped+' older messages to fit context budget',null);
  else if(m.type==='addUserMessage')addUser(m.text);
  else if(m.type==='model'){mdl.textContent=m.provider+' · '+m.model;mdl.title='Click to change model ('+m.provider+'/'+m.model+')'}
  else if(m.type==='config'){uiHasKey=m.hasKey||{};uiHasTavily=!!m.hasWebSearchKey;setProviderUI(m.provider||'openai');if(m.model)modelSel.value=m.model;if(idx){idx.textContent='Index: '+shortPath(m.indexWorkspaceRoot);idx.title='Index workspace: '+(m.indexWorkspaceRoot||'not selected')+' (click to change)';}}
  else if(m.type==='search_start'){removeWelcome()}
  else if(m.type==='search_result'){renderSearchResults(m.results)}
  else if(m.type==='history_list'){renderHistory(m.sessions,m.currentId)}
  else if(m.type==='history_load'){replaySession(m.session);toggleHistory(false)}
  else if(m.type==='clear'){msgs.innerHTML='<div class="welcome" id="wel"><div class="wel-title">Open Context Chat</div><div class="wel-sub">New conversation. Ask a question or switch to <b>Search</b> mode for raw snippet lookup.</div></div>';cur=null;fullText='';setBusy(false);tools={};edits={}}
});
rebuildModelOptions();
V.postMessage({type:'ready'});
})();
`;
