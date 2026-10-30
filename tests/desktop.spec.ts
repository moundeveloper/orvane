import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";

// Sites that refuse framing (like NetSuite) must still load in the desktop
// Browser app, with real history and links opening as tabs.
test("Desktop Browser app loads frame-blocking sites in a webview", async ({}, info) => {
  test.setTimeout(120000);
  const site = createServer((request, response) => {
    const name = (request.url || "/").slice(1) || "home";
    response.setHeader("content-type", "text/html");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("content-security-policy", "frame-ancestors 'none'");
    response.end(
      `<!doctype html><title>Fixture ${name}</title><h1>${name}</h1>` +
        `<a id="tab" href="/two" target="_blank">two</a><div style="height:4000px"></div>`,
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: "5199",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page
      .getByRole("button", { name: "Create Browser", exact: true })
      .click();
    const browser = page.locator(".browser-view");
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    await addressBar.fill(`${origin}/one`);
    await addressBar.focus();
    // Plain key press: locator.press can wait on the embedded page's navigation.
    await page.keyboard.press("Enter");
    const tabs = browser.locator(".browser-tab");
    await expect(tabs.first()).toContainText("Fixture one", {
      timeout: 15000,
    });

    // Real history from the page itself.
    await addressBar.fill(`${origin}/three`);
    await addressBar.focus();
    // Plain key press: locator.press can wait on the embedded page's navigation.
    await page.keyboard.press("Enter");
    await expect(tabs.first()).toContainText("Fixture three");
    await browser.getByRole("button", { name: "Back", exact: true }).click();
    await expect(tabs.first()).toContainText("Fixture one");
    await expect(addressBar).toHaveValue(`${origin}/one`);

    // A target=_blank link inside the page opens as a Browser tab.
    await app.evaluate(async ({ webContents }) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === "webview");
      await guest!.executeJavaScript("document.getElementById('tab').click()", true);
    });
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toContainText("Fixture two", { timeout: 15000 });

    // Guests are isolated: no Node, own session.
    const guest = await app.evaluate(({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getType() === "webview")!;
      return contents.executeJavaScript("typeof require + ' ' + typeof process");
    });
    expect(guest).toBe("undefined undefined");

    // Canvas zoom: the active page renders at on-screen pixel density
    // (sharp) while keeping the same CSS layout width.
    const guestMetrics = () =>
      app.evaluate(async ({ webContents }) => {
        const guests = webContents
          .getAllWebContents()
          .filter((c) => c.getType() === "webview");
        const guest = guests.sort((a, b) => b.id - a.id)[0]!;
        return guest.executeJavaScript(
          "({ dpr: devicePixelRatio, width: innerWidth })",
        ) as Promise<{ dpr: number; width: number }>;
      });
    const hostDpr = await page.evaluate(() => devicePixelRatio);
    const flat = await guestMetrics();
    await page.mouse.move(700, 450);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Control");
    const box = page.locator(".browser-page");
    const zoom = () =>
      box.evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
    await expect.poll(zoom).toBeGreaterThan(1.2);
    await expect
      .poll(async () => {
        const [scale, metrics] = [await zoom(), await guestMetrics()];
        return (
          Math.abs(metrics.dpr - hostDpr * scale) < 0.05 * hostDpr &&
          Math.abs(metrics.width - flat.width) <= 2
        );
      }, { timeout: 10000 })
      .toBe(true);

    // A window.open popup is not affected by the canvas zoom.
    const popupZoom = await app.evaluate(async ({ webContents, BrowserWindow }) => {
      const guests = webContents
        .getAllWebContents()
        .filter((c) => c.getType() === "webview");
      const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      await guests.sort((a, b) => b.id - a.id)[0]!.executeJavaScript(
        "window.open(location.href, 'pick', 'width=420,height=320'); 1",
        true,
      );
      let popup: Electron.BrowserWindow | undefined;
      for (let i = 0; i < 50 && !popup; i++) {
        await new Promise((done) => setTimeout(done, 100));
        popup = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
      }
      if (!popup) return -1;
      await new Promise((done) => setTimeout(done, 500));
      const factor = popup.webContents.getZoomFactor();
      popup.close();
      return factor;
    });
    expect(popupZoom).toBe(1);

    // Clicking elsewhere and coming back: the page still scrolls, and canvas
    // gestures made over it (Ctrl+wheel, middle-drag) move the canvas.
    const guestScroll = () =>
      app.evaluate(async ({ webContents }) => {
        const guests = webContents
          .getAllWebContents()
          .filter((c) => c.getType() === "webview");
        return guests.sort((a, b) => b.id - a.id)[0]!.executeJavaScript("scrollY") as Promise<number>;
      });
    const zoomedIn = await zoom();
    await page.mouse.move(700, 450);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 700);
    await page.keyboard.up("Control");
    await expect.poll(zoom).toBeLessThan(zoomedIn * 0.5);
    await page.locator(".canvas-background").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".browser-shield")).toHaveCount(0);
    const pageBox = async () => (await box.boundingBox())!;
    let b = await pageBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(guestScroll).toBeGreaterThan(100);
    const zoomBefore = await zoom();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 300);
    await page.keyboard.up("Control");
    await expect.poll(zoom).toBeLessThan(zoomBefore * 0.9);
    await page.waitForTimeout(600); // let the zoom animation settle
    b = await pageBox();
    const cx = b.x + b.width / 2,
      cy = b.y + b.height / 2;
    // Panning follows the OS cursor; in the test it follows Playwright's
    // virtual mouse, mapped to screen coordinates.
    await app.evaluate(({ screen }) => {
      const g = globalThis as any;
      g.realCursor ??= screen.getCursorScreenPoint.bind(screen);
      screen.getCursorScreenPoint = () => g.fakeCursor ?? g.realCursor();
    });
    const moveTo = async (x: number, y: number) => {
      await app.evaluate(({ BrowserWindow }, p) => {
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith("http://localhost:5199"),
        )!;
        const bounds = window.getContentBounds();
        (globalThis as any).fakeCursor = {
          x: Math.round(bounds.x + p.x),
          y: Math.round(bounds.y + p.y),
        };
      }, { x, y });
      await page.mouse.move(x, y);
    };
    await moveTo(cx, cy);
    await page.mouse.down({ button: "middle" });
    await page.waitForTimeout(100); // a hand starts moving after pressing
    for (let i = 1; i <= 6; i++) {
      await moveTo(cx - 10 * i, cy - 5 * i);
      await page.waitForTimeout(30);
    }
    await page.mouse.up({ button: "middle" });
    // The canvas follows the pointer (60px drag) without drifting.
    await expect
      .poll(async () => b.x - (await pageBox()).x)
      .toBeGreaterThan(50);
    expect(b.x - (await pageBox()).x).toBeLessThan(70);

    // Middle-click closes a tab.
    const before = await tabs.count();
    await tabs.last().click({ button: "middle" });
    await expect(tabs).toHaveCount(before - 1);
    await page.screenshot({ path: "artifacts/desktop-browser.png" });
  } finally {
    await app.close();
    await new Promise((done) => site.close(done));
    // Quitting stops the dev server the app started.
    await expect
      .poll(() =>
        fetch("http://localhost:5199", { signal: AbortSignal.timeout(1000) }).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
  }
});

test("the server the desktop app started stops even if the app is killed", async ({}, info) => {
  test.setTimeout(120000);
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: "5196",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  const page = await app.firstWindow({ timeout: 90000 });
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
  const up = () =>
    fetch("http://localhost:5196", { signal: AbortSignal.timeout(1000) }).then(
      () => true,
      () => false,
    );
  expect(await up()).toBe(true);
  // app.process() is a launcher; kill the real Electron main process.
  const pid = await app.evaluate(() => process.pid);
  process.kill(pid, "SIGKILL");
  await expect.poll(up, { timeout: 15000 }).toBe(false);
});