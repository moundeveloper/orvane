import { appStrip, hostDocument, icon, navScriptTag } from "./orvane-host-view.ts";

export const browserPage = (chat: boolean, maker: boolean, terminal: boolean) => hostDocument("Browser",
  `<section class="host-app host-browser">
<header class="app-bar">${icon("globe", 15)}<strong>Browser</strong><span id="browser-status" class="app-status" role="status">Connecting to desktop Browser…</span></header>
<nav id="browser-tabs" class="host-tabs" aria-label="Shared Browser tabs"></nav>
<form id="address-form" class="browser-bar"><button type="button" class="ghost icon" data-browser-action="back" aria-label="Back" title="Back">${icon("back", 15)}</button>
<button type="button" class="ghost icon" data-browser-action="forward" aria-label="Forward" title="Forward">${icon("forward", 15)}</button>
<button type="button" class="ghost icon" data-browser-action="reload" aria-label="Reload" title="Reload">${icon("refresh", 14)}</button>
<label class="address">${icon("globe", 13)}<input id="browser-address" type="text" aria-label="Address" placeholder="https://…" autocomplete="off" required></label>
<button type="submit">Go</button><button type="button" id="browser-new">${icon("plus", 14)}New tab</button></form>
<div class="browser-frame"><img id="browser-image" alt="Live view of the desktop tab" tabindex="0" hidden>
<p id="browser-empty" class="muted">Open a tab here or share one from the desktop Browser tab menu.</p></div>
<form id="browser-type" class="browser-bar"><input id="browser-text" type="text" aria-label="Text to type in the desktop page" placeholder="Type into the active field on the desktop page…">
<button type="submit">Send text</button><button type="button" id="browser-enter" class="ghost">${icon("enter", 13)}Enter</button></form>
<p id="browser-error" role="status" class="error"></p></section>`,
  navScriptTag + '<script src="/browser.js" defer></script>', appStrip("browser", chat, maker, terminal, true));

export const browserCss = `
.host-browser{display:grid;grid-template-rows:auto auto auto minmax(0,1fr) auto auto}
.browser-bar{display:flex;align-items:center;gap:6px;min-width:0;padding:7px 10px}
.browser-bar>input{flex:1}
.address{display:flex;align-items:center;gap:7px;flex:1;min-width:0;height:30px;padding:0 9px;border:1px solid var(--line2);border-radius:7px;background:var(--raised);color:var(--accent)}
.address:focus-within{border-color:#7b97a7}
.address input{flex:1;height:auto;padding:0;border:0;background:transparent;color:var(--strong);font-size:12.5px}
.browser-frame{display:grid;place-items:center;min-height:0;overflow:auto;margin:0 10px;border-radius:8px;background:#e9edf0}
.browser-frame img{display:block;max-width:100%;max-height:100%;object-fit:contain;cursor:crosshair;border-radius:6px;box-shadow:0 1px 2px #263f5512,0 6px 18px #263f5514}
.browser-frame img:focus-visible{outline:none;box-shadow:0 0 0 3px #6f899866}
#browser-empty{padding:0 20px;text-align:center}
#browser-type{padding-bottom:10px}
#browser-error:not(:empty){padding:0 12px 8px}
@media(max-width:560px){#browser-new{width:28px;padding:0;font-size:0;gap:0}}
`;

export const browserScript = `
const get=id=>document.getElementById(id), tabs=get("browser-tabs");
const field=get("browser-address"), image=get("browser-image"), status=get("browser-status"), error=get("browser-error");
const storage="orvane.host.browser";
let active="", csrf="", url="", busy=false, shown="", lastInventory=0, generation=0, timer;
const node=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el};
async function request(path,data){
  const response=await fetch(path,{signal:AbortSignal.timeout(16_000),
    ...(data?{method:"POST",headers:{"Content-Type":"application/json","X-Orvane-CSRF":csrf},body:JSON.stringify(data)}:{})});
  if(response.status===401){location.replace("/");throw Error("Sign in again.")}
  const result=await response.json();
  if(!response.ok)throw Error(result.error||"The desktop Browser is unavailable.");
  return result;
}
function select(id){
  if(id===active)return;
  active=id;url="";generation++;field.value="";image.hidden=true;image.removeAttribute("src");
  get("browser-empty").hidden=!!active;sessionStorage.setItem(storage,id);
  shown="";lastInventory=0;
}
function list(values){
  const version=JSON.stringify([values,active]);
  if(shown===version)return;
  shown=version;
  tabs.replaceChildren(...values.map(item=>{
    const b=node("button","");b.append(node("span",item.title||item.url));
    b.type="button";b.title=item.url;b.setAttribute("aria-current",String(active===item.tabId));
    b.onclick=()=>{select(item.tabId);list(values);void act({action:"select",tab:item.tabId})};
    return b;
  }));
}
function schedule(){
  clearTimeout(timer);timer=setTimeout(refresh,active?1100:2300);
}
async function refresh(){
  if(document.hidden||busy){schedule();return}
  busy=true;
  try{
    if(Date.now()-lastInventory>2500){
      const result=await request("/api/browser");
      const values=result.view.tabs;csrf=result.csrf;
      if(!values.some(tab=>tab.tabId===active)){
        const remembered=sessionStorage.getItem(storage);
        select(values.find(tab=>tab.tabId===remembered)?.tabId||values.find(tab=>tab.active)?.tabId||values[0]?.tabId||"");
      }
      list(values);lastInventory=Date.now();
    }
    if(active){
      const ticket=generation, result=await request("/api/browser/view?tab="+encodeURIComponent(active));
      if(ticket===generation){
        const view=result.view;url=view.url;
        if(document.activeElement!==field)field.value=view.url;
        status.textContent=view.title||"Connected to desktop Browser";
        if(view.image){
          image.src="data:image/jpeg;base64,"+view.image;image.hidden=false;
        }else status.textContent=view.screenshotWarning||"Waiting for a page preview…";
      }
    }else status.textContent="No shared tabs";
  }catch(e){status.textContent=e.message;lastInventory=0}
  finally{busy=false;schedule()}
}
async function act(data){
  if(!csrf)return;
  clearTimeout(timer);
  // A read may still be finishing. User actions are never retried.
  if(busy){setTimeout(()=>void act(data),80);return}
  busy=true;error.textContent="";
  try{
    const result=await request("/api/browser/action",data);
    if(data.action==="open")select(result.view.tabId);
  }catch(e){error.textContent=e.message}
  finally{busy=false;lastInventory=0;void refresh()}
}
function address(){
  const value=field.value.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(value)?value:"https://"+value;
}
get("address-form").onsubmit=event=>{
  event.preventDefault();
  const value=address();void act(active?{action:"navigate",tab:active,url:value}:{action:"open",url:value});
};
get("browser-new").onclick=()=>{if(field.value.trim())void act({action:"open",url:address()});else field.focus()};
document.querySelectorAll("[data-browser-action]").forEach(b=>b.onclick=()=>{if(active)void act({action:b.dataset.browserAction,tab:active})});
function point(event){
  const bounds=image.getBoundingClientRect();
  return {x:(event.clientX-bounds.left)/bounds.width,y:(event.clientY-bounds.top)/bounds.height};
}
image.onclick=event=>{if(active&&url)void act({action:"click",tab:active,page:url,...point(event)})};
image.addEventListener("wheel",event=>{
  if(event.ctrlKey||event.metaKey||!active||!url)return;
  event.preventDefault();
  if(!busy)void act({action:"scroll",tab:active,page:url,...point(event),dy:Math.max(-1000,Math.min(1000,event.deltaY))});
},{passive:false});
const keys=new Set(["Enter","Escape","Tab","Backspace","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"]);
image.onkeydown=event=>{
  if(!active||!url||event.altKey||event.metaKey||event.ctrlKey&&event.key!=="a")return;
  if(!keys.has(event.key)&&!event.ctrlKey)return;
  event.preventDefault();void act({action:"key",tab:active,page:url,key:event.ctrlKey?"Control+a":event.key});
};
get("browser-type").onsubmit=event=>{
  event.preventDefault();const input=get("browser-text");
  if(active&&url&&input.value){void act({action:"text",tab:active,page:url,value:input.value});input.value=""}
};
get("browser-enter").onclick=()=>{if(active&&url)void act({action:"key",tab:active,page:url,key:"Enter"})};
get("sign-out").onsubmit=()=>["maker","pending","drafts","session","terminal","browser"].forEach(key=>sessionStorage.removeItem("orvane.host."+key));
refresh();
`;
