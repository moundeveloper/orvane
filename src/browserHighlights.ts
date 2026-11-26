export interface SourcePassage {
  id: string;
  quote: string;
  label?: string;
  prefix?: string;
  suffix?: string;
  text: string;
  found: boolean;
  matches: number;
}
export interface BrowserSources {
  url: string;
  title: string;
  passages: SourcePassage[];
  selected: string;
}
export const SOURCE_MESSAGE = "__orvane_sources__";

/** Validate saved anchors; none of this text is executable page code. */
export function readBrowserSources(raw: unknown): BrowserSources | undefined {
  const value = raw as Partial<BrowserSources> | null;
  if (!value || typeof value.url !== "string" || value.url.length > 8000 || !Array.isArray(value.passages)) return;
  const passages = value.passages.slice(0, 20).filter((p) => p && typeof p.id === "string" && /^[\w-]{1,80}$/.test(p.id) &&
    typeof p.quote === "string" && !!p.quote.trim() && p.quote.length <= 4000).map((p) => ({
      id: p.id, quote: p.quote, text: typeof p.text === "string" ? p.text.slice(0, 6000) : "",
      found: false, matches: 0,
      ...(typeof p.label === "string" ? { label: p.label.slice(0, 120) } : {}),
      ...(typeof p.prefix === "string" ? { prefix: p.prefix.slice(0, 200) } : {}),
      ...(typeof p.suffix === "string" ? { suffix: p.suffix.slice(0, 200) } : {}),
    }));
  if (!passages.length) return;
  return { url: value.url, title: typeof value.title === "string" ? value.title.slice(0, 200) : "",
    passages, selected: passages.some((p) => p.id === value.selected) ? value.selected! : passages[0]!.id };
}
export function sameSourcePage(a: string, b: string) {
  try { const x = new URL(a), y = new URL(b); x.hash = y.hash = ""; return x.href === y.href; } catch { return false; }
}

// A self-contained script for the current main document. CSS Highlight ranges
// paint text without replacing nodes, changing selection, or breaking links.
export function sourceHighlightScript(sources?: BrowserSources, scroll = false): string {
  const encoded = JSON.stringify(sources ? { selected: sources.selected,
    passages: sources.passages.map(({ id, quote, prefix, suffix }) => ({ id, quote, prefix, suffix })) } : null);
  if (encoded.length > 85_000) throw Error("These source passages are too large. Send fewer or shorter quotes.");
  return `(() => {
const spec = ${encoded};
window.__orvaneSources?.stop();
if (!spec) return { cleared: true };
if (!CSS.highlights || typeof Highlight === "undefined") throw Error("This page does not support source highlights.");
const clean = s => String(s || "").replace(/\\s+/g," ").trim();
const style = document.createElement("style");
style.textContent = "::highlight(orvane-source){background:#e1eef0;text-decoration:underline 1px #87b0b8}::highlight(orvane-source-active){background:#c3dde8;color:#17303e;text-decoration:underline 2px #365f78}";
(document.head || document.documentElement).append(style);
const layer = document.createElement("div"); layer.dataset.orvaneSources = "";
layer.style.cssText="position:fixed;inset:0;pointer-events:none;z-index:2147483646";
document.documentElement.append(layer);
let selected = spec.selected, ranges = new Map(), timer = 0, frame = 0, stopped = false, lastReport = "";
const report = results => { const message=JSON.stringify({ url: location.href, selected, passages: results }); if(message!==lastReport){lastReport=message;console.debug(${JSON.stringify(SOURCE_MESSAGE)} + message)} };
function markers() {
  frame=0; layer.replaceChildren();
  spec.passages.forEach((p,i)=>{
    const r=ranges.get(p.id)?.[0]; if(!r)return;
    const box=r.getBoundingClientRect();
    if(box.left<38 || box.top<0 || box.top>innerHeight-20 || !box.height)return;
    const button=document.createElement("button"); button.textContent=String(i+1);
    button.setAttribute("aria-label","Source passage "+(i+1)); button.type="button";
    button.style.cssText="position:absolute;pointer-events:auto;width:19px;height:19px;padding:0;border:0;border-radius:6px;font:600 10.5px/19px system-ui;cursor:pointer;left:"+(box.left-28)+"px;top:"+box.top+"px;background:"+(p.id===selected?"#365f78":"#e1eef0")+";color:"+(p.id===selected?"#fff":"#456d7c");
    button.onclick=()=>{selected=p.id;refresh(false)}; layer.append(button);
  });
}
function queueMarkers(){if(!frame)frame=requestAnimationFrame(markers)}
function refresh(jump) {
  if(stopped)return [];
  let text="", positions=[], previousBlock=null;
  const walker=document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node, visited=0;
  while((node=walker.nextNode()) && text.length<250000 && visited++<20000){
    const parent=node.parentElement;
    if(!parent || parent.closest("script,style,noscript,textarea,input,select,[contenteditable],[hidden],[aria-hidden=true],[data-orvane-sources]"))continue;
    if(!parent.getClientRects().length || getComputedStyle(parent).visibility==="hidden")continue;
    const block=parent.closest("p,div,section,article,li,h1,h2,h3,h4,td,th,blockquote,pre,br");
    if(previousBlock && block!==previousBlock && text && !text.endsWith(" ")){text+=" ";positions.push(null)}
    previousBlock=block;
    for(let i=0;i<node.data.length && text.length<250000;i++){
      const char=node.data[i];
      if(/\\s/.test(char)){if(text.endsWith(" ") || !text)continue;text+=" "}else text+=char;
      positions.push({node,offset:i});
    }
  }
  ranges=new Map(); const results=[]; const all=[], active=[];
  for(const p of spec.passages){
    const quote=clean(p.quote), prefix=clean(p.prefix), suffix=clean(p.suffix); const hits=[];
    if(quote){let from=0,at;
      while(hits.length<20 && (at=text.indexOf(quote,from))!==-1){
        from=at+Math.max(1,quote.length);
        if(prefix && !text.slice(0,at).trimEnd().endsWith(prefix))continue;
        if(suffix && !text.slice(at+quote.length).trimStart().startsWith(suffix))continue;
        const start=positions[at],end=positions[at+quote.length-1];if(!start||!end)continue;
        const r=document.createRange();r.setStart(start.node,start.offset);r.setEnd(end.node,end.offset+1);hits.push(r);
      }
    }
    ranges.set(p.id,hits); all.push(...hits);if(p.id===selected)active.push(...hits);
    results.push({id:p.id,found:!!hits.length,matches:hits.length,text:hits[0]?.toString().slice(0,6000)||""});
  }
  CSS.highlights.set("orvane-source",new Highlight(...all));
  CSS.highlights.set("orvane-source-active",new Highlight(...active));
  if(jump){const r=ranges.get(selected)?.[0];if(r){
    r.startContainer.parentElement?.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});
    // Nested scrollers are handled by scrollIntoView, without changing links.
  }}
  markers(); report(results); return results;
}
const observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>refresh(false),180)});
observer.observe(document.body || document.documentElement,{childList:true,subtree:true,characterData:true});
addEventListener("scroll",queueMarkers,{capture:true,passive:true});addEventListener("resize",queueMarkers);
window.__orvaneSources={stop(){stopped=true;observer.disconnect();clearTimeout(timer);cancelAnimationFrame(frame);removeEventListener("scroll",queueMarkers,true);removeEventListener("resize",queueMarkers);style.remove();layer.remove();CSS.highlights.delete("orvane-source");CSS.highlights.delete("orvane-source-active")}};
const passages=refresh(${scroll}),target=ranges.get(selected)?.[0]?.getBoundingClientRect();
return {url:location.href,selected,passages,viewport:{width:innerWidth,height:innerHeight},target:target?{left:target.left,top:target.top,right:target.right,bottom:target.bottom}:null};
})()`;
}
