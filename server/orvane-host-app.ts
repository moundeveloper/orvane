import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appStrip, hostHeader, navScriptTag } from "./orvane-host-view.ts";

// The desktop's production build (vite build): host-agents.html mounts the
// real AgentSessions.vue, and /assets holds its scripts, styles and fonts.
export const builtApp = fileURLToPath(new URL("../dist/", import.meta.url));

const types: Record<string, string> = {
  ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".wasm": "application/wasm",
};

/** A built asset by its hashed name, or undefined. Names only, no folders. */
export async function builtAsset(directory: string, name: string) {
  const type = types[extname(name)];
  if (!type || !/^[\w.-]{1,160}$/.test(name) || name.startsWith(".")) return;
  const data = await readFile(join(directory, "assets", name)).catch(() => undefined);
  return data && { data, type };
}

const escape = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

type SharedApps = { maker: boolean; terminal: boolean; browser: boolean; notes: boolean };

/**
 * A laptop page that runs a desktop component from the production build: the
 * host's top bar, then the component in one app window. Built tags come from
 * dist/<entry>.html.
 */
async function builtPage(
  directory: string, entry: string, title: string, active: string, chat: boolean, apps: SharedApps, meta: string,
) {
  const built = await readFile(join(directory, entry), "utf8").catch(() => "");
  const tags = built.match(/<script type="module"[^>]*><\/script>|<link rel="(?:modulepreload|stylesheet)"[^>]*>/g) ?? [];
  const content = tags.length
    ? `<div id="${entry.replace(/\.html$/, "")}" class="host-app"></div>`
    : `<p class="host-missing" role="alert">${title} isn't built yet. On the desktop, run <code>pnpm build-only</code> (or restart Orvane), then reload this page.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="orvane-host" content="">${meta}
<title>${title} · Orvane</title><link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/host-shell.css">
${tags.join("\n")}
${navScriptTag}</head><body>${hostHeader(appStrip(active, chat, apps.maker, apps.terminal, apps.browser, apps.notes))}<main>${content}</main></body></html>`;
}

/** The laptop's Agent Sessions page: the desktop's AgentSessions.vue. */
export const agentsPage = (directory: string, csrf: string, modes: object, apps: SharedApps) =>
  builtPage(directory, "host-agents.html", "Agent Sessions", "chat", true, apps,
    `<meta name="orvane-csrf" content="${escape(csrf)}">
<meta name="orvane-modes" content="${escape(JSON.stringify(modes))}">`);

/** The laptop's Notes page: the desktop's NotesView.vue on the same pages. */
export const notesPage = (directory: string, csrf: string, chat: boolean, apps: SharedApps) =>
  builtPage(directory, "host-notes.html", "Notes", "notes", chat, apps, `<meta name="orvane-csrf" content="${escape(csrf)}">`);

// Only the page frame and the top bar: the app inside keeps the desktop's own
// styles, so nothing here may reach into it.
export const hostShellCss = `
html,body{height:100%}body{margin:0;height:100dvh;display:grid;grid-template-rows:48px minmax(0,1fr);overflow:hidden;background:#e9edf0}
body>main{min-height:0;padding:0 14px 14px}
.host-app{height:100%;min-height:0;overflow:hidden;background:#f7f9fa;border-radius:10px;box-shadow:0 1px 2px #263f5512,0 10px 30px #263f551c}
.host-missing{margin:24px 8px;color:#455968;font:13px/1.5 "Inter Variable",Inter,"Segoe UI",system-ui,sans-serif}
.host-top{display:flex;align-items:center;gap:14px;min-width:0;padding:0 14px 0 22px;font:13px/1.5 "Inter Variable",Inter,"Segoe UI",system-ui,sans-serif;color:#455968}
.host-top .i{flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.host-top .wordmark{display:flex;align-items:center;flex:none;color:#556c7a}
.host-top .wordmark>img{margin-right:9px}
.host-top .wordmark>span:first-of-type{font-size:15px;font-weight:550;letter-spacing:-.7px}
.host-top .workspace-label{margin-left:12px;padding-left:17px;border-left:1px solid #ccd6dd;color:#5b6c77;font-size:10px;letter-spacing:.01em}
.host-top .host-apps{display:flex;align-items:center;gap:2px;flex:1;min-width:0;margin-left:10px}
.host-top .host-apps a,.host-top .top-btn{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 9px;border:0;border-radius:6px;color:#556c7a;
background:none;font:inherit;font-size:12px;line-height:1;text-decoration:none;white-space:nowrap;cursor:pointer}
.host-top .host-apps a .i,.host-top .top-btn .i{color:#6f8998}
.host-top .host-apps a:hover,.host-top .top-btn:hover{background:#e8eef2;color:#273f50}
.host-top .host-apps [aria-current=page]{background:#f7f9fa;color:#273f50;font-weight:550;box-shadow:0 1px 2px #263f5512,0 2px 8px #263f550d}
.host-top .host-apps [aria-current=page] .i{color:#273f50}
.host-top .host-keys{display:inline-flex;gap:3px;margin-left:auto;padding-left:8px}
.host-top kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border:1px solid #d6e0e6;border-bottom-width:2px;
border-radius:4px;background:#fbfcfd;color:#5d7381;font:10.5px/1 "Cascadia Code",Consolas,monospace}
.host-top #restart,.host-top #sign-out{flex:none;margin:0}.host-top #restart{margin-left:auto}.host-top .host-apps~#restart{margin-left:0}
`;
