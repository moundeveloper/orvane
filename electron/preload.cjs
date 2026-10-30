// Orvane window only (never websites): tells the Browser app it can use
// <webview>, relays links that a page wants opened in a new tab, and manages
// saved logins (sites and usernames only; passwords never reach this window).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orvaneDesktop", {
  webview: true,
  partition: "persist:orvane-browser",
  /** Render a Browser page at this many device pixels per CSS pixel. */
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
    /** Answer a save prompt: "save", "never" or "dismiss". */
    decide: (id, choice) => ipcRenderer.invoke("orvane:password-decide", id, choice),
    /** A sign-in in a Browser page that could be saved. */
    onPrompt(callback) {
      const listener = (_event, prompt) => callback(prompt);
      ipcRenderer.on("orvane:password-prompt", listener);
      return () => ipcRenderer.removeListener("orvane:password-prompt", listener);
    },
  },
});
