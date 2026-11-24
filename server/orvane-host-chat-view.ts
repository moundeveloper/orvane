import { appStrip, hostDocument, icon, iconScript, navScriptTag } from "./orvane-host-view.ts";

// Markup, classes and values copied from the desktop Agent Sessions app
// (AgentSessions.vue, ComposerModes.vue, ChatMarkdown.vue): toolbar with
// + Claude / + Codex, 268px sidebar with dated groups, frost session header
// over the thread, and the frost composer with its actions row.
export const chatPage = (maker = false, terminal = false, browser = false) => hostDocument("Agent Sessions", `<section class="host-app host-chat">
<header class="app-bar cs-toolbar">${icon("sessions", 16)}<strong>Agent sessions</strong><p id="connection" class="app-status" role="status">Connecting to host…</p>
<button type="button" id="new-claude" class="new-chat" data-provider="claude" title="New Claude Code session" disabled>${icon("plus", 14)}Claude</button>
<button type="button" id="new-codex" class="new-chat" data-provider="codex" title="New Codex session" disabled>${icon("plus", 14)}Codex</button></header>
<div id="chat-layout" class="chat-layout">
<aside class="session-rail" aria-label="Sessions">
<label class="cs-search">${icon("search", 14)}<input id="session-search" type="text" placeholder="Find a session" aria-label="Find a session" aria-keyshortcuts="/" autocomplete="off"><kbd>/</kbd></label>
<nav id="session-list" aria-label="Host sessions"><p class="cs-empty">Loading sessions…</p></nav></aside>
<section class="conversation" aria-label="Conversation">
<div class="chat-header"><button type="button" id="show-sessions" class="back ghost">${icon("back", 14)}Sessions</button>
<div class="chat-name"><h1 id="chat-title">Choose a session</h1><p id="chat-meta" class="cs-head-meta"></p></div></div>
<div id="transcript" tabindex="0" aria-label="Transcript"><div class="cs-welcome">${icon("sessions", 24)}<strong>Choose a session or start a new one</strong></div></div>
<div class="dock">
<div id="approval" hidden></div>
<form id="compose" hidden>
<p id="message-error" class="cs-error-line" role="status"></p>
<div id="new-session-options" class="cs-card" hidden></div>
<div class="compose-box"><textarea id="message" aria-label="Message" maxlength="12000" rows="2" placeholder="Write a message…" aria-keyshortcuts="Enter Shift+Enter"></textarea>
<div class="compose-actions">
<span id="mode-pill" class="cm-pill" hidden>${icon("edit", 13)}<span>Edits</span><b></b></span>
<span id="folder-chip" class="cs-folder-chip" hidden>${icon("folder", 13)}<span></span></span>
<p id="run-state" role="status" class="cs-status"></p>
<button type="button" id="stop-run" class="cs-stop" aria-label="Stop" title="Stop" hidden>${icon("stop", 11)}</button>
<button type="submit" id="send" class="cs-send" aria-label="Send" title="Send" disabled>${icon("up", 16)}<span id="send-label"></span></button></div></div></form>
</div></section></div></section>`, navScriptTag + '<script src="/marked.js" defer></script><script src="/purify.js" defer></script><script src="/chat.js" defer></script>', appStrip("chat", true, maker, terminal, browser));

export const chatCss = `
.host-chat{display:flex;flex-direction:column;font-size:13px;line-height:normal;container-type:inline-size}
.cs-toolbar{gap:6px}.cs-toolbar>strong{flex:none;margin-left:2px}
.cs-toolbar .app-status{margin-right:4px}
.chat-layout{display:grid;grid-template-columns:268px minmax(0,1fr);flex:1;min-height:0}

/* Sidebar (.cs-sidebar, .cs-session-list, .cs-session) */
.session-rail{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
#session-list{min-height:0;overflow:auto;padding:2px 6px 12px}
.cs-group b{font-weight:500;color:#7c909c}
.cs-session{display:grid;grid-template-columns:minmax(0,1fr) auto;justify-items:stretch;gap:1px 8px;width:100%;height:auto;padding:7px 8px;border:0;border-radius:7px;
text-align:left;line-height:normal;white-space:normal}
.cs-session:hover{background:var(--hover)}.cs-session[aria-current=true]{background:var(--select)}
.cs-session strong{min-width:0;overflow:hidden;color:var(--strong);font-size:12.5px;font-weight:550;text-overflow:ellipsis;white-space:nowrap}
.cs-session time{align-self:center;color:#7c909c;font-size:11px}
.cs-row-meta{grid-column:1/-1;display:flex;align-items:center;gap:6px;min-width:0;color:var(--muted);font-size:11.5px}
.cs-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cs-prov{display:inline-flex;align-items:center;gap:4px;flex:none}
.cs-prov::before{content:"";width:6px;height:6px;border-radius:50%;background:#9db0bc}
.cs-prov.codex::before{border-radius:1.5px;background:#8a9fae}
.cs-state.running{color:var(--run);background:#e1ecf2}
.cs-empty{margin:18px 10px;color:var(--muted);font-size:12px;line-height:1.6}

/* Session view: frost header over the thread (.cs-session-header). */
.conversation{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0}
.chat-header{position:absolute;inset:0 0 auto;z-index:3;display:flex;align-items:center;gap:8px;min-height:50px;padding:8px 12px 8px 16px;
background:rgb(247 250 252 / 8%);backdrop-filter:blur(8px) saturate(120%);border-bottom:1px solid #e1e8ecc0}
.chat-name{display:grid;gap:1px;flex:1;min-width:0}
.chat-name h1{overflow:hidden;color:var(--strong);font-size:13.5px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.cs-head-meta{display:flex;align-items:center;gap:7px;min-width:0;color:var(--muted);font-size:11.5px}
.cs-head-meta:empty{display:none}.cs-head-meta>span{flex:none}.cs-head-meta>.cs-path{flex:0 1 auto}
.cs-sep{color:#b4c3cc}.cs-head-state.running{color:var(--run)}.cs-head-state.approval{color:#7d5a1f;font-weight:550}.cs-head-state.failed{color:#8c4637}
.back{display:none}
.conversation:not(.has-header) .chat-header{display:none}
#transcript{flex:1;display:grid;align-content:start;gap:16px;min-height:0;overflow:auto;padding:66px 20px 6px;outline:none;overflow-wrap:anywhere}
.conversation:not(.has-header) #transcript{align-content:center;padding-top:20px}
#transcript>*{width:100%;max-width:760px;justify-self:center}
#transcript:focus-visible{box-shadow:inset 0 0 0 2px #6f899840}
#transcript>.cs-empty{margin:18px auto;text-align:center}
.cs-welcome{display:grid;place-content:center;justify-items:center;gap:10px;color:var(--muted)}
.cs-welcome strong{color:var(--strong);font-weight:600}
.cs-hello{display:grid;place-items:center;gap:10px;padding:70px 0 20px;color:var(--muted);text-align:center;font-size:12px}
.cs-hello strong{color:var(--strong);font-size:15px;font-weight:600}
.cs-mark.cs-mark-lg{width:40px;height:40px;border-radius:12px}

/* Messages (.cs-message) and their markdown (ChatMarkdown.vue). */
.cs-message{display:grid;gap:5px;min-width:0}
.cs-message-meta{display:flex;align-items:center;gap:7px;min-height:20px;color:var(--muted);font-size:11.5px}
.cs-message-meta strong{color:var(--strong);font-weight:600}
.cs-mark{display:inline-grid;place-items:center;flex:none;width:20px;height:20px;border-radius:6px;background:#e3ecf1;color:var(--strong)}
.cs-message-text{min-width:0;max-width:100%;color:#3d5262;font-size:13.5px;line-height:1.6}
.cs-message.user{justify-items:end}
.cs-message.user .cs-message-text{max-width:min(560px,86%);padding:8px 12px;border-radius:10px 10px 3px 10px;background:#e7eff4;color:var(--strong)}
.cs-message.plain .cs-message-text{white-space:pre-wrap}
.chat-markdown{overflow-wrap:anywhere;line-height:1.65}
.chat-markdown>:first-child{margin-top:0}.chat-markdown>:last-child{margin-bottom:0}
.chat-markdown p{margin:0 0 12px;max-width:75ch}
.chat-markdown :is(h1,h2,h3,h4,h5,h6){margin:20px 0 10px;color:#3d5362;font-weight:500;line-height:1.4}
.chat-markdown h1{font-size:21px}.chat-markdown h2{font-size:18px}.chat-markdown h3{font-size:16px}.chat-markdown :is(h4,h5,h6){font-size:14px}
.chat-markdown :is(ul,ol){margin:8px 0 14px;padding-left:24px}.chat-markdown li{margin:5px 0}.chat-markdown li>p{margin-bottom:5px}
.chat-markdown li>input{margin-right:7px;vertical-align:middle}.chat-markdown li:has(>input[type=checkbox]){list-style:none}
.chat-markdown strong{font-weight:600}
.chat-markdown a[href]{color:#385d76;text-decoration:underline;text-underline-offset:3px}
.chat-markdown a:focus-visible{outline:1px solid #7a96a6;outline-offset:2px;box-shadow:none}
.chat-markdown code{padding:2px 4px;border-radius:2px;background:#e7edf1;font:12px/1.6 Consolas,monospace;white-space:break-spaces;overflow-wrap:anywhere}
.chat-markdown pre{margin:12px 0;padding:12px 14px;border:1px solid #d4dfe6;border-radius:3px;background:#edf1f3;white-space:pre-wrap;overflow-wrap:anywhere}
.chat-markdown pre>code{padding:0;background:none;border-radius:0}
.chat-markdown blockquote{margin:14px 0;padding:2px 0 2px 14px;border-left:1px solid #9fb4c2;color:#526976}
.chat-markdown blockquote p:last-child{margin:0}
.chat-markdown hr{margin:18px 0;border:0;border-top:1px solid #d6e0e6}
.chat-markdown .md-table{max-width:100%;margin:14px 0;overflow-x:auto;scrollbar-gutter:stable}
.chat-markdown table{min-width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.chat-markdown :is(th,td){min-width:85px;padding:9px 12px;border-bottom:1px solid #d6e0e6;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.chat-markdown th{background:#e7eef2;color:#3d5362;font-weight:500}.chat-markdown td{background:#f7f9fa}
.chat-markdown [align=right]{text-align:right}.chat-markdown [align=center]{text-align:center}
.chat-markdown .md-image{color:#526976;font-size:12px}

/* Dock: cards and composer under the thread (.cs-compose, .cs-dock). */
.dock{flex:none;display:grid;gap:8px;padding:0 20px 14px}
.dock>*{width:100%;max-width:760px;margin:0 auto}
#approval{max-height:34dvh;overflow:auto}
#compose{display:grid;gap:8px}
.cs-error-line{color:#a0624f;font-size:12px}.cs-error-line:empty{display:none}
.cs-card{padding:8px 10px;border:1px solid #dbe5eb;border-radius:11px;background:#f7f9fae8;box-shadow:0 8px 24px #263f5512}
.compose-box{display:grid;gap:7px;min-width:0;padding:9px 10px;border:1px solid #dbe5eb;border-radius:14px;background:rgb(247 250 252 / 8%);
backdrop-filter:blur(8px) saturate(120%);box-shadow:inset 0 1px 3px #53738c12,0 10px 28px #263f551a,0 2px 6px #263f550f}
.compose-box:focus-within{border-color:#7b97a7}
.compose-box textarea{display:block;width:100%;min-width:0;min-height:44px;max-height:30dvh;padding:2px 3px;field-sizing:content;resize:none;overflow-y:auto;
border:0;border-radius:0;background:transparent;font-size:13.5px;line-height:1.5;outline:none}
.compose-box textarea[readonly]{color:var(--muted)}
.compose-actions{display:flex;align-items:center;gap:6px;min-width:0}
.cs-folder-chip{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;max-width:180px;height:28px;padding:0 4px;color:var(--muted);font-size:12px}
.cs-folder-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-pill{display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;padding:0 8px;border-radius:7px;color:var(--muted);font-size:12px;white-space:nowrap}
.cm-pill b{color:var(--run);font-weight:500}
/* No model picker here, so the first item lines up with the text like it. */
.compose-actions>.cm-pill:first-child{margin-left:-5px}.cm-pill.cm-full,.cm-pill.cm-full b{color:#b08a4a}
.cs-status{flex:1 1 auto;min-width:52px;overflow:hidden;color:var(--muted);font-size:11.5px;text-align:right;text-overflow:ellipsis;white-space:nowrap}
.cs-status.running{color:var(--run)}
.cs-send,.cs-stop{flex:none;min-width:30px;height:30px;padding:0}
.cs-send{color:var(--strong);background:#dce9ef;border-color:#bacfd9}.cs-send:hover{background:#d1e2ea}.cs-send:disabled{background:transparent}
.cs-send:has(#send-label:not(:empty)){padding:0 9px}
.cs-stop .i{fill:currentColor}
#send-label:empty{display:none}

/* New session: the desktop's folder card, with the shared projects. */
#new-session-options{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
#new-session-options fieldset{display:flex;align-items:center;gap:8px;min-width:0;margin:0;padding:0;border:0}
#new-session-options legend{float:left;padding:0;color:var(--muted);font-size:12px}
#new-session-options input{width:150px;height:28px;border-radius:7px;background:#fbfcfdcc;font-size:12px}

/* Approval (.cs-permission) and questions (AgentQuestions .aq). */
.approval-card{display:grid;gap:8px;padding:10px 12px;border:1px solid #e6d6b8;border-radius:11px;background:#fbf7efe8;box-shadow:0 8px 24px #4a3c2014}
.approval-card.questions{gap:0;padding:0;border-color:#e3d7c0;background:#fdfbf7;box-shadow:0 8px 24px #4a3c2012}
.approval-head{display:flex;align-items:center;gap:8px;color:#7d5a1f;font-size:12.5px}
.approval-head strong{color:#5e4415;font-weight:600}
.questions .approval-head{min-height:38px;padding:0 12px;border-bottom:1px solid #efe6d6;color:var(--text)}
.questions .approval-head strong{color:var(--strong)}
.wait-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#b08a4a;box-shadow:0 0 0 3px #b08a4a22}
.approval-card details{display:grid;gap:4px}
.approval-card summary{width:fit-content;color:#8a6c3a;font-size:12px;cursor:pointer}
.approval-card pre{max-height:120px;margin:4px 0 0;overflow:auto;padding:7px 9px;border-radius:6px;background:#f3ead9;color:#4b3a1c;
font:11.5px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.approval-card>p{font-size:12px}
.approval-card fieldset{display:grid;gap:2px;min-width:0;margin:0;padding:12px 14px 10px;border:0}
.approval-card fieldset+fieldset{border-top:1px solid #efe6d6}
.approval-card legend{float:left;width:100%;margin-bottom:6px;padding:0;color:var(--strong);font-size:13.5px;font-weight:550;line-height:1.45}
.approval-card fieldset label{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:center;gap:9px;min-height:32px;padding:5px 8px;
border:1px solid transparent;border-radius:7px;color:var(--strong);font-weight:550;cursor:pointer}
.approval-card fieldset label:hover{background:#eef3f6}
.approval-card fieldset label:has(input:checked){background:#e4edf2;border-color:#cfdde6}
.approval-card fieldset label:has(input:focus-visible){border-color:#9fb6c3}
.approval-card label input{grid-area:1/1;appearance:none;width:16px;height:16px;margin:0;padding:0;border:1.5px solid #a9bcc7;border-radius:50%;background:#fff;outline:none;cursor:pointer}
.approval-card label input[type=checkbox]{border-radius:4px}
.approval-card label input[type=radio]:checked{border-color:var(--run);box-shadow:inset 0 0 0 3px #fff;background:var(--run)}
.approval-card label input[type=checkbox]:checked{border-color:var(--run);background:var(--run)}
.approval-card label .tick{grid-area:1/1;place-self:center;width:10px;height:10px;stroke:#fff;stroke-width:2.6;opacity:0;pointer-events:none}
.approval-card label input[type=checkbox]:checked+.tick{opacity:1}
.approval-card fieldset small{margin:-2px 0 4px 33px;color:var(--muted);font-size:12px;line-height:1.45}
.approval-card fieldset>input{width:100%;margin-top:4px}
.approval-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.questions .approval-actions{padding:8px 12px 10px;border-top:1px solid #efe6d6}
.approval-card:not(.questions) .approval-actions button{border-color:#dfcfae}
.approval-card:not(.questions) .approval-actions button:hover{background:#f1e7d3}
.approval-card:not(.questions) .approval-actions .allow{color:#3f2f10;background:#efe2c4;border-color:#d8c294}
.approval-card:not(.questions) .approval-actions .allow:hover{background:#e9d9b4}
.questions .approval-actions .allow{color:#fff;background:var(--run);border-color:var(--run)}

/* Narrow: the desktop's container rule, one column with a back button. */
@container (max-width:650px){
  .chat-layout{grid-template-columns:minmax(0,1fr)}.session-rail{border-right:0}
  .chat-layout.has-session .session-rail,.chat-layout:not(.has-session) .conversation{display:none}
  .chat-layout.has-session .back{display:inline-flex}.chat-header{padding-left:8px}
  #transcript{padding-inline:12px}.dock{padding:0 10px 10px}
  .cs-toolbar .app-status{visibility:hidden}
}
`;

export const chatScript = `
${iconScript}
const get=id=>document.getElementById(id);
const field=get("message"), send=get("send"), stop=get("stop-run"), transcript=get("transcript"), list=get("session-list");
const connection=get("connection"), state=get("run-state"), error=get("message-error"), search=get("session-search");
const selectedKey="orvane.host.session", pendingKey="orvane.host.pending", draftsKey="orvane.host.drafts";
const modeNames={ask:"Ask first",auto:"Auto-accept",plan:"Plan only",full:"Full access"};
const providerNames={claude:"Claude Code",codex:"Codex"};
const stateNames={running:"Running",approval:"Needs approval"};
const drafts=new Map();
let sessions=[], projects=[], modes={}, active="", csrf="", current=null, pending=null, draft=null, online=false, loaded=false, sending=false;
let threadVersion="", listVersion="", approvalVersion="", generation=0, refreshTimer, polling=false, dirty=false, signingOut=false;
try {
  const saved=JSON.parse(sessionStorage.getItem(pendingKey));
  if(saved && typeof saved.session==="string" && typeof saved.message==="string" && typeof saved.requestId==="string") pending=saved;
  for(const [id,text] of JSON.parse(sessionStorage.getItem(draftsKey)||"[]"))if(typeof text==="string")drafts.set(id,text);
} catch {}

function node(tag,text,css){
  const el=document.createElement(tag);el.textContent=text;
  if(css)el.className=css;
  return el;
}
// The desktop's time formats (AgentSessions.vue time and rowTime).
function stamp(value){
  const d=new Date(value);
  return Number.isNaN(d.valueOf())?"":d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
}
function rowTime(value){
  const d=new Date(value), midnight=new Date();midnight.setHours(0,0,0,0);
  if(Number.isNaN(d.valueOf()))return "";
  return d>=midnight?d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"}):d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
}
// ChatMarkdown.vue: GitHub markdown, raw HTML kept as text, sanitized tags.
const escapeHtml=text=>text.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const markdown=window.marked&&window.DOMPurify?new window.marked.Marked({gfm:true,renderer:{
  html:({text})=>escapeHtml(text),image:({text})=>'<span class="md-image">Image: '+escapeHtml(text)+"</span>",
}}):null;
function rendered(text){
  if(!markdown)return null;
  const fragment=window.DOMPurify.sanitize(markdown.parse(text,{async:false}),{
    ALLOWED_TAGS:["p","h1","h2","h3","h4","h5","h6","ul","ol","li","pre","code","blockquote","table","thead","tbody","tr","th","td","em","strong","del","br","hr","a","input","span"],
    ALLOWED_ATTR:["href","title","class","align","start","type","checked","disabled"],RETURN_DOM_FRAGMENT:true,
  });
  for(const link of fragment.querySelectorAll("a")){
    const href=link.getAttribute("href")||"";
    if(!/^(https?:|mailto:|#)/i.test(href))link.removeAttribute("href");
    else if(!href.startsWith("#")){link.target="_blank";link.rel="noopener noreferrer"}
  }
  for(const input of fragment.querySelectorAll("input")){input.type="checkbox";input.disabled=true}
  for(const table of fragment.querySelectorAll("table")){
    const scroll=node("div","","md-table");scroll.setAttribute("role","region");scroll.setAttribute("aria-label","Message table");scroll.tabIndex=0;
    table.replaceWith(scroll);scroll.append(table);
  }
  const box=node("div","","cs-message-text chat-markdown");box.append(fragment);
  return box;
}
async function request(path, data){
  const response=await fetch(path,{
    signal:AbortSignal.timeout(8000),
    ...(data ? {method:"POST",headers:{"Content-Type":"application/json","X-Orvane-CSRF":csrf},body:JSON.stringify(data)} : {}),
  });
  if(response.status===401){location.replace("/");throw Error("Sign in again.")}
  const json=await response.json();
  if(!response.ok)throw Object.assign(Error(json.error||"The host could not complete that request."),{status:response.status});
  return json;
}
function savePending(value){
  pending=value;
  if(value)sessionStorage.setItem(pendingKey,JSON.stringify(value));else sessionStorage.removeItem(pendingKey);
}
function controls(){
  const retry=!!pending && (pending.session===active || draft&&pending.action==="start");
  const busy=!!current?.run?.busy;
  get("send-label").textContent=retry?"Retry send":"";
  send.setAttribute("aria-label",retry?"Retry send":"Send");send.title=retry?"Retry send":"Send";
  field.readOnly=retry;
  send.disabled=(!active&&!draft)||!online||sending||(!retry&&(!!pending||busy||!field.value.trim()||draft&&!draft.project));
  for(const b of document.querySelectorAll(".new-chat"))b.disabled=!projects.length;
  // Stop takes Send's place while a turn runs, as on the desktop.
  stop.hidden=!busy;send.hidden=busy&&!retry;
  stop.disabled=!online||sending||current?.run?.status==="stopping";
}
// Header line: provider · project · run state (.cs-head-meta).
function headMeta(provider,project,run){
  const meta=get("chat-meta");meta.replaceChildren();
  if(!provider)return;
  meta.append(node("span",provider));
  if(project)meta.append(node("span","·","cs-sep"),node("span",project,"cs-path"));
  const runState=run?.awaitingApproval?"approval":run?.busy?"running":run?.status==="failed"?"failed":run?.status==="stopped"?"stopped":"";
  if(runState)meta.append(node("span","·","cs-sep"),node("span",runState==="approval"?"Needs approval":runState[0].toUpperCase()+runState.slice(1),"cs-head-state "+runState));
}
function composerChips(project,mode){
  const chip=get("folder-chip"), pill=get("mode-pill");
  chip.hidden=!project;chip.lastElementChild.textContent=project||"";chip.title=project||"";
  pill.hidden=!mode;pill.lastElementChild.textContent=modeNames[mode]||"";
  pill.classList.toggle("cm-full",mode==="full");
  pill.setAttribute("aria-label","Edits: "+(modeNames[mode]||""));
  pill.title=mode==="full"?"Full access: runs anything without asking. Change it in desktop Agent Sessions.":"Edit mode from desktop Agent Sessions";
}
function showHeader(on){document.querySelector(".conversation").classList.toggle("has-header",on)}
function renderList(){
  const query=search.value.trim().toLowerCase();
  const shown=sessions.filter(s=>(s.title+" "+s.provider+" "+(s.project||"")).toLowerCase().includes(query));
  const version=JSON.stringify([shown,active]);
  if(version===listVersion)return;
  listVersion=version;
  const focused=list.contains(document.activeElement)?document.activeElement.dataset.session:undefined;
  const midnight=new Date();midnight.setHours(0,0,0,0);
  const groups=[["Needs attention",[]],["Today",[]],["Earlier",[]]];
  for(const s of shown)groups[s.state?0:s.updatedAt>=midnight.valueOf()?1:2][1].push(s);
  const rows=[];
  for(const [label,items] of groups){
    if(!items.length)continue;
    const head=node("p",label+" ","cs-group");head.append(node("b",String(items.length)));rows.push(head);
    for(const s of items){
      const b=node("button","","cs-session");
      b.type="button";b.dataset.session=s.id;b.setAttribute("aria-current",String(active===s.id));
      const title=node("strong",s.title);title.title=s.title;
      const when=node("time",rowTime(s.updatedAt));if(s.updatedAt)when.dateTime=new Date(s.updatedAt).toISOString();
      const meta=node("span","","cs-row-meta");
      meta.append(node("span",s.provider,"cs-prov"+(s.kind==="codex"?" codex":"")));
      if(s.project){const path=node("span",s.project,"cs-path");path.title=s.project;meta.append(path)}
      if(s.state)meta.append(node("span",stateNames[s.state],"cs-state "+s.state));
      b.append(title,when,meta);
      b.onclick=()=>select(s.id,true);rows.push(b);
    }
  }
  list.replaceChildren(...rows);
  if(!shown.length)list.append(node("p",query?"No matching sessions.":"No sessions in the shared projects.","cs-empty"));
  if(focused)[...list.children].find(b=>b.dataset.session===focused)?.focus();
}
function welcome(){
  const box=node("div","","cs-welcome");box.append(icon("sessions",24),node("strong","Choose a session or start a new one"));
  return box;
}
function select(id,focus){
  if(id===active&&!draft){if(focus&&id){get("chat-layout").classList.add("has-session");field.focus()}return}
  if(active)drafts.set(active,field.value);
  active=id;generation++;current=null;draft=null;threadVersion="";error.textContent="";
  get("new-session-options").hidden=true;
  sessionStorage.setItem(selectedKey,id);
  get("chat-layout").classList.toggle("has-session",!!id);
  const s=sessions.find(s=>s.id===id);
  showHeader(!!id);
  get("chat-title").textContent=s?.title||"Session";
  headMeta(s?.provider||"",s?.project||"",null);
  composerChips(s?.project||"",s?modes[s.kind]:"");
  get("compose").hidden=!id;
  field.value=pending?.session===id?pending.message:(drafts.get(id)||"");
  state.textContent=pending?.session===id?"Check whether the previous send reached the host.":"";
  transcript.replaceChildren(id?node("p","Reading session…","cs-empty"):welcome());
  renderApproval(null);
  renderList();controls();schedule(0);
  if(focus&&id)field.focus();
}
function options(){
  const settings=get("new-session-options");
  if(!draft){settings.hidden=true;return}
  settings.hidden=false;settings.replaceChildren();
  const box=node("fieldset","");
  box.append(node("legend","Shared project"));
  const track=node("span","","seg");
  projects.forEach(item=>{
    const button=node("button",item.name);
    button.type="button";button.setAttribute("aria-pressed",String(draft.project===item.id));
    button.onclick=()=>{draft.project=item.id;options();draftView();controls()};
    track.append(button);
  });
  box.append(track);settings.append(box);
  const model=node("input","");
  model.type="text";model.maxLength=150;model.placeholder="Provider default";model.value=draft.model||"";
  model.setAttribute("aria-label","Model identifier");model.oninput=()=>{draft.model=model.value.trim()};
  const modelBox=node("fieldset","");modelBox.append(node("legend","Model"),model);settings.append(modelBox);
}
function draftView(){
  const name=providerNames[draft.provider];
  get("chat-title").textContent="New "+name+" session";
  const project=projects.find(p=>p.id===draft.project)?.name||"";
  headMeta(name,project,null);composerChips(project,modes[draft.provider]);
}
function openDraft(saved){
  if(active)drafts.set(active,field.value);
  active="";generation++;current=null;threadVersion="";error.textContent="";
  draft={provider:saved?.provider||"claude",project:saved?.project||projects[0]?.id,model:saved?.model||""};
  get("chat-layout").classList.add("has-session");showHeader(true);draftView();
  get("compose").hidden=false;field.value=saved?.message||field.value&&pending?.message||"";
  const hello=node("div","","cs-hello"), mark=node("span","","cs-mark cs-mark-lg");
  mark.append(icon("ai",20));hello.append(mark,node("strong","New "+providerNames[draft.provider]+" session"));
  transcript.replaceChildren(hello);
  state.textContent="";renderApproval(null);options();renderList();controls();field.focus();
}
function renderApproval(value){
  const box=get("approval"), permission=value?.approval;
  const version=permission ? value.run.id+":"+permission.id : "";
  if(approvalVersion===version)return;
  approvalVersion=version;box.hidden=!permission;box.replaceChildren();
  if(!permission)return;
  const form=node("form","","approval-card"+(permission.questions?" questions":"")), actions=node("div","","approval-actions");
  const head=node("div","","approval-head");
  head.append(permission.questions?node("span","","wait-dot"):icon("lock",14),node("strong",permission.questions?"Agent question":permission.tool+" needs approval"));
  form.append(head);
  const fields=[];
  if(permission.questions){
    permission.questions.forEach((q,index)=>{
      const fieldset=node("fieldset",""), label=node("legend",q.question);
      fieldset.append(label);
      const name="answer-"+index;
      (q.secret?[]:q.options).forEach(option=>{
        const item=node("label",""), choice=node("input","");
        choice.type=q.multiSelect?"checkbox":"radio";choice.name=name;choice.value=option.label;
        const tick=icon("check",10);tick.classList.add("tick");
        item.append(choice,tick,node("span",option.label));
        fieldset.append(item);
        if(option.description)fieldset.append(node("small",option.description,"muted"));
      });
      if(q.secret||!q.options.length||q.other!==false){
        const input=node("input","");
        input.type=q.secret?"password":"text";input.name=name+"-text";input.maxLength=4000;
        input.setAttribute("aria-label",q.question+" (typed answer)");
        input.placeholder=q.options.length&&!q.secret?"Other answer":"Your answer";fieldset.append(input);
      }
      fields.push({key:q.id||q.question,name});form.append(fieldset);
    });
  }else if(permission.input){
    const details=node("details","");
    details.open=true;details.append(node("summary","Tool arguments"),node("pre",permission.input));form.append(details);
  }else form.append(node("p","Review the full request on the desktop.","muted"));
  const deny=node("button",permission.questions?"Skip":"Deny"), allow=node("button",permission.questions?"Send answers":"Allow once","allow");
  if(permission.questions)deny.className="ghost";
  deny.type=allow.type="submit";deny.value="deny";allow.value="allow";allow.disabled=!permission.input;
  actions.append(deny,allow);form.append(actions);box.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();
    if(!online||sending)return;
    const allowDecision=event.submitter?.value==="allow";
    const data=new FormData(form), answers=fields.map(({key,name})=>[
      key,String(data.get(name+"-text")||"").trim()||data.getAll(name).join(", "),
    ]);
    if(allowDecision&&!allow.disabled&&answers.some(([,answer])=>!answer)){
      error.textContent="Answer each question first.";return;
    }
    sending=true;allow.disabled=deny.disabled=true;error.textContent="";controls();
    try {
      await request("/api/chat",{action:"approval",session:active,runId:value.run.id,approvalId:permission.id,
        allow:allowDecision,...(allowDecision&&fields.length?{answers:Object.fromEntries(answers)}:{})});
      renderApproval(null);
    }catch(e){error.textContent=e.message;allow.disabled=!permission.input;deny.disabled=false}
    finally{sending=false;controls();schedule(0)}
  };
}
function renderChat(value){
  current=value;
  get("chat-title").textContent=value.title;headMeta(value.provider,value.project,value.run);
  composerChips(value.project,value.mode);
  const run=value.run;
  state.classList.toggle("running",!!run?.busy);
  state.textContent=pending && pending.session!==active?"Confirm the pending send in its session.":
    run?.awaitingApproval&&!value.approval?"Needs approval in desktop Agent Sessions.":
    run?.awaitingApproval?"Waiting for approval":
    run?.status==="stopping"?"Stopping…":
    run?.busy?"Working on the host…":run?.status==="failed"?"Turn failed. See desktop Agent Sessions for details.":
    run?.status==="stopped"?"Stopped":"";
  const version=JSON.stringify(value.messages);
  if(version!==threadVersion){
    const atEnd=!threadVersion||transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<60;
    const previousTop=transcript.scrollTop;
    threadVersion=version;
    transcript.replaceChildren(...value.messages.map(m=>{
      const user=m.role==="user";
      const text=!user&&rendered(m.text);
      const row=node("article","","cs-message "+m.role+(text?"":" plain"));
      row.dataset.message=m.id;
      const meta=node("div","","cs-message-meta");
      if(!user){const mark=node("span","","cs-mark");mark.append(icon("ai",12));meta.append(mark)}
      meta.append(node("strong",user?"You":value.provider));
      if(m.at)meta.append(node("time",stamp(m.at)));
      row.append(meta,text||node("div",m.text,"cs-message-text"));
      return row;
    }));
    if(!value.messages.length)transcript.append(node("p","No readable conversation messages yet.","cs-empty"));
    transcript.scrollTop=atEnd?transcript.scrollHeight:previousTop;
  }
  renderApproval(value);controls();
}
function schedule(delay=2500){
  clearTimeout(refreshTimer);
  if(polling){dirty=true;return}
  refreshTimer=setTimeout(refresh,delay);
}
async function refresh(){
  if(document.hidden){schedule();return}
  polling=true;
  try{
    const result=await request("/api/sessions");
    csrf=result.csrf;sessions=result.sessions;projects=result.projects;modes=result.modes||{};online=true;
    connection.textContent="Connected to host";
    if(!loaded){
      loaded=true;
      const preferred=pending?.session||sessionStorage.getItem(selectedKey);
      const first=sessions.find(s=>s.id===preferred);
      if(pending?.action==="start")openDraft(pending);
      else if(first||preferred?.startsWith("new-"))select(first?.id||preferred,false);
    }else if(active&&!active.startsWith("new-")&&!sessions.some(s=>s.id===active)){
      select("",false);connection.textContent="That session is no longer shared.";
    }
    if(draft)draftView();
    renderList();
    const ticket=generation;
    if(active){
      const value=await request("/api/chat?session="+encodeURIComponent(active));
      if(ticket===generation){
        if(value.savedSession&&!value.run?.busy&&sessions.some(s=>s.id===value.savedSession))select(value.savedSession,false);
        else renderChat(value);
      }
    }
  }catch(e){
    if(e.status===404&&active.startsWith("new-")){select("",false);connection.textContent=e.message}
    else {online=false;connection.textContent="Reconnecting to host…"}
  }
  finally{
    polling=false;controls();
    const delay=dirty?0:2500;dirty=false;schedule(delay);
  }
}
get("compose").onsubmit=async event=>{
  event.preventDefault();
  if(send.disabled||send.hidden||sending)return;
  const requestId=crypto.randomUUID(), message=field.value.trim();
  const turn=pending||(draft?{action:"start",...draft,model:draft.model||undefined,requestId,message}:
    {action:"send",session:active,requestId,message});
  savePending(turn);sending=true;error.textContent="";controls();
  try{
    const result=await request("/api/chat",turn);
    savePending(null);drafts.delete(turn.session);
    if(turn.action==="start"&&draft){
      select(result.session,false);
      state.textContent="Starting on the host…";
    }else if(turn.session===active){
      generation++;
      field.value="";threadVersion="";
      if(current)current.run={busy:true};
      state.textContent="Starting on the host…";
    }
  }catch(e){
    if(e.status&&e.status<500)savePending(null);
    error.textContent=e.status&&e.status<500?e.message:"Send not confirmed. Retry will check the same request.";
  }finally{sending=false;controls();schedule(0)}
};
stop.onclick=async()=>{
  if(stop.disabled||!current?.run?.id)return;
  sending=true;controls();
  try{await request("/api/chat",{action:"stop",session:active,runId:current.run.id})}
  catch(e){error.textContent=e.message}
  finally{sending=false;controls();schedule(0)}
};
get("show-sessions").onclick=()=>{get("chat-layout").classList.remove("has-session");search.focus()};
for(const button of document.querySelectorAll(".new-chat"))button.onclick=()=>{
  if(pending&&pending.action!=="start")return;
  openDraft(pending?.action==="start"?pending:{provider:button.dataset.provider});
};
list.addEventListener("click",event=>{if(event.target.closest("button"))get("chat-layout").classList.add("has-session")});
search.oninput=renderList;field.oninput=controls;
search.onkeydown=event=>{if(event.key==="Escape"){event.stopPropagation();search.blur()}};
field.onkeydown=event=>{
  if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing){event.preventDefault();get("compose").requestSubmit()}
};
document.addEventListener("keydown",event=>{
  if(event.key==="/"&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.target.closest("input,textarea,[contenteditable]")){
    event.preventDefault();get("chat-layout").classList.remove("has-session");search.focus();
  }
});
document.addEventListener("visibilitychange",()=>{if(!document.hidden)schedule(0)});
get("sign-out").onsubmit=()=>{signingOut=true;savePending(null);sessionStorage.removeItem(selectedKey);sessionStorage.removeItem(draftsKey);sessionStorage.removeItem("orvane.host.terminal")};
window.addEventListener("pagehide",()=>{
  if(signingOut)return;
  if(active)drafts.set(active,field.value);
  sessionStorage.setItem(draftsKey,JSON.stringify([...drafts.entries()].slice(-10)));
});
refresh();
`;
