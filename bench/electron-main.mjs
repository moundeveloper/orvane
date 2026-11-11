// A bare window on Electron's Chromium for the benchmark: the same sandboxed
// renderer settings as the desktop shell, no preload, so the fixture can
// stand in for the desktop bridge. The harness navigates it.
import { app, BrowserWindow } from "electron";

if (process.env.ORVANE_USER_DATA)
  app.setPath("userData", process.env.ORVANE_USER_DATA);
app.on("window-all-closed", () => app.quit());
// No top-level await: Playwright's launcher holds the ready event until it
// has attached, which a pending module evaluation would deadlock.
void app.whenReady().then(() => {
  const window = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1440,
    height: 1000,
    useContentSize: true,
    backgroundColor: "#e9eef1",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  window.setMenuBarVisibility(false);
  void window.loadURL("about:blank");
});
