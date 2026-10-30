// Orvane desktop shell. Runs the normal Vite app (with its local APIs) and
// shows it in a window whose Browser app can use <webview>, so sites that
// refuse to be framed (NetSuite, Google…) load like in a real browser.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  session,
  shell,
  webContents,
} from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  let panning = false, moved = false;
  addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    stop(event);
    panning = true;
    moved = false;
    try { document.documentElement.setPointerCapture(event.pointerId); } catch {}
    send({ kind: "pan-start" });
  }, true);
  addEventListener("mousedown", (event) => { if (event.button === 1) stop(event); }, true);
  addEventListener("pointermove", (event) => {
    if (!panning) return;
    stop(event);
    moved = true;
    if (!(event.buttons & 4)) { panning = false; send({ kind: "pan-end" }); }
  }, true);
  // A middle click without dragging still opens links in a new tab.
  addEventListener("pointerup", (event) => {
    if (event.button === 1 && panning) { panning = false; send({ kind: "pan-end" }); }
  }, true);
  addEventListener("auxclick", (event) => { if (event.button === 1 && moved) stop(event); }, true);
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
  // Websites get no camera, microphone, location or notifications.
  sites.setPermissionRequestHandler((_contents, permission, done) =>
    done(["fullscreen", "clipboard-sanitized-write"].includes(permission)),
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, done) =>
    done(isOrvane(contents.getURL()) && permission === "clipboard-sanitized-write"),
  );

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") {
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
          .executeJavaScriptInIsolatedWorld(CANVAS_WORLD, [{ code: CANVAS_GESTURES }])
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
        const finite = (...values) => values.every((v) => Number.isFinite(v) && Math.abs(v) < 1e5);
        const relay =
          input?.kind === "zoom" && finite(input.x, input.y, input.deltaY)
            ? { kind: "zoom", x: input.x, y: input.y, deltaY: input.deltaY }
            : undefined;
        if (relay) contents.hostWebContents?.send("orvane:guest-input", { from: contents.id, ...relay });
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
              autoHideMenuBar: true,
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
  const guest = typeof id === "number" ? webContents.fromId(id) : undefined;
  if (
    !guest ||
    guest.getType() !== "webview" ||
    guest.hostWebContents !== event.sender ||
    typeof density !== "number" ||
    !Number.isFinite(density)
  )
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    title: "Orvane",
    autoHideMenuBar: true,
    backgroundColor: "#e9eef1",
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
  void window.loadURL(origin);
  return window;
}

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
