import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";

// Browser pages nobody sees stop running (no requestAnimationFrame, no
// repaint) and come back at once; beyond the live-page budget, long-unseen
// pages are replaced by a picture until reloaded.

// Each page records the time of every animation frame it draws.
const FRAMES =
  "<script>window.frameTimes = []; (function frame() { frameTimes.push(Date.now());" +
  " if (frameTimes.length > 4000) frameTimes.splice(0, 2000); requestAnimationFrame(frame); })();</script>";

async function site() {
  const server = createServer((request, response) => {
    const name = (request.url || "/").slice(1) || "home";
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><title>Fixture ${name}</title><h1>${name}</h1>` +
        (["b", "c"].includes(name) ? '<div style="height:6000px">A long source page</div>' : "") +
        (name === "form" ? `<input id="field" value="start">` : "") +
        FRAMES,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function launch(port: string, outputPath: (name: string) => string) {
  const data = outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: port,
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: outputPath("profile"),
    },
  });
  const page = await app.firstWindow();
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
  return { app, page };
}

/** Submit the address bar without key presses: a key press can stall on the
 * embedded page while it takes focus and navigates. */
const submit = (address: Locator) =>
  address.evaluate((input) => (input as HTMLInputElement).form!.requestSubmit());

async function createBrowser(page: Page, url: string, title: string) {
  const before = await page.locator(".browser-view").count();
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create Browser", exact: true }).click();
  // The Browser app loads asynchronously: wait for the new one.
  await expect(page.locator(".browser-view")).toHaveCount(before + 1);
  const browser = page.locator(".browser-view").nth(before);
  const address = browser.getByRole("textbox", { name: "Address" });
  await address.fill(url);
  await submit(address);
  await expect(browser.locator(".browser-tab.active")).toContainText(title, { timeout: 15000 });
  return browser;
}

/** Run code in the Browser page whose address ends with this path. */
const inGuest = <T>(app: ElectronApplication, path: string, code: string) =>
  app.evaluate(
    ({ webContents }, [path, code]) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === "webview" && c.getURL().endsWith(path));
      if (!guest) throw Error(`No page at ${path}`);
      return guest.executeJavaScript(code, true);
    },
    [path, code],
  ) as Promise<T>;
const liveGuests = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === "webview" && !c.isDestroyed())
      .map((c) => c.getURL().replace(/^https?:\/\/[^/]+/, ""))
      .sort(),
  );
/** Frames the page drew between two wall-clock times (read afterwards). */
const framesBetween = (app: ElectronApplication, path: string, from: number, to: number) =>
  inGuest<number>(
    app,
    path,
    `frameTimes.filter((t) => t >= ${from} && t < ${to}).length`,
  );
const pan = (page: Page, dx: number) =>
  page.evaluate(
    (dx) => window.dispatchEvent(new CustomEvent("orvane-canvas-pan", { detail: { dx, dy: 0 } })),
    dx,
  );

test("Desktop Browser pauses pages nobody sees and resumes them at once", async ({}, info) => {
  test.setTimeout(150000);
  const { server, origin } = await site();
  const { app, page } = await launch("5193", (name) => info.outputPath(name));
  try {
    await page.evaluate(() => localStorage.setItem("orvane.browser.pauseAfterMs", "200"));
    // Count the Orvane window's own animation-frame callbacks.
    await page.evaluate(() => {
      const w = window as unknown as { hostFrames: number };
      w.hostFrames = 0;
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        w.hostFrames++;
        return request(callback);
      };
    });
    await createBrowser(page, `${origin}/one`, "Fixture one");
    await page.locator(".canvas-background").click({ position: { x: 5, y: 5 } });
    const box = page.locator(".browser-view .browser-page");
    const zoom = () =>
      box.evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);

    // On screen: full rate.
    let from = Date.now();
    await page.waitForTimeout(1000);
    expect(await framesBetween(app, "/one", from, from + 1000)).toBeGreaterThan(30);

    // The window idles: nothing polls the page size every frame any more.
    await page.waitForTimeout(500);
    const hostBefore = await page.evaluate(() => (window as unknown as { hostFrames: number }).hostFrames);
    await page.waitForTimeout(1000);
    const hostIdle =
      (await page.evaluate(() => (window as unknown as { hostFrames: number }).hostFrames)) - hostBefore;
    expect(hostIdle).toBeLessThan(10);

    // Panned off-screen: the page stops drawing...
    await pan(page, 6000);
    await page.waitForTimeout(1000);
    from = Date.now();
    await page.waitForTimeout(1000);
    const offscreen = { from, to: from + 1000 };
    // ...and draws again as soon as it is back.
    await pan(page, -6000);
    await page.waitForTimeout(300);
    const back = Date.now();
    await page.waitForTimeout(1000);
    expect(await framesBetween(app, "/one", offscreen.from, offscreen.to)).toBeLessThan(5);
    expect(await framesBetween(app, "/one", back, back + 1000)).toBeGreaterThan(30);

    // Zoomed out until unreadable: paused too, until zoomed back in.
    const b = (await box.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < 6 && (await zoom()) >= 0.22; i++) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(150);
    }
    await page.keyboard.up("Control");
    await expect.poll(zoom).toBeLessThan(0.25);
    await page.waitForTimeout(1200);
    from = Date.now();
    await page.waitForTimeout(1000);
    const zoomedOut = { from, to: from + 1000 };
    await page.keyboard.down("Control");
    for (let i = 0; i < 8 && (await zoom()) < 0.6; i++) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(150);
    }
    await page.keyboard.up("Control");
    await page.waitForTimeout(600);
    const zoomedIn = Date.now();
    await page.waitForTimeout(1000);
    expect(await framesBetween(app, "/one", zoomedOut.from, zoomedOut.to)).toBeLessThan(5);
    expect(await framesBetween(app, "/one", zoomedIn, zoomedIn + 1000)).toBeGreaterThan(30);

    // A background tab is paused as well; selecting it resumes it.
    const browser = page.locator(".browser-view");
    await browser.getByRole("button", { name: "New tab", exact: true }).click();
    const address = browser.getByRole("textbox", { name: "Address" });
    await address.fill(`${origin}/two`);
    await submit(address);
    await expect(browser.locator(".browser-tab.active")).toContainText("Fixture two", { timeout: 15000 });
    await page.waitForTimeout(800);
    from = Date.now();
    await page.waitForTimeout(1000);
    const background = { from, to: from + 1000 };
    await browser.locator(".browser-tab").first().click();
    await page.waitForTimeout(300);
    expect(await framesBetween(app, "/one", background.from, background.to)).toBeLessThan(5);
    const selected = Date.now();
    await page.waitForTimeout(1000);
    expect(await framesBetween(app, "/one", selected, selected + 1000)).toBeGreaterThan(30);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

// Each pause used to add a "destroyed" listener that resuming never removed,
// so panning a page off and on screen grew the list until Node warned
// (MaxListenersExceededWarning).
test("Desktop Browser pause and resume cycles do not pile up page listeners", async ({}, info) => {
  test.setTimeout(120000);
  const { server, origin } = await site();
  const { app, page } = await launch("5194", (name) => info.outputPath(name));
  try {
    await page.evaluate(() => localStorage.setItem("orvane.browser.pauseAfterMs", "200"));
    await createBrowser(page, `${origin}/one`, "Fixture one");
    await page.locator(".canvas-background").click({ position: { x: 5, y: 5 } });
    const listeners = () =>
      app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((c) => c.getType() === "webview" && c.getURL().endsWith("/one"))!
          .listenerCount("destroyed"),
      );
    const start = await listeners();
    for (let i = 0; i < 12; i++) {
      await pan(page, 6000);
      await page.waitForTimeout(700);
      await pan(page, -6000);
      await page.waitForTimeout(300);
    }
    // The cycles really paused the page: the last off-screen spell drew nothing.
    await pan(page, 6000);
    await page.waitForTimeout(1000);
    const from = Date.now();
    await page.waitForTimeout(600);
    await pan(page, -6000);
    await page.waitForTimeout(300);
    expect(await framesBetween(app, "/one", from, from + 600)).toBeLessThan(5);
    expect(await listeners()).toBeLessThanOrEqual(start + 1);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test("Desktop Browser discards long-unseen pages beyond the live limit", async ({}, info) => {
  test.setTimeout(150000);
  const { server, origin } = await site();
  const { app, page } = await launch("5192", (name) => info.outputPath(name));
  try {
    await page.evaluate(() => {
      localStorage.setItem("orvane.browser.liveLimit", "1");
      localStorage.setItem("orvane.browser.discardAfterMs", "400");
      localStorage.setItem("orvane.browser.pauseAfterMs", "150");
    });
    const browser = await createBrowser(page, `${origin}/a`, "Fixture a");
    const address = browser.getByRole("textbox", { name: "Address" });
    const tabs = browser.locator(".browser-tab");
    const openInNewTab = async (path: string) => {
      await browser.getByRole("button", { name: "New tab", exact: true }).click();
      await address.fill(`${origin}${path}`);
      await submit(address);
      await expect(browser.locator(".browser-tab.active")).toContainText(`Fixture ${path.slice(1)}`, {
        timeout: 15000,
      });
    };

    const tabMenu = async (index: number, item: string) => {
      await tabs.nth(index).click({ button: "right" });
      await browser.getByRole("menu").getByText(item, { exact: true }).click();
    };
    // Turned off, background pages stay loaded even over budget.
    await page.evaluate(() => localStorage.setItem("orvane.browser.discardEnabled", "false"));
    await openInNewTab("/b");
    await page.waitForTimeout(1200);
    expect(await liveGuests(app)).toEqual(["/a", "/b"]);
    // On by default; a tab set to "Keep tab live" still stays loaded.
    await tabMenu(0, "Keep tab live");
    await page.evaluate(() => localStorage.removeItem("orvane.browser.discardEnabled"));
    await page.waitForTimeout(2500);
    expect(await liveGuests(app)).toEqual(["/a", "/b"]);
    // So does a tab whose site has a processing tab (the MCP and NetSuite
    // apps create one from a live tab of that account).
    await tabMenu(0, "Allow unloading");
    await tabs.first().click();
    await browser.getByRole("button", { name: "Use current tab" }).click();
    await expect(browser.locator(".processing-list")).toContainText("ready", { timeout: 15000 });
    await tabs.nth(1).click();
    await page.waitForTimeout(2500);
    expect(await liveGuests(app)).toEqual(["/a", "/b"]);
    // Without either, the background page is discarded.
    await browser.getByRole("button", { name: /Processing tabs/ }).click();
    await browser.locator(".processing-row").getByRole("button", { name: "Close" }).click();
    await expect(browser.locator(".processing-row")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => liveGuests(app), { timeout: 10000 }).toEqual(["/b"]);
    await expect(browser.locator(".browser-discarded")).toHaveCount(1);
    await expect(tabs.first()).toContainText("Fixture a");

    // Selecting it brings the page back at the same address.
    await tabs.first().click();
    await expect.poll(() => liveGuests(app), { timeout: 10000 }).toContain("/a");
    expect(await inGuest<string>(app, "/a", "document.title")).toBe("Fixture a");
    // ...and now the other one goes.
    await expect.poll(() => liveGuests(app), { timeout: 10000 }).toEqual(["/a"]);

    // A page with edited form fields is never discarded.
    await address.fill(`${origin}/form`);
    await submit(address);
    await expect(tabs.first()).toContainText("Fixture form", { timeout: 15000 });
    await inGuest(app, "/form", "document.getElementById('field').value = 'typed'; 1");
    await tabs.nth(1).click();
    await expect.poll(() => liveGuests(app), { timeout: 10000 }).toEqual(["/b", "/form"]);
    await page.waitForTimeout(2000);
    expect(await liveGuests(app)).toEqual(["/b", "/form"]);

    // Once the edit is undone it can go, like any other.
    await inGuest(app, "/form", "document.getElementById('field').value = 'start'; 1").catch(() => undefined);
    // (It was paused; the edit check retries after the discard delay.)
    await expect.poll(() => liveGuests(app), { timeout: 15000 }).toEqual(["/b"]);

    // Returning to a discarded app revives it without clicking a blank
    // placeholder, and restores the source page's reading position.
    await inGuest(app, "/b", "scrollTo(0, 900); 1");
    expect(await inGuest<number>(app, "/b", "scrollY")).toBe(900);
    await createBrowser(page, `${origin}/c`, "Fixture c");
    await page.locator(".canvas-background").click({ position: { x: 5, y: 5 } });
    // Over budget, pages on screen keep a picture (taken asynchronously; a
    // page already off-screen can't be captured).
    await page.waitForTimeout(1000);
    await pan(page, 8000);
    await expect.poll(async () => (await liveGuests(app)).length, { timeout: 10000 }).toBe(1);
    await pan(page, -8000);
    await expect.poll(() => liveGuests(app), { timeout: 10000 }).toContain("/b");
    await expect(page.locator(".browser-discarded:visible")).toHaveCount(0);
    await expect.poll(() => inGuest<number>(app, "/b", "scrollY"), { timeout: 10000 }).toBe(900);
    await page.screenshot({ path: "artifacts/browser-discard.png" });
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
