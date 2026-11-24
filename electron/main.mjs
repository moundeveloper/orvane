// Orvane desktop shell. Runs the normal Vite app (with its local APIs) and
// shows it in a window whose Browser app can use <webview>, so sites that
// refuse to be framed (NetSuite, Google…) load like in a real browser.
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerSaveBlocker,
  screen,
  session,
  shell,
  Tray,
  webContents,
  webFrameMain,
} from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setupPasswords } from "./passwords.mjs";
import { setupPageDialogs } from "./page-dialogs.mjs";
import { setupPageRecorder } from "./page-recorder.mjs";
import { netSuiteLogin } from "./netsuite-login.mjs";
import { browserEnvironments } from "./netsuite-accounts.mjs";
import { setupNetSuite } from "./netsuite.mjs";
import { setupProcessing } from "./processing.mjs";
import { startNetSuiteBroker } from "./netsuite-broker.mjs";
import { createNetSuiteSessionTracker } from "./netsuite-session-tracker.mjs";
import { setupTouchpad } from "./touchpad.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.ORVANE_PORT || 5173);
const origin = `http://localhost:${port}`;
let mainWindow;
const browserPopups = new Set();
function workspaceAllowsPopups() {
  return mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized();
}
function minimizeBrowserPopups() {
  for (const popup of browserPopups) {
    if (!popup.isDestroyed() && popup.isVisible() && !popup.isMinimized()) popup.minimize();
  }
}
function trackBrowserPopup(popup) {
  browserPopups.add(popup);
  popup.once("closed", () => browserPopups.delete(popup));
  // A selector or sign-in dialog can open another native window. Track the
  // whole chain, and keep minimized dialogs from opening windows on restore.
  popup.webContents.setWindowOpenHandler(() => ({
    action: workspaceAllowsPopups() && popup.isVisible() && !popup.isMinimized() ? "allow" : "deny",
  }));
  popup.webContents.on("did-create-window", trackBrowserPopup);
  if (!workspaceAllowsPopups() && popup.isVisible() && !popup.isMinimized()) popup.minimize();
}
export const BROWSER_PARTITION = "persist:orvane-browser";
// Inspect docks DevTools inside the Browser app: the app adds a <webview>
// with this src, and Electron renders the page's DevTools into it. It gets
// its own in-memory session and none of the Browser page handling.
const GOOGLE_SIGN_IN_AGENT = process.platform === "darwin"
  ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0"
  : "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0";
const googleSignIn = (url) => {
  try { return new URL(url).origin === "https://accounts.google.com"; } catch { return false; }
};
const DEVTOOLS_SRC = "about:blank#orvane-devtools";
const DEVTOOLS_PARTITION = "orvane-devtools";
const isDevtoolsGuest = (contents) => contents.session === session.fromPartition(DEVTOOLS_PARTITION);
const CANVAS_WORLD = 1987;
const CANVAS_PREFIX = "\u0000orvane-canvas:";
// Runs inside each Browser page (isolated world): turns Ctrl/Cmd+wheel and
// middle-drag into canvas zoom/pan messages and keeps them from the page.
const CANVAS_GESTURES = `(() => {
  if (window.__orvaneCanvas) return;
  window.__orvaneCanvas = true;
  const send = (data) => console.debug(${JSON.stringify(CANVAS_PREFIX)} + JSON.stringify(data));
  const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    stop(event);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    send({ kind: "zoom", x: event.clientX, y: event.clientY, deltaY: event.deltaY * unit });
  }, { capture: true, passive: false });
  let pressed = false, moved = false, startX = 0, startY = 0;
  addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    pressed = true; moved = false; startX = event.screenX; startY = event.screenY;
    send({ kind: "pan-start" });
  }, true);
  addEventListener("pointermove", (event) => {
    if (!pressed) return;
    if (!(event.buttons & 4)) { pressed = false; send({ kind: "pan-end" }); return; }
    if (Math.hypot(event.screenX - startX, event.screenY - startY) >= 4) moved = true;
    if (moved) stop(event);
  }, true);
  addEventListener("pointerup", (event) => {
    if (event.button !== 1 || !pressed) return;
    pressed = false; send({ kind: "pan-end" });
    if (moved) stop(event);
  }, true);
  addEventListener("auxclick", (event) => { if (event.button === 1 && moved) stop(event); }, true);
  // Any press in the page tells the Browser which pane is in use.
  addEventListener("pointerdown", () => send({ kind: "focus" }), true);
  // Links: Shift-click previews in a Peek, Alt-click opens beside this page,
  // and a pinned page previews links that leave its site instead of leaving.
  const site = (host) => host.replace(/^www[.]/, "").split(".").slice(-2).join(".");
  addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    const link = event.target instanceof Element && event.target.closest("a[href]");
    if (!link || !/^https?:/.test(link.href)) return;
    let kind = event.shiftKey ? "peek" : event.altKey ? "split" : "";
    if (!kind && window.__orvanePinned && link.target !== "_blank" && !link.hasAttribute("download")) {
      try { if (site(new URL(link.href).hostname) !== site(location.hostname)) kind = "peek"; } catch {}
    }
    if (!kind) return;
    stop(event);
    send({ kind, url: link.href });
  }, true);
  // Browser shortcuts pressed while the page has focus.
  addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    let name;
    if (event.altKey && key === "arrowleft") name = mod ? "space-back" : "history-back";
    else if (event.altKey && key === "arrowright") name = mod ? "space-next" : "history-forward";
    else if (key === "escape") {
      send({ kind: "key", name: "escape" });
      return;
    } else if (mod && !event.altKey) {
      if (key === "tab") name = event.shiftKey ? "tab-back" : "tab-next";
      else if (event.shiftKey) name = ({ a: "search", c: "copy-url", t: "reopen-tab", p: "commands", k: "agent", l: "send-selection" })[key];
      else if (/^[1-9]$/.test(key)) name = "tab-" + key;
      else name = ({ k: "palette", l: "address", t: "new-tab", w: "close-tab", b: "library",
        o: "promote-peek", f: "find", [String.fromCharCode(92)]: "sidebar" })[key];
    }
    if (!name) return;
    stop(event);
    send({ kind: "key", name });
  }, true);
  addEventListener("keyup", (event) => { if (event.key === "Control" || event.key === "Meta") send({ kind: "key", name: "release" }); }, true);
  // Holding Space (outside text fields) pans Orvane's canvas: moving the
  // pointer while it is held moves the view.
  const editable = (t) => t instanceof Element && !!t.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])");
  let spaceHeld = false;
  addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.ctrlKey || event.metaKey || event.altKey || editable(event.target)) return;
    stop(event);
    if (!spaceHeld) { spaceHeld = true; send({ kind: "key", name: "space-down" }); }
  }, true);
  addEventListener("keyup", (event) => {
    if (event.code !== "Space" || !spaceHeld) return;
    stop(event);
    spaceHeld = false;
    send({ kind: "key", name: "space-up" });
  }, true);
  addEventListener("blur", () => { if (spaceHeld) { spaceHeld = false; send({ kind: "key", name: "space-up" }); } });
})();`;
// Separate profile (sessions, cookies) for tests or a second setup.
if (process.env.ORVANE_USER_DATA)
  app.setPath("userData", process.env.ORVANE_USER_DATA);
// Windows touchpads: Chromium routes precision-touchpad scrolling through
// Direct Manipulation configured with RAILS_X | RAILS_Y, which locks a
// scroll gesture to one axis when it starts along it. That helper lives on
// Chromium's "legacy" intermediate window; without that window Windows
// delivers ordinary wheel messages carrying both axes, so two-finger
// panning on the canvas is free in every direction. Must be set before
// the app is ready.
if (process.platform === "win32") app.commandLine.appendSwitch("disable-legacy-window");

const web = (url) => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};
const isOrvane = (url) => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

async function running() {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(800) });
    return (await response.text()).includes("<title>Orvane");
  } catch {
    return false;
  }
}

// The dev server runs on the system Node, not Electron's, so native modules
// (better-sqlite3) stay built for the same Node the MCP server uses.
let server;
let desktopNetSuiteService, netSuiteBroker;
async function startServer() {
  if (await running()) return;
  server = spawn(
    process.env.ORVANE_NODE || "node",
    [join(root, "electron/server.mjs"), String(port), String(process.pid)],
    // The stdin pipe ties the server's life to this process (see server.mjs).
    { cwd: root, stdio: ["pipe", "inherit", "inherit"], windowsHide: true },
  );
  server.on("exit", (code) => {
    server = undefined;
    if (code) console.error(`Orvane server exited with code ${code}`);
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await running()) return;
    if (!server) throw Error("The Orvane server could not start.");
    await new Promise((done) => setTimeout(done, 300));
  }
  throw Error("The Orvane server did not answer within 60 seconds.");
}
function stopServer() {
  const child = server;
  const closing = netSuiteBroker?.close().catch(error => console.error("NetSuite broker close failed:", error.message));
  netSuiteBroker = undefined;
  const stopped = child && new Promise((resolve) => {
    // The stdin pipe can fail to signal EOF on Windows. Wait for the actual
    // exit so a relaunched desktop cannot attach to its previous server.
    const timeout = setTimeout(() => child.kill(), 2500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.stdin.end();
  });
  return Promise.all([closing, stopped]);
}

function secure() {
  const sites = session.fromPartition(BROWSER_PARTITION);
  // Pages see a plain Chrome user agent: CDNs such as Akamai (NetSuite)
  // answer "Access Denied" to one naming Electron or this app.
  sites.setUserAgent(
    app.userAgentFallback
      .replace(/ Electron\/\S+/, "")
      .replace(new RegExp(` ${app.getName()}\\/\\S+`, "i"), ""),
  );
  // Google's sign-in refuses embedded Chromium ("This browser or app may not
  // be secure") even with the plain Chrome agent above: it also reads the
  // Chromium brand hints. Its sign-in pages alone see a Firefox agent and
  // no brand hints, in requests and in the page; other sites are unchanged.
  const siteAgent = sites.getUserAgent();
  sites.webRequest.onBeforeSendHeaders({ urls: ["https://accounts.google.com/*"] }, (details, done) => {
    const requestHeaders = { ...details.requestHeaders, "User-Agent": GOOGLE_SIGN_IN_AGENT };
    for (const name of Object.keys(requestHeaders))
      if (/^sec-ch-ua/i.test(name)) delete requestHeaders[name];
    done({ requestHeaders });
  });
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview" || contents.session !== sites) return;
    const agentFor = (url) => (googleSignIn(url) ? GOOGLE_SIGN_IN_AGENT : siteAgent);
    const follow = (url) => {
      const agent = agentFor(url);
      if (!contents.isDestroyed() && contents.getUserAgent() !== agent) contents.setUserAgent(agent);
    };
    contents.on("will-navigate", (_e, url) => follow(url));
    contents.on("will-redirect", (event) => { if (event.isMainFrame) follow(event.url); });
    contents.on("did-start-navigation", (event) => { if (event.isMainFrame && !event.isSameDocument) follow(event.url); });
  });
  // Websites get no camera, microphone, location or notifications.
  sites.setPermissionRequestHandler((_contents, permission, done) =>
    done(["fullscreen", "clipboard-sanitized-write"].includes(permission)),
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, done, details) =>
    done(
      isOrvane(contents.getURL()) &&
        (permission === "clipboard-sanitized-write" ||
          // Right-click paste in the Terminal app; Orvane's own page only,
          // never a frame inside it (code apps).
          (permission === "clipboard-read" && details?.isMainFrame === true && isOrvane(details.requestingUrl || ""))),
    ),
  );

  const processing = setupProcessing({ partition: sites, isOrvane });
  const sessions = createNetSuiteSessionTracker();
  const netSuiteService = setupNetSuite(isOrvane, sites, processing, { sessionEpoch: sessions.current });

  // Saved logins: offered on sign-in forms, saved after a sign-in works.
  const trackPasswords = setupPasswords({
    ownGuest,
    partition: BROWSER_PARTITION,
    isOrvane,
    isProcessing: processing.owns,
    folder: app.getPath("userData"),
  });
  processing.onSignInReset(trackPasswords.resetAutoLogin);
  // Page alert/confirm/prompt as Orvane cards instead of native popups.
  setupPageDialogs({ partition: BROWSER_PARTITION, isProcessing: processing.owns });
  ipcMain.handle("orvane:browser-netsuite-environments", (event, id) => {
    const guest = ownGuest(event, id);
    if (!guest || guest.session !== sites || event.senderFrame?.parent || !isOrvane(event.senderFrame?.url ?? ""))
      throw Error("Browser tab is unavailable.");
    return browserEnvironments(sites, guest.getURL());
  });
  ipcMain.handle("orvane:clip-reload", (event, id, url) => {
    const guest = ownGuest(event, id);
    if (!guest || event.senderFrame?.parent || !isOrvane(event.senderFrame?.url ?? "") ||
        guest.session !== sites || typeof url !== "string" || !web(url) || isOrvane(url))
      throw Error("No such live page.");
    trackPasswords.resetAutoLogin(guest);
    return guest.loadURL(url);
  });
  desktopNetSuiteService = netSuiteService;

  app.on("web-contents-created", (_event, contents) => {
    if (contents.session === sites) trackPasswords(contents);
    if (contents.getType() === "webview" && isDevtoolsGuest(contents)) return;
    if (contents.getType() === "webview") {
      contents.on("before-input-event", (event, input) => {
        if (contents.hostWebContents === mainWindow?.webContents) fullScreenKey(event, input);
      });
      contents.on("before-mouse-event", (_event, input) => {
        // The AI's clicks (orvane:page-agent) are not the user clicking in
        // the page: they must not close the user's menus and panels.
        if (input.type === "mouseDown" && !agentInput.has(contents.id))
          contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, kind: "pointer-down" });
      });
      sessions.observe(contents);
      // Discovery follows the real Browser tab as login and navigation finish.
      // The host UI can update its environment list without a refresh button.
      let wasNetSuite = false, environmentHost;
      const notifyEnvironment = (url) => {
        let isNetSuite = false;
        try { const u = new URL(url); isNetSuite = u.protocol === "https:" && /^[a-z0-9-]+\.app\.netsuite\.com$/i.test(u.hostname); } catch {}
        environmentHost = contents.hostWebContents || environmentHost;
        if ((isNetSuite || wasNetSuite) && environmentHost && !environmentHost.isDestroyed()) environmentHost.send("orvane:processing-changed");
        wasNetSuite = isNetSuite;
      };
      contents.on("did-navigate", (_event, url) => notifyEnvironment(url));
      contents.on("did-navigate-in-page", (_event, url, isMainFrame) => { if (isMainFrame) notifyEnvironment(url); });
      contents.on("dom-ready", () => { notifyEnvironment(contents.getURL()); processing.sourceChanged(contents); });
      contents.on("destroyed", () => { if (wasNetSuite && environmentHost && !environmentHost.isDestroyed()) environmentHost.send("orvane:processing-changed"); });
      // Canvas zoom is handled by render density, never by site zoom, which
      // Chromium remembers per site and would leak into popups.
      contents.on("dom-ready", () => {
        if (contents.getZoomFactor() !== 1) contents.setZoomFactor(1);
      });
      // Canvas gestures over a page: Ctrl/Cmd+wheel zooms and middle-drag
      // pans the canvas, as everywhere else in Orvane; hover, scroll and
      // clicks stay with the page. A small listener runs in an isolated world
      // (invisible to page scripts) and reports through console messages
      // that only this process reads.
      // Electron runs isolated-world scripts only once the page has finished
      // loading, which streaming sites (YouTube…) can put off for minutes:
      // their shortcuts and gestures would not work until then. A page still
      // loading shortly after its document is ready gets the listener in its
      // main world instead (as iframes do below), once per document.
      let pendingGestures;
      contents.on("dom-ready", () => {
        pendingGestures?.();
        mainWorldGuests.delete(contents.id);
        let done = false;
        const pinned = `window.__orvanePinned = ${pinnedGuests.has(contents.id)};`;
        const isolated = () => {
          if (done || contents.isDestroyed()) return;
          done = true;
          pendingGestures?.();
          contents
            .executeJavaScriptInIsolatedWorld(CANVAS_WORLD, [{ code: pinned }, { code: CANVAS_GESTURES }])
            .catch(() => undefined);
        };
        if (!contents.isLoadingMainFrame()) return isolated();
        const timer = setTimeout(() => {
          if (done || contents.isDestroyed()) return;
          done = true;
          pendingGestures?.();
          mainWorldGuests.add(contents.id);
          contents.mainFrame.executeJavaScript(pinned + CANVAS_GESTURES).catch(() => undefined);
        }, 1500);
        contents.once("did-stop-loading", isolated);
        pendingGestures = () => {
          pendingGestures = undefined;
          clearTimeout(timer);
          contents.off("did-stop-loading", isolated);
        };
      });
      contents.on("destroyed", () => {
        pinnedGuests.delete(contents.id);
        mainWorldGuests.delete(contents.id);
      });
      // Iframes (NetSuite's Setup Manager…) get their own input, so they need
      // the listener too; Electron can only run it in their main world there.
      contents.on("did-frame-finish-load", (_event, isMainFrame, processId, routingId) => {
        if (isMainFrame) return;
        webFrameMain
          .fromId(processId, routingId)
          ?.executeJavaScript(CANVAS_GESTURES)
          .catch(() => undefined);
      });
      // Middle-drag: the page's own coordinates shift as it moves with the
      // canvas, so follow the real cursor instead until the button is released.
      let panTimer, panFrom, panIdle = 0;
      const stopPan = () => {
        clearInterval(panTimer);
        panTimer = undefined;
      };
      const startPan = () => {
        stopPan();
        panFrom = screen.getCursorScreenPoint();
        panIdle = 0;
        panTimer = setInterval(() => {
          const host = contents.hostWebContents;
          if (!host || host.isDestroyed()) return stopPan();
          const point = screen.getCursorScreenPoint();
          const dx = point.x - panFrom.x,
            dy = point.y - panFrom.y;
          // Safety stop if a release was missed (about 10 s without motion).
          if (!dx && !dy) return ++panIdle > 1200 && stopPan();
          panIdle = 0;
          panFrom = point;
          host.send("orvane:guest-input", { from: contents.id, kind: "pan", dx, dy });
        }, 8);
      };
      contents.on("destroyed", stopPan);
      contents.on("console-message", (details, ...legacy) => {
        const message = typeof details?.message === "string" ? details.message : legacy[1];
        if (typeof message !== "string" || !message.startsWith(CANVAS_PREFIX)) return;
        let input;
        try {
          input = JSON.parse(message.slice(CANVAS_PREFIX.length));
        } catch {
          return;
        }
        if (input?.kind === "pan-start") return startPan();
        if (input?.kind === "pan-end") return stopPan();
        if (input?.kind === "focus")
          return void contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, kind: "focus" });
        if (input?.kind === "peek" || input?.kind === "split") {
          if (typeof input.url === "string" && web(input.url) && !isOrvane(input.url))
            contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, kind: input.kind, url: input.url });
          return;
        }
        if (input?.kind === "key") {
          if (typeof input.name === "string" && /^(?:[a-z-]{1,16}|tab-[1-9])$/.test(input.name))
            contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, kind: "key", name: input.name });
          return;
        }
        const finite = (...values) => values.every((v) => Number.isFinite(v) && Math.abs(v) < 1e5);
        if (input?.kind !== "zoom" || !finite(input.x, input.y, input.deltaY)) return;
        let relay = { kind: "zoom", x: input.x, y: input.y, deltaY: input.deltaY };
        // Inside an iframe the position is the iframe's own: use the real
        // cursor in Orvane's window instead.
        if (details?.frame?.parent) {
          const host = contents.hostWebContents;
          const window = host && BrowserWindow.fromWebContents(host);
          if (!window) return;
          const bounds = window.getContentBounds();
          const point = screen.getCursorScreenPoint();
          relay = {
            kind: "zoom",
            clientX: point.x - bounds.x,
            clientY: point.y - bounds.y,
            deltaY: input.deltaY,
          };
        }
        if (relay) contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, ...relay });
      });
      // Electron does not provide Chrome's page context menu automatically.
      contents.on("context-menu", (_event, params) => {
        const items = [];
        if (web(params.linkURL) && !isOrvane(params.linkURL)) items.push(
          { label: "Open link in Peek View", click: () => contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, kind: "peek", url: params.linkURL }) },
          { label: "Open link as Split", click: () => contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, kind: "split", url: params.linkURL }) },
          { label: "Open link in new tab", click: () => contents.hostWebContents?.send("orvane:open-tab", { from: contents.id, url: params.linkURL, background: true }) },
          { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
          { label: "Save link as…", click: () => contents.downloadURL(params.linkURL) },
          { type: "separator" },
        );
        // Images, video and audio get the usual browser items.
        const media = { image: "image", video: "video", audio: "audio" }[params.mediaType];
        if (media && web(params.srcURL) && !isOrvane(params.srcURL)) items.push(
          { label: `Open ${media} in new tab`, click: () => contents.hostWebContents?.send("orvane:open-tab", { from: contents.id, url: params.srcURL, background: true }) },
          { label: `Save ${media} as…`, click: () => contents.downloadURL(params.srcURL) },
          ...(media === "image" ? [{ label: "Copy image", click: () => contents.copyImageAt(params.x, params.y) }] : []),
          { label: `Copy ${media} address`, click: () => clipboard.writeText(params.srcURL) },
          { type: "separator" },
        );
        if (params.isEditable) items.push(
          { label: "Undo", enabled: params.editFlags.canUndo, click: () => contents.undo() },
          { label: "Redo", enabled: params.editFlags.canRedo, click: () => contents.redo() },
          { type: "separator" },
          { label: "Cut", enabled: params.editFlags.canCut, click: () => contents.cut() },
          { label: "Copy", enabled: params.editFlags.canCopy, click: () => contents.copy() },
          { label: "Paste", enabled: params.editFlags.canPaste, click: () => contents.paste() },
          { label: "Select all", enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
        );
        else if (params.selectionText) items.push({ label: "Copy", enabled: params.editFlags.canCopy, click: () => contents.copy() });
        else items.push(
          { label: "Back", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
          { label: "Forward", enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
          { label: "Reload", click: () => contents.reload() },
        );
        items.push(
          { type: "separator" },
          { label: "Inspect", click: () => {
            if (contents.isDestroyed()) return;
            // The Browser app docks DevTools under the page, like a browser.
            const host = contents.hostWebContents;
            if (host && !host.isDestroyed())
              host.send("orvane:guest-input", { from: contents.id, kind: "inspect", x: params.x, y: params.y });
            else contents.inspectElement(params.x, params.y);
          } },
        );
        Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents.hostWebContents) || undefined });
      });
      let googleHandoffAt = -Infinity;
      function openGoogleSignIn(url) {
        try {
          const target = new URL(url);
          if (target.origin !== "https://accounts.google.com" ||
              !/^\/(?:o\/oauth2|signin\/oauth|gsi\/(?:select|transform))(?:\/|$)/i.test(target.pathname)) return false;
          const current = contents.getURL();
          const destination = web(current) && !isOrvane(current) && new URL(current).origin !== target.origin ? current : url;
          if (Date.now() - googleHandoffAt > 3000 && mainWindow?.isVisible() && !mainWindow.isMinimized()) {
            googleHandoffAt = Date.now();
            void shell.openExternal(destination).catch(() => undefined);
          }
          contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, kind: "key", name: "google-sign-in" });
          return true;
        } catch {
          return false;
        }
      }
      contents.on("will-navigate", (event, url) => {
        if (openGoogleSignIn(url)) return event.preventDefault();
        if (!web(url) || isOrvane(url)) event.preventDefault();
      });
      contents.on("will-redirect", (event) => {
        if (event.isMainFrame && openGoogleSignIn(event.url)) event.preventDefault();
      });
      let popupGestureAt = -Infinity;
      contents.on("before-mouse-event", (_event, input) => {
        if (input.type === "mouseDown" && input.button === "left") popupGestureAt = Date.now();
      });
      contents.on("before-input-event", (_event, input) => {
        if (input.type === "keyDown" && ["Enter", " "].includes(input.key)) popupGestureAt = Date.now();
      });
      const hasPopupGesture = () => Date.now() - popupGestureAt < 1500;
      contents.setWindowOpenHandler(({ url, disposition }) => {
        if (!web(url) || isOrvane(url)) return { action: "deny" };
        if (openGoogleSignIn(url)) return { action: "deny" };
        // window.open popups (NetSuite selectors, sign-in flows) keep their
        // opener; links meant for a new tab open as a Browser tab instead.
        if (disposition === "new-window") {
          if (contents.hostWebContents !== mainWindow?.webContents ||
              !workspaceAllowsPopups() ||
              (netSuiteLogin(url) && !hasPopupGesture())) {
            return { action: "deny" };
          }
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              webPreferences: {
                partition: BROWSER_PARTITION,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
              },
            },
          };
        }
        contents.hostWebContents?.send("orvane:open-tab", {
          from: contents.id,
          url,
          background: disposition === "background-tab",
        });
        return { action: "deny" };
      });
      contents.on("did-create-window", (popup) => {
        trackBrowserPopup(popup);
        const authorized = hasPopupGesture();
        const handleNavigation = (event, url) => {
          if (!openGoogleSignIn(url) && (authorized || !netSuiteLogin(url))) return;
          event.preventDefault();
          if (!popup.isDestroyed()) popup.close();
        };
        popup.webContents.on("will-navigate", handleNavigation);
        popup.webContents.on("will-redirect", (event) => {
          if (event.isMainFrame) handleNavigation(event, event.url);
        });
      });
      return;
    }
    if (contents.getType() !== "window") return;
    contents.on("will-attach-webview", (event, preferences, params) => {
      // Guests never get Node, a preload or Orvane's own session.
      delete preferences.preload;
      preferences.nodeIntegration = false;
      preferences.nodeIntegrationInSubFrames = false;
      preferences.contextIsolation = true;
      preferences.sandbox = true;
      if (params.src === DEVTOOLS_SRC) {
        // The element's partition attribute decides the session; enforce it.
        preferences.partition = DEVTOOLS_PARTITION;
        return;
      }
      params.partition = BROWSER_PARTITION;
      if (!web(params.src) || isOrvane(params.src)) event.preventDefault();
    });
  });
}

// The canvas scales apps with a CSS transform; a page rendered at normal
// density would be stretched and blurry. Orvane asks for its own webviews to
// render at the on-screen density instead (per page, unlike site zoom, so
// popups and layout are unaffected).
// Scripts the window runs in its own Browser pages (live clips). Unlike
// <webview>.executeJavaScript, the main frame runs them at once: a page can
// stay "loading" for minutes (streaming sites), which would hold them back.
ipcMain.handle("orvane:page-run", async (event, id, code) => {
  const guest = ownGuest(event, id);
  if (!guest || typeof code !== "string" || code.length > 100_000) throw Error("No such page.");
  return guest.mainFrame.executeJavaScript(code, false);
});
// A web image pasted or dropped on the canvas by address only: the local
// server downloads it without any sign-in, so a picture behind a login
// fails there. Fetch it again with the Browser's cookies (the user's
// sign-ins in Orvane's Browser). Returns a data URL, or "" when refused.
ipcMain.handle("orvane:browser-image", async (_event, url) => {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return "";
  }
  if (!/^https?:$/.test(parsed.protocol)) return "";
  try {
    const response = await session.fromPartition(BROWSER_PARTITION).fetch(parsed.href, {
      signal: AbortSignal.timeout(15_000),
    });
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!response.ok || !type.startsWith("image/")) return "";
    if (Number(response.headers.get("content-length")) > 30 * 1024 * 1024) return "";
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 30 * 1024 * 1024) return "";
    return `data:${type};base64,${data.toString("base64")}`;
  } catch {
    return "";
  }
});
// AI control of a Browser page: real (trusted) input like Playwright's, not
// synthetic DOM events, plus a picture of what is on screen. Coordinates are
// CSS pixels of the page's viewport.
const AGENT_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Insert",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
function pageAgentMouse(guest, op) {
  const zoom = guest.getZoomFactor() || 1;
  const point = (n) => {
    if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e5) throw Error("Bad coordinate.");
    return Math.round(n * zoom);
  };
  const x = point(op.x), y = point(op.y);
  const button = op.button === "right" ? "right" : op.button === "middle" ? "middle" : "left";
  guest.sendInputEvent({ type: "mouseMove", x, y });
  if (op.action === "move") return true;
  const clicks = op.action === "double" ? 2 : 1;
  for (let clickCount = 1; clickCount <= clicks; clickCount++) {
    guest.sendInputEvent({ type: "mouseDown", x, y, button, clickCount });
    guest.sendInputEvent({ type: "mouseUp", x, y, button, clickCount });
  }
  return true;
}
/** Guests receiving AI input right now (see before-mouse-event). */
const agentInput = new Set();
function agentDeadline(ms, cap) {
  return Number.isFinite(ms) ? Math.max(1, Math.min(ms, cap)) : cap;
}
function navigateAgentPage(guest, op) {
  const history = guest.navigationHistory;
  const page = () => ({ page: { url: guest.getURL(), title: guest.getTitle() } });
  if ((op.action === "back" && !history.canGoBack()) ||
      (op.action === "forward" && !history.canGoForward())) return page();
  let requested;
  if (op.action === "url") {
    if (typeof op.url !== "string" || !web(op.url)) throw Error("Enter an http or https address.");
    const destination = new URL(op.url);
    if (isOrvane(destination.href) ||
        (["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname) && destination.port === String(port)))
      throw Error("Orvane itself can't be opened inside its own browser.");
    requested = destination.href;
  } else if (!["back", "forward", "reload"].includes(op.action)) {
    throw Error("Unknown navigation action.");
  }
  return new Promise((resolve) => {
    let started;
    let done = false;
    const timer = setTimeout(() => finish({ error: "Navigation did not commit in time. Check the tab before retrying." }), agentDeadline(op.timeoutMs, 8000));
    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      guest.removeListener("did-start-navigation", start);
      guest.removeListener("did-navigate", commit);
      guest.removeListener("did-navigate-in-page", inPage);
      guest.removeListener("did-fail-provisional-load", fail);
      guest.removeListener("destroyed", destroyed);
      resolve(result);
    }
    function start({ url, isMainFrame }) {
      if (!isMainFrame) return;
      if (started) return finish({ error: "Navigation was canceled by another navigation." });
      if (!requested || url === requested) started = url;
    }
    function commit() {
      if (started) finish(page());
    }
    function inPage(_event, url, isMainFrame) {
      if (isMainFrame && (started || url === requested)) finish(page());
    }
    function fail(_event, code, description, url, isMainFrame) {
      if (!isMainFrame || (code === -3 && (!started || url !== started))) return;
      finish({ error: code === -3 ? "Navigation was canceled." : `Navigation failed (${description || code}).` });
    }
    function destroyed() {
      finish({ error: "The page closed before navigation committed." });
    }
    guest.on("did-start-navigation", start);
    guest.on("did-navigate", commit);
    guest.on("did-navigate-in-page", inPage);
    if (!requested) guest.on("did-fail-provisional-load", fail);
    guest.once("destroyed", destroyed);
    try {
      if (requested) {
        void guest.loadURL(requested).catch((error) => finish({
          error: error.code === "ERR_ABORTED" ? "Navigation was canceled." : `Navigation failed (${error.code || error.message}).`,
        }));
      } else if (op.action === "back") history.goBack();
      else if (op.action === "forward") history.goForward();
      else guest.reload();
    } catch (error) {
      finish({ error: `Navigation failed (${error.message}).` });
    }
  });
}
async function captureAgentPage(guest, op) {
  let timer;
  try {
    const image = await Promise.race([
      guest.capturePage(),
      new Promise((resolve) => { timer = setTimeout(resolve, agentDeadline(op.timeoutMs, 1800)); }),
    ]);
    if (!image) return { screenshotWarning: "Screenshot capture timed out." };
    if (image.isEmpty()) return { screenshotWarning: "The page has no rendered image yet." };
    const { width } = image.getSize();
    const scaled = width > 1280 ? image.resize({ width: 1280 }) : image;
    return { image: scaled.toJPEG(70).toString("base64") };
  } catch {
    return { screenshotWarning: "The Browser could not capture the page image." };
  } finally {
    clearTimeout(timer);
  }
}
/** Real-time page recordings for browser_record, made on first use. */
let pageRecorder;
ipcMain.handle("orvane:page-agent", async (event, id, op) => {
  const guest = ownGuest(event, id);
  if (!guest || !op || typeof op !== "object") throw Error("No such page.");
  if (op.type === "mouse") {
    agentInput.add(guest.id);
    try {
      return pageAgentMouse(guest, op);
    } finally {
      agentInput.delete(guest.id);
    }
  }
  const zoom = guest.getZoomFactor() || 1;
  const point = (n) => {
    if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e5) throw Error("Bad coordinate.");
    return Math.round(n * zoom);
  };
  switch (op.type) {
    case "wheel": {
      guest.sendInputEvent({
        type: "mouseWheel", x: point(op.x), y: point(op.y),
        deltaX: -Number(op.dx || 0), deltaY: -Number(op.dy || 0), canScroll: true,
      });
      return true;
    }
    case "text": {
      if (typeof op.text !== "string" || op.text.length > 20_000) throw Error("Bad text.");
      await guest.insertText(op.text);
      return true;
    }
    case "key": {
      // "Enter", "a", "Control+a", "Shift+Tab"…
      if (typeof op.key !== "string" || op.key.length > 40) throw Error("Bad key.");
      const parts = op.key.split("+");
      const name = parts.pop();
      const modifiers = parts.map((m) => m.toLowerCase())
        .map((m) => (m === "ctrl" || m === "control" ? "control" : m === "cmd" || m === "meta" ? "meta" : m));
      if (!name || modifiers.some((m) => !["control", "shift", "alt", "meta"].includes(m)))
        throw Error(`Unknown key ${op.key}.`);
      const keyCode = name === "Space" ? "Space" : AGENT_KEYS.has(name) ? name : name.length === 1 ? name : "";
      if (!keyCode) throw Error(`Unknown key ${op.key}.`);
      guest.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      if (name.length === 1 || name === "Space" || name === "Enter")
        if (!modifiers.some((m) => m !== "shift"))
          guest.sendInputEvent({ type: "char", keyCode: name === "Space" ? " " : name === "Enter" ? "\r" : name, modifiers });
      guest.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      return true;
    }
    case "screenshot":
      return captureAgentPage(guest, op);
    case "record-start":
    case "record-status":
    case "record-stop":
      pageRecorder ??= setupPageRecorder({ folder: app.getPath("userData"), isPaused: (id) => pausedGuests.has(id) });
      return pageRecorder.handle(guest, op);
    case "navigate":
      return navigateAgentPage(guest, op);
    default:
      throw Error("Unknown page action.");
  }
});
ipcMain.handle("orvane:page-density", (event, id, density) => {
  const guest = ownGuest(event, id);
  if (!guest || typeof density !== "number" || !Number.isFinite(density))
    return;
  guest.enableDeviceEmulation({
    screenPosition: "desktop",
    screenSize: { width: 0, height: 0 },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: Math.min(8, Math.max(0.5, density)),
    viewSize: { width: 0, height: 0 },
    scale: 1,
  });
});

// Which monitor Orvane opens on, and whether it opens full screen. Kept in
// the profile folder (the monitor by its display id). If that monitor is
// not connected, Orvane opens on the monitor in use (the one under the
// mouse) and keeps the choice for when it returns.
const windowSettings = () => join(app.getPath("userData"), "window.json");
function readWindowSettings() {
  try {
    const value = JSON.parse(readFileSync(windowSettings(), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function saveWindowSettings(patch) {
  try {
    writeFileSync(windowSettings(), JSON.stringify({ ...readWindowSettings(), ...patch }));
  } catch {
    // The window still changes; the choice just is not remembered.
  }
}
function chosenDisplayId() {
  const id = readWindowSettings().displayId;
  return typeof id === "number" ? id : undefined;
}
function chosenDisplay() {
  const id = chosenDisplayId();
  return (
    screen.getAllDisplays().find((display) => display.id === id) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  );
}
const openFullScreen = () => readWindowSettings().fullScreen === true;
function setFullScreen(window, on) {
  window.setFullScreen(on);
  saveWindowSettings({ fullScreen: on });
  window.webContents.send("orvane:window-fullscreen", on);
}
function normalWindowBounds(display, size = { width: 1440, height: 900 }) {
  const area = display.workArea;
  const width = Math.min(size.width, Math.max(800, area.width - 64));
  const height = Math.min(size.height, Math.max(560, area.height - 64));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}
function placeOn(window, display) {
  const fullScreen = window.isFullScreen();
  const maximized = window.isMaximized() || fullScreen;
  const bounds = normalWindowBounds(display, window.getNormalBounds());
  if (fullScreen) window.setFullScreen(false);
  if (window.isMaximized()) window.unmaximize();
  window.setBounds(bounds);
  if (fullScreen) window.setFullScreen(true);
  else if (maximized) window.maximize();
}
function workspaceWindow(event) {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
      event.senderFrame === event.sender.mainFrame && isOrvane(event.senderFrame?.url || "")) {
    return mainWindow;
  }
}
ipcMain.handle("orvane:displays", (event) => {
  if (!isOrvane(event.senderFrame?.url || "")) return [];
  const chosen = chosenDisplayId();
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: `${display.label || `Monitor ${index + 1}`} · ${display.size.width}×${display.size.height}${display.id === primary ? " · primary" : ""}`,
    chosen: display.id === chosen,
  }));
});
ipcMain.handle("orvane:display-set", (event, id) => {
  const window = workspaceWindow(event);
  if (!window) return false;
  const display = screen.getAllDisplays().find((item) => item.id === id);
  if (!display) return false;
  saveWindowSettings({ displayId: display.id });
  placeOn(window, display);
  return true;
});
ipcMain.handle("orvane:window-fullscreen", (event) => workspaceWindow(event)?.isFullScreen() ?? false);
ipcMain.handle("orvane:window-fullscreen-set", (event, on) => {
  const window = workspaceWindow(event);
  if (!window || typeof on !== "boolean") return false;
  setFullScreen(window, on);
  return true;
});

// Pinned Browser pages preview links that leave their site (see
// CANVAS_GESTURES); the flag lives in the isolated world, unseen by the page.
const pinnedGuests = new Set();
/** Pages whose current document got the listener in its main world. */
const mainWorldGuests = new Set();
ipcMain.handle("orvane:page-pinned", (event, id, pinned) => {
  const guest = ownGuest(event, id);
  if (!guest || typeof pinned !== "boolean") return;
  if (pinned) pinnedGuests.add(guest.id);
  else pinnedGuests.delete(guest.id);
  const code = `window.__orvanePinned = ${pinned};`;
  (mainWorldGuests.has(guest.id)
    ? guest.mainFrame.executeJavaScript(code)
    : guest.executeJavaScriptInIsolatedWorld(CANVAS_WORLD, [{ code }])
  ).catch(() => undefined);
});

// A picture of a Browser page as a PNG data URL, for Orvane to copy: what
// is visible, an area of it, or the whole page (through a short debugger
// session, skipped when the page is paused or another debugger owns it).
ipcMain.handle("orvane:page-capture", async (event, id, mode, rect) => {
  const guest = ownGuest(event, id);
  if (!guest) return "";
  let image;
  try {
    if (mode === "full" && !guest.debugger.isAttached()) {
      guest.debugger.attach("1.3");
      try {
        const { cssContentSize: size } = await guest.debugger.sendCommand("Page.getLayoutMetrics", {});
        const { data } = await guest.debugger.sendCommand("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.min(size.width, 8000), height: Math.min(size.height, 16000), scale: 1 },
        });
        image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
      } finally {
        try { guest.debugger.detach(); } catch {}
      }
    } else {
      const area =
        mode === "area" && rect && [rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n) && n >= 0 && n < 1e5) && rect.width >= 2 && rect.height >= 2
          ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          : undefined;
      // An explicit undefined is rejected as a rectangle.
      image = await (area ? guest.capturePage(area) : guest.capturePage());
    }
  } catch {
    return "";
  }
  return !image || image.isEmpty() ? "" : image.toDataURL();
});

ipcMain.handle("orvane:page-clip", async (event, id, url, rect, fromViewport) => {
  const guest = ownGuest(event, id);
  if (!guest || typeof url !== "string" || !web(url) || guest.getURL() !== url)
    throw Error("Open the clip’s original page in Orvane Browser.");
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n) && n >= 0) ||
      rect.width < 4 || rect.height < 4 || rect.width > 4096 || rect.height > 4096)
    throw Error("Choose a page area between 4 and 4096 pixels per side.");
  if (guest.debugger.isAttached()) throw Error("Close the page debugger before capturing a clip.");
  guest.debugger.attach("1.3");
  try {
    const { cssVisualViewport: viewport, cssContentSize: content } = await guest.debugger.sendCommand("Page.getLayoutMetrics");
    const unit = fromViewport ? guest.getZoomFactor() : 1;
    const x = Math.round(rect.x / unit + (fromViewport ? viewport.pageX : 0));
    const y = Math.round(rect.y / unit + (fromViewport ? viewport.pageY : 0));
    const width = Math.min(Math.round(rect.width / unit), Math.floor(content.width - x));
    const height = Math.min(Math.round(rect.height / unit), Math.floor(content.height - y));
    if (width < 4 || height < 4) throw Error("The selected area is outside the page.");
    const clip = { x, y, width, height };
    const { data } = await guest.debugger.sendCommand("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 },
    });
    if (guest.getURL() !== url || !data) throw Error("The page changed while capturing.");
    return { image: `data:image/png;base64,${data}`, rect: clip };
  } finally {
    if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach();
  }
});

// The close button in Orvane's top bar. Only Orvane's own window may ask,
// and closing goes through the unsaved-changes guard in createWindow.
// Calendar reminders. Kept referenced until clicked or closed, so the click
// still arrives.
const shownNotifications = new Set();
ipcMain.handle("orvane:notify", (event, data) => {
  if (!isOrvane(event.senderFrame?.url || "") || !Notification.isSupported()) return;
  const notification = new Notification({
    title: String(data?.title ?? "Reminder").slice(0, 120),
    body: String(data?.body ?? "").slice(0, 240),
    icon: join(root, "public/favicon.ico"),
  });
  const appId = String(data?.appId ?? "");
  const forget = () => shownNotifications.delete(notification);
  notification.on("click", () => {
    forget();
    showWindow();
    if (!event.sender.isDestroyed()) event.sender.send("orvane:notification-click", appId);
  });
  notification.on("close", forget);
  shownNotifications.add(notification);
  notification.show();
});
// Agent sessions: Windows does not sleep while a turn runs. The screen can
// still turn off and lock.
let keepAwakeId = -1;
let hostAwakeId = -1;
let hostAwakeTimer;
function monitorHostAwake() {
  async function check() {
    if (quitting) return;
    let awake = false;
    try {
      const response = await fetch(`${origin}/__orvane/agents/host-awake`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(1000),
      });
      awake = response.ok && (await response.json()).keepAwake === true;
    } catch {
      // A stopped local server cannot be hosting.
    }
    if (quitting) return;
    if (awake && hostAwakeId < 0) hostAwakeId = powerSaveBlocker.start("prevent-app-suspension");
    else if (!awake && hostAwakeId >= 0) {
      powerSaveBlocker.stop(hostAwakeId);
      hostAwakeId = -1;
    }
    hostAwakeTimer = setTimeout(check, 2500);
    hostAwakeTimer.unref();
  }
  void check();
}
ipcMain.handle("orvane:keep-awake", (event, on) => {
  if (!isOrvane(event.senderFrame?.url || "")) return false;
  if (on && keepAwakeId < 0) keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
  else if (!on && keepAwakeId >= 0) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = -1;
  }
  return keepAwakeId >= 0 && powerSaveBlocker.isStarted(keepAwakeId);
});
app.on("will-quit", () => {
  if (keepAwakeId >= 0) powerSaveBlocker.stop(keepAwakeId);
  clearTimeout(hostAwakeTimer);
  if (hostAwakeId >= 0) powerSaveBlocker.stop(hostAwakeId);
});
// A picture of part of Orvane's own window (an app on the canvas), for an
// agent snapshot. Browser pages use orvane:page-capture instead.
ipcMain.handle("orvane:window-capture", async (event, rect) => {
  if (!isOrvane(event.senderFrame?.url || "")) return "";
  const area = rect && ["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key]))
    ? {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      }
    : undefined;
  const image = await (area ? event.sender.capturePage(area) : event.sender.capturePage());
  return image.isEmpty() ? "" : image.toDataURL();
});
ipcMain.handle("orvane:window-close", (event) => {
  workspaceWindow(event)?.close();
});
ipcMain.handle("orvane:window-maximized", (event) => workspaceWindow(event)?.isMaximized() ?? false);
ipcMain.handle("orvane:window-toggle-maximize", (event) => {
  const window = workspaceWindow(event);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});

// Once a maximized Windows window is grabbed, restore it under the cursor.
// Electron's native draggable region takes over again on the next press.
let windowDrag;
ipcMain.on("orvane:window-drag", (event, phase) => {
  const window = workspaceWindow(event);
  if (!window || process.platform !== "win32") return;
  if (phase === "end") {
    windowDrag = undefined;
  } else if (phase === "start" && window.isMaximized()) {
    const start = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    windowDrag = { start, bounds, normal: window.getNormalBounds(), restored: false };
  } else if (phase === "move" && windowDrag) {
    const { start, bounds, normal, restored } = windowDrag;
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - start.x, dy = cursor.y - start.y;
    if (!restored && Math.hypot(dx, dy) < 5) return;
    const x = bounds.x + dx, y = bounds.y + dy;
    if (restored) window.setPosition(x, y);
    else {
      windowDrag.restored = true;
      window.unmaximize();
      window.setBounds({ ...normal, x, y });
    }
  }
});
ipcMain.handle("orvane:inbox-clipboard", (event) => {
  if (
    event.sender.getType() !== "window" ||
    event.senderFrame !== event.sender.mainFrame ||
    !isOrvane(event.senderFrame?.url || "")
  ) return null;
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const png = image.toPNG();
    if (png.length > 30_000_000) throw Error("Clipboard images can be up to 30 MB.");
    return { kind: "image", value: `data:image/png;base64,${png.toString("base64")}` };
  }
  const text = clipboard.readText().trim();
  return text ? { kind: "text", value: text } : null;
});

// Docked DevTools follow Orvane's light palette instead of the system's dark
// mode: the frontend is told it runs in a light scheme, and its colour tokens
// and scrollbars are set to Orvane's.
const DEVTOOLS_CSS = `:root, :root.theme-with-dark-background {
  --sys-color-cdt-base: #f1f5f8 !important;
  --sys-color-cdt-base-container: #f7f9fa !important;
  --sys-color-surface: #f7f9fa !important;
  --sys-color-surface1: #f3f6f8 !important;
  --sys-color-surface2: #eef3f6 !important;
  --sys-color-surface3: #e9eff2 !important;
  --sys-color-surface4: #e4ebef !important;
  --sys-color-surface5: #dfe7ec !important;
  --sys-color-header-container: #eef3f6 !important;
  --sys-color-header-container-highlight: #e7eef2 !important;
  --sys-color-neutral-container: #e8eff3 !important;
  --sys-color-on-surface: #273f50 !important;
  --sys-color-on-surface-subtle: #5d7381 !important;
  --sys-color-token-subtle: #8296a2 !important;
  --sys-color-primary: #4f6c7c !important;
  --sys-color-primary-bright: #6f8998 !important;
  --sys-color-tonal-container: #dfe9ef !important;
  --sys-color-on-tonal-container: #273f50 !important;
  --sys-color-divider: #e3eaee !important;
  --sys-color-neutral-outline: #cfdbe2 !important;
  /* Hover and selection are drawn as layers over the content: keep them translucent. */
  --sys-color-state-hover-on-subtle: rgb(111 137 152 / 12%) !important;
  --sys-color-state-hover-on-prominent: rgb(255 255 255 / 12%) !important;
  --sys-color-state-ripple-primary: rgb(111 137 152 / 22%) !important;
  --sys-color-state-focus-select: rgb(111 137 152 / 22%) !important;
  --sys-color-state-on-header-hover: rgb(111 137 152 / 14%) !important;
  --sys-color-state-header-hover: #dfe9ef !important;
  --sys-color-tonal-outline: #b9cbd6 !important;
}
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
::-webkit-scrollbar-thumb { background: #bacbd5; border-radius: 3px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }`;
const themedDevtools = new WeakSet();
function themeDevtools(devtools) {
  if (themedDevtools.has(devtools)) return;
  themedDevtools.add(devtools);
  try {
    if (!devtools.debugger.isAttached()) devtools.debugger.attach("1.3");
    void devtools.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    }).catch(() => undefined);
  } catch {}
  devtools.on("dom-ready", () => void devtools.insertCSS(DEVTOOLS_CSS).catch(() => undefined));
}
// Docked DevTools: a Browser page's DevTools run in the DevTools <webview>
// the same Orvane window placed under it.
//
// Electron's setDevToolsWebContents() leaves DevTools rendered into a
// <webview> without its connection to the page (tested on Electron 44, 45
// and 46: the Elements panel stays empty). So Orvane connects them itself:
// the DevTools app is opened in remote mode (?ws=) against a WebSocket on
// 127.0.0.1, behind a random one-use token, that relays the DevTools
// protocol to the page through guest.debugger.
const devtoolsLinks = new Map(); // guest id -> link
let devtoolsServer;
function devtoolsBridge() {
  devtoolsServer ??= new Promise((resolve, reject) => {
    const http = createServer((_request, response) => response.writeHead(404).end());
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
    http.on("upgrade", (request, socket, head) => {
      const link = [...devtoolsLinks.values()].find((item) => request.url === "/" + item.token);
      // Only the DevTools app Orvane opened, once per token.
      if (!link || link.socket || request.headers.origin !== "devtools://devtools") return socket.destroy();
      sockets.handleUpgrade(request, socket, head, (ws) => connectDevtools(link, ws));
    });
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve(http.address().port));
  });
  return devtoolsServer;
}
function connectDevtools(link, ws) {
  const { guest } = link;
  if (guest.isDestroyed()) return ws.close();
  link.socket = ws;
  // The page shown in DevTools runs; a paused off-screen page resumes.
  resumeGuest(guest);
  try {
    if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
  } catch {
    return ws.close();
  }
  const send = (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
  const onMessage = (_event, method, params, sessionId) => send(sessionId ? { method, params, sessionId } : { method, params });
  const onDetach = () => ws.close();
  guest.debugger.on("message", onMessage);
  guest.debugger.on("detach", onDetach);
  link.detach = () => {
    guest.debugger.removeListener("message", onMessage);
    guest.debugger.removeListener("detach", onDetach);
  };
  let revealed = false;
  ws.on("message", async (data) => {
    let request;
    try { request = JSON.parse(String(data)); } catch { return; }
    const { id, method, params, sessionId } = request;
    const reply = sessionId ? { id, sessionId } : { id };
    try {
      const result = await guest.debugger.sendCommand(method, params ?? {}, sessionId);
      send({ ...reply, result: result ?? {} });
    } catch (error) {
      send({ ...reply, error: { code: -32000, message: String(error?.message ?? error) } });
    }
    // The page's document is in DevTools: show the element that was right-clicked.
    if (!revealed && method === "DOM.getDocument" && !sessionId) {
      revealed = true;
      void revealDevtoolsElement(link);
    }
  });
  ws.on("close", () => closeDevtoolsLink(guest.id));
}
async function revealDevtoolsElement(link) {
  const at = link.point;
  link.point = undefined;
  if (!at || !link.socket || link.guest.isDestroyed()) return;
  try {
    const zoom = link.guest.getZoomFactor() || 1;
    const { backendNodeId } = await link.guest.debugger.sendCommand("DOM.getNodeForLocation", {
      x: Math.round(at.x / zoom),
      y: Math.round(at.y / zoom),
      includeUserAgentShadowDOM: false,
    });
    if (backendNodeId && link.socket.readyState === link.socket.OPEN)
      link.socket.send(JSON.stringify({ method: "Overlay.inspectNodeRequested", params: { backendNodeId } }));
  } catch {}
}
function closeDevtoolsLink(guestId) {
  const link = devtoolsLinks.get(guestId);
  if (!link) return;
  devtoolsLinks.delete(guestId);
  link.detach?.();
  if (link.socket && link.socket.readyState <= link.socket.OPEN) link.socket.close();
  if (!link.guest.isDestroyed() && link.socket) {
    try { link.guest.debugger.detach(); } catch {}
  }
}
ipcMain.handle("orvane:page-devtools", async (event, id, devtoolsId, x, y) => {
  const guest = ownGuest(event, id);
  const devtools = typeof devtoolsId === "number" ? webContents.fromId(devtoolsId) : undefined;
  if (!guest || isDevtoolsGuest(guest) || !devtools || devtools.isDestroyed() ||
      devtools.getType() !== "webview" || devtools.hostWebContents !== event.sender || !isDevtoolsGuest(devtools)) return false;
  const point = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  const open = devtoolsLinks.get(guest.id);
  // Already docked there: only reveal the element.
  if (open && open.devtools === devtools) {
    open.point = point;
    void revealDevtoolsElement(open);
    return true;
  }
  closeDevtoolsLink(guest.id);
  // Another page's DevTools in the same view, or a page another debugger owns.
  for (const [other, link] of devtoolsLinks) if (link.devtools === devtools) closeDevtoolsLink(other);
  if (guest.debugger.isAttached() && !pausedGuests.has(guest.id)) return false;
  const port = await devtoolsBridge();
  const link = { guest, devtools, token: randomBytes(24).toString("hex"), point };
  devtoolsLinks.set(guest.id, link);
  const forget = () => { if (devtoolsLinks.get(guest.id) === link) closeDevtoolsLink(guest.id); };
  guest.once("destroyed", forget);
  devtools.once("destroyed", forget);
  themeDevtools(devtools);
  await devtools.loadURL(`devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:${port}/${link.token}`).catch(() => undefined);
  return true;
});
ipcMain.handle("orvane:page-devtools-close", (event, id) => {
  const guest = ownGuest(event, id);
  if (guest) closeDevtoolsLink(guest.id);
});

/** F11 toggles full screen (kept for next launch), also inside Browser pages. */
function fullScreenKey(event, input) {
  if (input.type !== "keyDown" || input.key !== "F11" || input.isAutoRepeat) return;
  if (input.control || input.alt || input.meta || input.shift) return;
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  event.preventDefault();
  setFullScreen(window, !window.isFullScreen());
}
/** A <webview> guest of the window that sent this IPC message, or nothing. */
function ownGuest(event, id) {
  const guest = typeof id === "number" ? webContents.fromId(id) : undefined;
  return guest &&
    !guest.isDestroyed() &&
    guest.getType() === "webview" &&
    guest.hostWebContents === event.sender
    ? guest
    : undefined;
}

// Off-screen pages. Electron keeps <webview> guests "visible" to Chromium
// whatever their CSS (display:none, visibility:hidden, off-screen) and
// ignores Page.setWebLifecycleState there, so they keep running
// requestAnimationFrame and repainting at 60 fps. What does stop them is
// pausing the page's JavaScript through the debugger: no rAF, no timers, no
// script-driven repaint until the page is shown again (like Chrome's tab
// freezing). Compositor-only animations (CSS, video) still run.
const pausedGuests = new Set();
async function pauseGuest(guest) {
  if (pausedGuests.has(guest.id)) return;
  const debug = guest.debugger;
  try {
    if (debug.isAttached()) return; // Do not take over someone else's debugger.
    debug.attach("1.3");
  } catch {
    return; // Another debugger owns the page; leave it running.
  }
  pausedGuests.add(guest.id);
  // Both listeners go once the pause ends either way; otherwise every
  // pause/resume cycle would leave one more on the page.
  const forget = () => {
    pausedGuests.delete(guest.id);
    debug.removeListener("detach", forget);
    if (!guest.isDestroyed()) guest.removeListener("destroyed", forget);
  };
  debug.once("detach", forget);
  guest.once("destroyed", forget);
  try {
    await debug.sendCommand("Debugger.enable", {});
    if (!pausedGuests.has(guest.id)) return;
    await debug.sendCommand("Debugger.pause", {});
  } catch {
    resumeGuest(guest);
  }
}
function resumeGuest(guest) {
  if (!pausedGuests.delete(guest.id) || guest.isDestroyed()) return;
  // Detaching ends the session, which resumes the page.
  try {
    guest.debugger.detach();
  } catch {
    // Already detached.
  }
}
ipcMain.handle("orvane:page-active", (event, id, active) => {
  const guest = ownGuest(event, id);
  if (!guest || typeof active !== "boolean") return;
  if (active) resumeGuest(guest);
  else return pauseGuest(guest);
});
// A new document (cross-site navigation) starts unpaused; keep it paused.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview" || isDevtoolsGuest(contents)) return;
  contents.on("dom-ready", () => {
    if (pausedGuests.has(contents.id))
      void contents.debugger.sendCommand("Debugger.pause", {}).catch(() => undefined);
  });
});

// Before a Browser tab is discarded: whether it holds edited form fields
// (main document only), and a picture of it to show until it is reloaded.
const EDITED_WORLD = 1988;
const EDITED_FIELDS = `(() => {
  // Embedded documents and rich editors can hold work we cannot inspect here.
  if (document.querySelector('iframe, frame, [contenteditable]:not([contenteditable="false"])')) return true;
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (el instanceof HTMLSelectElement) {
      if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
    } else if (el.type === "checkbox" || el.type === "radio") {
      if (el.checked !== el.defaultChecked) return true;
    } else if (el.type === "file" && el.files?.length) return true;
    else if (!["hidden", "submit", "button", "reset", "image", "file"].includes(el.type) && el.value !== el.defaultValue) return true;
  }
  return false;
})()`;
// Pictures of pages taken while on screen (Chromium draws no new frame for
// an off-screen or hidden page, so one can't be captured when discarding).
const pictures = new Map();
ipcMain.handle("orvane:page-remember", async (event, id) => {
  const guest = ownGuest(event, id);
  if (!guest) return;
  let timer;
  try {
    let image = await Promise.race([
      guest.capturePage(),
      new Promise((done) => (timer = setTimeout(() => done(undefined), 1500))),
    ]);
    if (!image || image.isEmpty() || guest.isDestroyed()) return;
    if (image.getSize().width > 1600) image = image.resize({ width: 1600, quality: "good" });
    if (!pictures.has(guest.id)) guest.once("destroyed", () => pictures.delete(guest.id));
    pictures.set(guest.id, `data:image/jpeg;base64,${image.toJPEG(72).toString("base64")}`);
  } catch {
    // No picture; the tab still reloads when clicked.
  } finally {
    clearTimeout(timer);
  }
});
ipcMain.handle("orvane:page-snapshot", async (event, id, picture) => {
  const guest = ownGuest(event, id);
  if (!guest) return null;
  resumeGuest(guest);
  let timer;
  const edited = await Promise.race([
    guest
      .executeJavaScriptInIsolatedWorld(EDITED_WORLD, [{ code: EDITED_FIELDS }])
      .catch(() => true),
    new Promise((done) => (timer = setTimeout(() => done(true), 2000))),
  ]);
  clearTimeout(timer);
  // Unknown (no answer) counts as edited: never drop work we can't see.
  if (edited !== false || guest.isDestroyed()) return { edited: true };
  return { edited: false, image: (picture === true && pictures.get(guest.id)) || "" };
});

// ---- Tray: closing the window hides Orvane there; Quit is in its menu ----
// Quitting (tray menu, or the system shutting down) really closes the window,
// still waiting for the last save as before.
let quitting = false;
let restart = { state: "idle" };
let restartTimer;
let shutdownStarted = false;
let shutdownReady = false;

function queueDesktopRestart(window, request) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    if (restart !== request || quitting || window.isDestroyed()) return;
    const [ready, saved] = await Promise.all([
      fetch(`${origin}/__orvane/agents/desktop-restart-ready`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(1500),
      }).then(async response => response.ok ? (await response.json()).ready : undefined).catch(() => undefined),
      workspaceSaved(window),
    ]);
    if (restart !== request || quitting || window.isDestroyed()) return;
    if (ready === true && saved) {
      restart = { state: "restarting" };
      app.quit();
      return;
    }
    request.waitingFor = ready === undefined ? "local-server" : ready !== true ? "agent-turns" : "workspace-save";
    queueDesktopRestart(window, request);
  }, 1000);
}

function workspaceSaved(window) {
  return window.webContents.executeJavaScript(
    'document.querySelector("main")?.dataset.saved === "true"',
  ).catch(() => false);
}

ipcMain.handle("orvane:desktop-restart", (event, action) => {
  const window = workspaceWindow(event);
  if (!window) throw Error("Restart requires the Orvane desktop workspace.");
  if (action === "schedule") {
    if (quitting || restart.state === "pending") return restart;
    restart = { state: "pending" };
    queueDesktopRestart(window, restart);
  } else if (action === "cancel") {
    if (restart.state === "pending") {
      clearTimeout(restartTimer);
      restart = { state: "cancelled" };
    }
  } else if (action !== "status") {
    throw Error("Unknown desktop restart action.");
  }
  return restart;
});

let tray;
// Started by "Launch at login": stay in the tray until shown.
const startedFromLogin = process.argv.includes("--from-login");
let firstShow = true;
const loginItem = () => ({
  path: process.execPath,
  args: [join(root, "electron/main.mjs"), "--from-login"],
});
function showWindow() {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (!window.isVisible()) minimizeBrowserPopups();
  if (window.isMinimized()) window.restore();
  if (firstShow) {
    firstShow = false;
    if (openFullScreen()) window.setFullScreen(true);
    else window.maximize();
  }
  window.show();
  window.focus();
  return window;
}
function quitOrvane() {
  quitting = true;
  app.quit();
}
function captureClipboard() {
  const window = showWindow();
  if (!window) return;
  const contents = window.webContents;
  const send = () => contents.send("orvane:inbox-capture");
  if (contents.isLoadingMainFrame()) contents.once("did-finish-load", send);
  else send();
}
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Show Orvane", click: showWindow },
    { label: "Capture clipboard", click: captureClipboard },
    {
      label: "Launch at login",
      type: "checkbox",
      checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked });
        tray?.setContextMenu(trayMenu());
      },
    },
    { type: "separator" },
    { label: "Quit Orvane", click: quitOrvane },
  ]);
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(join(root, "public/favicon.ico")));
  tray.setToolTip("Orvane");
  tray.setContextMenu(trayMenu());
  tray.on("click", showWindow);
}

function createWindow() {
  const window = new BrowserWindow({
    // Start on the chosen monitor so maximizing fills that one.
    ...normalWindowBounds(chosenDisplay()),
    minWidth: 800,
    minHeight: 560,
    title: "Orvane",
    icon: join(root, "public/favicon.ico"),
    backgroundColor: "#e9eef1",
    // No system title bar: Orvane's own top bar carries the drag area and
    // the close button. Shown once maximized, so it never flashes small.
    frame: false,
    show: false,
    webPreferences: {
      preload: join(root, "electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  mainWindow = window;
  window.webContents.on("before-input-event", (event, input) => fullScreenKey(event, input));
  const sendMaximized = () => window.webContents.send("orvane:window-maximized", window.isMaximized());
  window.on("maximize", sendMaximized);
  window.on("unmaximize", sendMaximized);
  window.on("hide", () => { windowDrag = undefined; });
  window.on("closed", () => { mainWindow = undefined; });
  // Orvane stays on its own origin; anything else opens in the system browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (isOrvane(url)) return;
    event.preventDefault();
    if (web(url)) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (web(url) && !isOrvane(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Closing while the last edit is still saving: Orvane's unsaved-changes
  // guard would silently block the close in Electron. Wait briefly for the
  // save instead, then ask only if it is still pending.
  let closing = false,
    leaveAnyway = false;
  const saved = () =>
    window.webContents
      .executeJavaScript(
        'document.querySelector("main")?.dataset.saved !== "false"',
        true,
      )
      .catch(() => true);
  window.on("close", (event) => {
    // Closing hides Orvane to the tray; it keeps running (reminders too).
    if (!quitting) {
      event.preventDefault();
      // Keep open dialogs available from the taskbar without leaving them
      // on screen or bringing them back when the workspace reopens.
      minimizeBrowserPopups();
      window.hide();
      return;
    }
    if (closing || leaveAnyway) return;
    event.preventDefault();
    closing = true;
    void (async () => {
      if (restart.state === "restarting") {
        const savedForRestart = await workspaceSaved(window);
        if (window.isDestroyed()) return;
        if (!savedForRestart) {
          closing = false;
          quitting = false;
          restart = { state: "pending", waitingFor: "workspace-save" };
          queueDesktopRestart(window, restart);
          return;
        }
        window.close();
        return;
      }
      for (let i = 0; i < 30 && !(await saved()); i++)
        await new Promise((done) => setTimeout(done, 100));
      if (window.isDestroyed()) return;
      if (!(await saved())) {
        showWindow();
        const choice = dialog.showMessageBoxSync(window, {
          type: "warning",
          buttons: ["Stay", "Close anyway"],
          defaultId: 0,
          cancelId: 0,
          title: "Orvane",
          message: "Your latest changes have not been saved yet.",
          detail:
            "Stay to let Orvane retry or export a backup, or close now and lose them.",
        });
        if (choice !== 1) {
          closing = false;
          quitting = false;
          return;
        }
        leaveAnyway = true;
      }
      window.close();
    })();
  });
  window.webContents.on("will-prevent-unload", (event) => {
    // Already confirmed above; let the page unload (and release its lease).
    if (leaveAnyway || closing) event.preventDefault();
  });
  if (!startedFromLogin) showWindow();
  void window.loadURL(origin);
  return window;
}

// No menu bar, not even on Alt: Alt+drag moves apps on the canvas. The menu
// stays installed so its shortcuts (copy, paste, reload…) still work.
// Electron's default menu, minus its "Close" item: Ctrl+W closed Orvane.
function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : [{ label: "File", submenu: [{ role: "quit" }] }]),
      { role: "editMenu" },
      { role: "viewMenu" },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
    ]),
  );
}
app.on("browser-window-created", (_event, window) => {
  window.setAutoHideMenuBar(false);
  window.setMenuBarVisibility(false);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    quitting = true;
    if (restart.state === "pending") {
      clearTimeout(restartTimer);
      restart = { state: "cancelled" };
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", event => {
    if (shutdownReady) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void (async () => {
      if (restart.state === "restarting" && !server) {
        // Leave a separately launched Vite server alone, but disconnect Host.
        try {
          const response = await fetch(`${origin}/__orvane/agents/host-settings`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "stop" }), signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw Error(`HTTP ${response.status}`);
        } catch (error) {
          console.error("Orvane Host could not stop:", error.message);
        }
      }
      await stopServer();
      if (restart.state === "restarting") {
        // A restart should reopen the window and require Host to be enabled again.
        process.env.ORVANE_HOST_ENABLED = "0";
        app.relaunch({ args: process.argv.slice(1).filter(arg => arg !== "--from-login") });
      }
      shutdownReady = true;
      app.quit();
    })();
  });
  app
    .whenReady()
    .then(async () => {
      secure();
      installMenu();
      await startServer();
      monitorHostAwake();
      createWindow();
      createTray();
      globalShortcut.register("CommandOrControl+Alt+I", captureClipboard);
      app.on("will-quit", () => globalShortcut.unregisterAll());
      // Free-direction two-finger panning from the touchpad's own fingers.
      app.on("will-quit", setupTouchpad(root));
      try { netSuiteBroker = await startNetSuiteBroker({
        directory: join(process.env.ORVANE_DATA_DIR || join(root, ".orvane"), "netsuite-broker"),
        service: desktopNetSuiteService,
        hosts: () => BrowserWindow.getAllWindows().map(window => window.webContents)
          .filter(contents => !contents.isDestroyed() && isOrvane(contents.getURL())),
        onExit: ({ expected, wasReady }) => { if (!expected && wasReady) console.error("NetSuite broker exited. Restart Desktop to restore MCP reads; no requests were replayed."); },
      }); } catch (error) {
        // A failed optional MCP journal/gateway must not close the user's UI.
        console.error("NetSuite MCP unavailable; Desktop remains open:", error.code || "BROKER_START_FAILED", error.message);
      }
    })
    .catch((error) => {
      console.error(error);
      stopServer();
      app.exit(1);
    });
}
