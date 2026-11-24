import { appStrip, hostDocument, icon, navScriptTag } from "./orvane-host-view.ts";

export const makerPage = (chat: boolean, terminal = false, browser = false) => hostDocument("UI Maker", `
<section class="host-app host-maker"><header class="app-bar">${icon("edit", 15)}<strong>UI Maker</strong><span id="maker-status" role="status" class="app-status">Loading components…</span></header>
<div class="maker-layout"><aside aria-label="UI Maker components" class="maker-rail">
<label class="cs-search">${icon("search", 14)}<input type="text" id="maker-search" placeholder="Find a component" aria-label="Find a component" autocomplete="off"></label>
<p class="cs-group">Components</p><nav id="maker-components" aria-label="Components"></nav></aside>
<section class="maker-main" aria-label="Component preview"><div class="maker-bar">
<strong id="component-name">Choose a component</strong><span class="seg"><button type="button" id="mode-review" aria-pressed="true">Versions</button>
<button type="button" id="mode-lab" aria-pressed="false" disabled>Lab</button></span></div>
<nav id="maker-versions" aria-label="Versions and variants"></nav>
<div class="maker-preview"><iframe id="maker-frame" title="Component preview" sandbox="allow-scripts" hidden></iframe>
<p id="maker-empty" class="muted">Select a saved version or a Lab variant.</p></div>
<footer class="maker-foot"><span id="maker-caption" class="muted"></span>
<button type="button" id="maker-cancel" class="ghost" hidden>Cancel</button><button type="button" id="maker-pick" class="primary" hidden>Pick this variant</button></footer>
</section></div></section>`, navScriptTag + '<script src="/maker.js" defer></script>', appStrip("maker", chat, true, terminal, browser));

export const makerCss = `
.host-maker{display:grid;grid-template-rows:auto minmax(0,1fr)}
.maker-layout{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:0}
.maker-rail{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
.maker-rail .cs-group{margin:8px 18px 4px}
#maker-components{display:grid;align-content:start;gap:1px;min-height:0;overflow:auto;padding:0 6px 12px}
#maker-components button{justify-content:flex-start;width:100%;height:auto;min-height:32px;padding:6px 8px;border:0;border-radius:7px;
color:var(--strong);font-size:12.5px;font-weight:550;line-height:1.4;text-align:left;white-space:normal;overflow-wrap:anywhere}
#maker-components [aria-current=true]{background:var(--select)}
#maker-components .muted{margin:18px 10px}
.maker-main{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;min-width:0}
.maker-bar,.maker-foot{display:flex;align-items:center;gap:8px;min-height:44px;padding:7px 12px}
.maker-bar strong{flex:1;min-width:0;overflow:hidden;font-size:13.5px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
#maker-versions{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;max-height:130px;overflow:auto;padding:0 12px 8px}
#maker-versions:empty{display:none}
#maker-versions button{height:24px;padding:0 8px;border:0;border-radius:6px;background:#e6eef3;color:#385d76;font:11.5px/1 var(--mono)}
#maker-versions button:hover{background:#dae6ed}
#maker-versions [aria-current=true],#maker-versions [aria-current=true]:hover{background:var(--run);color:#fff}
#maker-versions .group{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
#maker-versions .group b{padding:0 4px 0 0;color:#7a8f9b;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
#maker-versions .group button{font-family:inherit}
.maker-preview{display:grid;place-items:center;min-height:0;margin:0 10px;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#e9edf0}
.maker-preview iframe{display:block;width:100%;height:100%;border:0}
.maker-foot{min-height:46px}.maker-foot #maker-caption{flex:1;min-width:0;overflow-wrap:anywhere}
@media(max-width:650px){.maker-layout{grid-template-columns:150px minmax(0,1fr)}.maker-bar,.maker-foot{padding-inline:8px}}
`;

export const makerScript = `
const get=id=>document.getElementById(id);
const list=get("maker-components"), versions=get("maker-versions"), frame=get("maker-frame"), status=get("maker-status");
const pick=get("maker-pick"), cancel=get("maker-cancel"), empty=get("maker-empty");
let components=[], current="", detail=null, selected=null, mode="review", csrf="", generation=0, confirm=false;
const node=(tag,text,css)=>{const element=document.createElement(tag);element.textContent=text;if(css)element.className=css;return element};
const button=(label,action)=>{const b=node("button",label);b.type="button";b.onclick=action;return b};
async function request(path,data){
  const response=await fetch(path,{signal:AbortSignal.timeout(8000),
    ...(data?{method:"POST",headers:{"Content-Type":"application/json","X-Orvane-CSRF":csrf},body:JSON.stringify(data)}:{})});
  if(response.status===401){location.replace("/");throw Error("Sign in again.")}
  const value=await response.json();
  if(!response.ok)throw Error(value.error||"Could not open this component.");
  return value;
}
function listComponents(){
  const query=get("maker-search").value.toLowerCase();
  list.replaceChildren(...components.filter(c=>c.name.toLowerCase().includes(query)).map(c=>{
    const choice=button(c.name,()=>open(c.id));choice.setAttribute("aria-current",String(current===c.id));return choice;
  }));
  if(!list.children.length)list.append(node("p","No matching components.","muted"));
}
function select(item){
  selected=item;confirm=false;
  pick.textContent="Pick this variant";cancel.hidden=true;
  frame.hidden=!item;empty.hidden=!!item;
  pick.hidden=!item?.round||item?.status==="picked";
  get("maker-caption").textContent=item?.caption||"";
  if(item){
    const params=new URLSearchParams({component:current});
    if(item.round){params.set("round",item.round);params.set("variant",item.variant)}
    else params.set("version",item.version);
    frame.src="/api/maker/preview?"+params;
  }else frame.removeAttribute("src");
  listVersions();
}
function listVersions(){
  versions.replaceChildren();
  get("mode-review").setAttribute("aria-pressed",String(mode==="review"));
  get("mode-lab").setAttribute("aria-pressed",String(mode==="lab"));
  get("mode-lab").disabled=!detail?.rounds?.some(r=>r.variants.length);
  if(!detail)return;
  if(mode==="review"){
    detail.versions.forEach(v=>{
      const b=button("v"+v.n,()=>select({version:v.n,caption:v.summary}));
      b.setAttribute("aria-current",String(selected?.version===v.n));versions.append(b);
    });
  }else{
    detail.rounds.filter(r=>r.variants.length).forEach(r=>{
      const group=node("span","","group");group.append(node("b",r.title));
      r.variants.forEach(v=>{
        const b=button(v.label,()=>select({round:r.id,variant:v.id,caption:r.title,status:r.status}));
        b.setAttribute("aria-current",String(selected?.round===r.id&&selected.variant===v.id));group.append(b);
      });
      versions.append(group);
    });
  }
}
function switchMode(value){
  mode=value;
  const revision=detail?.versions.at(-1), round=detail?.rounds.find(r=>r.variants.length);
  if(mode==="lab"&&round){const variant=round.variants[0];select({round:round.id,variant:variant.id,caption:round.title,status:round.status})}
  else if(revision)select({version:revision.n,caption:revision.summary});
  else select(null);
}
async function open(id){
  current=id;detail=null;select(null);listComponents();
  get("component-name").textContent=components.find(c=>c.id===id)?.name||"Choose a component";
  if(!id)return;
  sessionStorage.setItem("orvane.host.maker",id);
  const ticket=++generation;status.textContent="Loading versions…";
  try{
    const result=await request("/api/maker/component?component="+encodeURIComponent(id));
    if(ticket!==generation)return;
    detail=result;switchMode("review");status.textContent="";
  }catch(e){if(ticket===generation)status.textContent=e.message}
}
pick.onclick=async()=>{
  const item=selected, component=current;
  if(!item?.round)return;
  if(!confirm){confirm=true;pick.textContent="Confirm pick";cancel.hidden=false;return}
  pick.disabled=cancel.disabled=true;
  try{
    const result=await request("/api/maker/pick",{component,round:item.round,variant:item.variant});
    if(current===component){await open(component);status.textContent="Saved as v"+result.v+" on the host."}
  }catch(e){status.textContent=e.message}
  finally{pick.disabled=cancel.disabled=false;confirm=false;pick.textContent="Pick this variant";cancel.hidden=true}
};
cancel.onclick=()=>{confirm=false;pick.textContent="Pick this variant";cancel.hidden=true};
get("mode-review").onclick=()=>switchMode("review");
get("mode-lab").onclick=()=>switchMode("lab");
get("maker-search").oninput=listComponents;
get("sign-out").onsubmit=()=>["maker","pending","drafts","session","terminal"].forEach(key=>sessionStorage.removeItem("orvane.host."+key));
(async()=>{
  try{
    const result=await request("/api/maker/components");components=result.components;csrf=result.csrf;
    const remembered=sessionStorage.getItem("orvane.host.maker");
    await open(components.find(c=>c.id===remembered)?.id||components[0]?.id||"");
    if(!components.length)status.textContent="No components on the host.";
  }catch(e){status.textContent=e.message}
})();
`;
