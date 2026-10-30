// Orvane window only (never websites): tells the Browser app it can use
// <webview> and relays links that a page wants opened in a new tab.
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
});
