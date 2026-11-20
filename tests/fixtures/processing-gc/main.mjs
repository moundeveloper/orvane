// Electron entry for tests/processing-gc.test.mjs: a processing page must
// survive garbage collection while only its page object is referenced.
import { app } from "electron";
import { writeFileSync } from "node:fs";
import { headlessPage } from "../../../electron/processing.mjs";

const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
const report = (value) => {
  writeFileSync(out, JSON.stringify(value));
  app.quit();
};
process.on("uncaughtException", (error) => report({ error: String(error?.stack || error) }));
app.whenReady().then(async () => {
  const page = headlessPage({ sandbox: true, contextIsolation: true, backgroundThrottling: false });
  await page.loadURL("data:text/html,<title>processing</title>");
  const running = page.webContents.mainFrame
    .executeJavaScript("new Promise(r => setTimeout(() => r('done'), 1500))")
    .then((value) => value, (error) => `rejected: ${error.message}`);
  for (let i = 0; i < 5; i++) {
    globalThis.gc();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const destroyed = page.isDestroyed();
  const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("never settled"), 10000))]);
  report({ destroyed, result });
});
