import { test, expect, _electron as electron, type TestInfo } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type TestWindowState = {
  trayClick: () => void;
  cursor: { x: number; y: number };
  dragStarted: boolean;
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

test("the tray reopens Orvane and its header can restore the window into a drag", async ({}, info) => {
  test.skip(process.platform !== "win32", "The restore-on-drag gesture is for Windows");
  test.setTimeout(150_000);
  const desktop = await launchTray(info);
  try {
    const page = await desktop.firstWindow();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 60_000 });
    const ids = await desktop.evaluate(({ BrowserWindow }) => {
      const [workspace] = BrowserWindow.getAllWindows();
      const popup = new BrowserWindow({
        parent: workspace,
        show: false,
        webPreferences: { backgroundThrottling: false },
      });
      // Processing windows are hidden children and can come first in this list.
      const getAllWindows = BrowserWindow.getAllWindows.bind(BrowserWindow);
      BrowserWindow.getAllWindows = () => [popup, ...getAllWindows().filter((window) => window !== popup)];
      return { workspace: workspace!.id, popup: popup.id };
    });
    const read = () => desktop.evaluate(({ BrowserWindow }, ids) => {
      const workspace = BrowserWindow.fromId(ids.workspace)!;
      return {
        visible: workspace.isVisible(),
        maximized: workspace.isMaximized(),
        bounds: workspace.getBounds(),
        popupVisible: BrowserWindow.fromId(ids.popup)!.isVisible(),
      };
    }, ids);
    const trayClick = () => desktop.evaluate(() =>
      (globalThis as unknown as { windowTest: TestWindowState }).windowTest.trayClick());
    const close = page.getByRole("button", { name: "Close Orvane", exact: true });

    await close.click();
    await expect.poll(async () => (await read()).visible).toBe(false);
    await trayClick();
    await expect.poll(read).toMatchObject({ visible: true, maximized: true, popupVisible: false });

    await page.getByRole("button", { name: "Restore Orvane window", exact: true }).click();
    await expect.poll(async () => (await read()).maximized).toBe(false);
    const normal = (await read()).bounds;
    await close.click();
    await expect.poll(async () => (await read()).visible).toBe(false);
    await trayClick();
    await expect.poll(read).toEqual({ visible: true, maximized: false, bounds: normal, popupVisible: false });

    await page.getByRole("button", { name: "Maximize Orvane window", exact: true }).click();
    await expect.poll(async () => (await read()).maximized).toBe(true);
    await expect(page.locator(".wordmark")).toHaveClass(/restore-drag/);
    const maximized = (await read()).bounds;
    const wordmark = (await page.locator(".wordmark").boundingBox())!;
    const point = { x: wordmark.x + 35, y: wordmark.y + wordmark.height / 2 };
    await desktop.evaluate(({ ipcMain, screen }, { bounds, point }) => {
      const fixture = (globalThis as unknown as { windowTest: TestWindowState }).windowTest;
      fixture.cursor = { x: bounds.x + point.x, y: bounds.y + point.y };
      screen.getCursorScreenPoint = () => ({ ...fixture.cursor });
      ipcMain.on("orvane:window-drag", (_event, phase) => {
        if (phase === "start") fixture.dragStarted = true;
      });
    }, { bounds: maximized, point });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    try {
      await expect.poll(() => desktop.evaluate(() =>
        (globalThis as unknown as { windowTest: TestWindowState }).windowTest.dragStarted)).toBe(true);
      await desktop.evaluate(() => {
        const { cursor } = (globalThis as unknown as { windowTest: TestWindowState }).windowTest;
        cursor.x += 140;
        cursor.y += 100;
      });
      await page.mouse.move(point.x + 140, point.y + 100);
      await expect.poll(async () => (await read()).maximized).toBe(false);
      await expect.poll(async () => (await read()).bounds.y).toBeGreaterThan(maximized.y + 50);
    } finally {
      await page.mouse.up();
    }
    await expect(page.locator(".wordmark")).toHaveCSS("app-region", "drag");
  } finally {
    await desktop.close();
  }
});

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

test("processing tabs run without a native window that Windows could draw", async ({}, info) => {
  test.setTimeout(120_000);
  const site = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>NetSuite Login</title><h1>Signed-out fixture</h1>");
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
    await expect(browser.locator(".browser-tab.active")).toContainText("NetSuite Login");
    await browser.getByRole("button", { name: "Use current tab" }).click();
    await expect(browser.locator(".processing-list")).toContainText("ready");
    // The hidden processing page used to be a real (owned) native window.
    // Windows could draw it as a dark "NetSuite Login" box after a tray
    // reopen even while it reported itself hidden: it must not exist at all.
    const state = () => desktop.evaluate(async ({ BrowserWindow, webContents }, url) => {
      const processing = webContents.getAllWebContents().find((contents) => contents.getType() !== "webview" && contents.getURL() === url);
      return {
        windows: BrowserWindow.getAllWindows().map((window) => window.getTitle()),
        processingWindow: processing ? BrowserWindow.fromWebContents(processing)?.getTitle() ?? null : "missing",
        processingRuns: processing ? await processing.executeJavaScript("document.title") : "missing",
        processingId: processing?.id,
      };
    }, url);
    const before = await state();
    expect(before).toMatchObject({ windows: [expect.stringContaining("Orvane")], processingWindow: null, processingRuns: "NetSuite Login" });
    await page.getByRole("button", { name: "Close Orvane", exact: true }).click();
    await desktop.evaluate(() => (globalThis as unknown as { windowTest: TestWindowState }).windowTest.trayClick());
    await expect.poll(state).toEqual(before);
  } finally {
    await desktop.close();
    site.closeAllConnections();
    site.close();
  }
});
