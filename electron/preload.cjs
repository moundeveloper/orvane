// Orvane window only (never websites): tells the Browser app it can use
// <webview>, relays links that a page wants opened in a new tab, and manages
// saved logins (sites and usernames only; passwords never reach this window).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("orvaneDesktop", {
  webview: true,
  /** The window has no system title bar; Orvane draws its own controls. */
  frameless: true,
  closeWindow: () => ipcRenderer.invoke("orvane:window-close"),
  isWindowMaximized: () => ipcRenderer.invoke("orvane:window-maximized"),
  toggleWindowMaximized: () => ipcRenderer.invoke("orvane:window-toggle-maximize"),
  onWindowMaximized(callback) {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on("orvane:window-maximized", listener);
    return () => ipcRenderer.removeListener("orvane:window-maximized", listener);
  },
  canRestoreByDrag: process.platform === "win32",
  dragWindow: (phase) => ipcRenderer.send("orvane:window-drag", phase),
  readInboxClipboard: () => ipcRenderer.invoke("orvane:inbox-clipboard"),
  setTabLogin: (id, rootUrl, loginId) => ipcRenderer.invoke("orvane:tab-login", id, rootUrl, loginId),
  onInboxCapture(callback) {
    const listener = () => callback();
    ipcRenderer.on("orvane:inbox-capture", listener);
    return () => ipcRenderer.removeListener("orvane:inbox-capture", listener);
  },
  /** A system notification (calendar reminders); clicking it opens the app. */
  notify: (notification) => ipcRenderer.invoke("orvane:notify", notification),
  onNotificationClick(callback) {
    const listener = (_event, appId) => callback(appId);
    ipcRenderer.on("orvane:notification-click", listener);
    return () => ipcRenderer.removeListener("orvane:notification-click", listener);
  },
  /** Monitors as [{ id, label, chosen }], and moving the window to one. */
  displays: () => ipcRenderer.invoke("orvane:displays"),
  setDisplay: (id) => ipcRenderer.invoke("orvane:display-set", id),
  /** Full screen (no taskbar), remembered for next launch; F11 toggles it. */
  isFullScreen: () => ipcRenderer.invoke("orvane:window-fullscreen"),
  setFullScreen: (on) => ipcRenderer.invoke("orvane:window-fullscreen-set", on),
  onFullScreen(callback) {
    const listener = (_event, on) => callback(on);
    ipcRenderer.on("orvane:window-fullscreen", listener);
    return () => ipcRenderer.removeListener("orvane:window-fullscreen", listener);
  },
  partition: "persist:orvane-browser",
  /** Two-finger touchpad movement (fractions of the pad), or { end: true }. */
  onTouchpad(callback) {
    const listener = (_event, input) => callback(input);
    ipcRenderer.on("orvane:touchpad", listener);
    return () => ipcRenderer.removeListener("orvane:touchpad", listener);
  },
  /** A web image fetched with the Browser's sign-ins, as a data URL ("" if refused). */
  browserImage(url) {
    return ipcRenderer.invoke("orvane:browser-image", url);
  },
  /** The local path of a file dropped from the system, or "" if it has none. */
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  /** Render a Browser page at this many device pixels per CSS pixel. */
  // Runs a script in one of this window's Browser pages, even while it is
  // still loading (the <webview> method waits for loading to finish).
  runInPage(webContentsId, code) {
    return ipcRenderer.invoke("orvane:page-run", webContentsId, code);
  },
  // AI control: trusted input, typing and pictures for one Browser page.
  pageAgent(webContentsId, op) {
    return ipcRenderer.invoke("orvane:page-agent", webContentsId, op);
  },
  setPageDensity(webContentsId, density) {
    return ipcRenderer.invoke("orvane:page-density", webContentsId, density);
  },
  /** Run a Browser page normally (true) or pause it while nobody sees it. */
  setPageActive(webContentsId, active) {
    return ipcRenderer.invoke("orvane:page-active", webContentsId, active);
  },
  /** Before discarding a page: { edited } and, when not edited, a picture. */
  snapshotPage(webContentsId, picture) {
    return ipcRenderer.invoke("orvane:page-snapshot", webContentsId, picture);
  },
  /** Keep a picture of a page now on screen, shown if it is discarded. */
  rememberPage(webContentsId) {
    return ipcRenderer.invoke("orvane:page-remember", webContentsId);
  },
  /** A pinned page previews links that leave its site in a Peek. */
  setPagePinned(webContentsId, pinned) {
    return ipcRenderer.invoke("orvane:page-pinned", webContentsId, pinned);
  },
  /** A PNG data URL of a page: "visible", "full", or "area" with a rect. */
  capturePage(webContentsId, mode, rect) {
    return ipcRenderer.invoke("orvane:page-capture", webContentsId, mode, rect);
  },
  captureClip(webContentsId, url, rect, fromViewport) {
    return ipcRenderer.invoke("orvane:page-clip", webContentsId, url, rect, fromViewport);
  },
  /** Docked DevTools: the page's DevTools rendered into a DevTools webview. */
  devtoolsSrc: "about:blank#orvane-devtools",
  openDevTools(webContentsId, devtoolsId, x, y) {
    return ipcRenderer.invoke("orvane:page-devtools", webContentsId, devtoolsId, x, y);
  },
  closeDevTools(webContentsId) {
    return ipcRenderer.invoke("orvane:page-devtools-close", webContentsId);
  },
  /** Canvas zoom/pan gestures made over a Browser page. */
  onGuestInput(callback) {
    const listener = (_event, input) => callback(input);
    ipcRenderer.on("orvane:guest-input", listener);
    return () => ipcRenderer.removeListener("orvane:guest-input", listener);
  },
  onOpenTab(callback) {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("orvane:open-tab", listener);
    return () => ipcRenderer.removeListener("orvane:open-tab", listener);
  },
  reloadClip: (id, url) => ipcRenderer.invoke("orvane:clip-reload", id, url),
  browserNetSuiteEnvironments: id => ipcRenderer.invoke("orvane:browser-netsuite-environments", id),
  processing: {
    list: () => ipcRenderer.invoke("orvane:processing-list"),
    create: id => ipcRenderer.invoke("orvane:processing-create", id),
    refresh: origin => ipcRenderer.invoke("orvane:processing-refresh", origin),
    close: origin => ipcRenderer.invoke("orvane:processing-close", origin),
    onChanged(callback) {
      const listener = () => callback();
      ipcRenderer.on("orvane:processing-changed", listener);
      return () => ipcRenderer.removeListener("orvane:processing-changed", listener);
    },
  },
  netsuite: {
    tabs: () => ipcRenderer.invoke("orvane:netsuite-tabs"),
    openRecord: (origin, kind, id) => ipcRenderer.invoke("orvane:netsuite-open-record", origin, kind, id),
    run: (id, operation, args) => ipcRenderer.invoke("orvane:netsuite-run", id, operation, args),
  },
  passwords: {
    list: () => ipcRenderer.invoke("orvane:passwords-list"),
    remove: (id) => ipcRenderer.invoke("orvane:passwords-remove", id),
    allow: (origin) => ipcRenderer.invoke("orvane:passwords-allow", origin),
    copy: (id) => ipcRenderer.invoke("orvane:passwords-copy", id),
    /** Turn NetSuite auto sign-in on or off for one saved login. */
    setAutoLogin: (id, on) => ipcRenderer.invoke("orvane:passwords-auto-login", id, on),
    setScope: (id, scope) => ipcRenderer.invoke("orvane:passwords-scope", id, scope),
    addEmail: (id, email) => ipcRenderer.invoke("orvane:passwords-add-email", id, email),
    /** Answer a save prompt: "save", "never" or "dismiss". */
    decide: (id, choice) => ipcRenderer.invoke("orvane:password-decide", id, choice),
    /** A sign-in in a Browser page that could be saved. */
    onPrompt(callback) {
      const listener = (_event, prompt) => callback(prompt);
      ipcRenderer.on("orvane:password-prompt", listener);
      return () => ipcRenderer.removeListener("orvane:password-prompt", listener);
    },
    /** NetSuite auto sign-in progress in a Browser page. */
    onAutoLogin(callback) {
      const listener = (_event, update) => callback(update);
      ipcRenderer.on("orvane:auto-login", listener);
      return () => ipcRenderer.removeListener("orvane:auto-login", listener);
    },
  },
});
