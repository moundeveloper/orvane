import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { appStrip, hostDocument, icon, navScriptTag } from "./orvane-host-view.ts";

const require = createRequire(import.meta.url);
export const xtermScriptPath = () => require.resolve("@xterm/xterm");
export const xtermCssPath = () => join(dirname(xtermScriptPath()), "../css/xterm.css");

export const terminalPage = (maker: boolean, browser = false) => hostDocument("Terminal", `
<section class="host-app host-terminal"><header class="app-bar">${icon("terminal", 15)}<strong>Terminal</strong><span id="terminal-status" class="app-status" role="status">Looking for shared terminals…</span></header>
<nav id="terminal-tabs" class="host-tabs" aria-label="Open desktop terminals"></nav>
<div class="terminal-content"><p id="terminal-empty" class="muted">Open a terminal in a shared project on the desktop.</p>
<div id="terminal-screen" aria-label="Terminal input and output" hidden></div></div>
<p id="terminal-error" role="status" class="error"></p></section>`,
  navScriptTag + '<link rel="stylesheet" href="/terminal/xterm.css"><script src="/terminal/xterm.js" defer></script><script src="/terminal.js" defer></script>',
  appStrip("terminal", true, maker, true, browser));

export const terminalCss = `
.host-terminal{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto}
.terminal-content{min-height:0;overflow:auto;margin:8px 10px 10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#f9fbfc}
#terminal-empty{padding:8px 2px}
#terminal-screen{width:max-content;max-width:none}
#terminal-screen .xterm-viewport{background:transparent;scrollbar-width:none}
#terminal-error:not(:empty){padding:0 12px 8px}.terminal-content .xterm{padding:2px 3px}
`;

export const terminalScript = `
const get=id=>document.getElementById(id), tabs=get("terminal-tabs");
const status=get("terminal-status"), screen=get("terminal-screen"), error=get("terminal-error");
const storage="orvane.host.terminal";
let terminal, active="", csrf="", cursor=0, step=0, lastInventory=0, listVersion="", online=false, input=Promise.resolve();
const node=(tag,text)=>{const element=document.createElement(tag);element.textContent=text;return element};
async function request(path,data){
  const response=await fetch(path,{signal:AbortSignal.timeout(8000),
    ...(data?{method:"POST",headers:{"Content-Type":"application/json","X-Orvane-CSRF":csrf},body:JSON.stringify(data)}:{})});
  if(response.status===401){location.replace("/");throw Error("Sign in again.")}
  const json=await response.json();
  if(!response.ok)throw Object.assign(Error(json.error||"Terminal unavailable."),{status:response.status});
  return json;
}
function select(id, focus=false){
  if(active===id){if(focus)terminal?.focus();return}
  active=id;cursor=0;step++;lastInventory=0;error.textContent="";
  sessionStorage.setItem(storage,id);screen.hidden=!id;get("terminal-empty").hidden=!!id;
  if(!id)return;
  if(!terminal){
    terminal=new Terminal({theme:{background:"#f9fbfc",foreground:"#273f50",cursor:"#365f78",selectionBackground:"#c9d9e3"},fontFamily:'"Cascadia Code",Consolas,monospace',fontSize:13,scrollback:3000});
    terminal.open(screen);
    terminal.onData(data=>{
      if(!active||!online)return;
      const target=active, ticket=step;
      input=input.then(async()=>{
        if(ticket!==step||target!==active||!online)return;
        await request("/api/terminal/input",{terminal:target,input:data});
      }).catch(()=>{
        online=false;error.textContent="Terminal input was not confirmed. Check the output before typing it again.";
      });
    });
  }
  terminal.reset();
  if(focus)terminal.focus();
}
function inventory(values){
  const version=JSON.stringify([values,active]);
  if(listVersion===version)return;
  listVersion=version;
  tabs.replaceChildren(...values.map(value=>{
    const b=node("button","");b.append(node("span",value.label+" · "+value.folder));
    b.type="button";b.setAttribute("aria-current",String(active===value.id));b.onclick=()=>{select(value.id,true);inventory(values)};
    return b;
  }));
}
async function refresh(){
  if(document.hidden){setTimeout(refresh,250);return}
  try{
    if(Date.now()-lastInventory>3000){
      const result=await request("/api/terminal");
      csrf=result.csrf;
      if(!result.terminals.some(value=>value.id===active)){
        const remembered=sessionStorage.getItem(storage);
        select(result.terminals.find(value=>value.id===remembered)?.id||result.terminals[0]?.id||"");
      }
      inventory(result.terminals);lastInventory=Date.now();
    }
    if(active){
      const ticket=step;
      const value=await request("/api/terminal/output?terminal="+encodeURIComponent(active)+"&cursor="+cursor);
      if(ticket===step){
        if(value.cols&&value.rows&&(terminal.cols!==value.cols||terminal.rows!==value.rows))terminal.resize(value.cols,value.rows);
        if(value.reset)terminal.reset();
        if(value.output)terminal.write(value.output);
        cursor=value.cursor;
      }
    }
    status.textContent=active?"Connected to desktop shell":"No shared terminals open";
    online=true;
  }catch(e){online=false;status.textContent=e.status===404?"Terminal closed":"Reconnecting to host…";lastInventory=0}
  setTimeout(refresh,active?180:800);
}
get("sign-out").onsubmit=()=>["maker","pending","drafts","session","terminal"].forEach(key=>sessionStorage.removeItem("orvane.host."+key));
refresh();
`;
