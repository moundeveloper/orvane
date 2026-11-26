// Lucide shapes, the same set the desktop's Icon.vue draws.
export const iconPaths = {
  sessions: '<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/>',
  ai: '<path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  stop: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  forward: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  terminal: '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  logout: '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  enter: '<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
} as const;
export type IconName = keyof typeof iconPaths;
export const icon = (name: IconName, size = 14) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]}</svg>`;
// For the page scripts: builds the same icons in the browser.
export const iconScript = `const ICONS=${JSON.stringify(iconPaths)};
function icon(name,size=14){
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("class","i");svg.setAttribute("width",size);svg.setAttribute("height",size);
  svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");svg.innerHTML=ICONS[name];
  return svg;
}`;

const signOut = `<form id="restart" method="post" action="/restart"><button type="submit" class="top-btn" title="Restart Orvane on the desktop">${icon("refresh", 14)}<span>Restart</span></button></form>
<form id="sign-out" method="post" action="/logout"><button type="submit" class="top-btn">${icon("logout", 14)}<span>Sign out</span></button></form>`;

// `nav` is given on signed-in pages (empty when only one app is shared); the
// sign-in page passes nothing and shows only the wordmark.
export const hostDocument = (title: string, content: string, script = "", nav?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Orvane</title><link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/host.css">${script}</head><body>
${hostHeader(nav)}<main>${content}</main></body></html>`;
export const hostHeader = (nav?: string) => `<header class="host-top"><span class="wordmark"><img src="/favicon.png" width="18" height="18" alt=""><span>orvane</span><span class="workspace-label">Local network</span></span>
${nav ?? ""}${nav === undefined ? "" : signOut}</header>`;

/** Restart from the laptop: confirm first, then report what happened. */
export function restartPage(state: "confirm" | "restarting" | "failed", message = "", instance = "") {
  const body = state === "confirm"
    ? `<p>Orvane waits for running agent turns and saves, then restarts. Desktop terminals close, and Host comes back on by itself.</p></div></div>
<form method="post" action="/restart"><input type="hidden" name="confirm" value="1">
<button type="submit" class="primary" autofocus>Restart Orvane</button></form>
<p class="login-foot"><a href="/">Cancel</a></p>`
    : state === "restarting"
      ? `<p role="status" id="restart-status" data-instance="${instance}">Orvane is restarting. This page goes back to Orvane once it's back.</p></div></div>
<p class="login-foot"><a href="/">Reload</a></p>`
      : `<p class="error" role="alert">${message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p></div></div>
<p class="login-foot"><a href="/">Back</a></p>`;
  return hostDocument("Restart Orvane", `<section class="login" aria-labelledby="restart-title">
<div class="login-head"><span class="login-mark">${icon("refresh", 15)}</span><div><h1 id="restart-title">${
    state === "confirm" ? "Restart Orvane?" : state === "restarting" ? "Restarting" : "Restart failed"}</h1>
${body}</section>`, state === "restarting" ? '<script src="/restart.js" defer></script>' : "", "");
}

// The Restarting page: each Host start has its own ID, so a different ID
// means Orvane is back. (A short restart can't be seen as an outage: the
// browser quietly retries a request that fails mid-restart.)
export const restartScript = `
const status=document.getElementById("restart-status");
const before=status?.dataset.instance||"";
async function check(){
  try{
    const response=await fetch("/instance",{cache:"no-store"});
    if(response.ok&&(await response.text())!==before){location.assign("/");return}
  }catch{
    if(status)status.textContent="Orvane is restarting. Waiting for it to come back…";
  }
  setTimeout(check,1000);
}
setTimeout(check,1000);
`;

export function signInPage(failed = false) {
  return hostDocument("Connect to host", `<section class="login" aria-labelledby="login-title">
<div class="login-head"><span class="login-mark">${icon("lock", 15)}</span><div><h1 id="login-title">Connect to host</h1>
<p>Orvane on this network asks for its access password.</p></div></div>
<form method="post" action="/login"><label for="password">Access password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">
${failed ? '<p class="error" role="alert">Password or sign-in attempt rejected.</p>' : ""}
<button type="submit" class="primary">Connect</button></form>
<p class="login-foot"><kbd>Enter</kbd><span>connect</span></p></section>`);
}

const appIcons: Record<string, IconName> = { chat: "sessions", maker: "edit", browser: "globe", terminal: "terminal", runs: "clock" };
export const appStrip = (active: string, chat: boolean, maker: boolean, terminal = false, browser = false) => {
  const apps = [
    ...(chat ? [{ id: "chat", path: "/", label: "Agent Sessions" }] : []),
    ...(maker ? [{ id: "maker", path: "/maker", label: "UI Maker" }] : []),
    ...(browser ? [{ id: "browser", path: "/browser", label: "Browser" }] : []),
    ...(terminal ? [{ id: "terminal", path: "/terminal", label: "Terminal" }] : []),
    { id: "runs", path: "/runs", label: "Recent runs" },
  ];
  if (apps.length < 2) return "";
  return `<nav class="host-apps" aria-label="Host apps">${apps.map(({ id, path, label }) =>
    `<a data-host-app href="${path}"${id === active ? ' aria-current="page"' : ""}>${icon(appIcons[id]!, 14)}<span>${label}</span></a>`).join("")}
    <span class="host-keys" aria-hidden="true"><kbd>Ctrl</kbd><kbd>←</kbd><kbd>→</kbd></span></nav>`;
};
export const navScriptTag = '<script src="/navigation.js" defer></script>';
export const watchPage = (chat = false, maker = false, terminal = false, browser = false) => hostDocument("Agent runs", `<section class="host-app watch">
<header class="app-bar">${icon("clock", 15)}<h1>Agent runs</h1><p class="app-status" id="connection" role="status">Connecting to host…</p></header>
<p class="cs-group">Recent</p><ul id="runs" aria-label="Recent runs"></ul></section>`,
navScriptTag + '<script src="/watch.js" defer></script>', appStrip("runs", chat, maker, terminal, browser));

// Shared shell: the canvas, the frost top bar with the wordmark and app strip,
// and one Orvane app window per page. Tokens and controls follow DESIGN.md and
// the design guide's look.md, with values copied from AgentSessions.vue.
export const hostCss = `
@font-face{font-family:"Inter Variable";src:url("/inter-latin.woff2") format("woff2");font-style:normal;font-weight:100 900;font-display:swap}
:root{color-scheme:light;font:13px/1.5 "Inter Variable",Inter,"Segoe UI",system-ui,sans-serif;font-synthesis:none;color:#455968;background:#e9edf0;
-webkit-font-smoothing:antialiased;--strong:#273f50;--text:#455968;--muted:#5d7381;--faint:#8296a2;--accent:#6f8998;--run:#365f78;
--line:#e1e8ec;--line2:#d5e0e5;--hover:#e5edf2;--select:#dde8ee;--raised:#fbfcfd;--app:#f7f9fa;--mono:"Cascadia Code",Consolas,monospace;
--app-shadow:0 1px 2px #263f5512,0 10px 30px #263f551c}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{height:100%}body{margin:0;height:100dvh;display:grid;grid-template-rows:48px minmax(0,1fr);overflow:hidden}
h1,h2,p,ul,ol{margin:0}strong,h1{color:var(--strong)}
.i{flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:8px;background:#c6d3db padding-box}
::-webkit-scrollbar-thumb:hover{background-color:#aebfca}::-webkit-scrollbar-button{display:none;width:0;height:0}
@supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:#c6d3db transparent}}

/* Controls: Agent Sessions' .cs-btn and the shared field look. */
button,input,textarea{font:inherit;color:inherit}
button{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 9px;border:1px solid var(--line2);
border-radius:6px;background:transparent;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
button:hover{background:var(--hover)}button:disabled{opacity:.5;cursor:default;background:transparent}
button:focus-visible,a:focus-visible{outline:none;box-shadow:0 0 0 3px #6f899840}
button.ghost{border-color:transparent}button.icon{width:28px;padding:0}
button.primary{color:#fff;background:var(--run);border-color:var(--run)}button.primary:hover{background:#2f5469}
button.primary:disabled{background:var(--run)}
input{height:30px;min-width:0;padding:0 9px;border:1px solid var(--line2);border-radius:7px;background:var(--raised);font-size:12.5px;outline:0}
input::placeholder,textarea::placeholder{color:var(--faint)}input:focus{border-color:#7b97a7}
kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border:1px solid #d6e0e6;border-bottom-width:2px;
border-radius:4px;background:var(--raised);color:var(--muted);font:10.5px/1 var(--mono)}
.muted{color:var(--muted);font-size:12px}.error{color:#a0624f;font-size:12px}
/* Segmented control (design guide: track #e8eff3, pressed button raised). */
.seg{display:inline-flex;flex-wrap:wrap;gap:2px;min-width:0;padding:2px;border-radius:7px;background:#e8eff3}
.seg button{height:24px;padding:0 9px;border:0;border-radius:6px;color:var(--muted);font-size:11.5px}
.seg button:hover{background:none;color:var(--strong)}
.seg [aria-pressed=true],.seg [aria-pressed=true]:hover{background:var(--raised);color:var(--strong);box-shadow:0 1px 2px #263f5512}
/* Search field (.cs-search) shared by the Agent Sessions and UI Maker sidebars. */
.cs-search{display:flex;align-items:center;gap:7px;flex:none;height:30px;margin:10px 10px 6px;padding:0 8px;border:1px solid var(--line2);border-radius:7px;background:var(--raised);color:var(--muted)}
.cs-search:focus-within{border-color:#7b97a7}
.cs-search input{flex:1;height:auto;padding:0;border:0;background:transparent;color:var(--text)}
.cs-group{display:flex;align-items:center;gap:6px;margin:10px 8px 4px;font-size:11px;font-weight:600;color:var(--muted)}

/* Top bar: the desktop's wordmark and frost header, with the shared apps on its centre line. */
.host-top{display:flex;align-items:center;gap:14px;min-width:0;padding:0 14px 0 22px;background:rgb(247 250 252 / 8%);
backdrop-filter:blur(8px) saturate(120%)}
.wordmark{display:flex;align-items:center;flex:none;color:#556c7a}
.wordmark>img{margin-right:9px}
.wordmark>span:first-of-type{font-size:15px;font-weight:550;letter-spacing:-.7px}
.workspace-label{margin-left:12px;padding-left:17px;border-left:1px solid #ccd6dd;color:#5b6c77;font-size:10px;letter-spacing:.01em}
.host-apps{display:flex;align-items:center;gap:2px;flex:1;min-width:0;margin-left:10px}
.host-apps a,.top-btn{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 9px;border:0;border-radius:6px;color:#556c7a;
background:none;font-size:12px;line-height:1;text-decoration:none;white-space:nowrap}
.host-apps a .i,.top-btn .i{color:var(--accent)}
.host-apps a:hover,.top-btn:hover{background:#e8eef2;color:var(--strong)}
.host-apps [aria-current=page]{background:var(--app);color:var(--strong);font-weight:550;box-shadow:0 1px 2px #263f5512,0 2px 8px #263f550d}
.host-apps [aria-current=page] .i{color:var(--strong)}
.host-keys{display:inline-flex;gap:3px;margin-left:auto;padding-left:8px}
#restart,#sign-out{flex:none}#restart{margin-left:auto}.host-apps~#restart{margin-left:0}

/* Each page is one app window on the canvas. */
main{min-height:0;padding:0 14px 14px}
.host-app{height:100%;min-height:0;overflow:hidden;background:var(--app);border-radius:10px;box-shadow:var(--app-shadow)}
.app-bar{display:flex;align-items:center;gap:8px;height:44px;flex:none;padding:0 10px 0 14px;border-bottom:1px solid var(--line)}
.app-bar>.i{color:var(--strong)}.app-bar>h1,.app-bar>strong{font-size:13px;font-weight:600;color:var(--strong);white-space:nowrap}
.app-status{flex:1;min-width:0;overflow:hidden;color:var(--faint);font-size:11.5px;text-align:right;text-overflow:ellipsis;white-space:nowrap}
/* Tab rows (Browser, Terminal): a segmented track like the design guide's. */
.host-tabs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;margin:7px 10px 0;padding:2px;border-radius:7px;background:#e8eff3;width:fit-content;max-width:calc(100% - 20px)}
.host-tabs:empty{display:none}
.host-tabs button{max-width:240px;height:24px;padding:0 9px;border:0;border-radius:6px;color:var(--muted);font-size:11.5px}
.host-tabs button>span{overflow:hidden;text-overflow:ellipsis}
.host-tabs button:hover{background:none;color:var(--strong)}
.host-tabs [aria-current=true]{background:var(--raised);color:var(--strong);box-shadow:0 1px 2px #263f5512}
.host-tabs [aria-current=true]:hover{background:var(--raised)}

/* Sign-in: one small app card on the canvas. */
.login{width:min(340px,calc(100% - 28px));margin:clamp(24px,14vh,120px) auto 0;padding:22px 22px 16px;background:var(--app);border-radius:10px;box-shadow:var(--app-shadow)}
.login-head{display:flex;gap:11px;align-items:flex-start}.login-head h1{font-size:15px;font-weight:600}.login-head p{color:var(--faint);font-size:12px}
.login-mark{display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:7px;background:#e3ecf1;color:var(--strong)}
.login form{display:grid;gap:7px;margin-top:18px}.login label{font-size:12px;font-weight:550;color:var(--muted)}
.login input{height:32px}.login button{height:32px;margin-top:5px;font-size:12.5px}
.login-foot{display:flex;align-items:center;gap:6px;margin-top:12px;color:var(--faint);font-size:11.5px}
.login-foot a{color:var(--accent);text-decoration:none}.login-foot a:hover{color:var(--strong)}.login-foot a:focus-visible{outline:none;box-shadow:0 0 0 3px #6f899840;border-radius:3px}

/* Recent runs. */
.watch{width:min(760px,100%);height:auto;max-height:100%;margin:0 auto;display:flex;flex-direction:column}
#runs{min-height:0;overflow:auto;padding:0 6px 10px;list-style:none}
#runs li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:1px 8px;padding:7px 8px;border-radius:7px;overflow-wrap:anywhere}
#runs li:hover{background:var(--hover)}#runs li strong{font-size:12.5px;font-weight:550}
#runs li small{display:flex;align-items:center;gap:4px;color:var(--muted);font-size:11.5px}
#runs li small::before{content:"";width:6px;height:6px;border-radius:50%;background:#9db0bc}
#runs li.muted{display:block;padding:10px 8px}#runs li.muted:hover{background:none}
.cs-state{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:9px;background:#edf1f3;color:var(--muted);font-size:10.5px;font-weight:550;white-space:nowrap}
.cs-state.approval{color:#7d5a1f;background:#f5eee1;box-shadow:inset 0 0 0 1px #e6d6b8}

@media(max-width:1000px){.host-keys{display:none}}
@media(max-width:900px){.workspace-label{display:none}.host-top{gap:8px;padding-left:16px}.host-apps{margin-left:0}}
@media(max-width:760px){.host-apps a>span,.top-btn>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.host-apps a,.top-btn{width:30px;padding:0;justify-content:center}main{padding:0 8px 8px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

export const hostNavScript = `
document.addEventListener("keydown",event=>{
  if(!event.ctrlKey||event.altKey||event.metaKey||event.shiftKey||event.defaultPrevented||
      !["ArrowLeft","ArrowRight"].includes(event.key)||
      event.target.closest?.("input,textarea,select,[contenteditable]"))return;
  const apps=[...document.querySelectorAll("[data-host-app]")];
  const current=apps.findIndex(a=>a.getAttribute("aria-current")==="page");
  if(apps.length<2||current<0)return;
  event.preventDefault();
  location.assign(apps[(current+apps.length+(event.key==="ArrowRight"?1:-1))%apps.length].href);
});
`;

export const watchScript = `
const status=document.getElementById("connection"), list=document.getElementById("runs");
function node(tag,text,css){const el=document.createElement(tag);el.textContent=text;if(css)el.className=css;return el}
async function refresh(){
  if(document.hidden){setTimeout(refresh,3000);return}
  try{
    const response=await fetch("/api/runs",{signal:AbortSignal.timeout(8000)});
    if(response.status===401){location.replace("/");return}
    if(!response.ok)throw Error();
    const {runs}=await response.json();
    status.textContent="Connected to host";
    list.replaceChildren(...runs.map(run=>{
      const row=node("li",""), summary=node("div","");
      summary.append(node("strong",run.title),node("small",run.provider));
      row.append(summary,node("span",run.awaitingApproval?"Needs approval":run.status,run.awaitingApproval?"cs-state approval":"cs-state"));
      return row;
    }));
    if(!runs.length)list.append(node("li","No recent agent runs.","muted"));
  }catch{status.textContent="Reconnecting to host…"}
  setTimeout(refresh,3000);
}
refresh();
document.getElementById("sign-out").onsubmit=()=>{
  sessionStorage.removeItem("orvane.host.pending");
  sessionStorage.removeItem("orvane.host.session");
  sessionStorage.removeItem("orvane.host.drafts");
  sessionStorage.removeItem("orvane.host.terminal");
};
`;
