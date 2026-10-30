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
