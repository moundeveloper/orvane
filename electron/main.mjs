// Orvane desktop shell. Runs the normal Vite app (with its local APIs) and
// shows it in a window whose Browser app can use <webview>, so sites that
// refuse to be framed (NetSuite, Google…) load like in a real browser.
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  webContents,
  webFrameMain,
} from "electron";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setupPasswords } from "./passwords.mjs";
import { setupNetSuite } from "./netsuite.mjs";
import { setupProcessing } from "./processing.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.ORVANE_PORT || 5173);
const origin = `http://localhost:${port}`;
export const BROWSER_PARTITION = "persist:orvane-browser";
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
      else if (event.shiftKey) name = ({ a: "search", c: "copy-url", t: "reopen-tab" })[key];
      else if (/^[1-9]$/.test(key)) name = "tab-" + key;
      else name = ({ k: "search", l: "address", t: "new-tab", w: "close-tab", b: "library",
        o: "promote-peek", [String.fromCharCode(92)]: "sidebar" })[key];
    }
    if (!name) return;
    stop(event);
    send({ kind: "key", name });
  }, true);
  addEventListener("keyup", (event) => { if (event.key === "Control" || event.key === "Meta") send({ kind: "key", name: "release" }); }, true);
})();`;
// Separate profile (sessions, cookies) for tests or a second setup.
if (process.env.ORVANE_USER_DATA)
  app.setPath("userData", process.env.ORVANE_USER_DATA);

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
  server?.kill();
  server = undefined;
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
  // Websites get no camera, microphone, location or notifications.
  sites.setPermissionRequestHandler((_contents, permission, done) =>
    done(["fullscreen", "clipboard-sanitized-write"].includes(permission)),
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, done) =>
    done(isOrvane(contents.getURL()) && permission === "clipboard-sanitized-write"),
  );

  const processing = setupProcessing({ partition: sites, isOrvane });
  setupNetSuite(isOrvane, sites, processing);

  // Saved logins: offered on sign-in forms, saved after a sign-in works.
  const trackPasswords = setupPasswords({
    partition: BROWSER_PARTITION,
    isOrvane,
    folder: app.getPath("userData"),
  });

  app.on("web-contents-created", (_event, contents) => {
    if (contents.session === sites) trackPasswords(contents);
    if (contents.getType() === "webview") {
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
      contents.on("dom-ready", () => {
        contents
          .executeJavaScriptInIsolatedWorld(CANVAS_WORLD, [
            { code: `window.__orvanePinned = ${pinnedGuests.has(contents.id)};` },
            { code: CANVAS_GESTURES },
          ])
          .catch(() => undefined);
      });
      contents.on("destroyed", () => pinnedGuests.delete(contents.id));
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
        Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents.hostWebContents) || undefined });
      });
      contents.on("will-navigate", (event, url) => {
        if (!web(url) || isOrvane(url)) event.preventDefault();
      });
      contents.setWindowOpenHandler(({ url, disposition }) => {
        if (!web(url) || isOrvane(url)) return { action: "deny" };
        // window.open popups (NetSuite selectors, sign-in flows) keep their
        // opener; links meant for a new tab open as a Browser tab instead.
        if (disposition === "new-window")
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
        contents.hostWebContents?.send("orvane:open-tab", {
          from: contents.id,
          url,
          background: disposition === "background-tab",
        });
        return { action: "deny" };
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
      params.partition = BROWSER_PARTITION;
      if (!web(params.src) || isOrvane(params.src)) event.preventDefault();
    });
  });
}

// The canvas scales apps with a CSS transform; a page rendered at normal
// density would be stretched and blurry. Orvane asks for its own webviews to
// render at the on-screen density instead (per page, unlike site zoom, so
// popups and layout are unaffected).
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

// Which monitor Orvane opens on. The choice is kept by the display's id in
// the profile folder; if that monitor is gone, the primary one is used and
// the choice is kept for when it returns.
const windowSettings = () => join(app.getPath("userData"), "window.json");
function chosenDisplayId() {
  try {
    const id = JSON.parse(readFileSync(windowSettings(), "utf8")).displayId;
    return typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}
function chosenDisplay() {
  const id = chosenDisplayId();
  return (
    screen.getAllDisplays().find((display) => display.id === id) ||
    screen.getPrimaryDisplay()
  );
}
function placeOn(window, display) {
  if (window.isFullScreen()) window.setFullScreen(false);
  if (window.isMaximized()) window.unmaximize();
  window.setBounds(display.workArea);
  window.maximize();
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
  if (!isOrvane(event.senderFrame?.url || "")) return false;
  const display = screen.getAllDisplays().find((item) => item.id === id);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!display || !window) return false;
  try {
    writeFileSync(windowSettings(), JSON.stringify({ displayId: display.id }));
  } catch {
    // The window still moves; the choice just is not remembered.
  }
  placeOn(window, display);
  return true;
});

// Pinned Browser pages preview links that leave their site (see
// CANVAS_GESTURES); the flag lives in the isolated world, unseen by the page.
const pinnedGuests = new Set();
ipcMain.handle("orvane:page-pinned", (event, id, pinned) => {
  const guest = ownGuest(event, id);
  if (!guest || typeof pinned !== "boolean") return;
  if (pinned) pinnedGuests.add(guest.id);
  else pinnedGuests.delete(guest.id);
  guest
    .executeJavaScriptInIsolatedWorld(CANVAS_WORLD, [{ code: `window.__orvanePinned = ${pinned};` }])
    .catch(() => undefined);
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

// The close button in Orvane's top bar. Only Orvane's own window may ask,
// and closing goes through the unsaved-changes guard in createWindow.
ipcMain.handle("orvane:window-close", (event) => {
  if (!isOrvane(event.senderFrame?.url || "")) return;
  BrowserWindow.fromWebContents(event.sender)?.close();
});

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
  const forget = () => pausedGuests.delete(guest.id);
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
  if (contents.getType() !== "webview") return;
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

function createWindow() {
  const area = chosenDisplay().workArea;
  const window = new BrowserWindow({
    // Start on the chosen monitor so maximizing fills that one.
    x: area.x,
    y: area.y,
    width: Math.min(1440, area.width),
    height: Math.min(900, area.height),
    minWidth: 800,
    minHeight: 560,
    title: "Orvane",
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
    if (closing || leaveAnyway) return;
    event.preventDefault();
    closing = true;
    void (async () => {
      for (let i = 0; i < 30 && !(await saved()); i++)
        await new Promise((done) => setTimeout(done, 100));
      if (window.isDestroyed()) return;
      if (!(await saved())) {
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
  window.maximize();
  window.show();
  void window.loadURL(origin);
  return window;
}

// No menu bar, not even on Alt: Alt+drag moves apps on the canvas. The menu
// stays installed so its shortcuts (copy, paste, reload…) still work.
app.on("browser-window-created", (_event, window) => {
  window.setAutoHideMenuBar(false);
  window.setMenuBarVisibility(false);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", stopServer);
  app
    .whenReady()
    .then(async () => {
      secure();
      await startServer();
      createWindow();
    })
    .catch((error) => {
      console.error(error);
      stopServer();
      app.exit(1);
    });
}
