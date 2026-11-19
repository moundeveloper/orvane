import { test, expect, _electron as electron, type TestInfo } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type TestWindowState = {
  trayClick: () => void;
};

async function launchTray(info: TestInfo) {
  const entry = info.outputPath("desktop-entry.mjs");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, `
import { Tray } from "electron";
const on = Tray.prototype.on;
Tray.prototype.on = function (name, listener) {
  if (name === "click") {
    globalThis.windowTest = { trayClick: () => this.emit("click") };
    Tray.prototype.on = on;
  }
  return on.call(this, name, listener);
};
await import(${JSON.stringify(pathToFileURL(resolve("electron/main.mjs")).href)});
`);
  const data = info.outputPath("data");
  return electron.launch({
    args: [entry],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
      ORVANE_PORT: "5227",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
}

test("tray reopen hides nested Browser login windows and keeps the processing tab alive", async ({}, info) => {
  test.setTimeout(120_000);
  const site = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const title = request.url === "/login" ? "NetSuite Login" : "Tray fixture";
    response.end(`<!doctype html><title>${title}</title><h1>Sign-in fixture</h1>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("Fixture port unavailable");
  const desktop = await launchTray(info);
  try {
    const page = await desktop.firstWindow();
    await expect(page.locator('main[data-editable="true"]')).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    const url = `http://127.0.0.1:${address.port}/`;
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    await addressBar.fill(url);
    await addressBar.press("Enter");
    await expect(browser.locator(".browser-tab.active")).toContainText("Tray fixture");
    await browser.getByRole("button", { name: "Use current tab" }).click();
    await expect(browser.locator(".processing-list")).toContainText("ready");
    const state = () => desktop.evaluate(({ BrowserWindow, webContents }, url) => {
      const windows = BrowserWindow.getAllWindows();
      const workspace = windows.find((window) => window.webContents.getURL().startsWith("http://localhost:5227"))!;
      return {
        workspaceVisible: workspace.isVisible(),
        visibleExtraWindows: windows.filter((window) => window !== workspace && window.isVisible() && !window.isMinimized()).map((window) => window.getTitle()),
        processingId: webContents.getAllWebContents().find((contents) => contents.getType() !== "webview" && contents.getURL() === url)?.id,
      };
    }, url);
    const before = await state();
    expect(before.processingId).toBeDefined();
    const openFrom = (source: string, path: string) => desktop.evaluate(({ webContents }, { url, source, path }) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL() === new URL(source, url).href && (source !== "/" || item.getType() === "webview"))!;
      return contents.mainFrame.executeJavaScript(`!!window.open(${JSON.stringify(path)}, '_blank', 'width=420,height=320')`, true);
    }, { url, source, path });
    expect(await openFrom("/", "/selector")).toBe(true);
    await expect.poll(async () => (await state()).visibleExtraWindows).toContain("Tray fixture");
    expect(await openFrom("/selector", "/login")).toBe(true);
    await expect.poll(async () => (await state()).visibleExtraWindows).toContain("NetSuite Login");
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.getByRole("button", { name: "Close Orvane", exact: true }).click();
      await expect.poll(async () => (await state()).workspaceVisible).toBe(false);
      expect(await openFrom("/selector", "/login?in-tray")).toBe(false);
      await desktop.evaluate(() => (globalThis as unknown as { windowTest: TestWindowState }).windowTest.trayClick());
      await expect.poll(state).toEqual({ workspaceVisible: true, visibleExtraWindows: [], processingId: before.processingId });
      expect(await openFrom("/selector", "/login?after-restore")).toBe(false);
    }
  } finally {
    await desktop.close();
    site.closeAllConnections();
    site.close();
  }
});
