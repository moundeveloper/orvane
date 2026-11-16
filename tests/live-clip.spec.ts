import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createServer } from "node:http";

// A page with a target in the middle, so a clip has to find it on the page.
const fixture =
  '<!doctype html><title>Live fixture</title><style>body{margin:0;height:2400px;font:20px sans-serif}' +
  "#lead{height:500px;background:#eee}" +
  "#sample{margin-left:40px;width:320px;height:180px;background:royalblue;color:white;font:32px sans-serif}" +
  "#sample p{margin:0;padding:12px}</style>" +
  '<div id="lead">Lead</div><div id="sample"><p id="label">Status blue</p></div>' +
  // Never finishes downloading: the page stays "loading", like streaming
  // sites, and everything must still work.
  '<img src="/never" alt="">';

async function launch(info: import("@playwright/test").TestInfo, port: string) {
  const data = info.outputPath("data");
  return electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      ORVANE_PORT: port,
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
}
/** Runs code in every webview guest showing the URL, newest first. */
function inGuests(app: ElectronApplication, url: string, code: string) {
  return app.evaluate(
    async ({ webContents }, { url, code }) =>
      Promise.all(
        webContents
          .getAllWebContents()
          .filter((item) => item.getType() === "webview" && item.getURL() === url)
          .sort((a, b) => b.id - a.id)
          .map((item) => item.mainFrame.executeJavaScript(code)),
      ),
    { url, code },
  );
}
async function openPage(page: Page, url: string) {
  await expect(page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create Browser", exact: true }).click();
  const browser = page.locator(".browser-view");
  await browser.getByRole("textbox", { name: "Address" }).fill(url);
  await page.keyboard.press("Enter");
  await expect(browser.locator(".browser-tab.active")).toContainText("Live fixture", { timeout: 15000 });
  return browser;
}
async function tool(browser: ReturnType<Page["locator"]>, name: string) {
  await browser.getByRole("button", { name: "Browser menu" }).click();
  await browser.getByRole("menu").getByText("Browser tools", { exact: true }).click();
  await browser.getByRole("menu").getByText(name, { exact: true }).click();
}

test("Desktop pins a live area that shows the page itself, cropped", async ({}, info) => {
  test.setTimeout(150_000);
  const site = createServer((request, response) => {
    if (request.url === "/never") return; // Left open until the test ends.
    response.setHeader("content-type", "text/html");
    response.end(fixture);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("Fixture port unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  const app = await launch(info, "5212");
  try {
    const page = await app.firstWindow();
    const browser = await openPage(page, url);
    const [region] = (await inGuests(
      app,
      url,
      `(() => { window.scrollTo(0, 300); const r = document.querySelector('#sample').getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; })()`,
    )) as { x: number; y: number; width: number; height: number }[];
    await tool(browser, "Pin a live area");
    const crop = browser.locator(".browser-crop");
    const box = (await crop.boundingBox())!;
    const scale = await crop.evaluate(
      (element) => element.getBoundingClientRect().width / (element as HTMLElement).offsetWidth,
    );
    await page.mouse.move(box.x + region!.x * scale, box.y + region!.y * scale);
    await page.mouse.down();
    await page.mouse.move(box.x + (region!.x + region!.width) * scale, box.y + (region!.y + region!.height) * scale, {
      steps: 6,
    });
    await page.mouse.up();

    const clip = page.getByRole("region", { name: /Live clip · Live fixture/ });
    await expect(clip.locator(".live-clip-window.ready")).toBeVisible({ timeout: 20000 });
    // The clip is a second live copy of the page, not a picture.
    await expect.poll(async () => (await inGuests(app, url, "1")).length, { timeout: 15000 }).toBe(2);
    // It shows the area that was dragged: the clip page scrolled so #sample
    // sits where the window is aimed.
    const [shown] = (await inGuests(
      app,
      url,
      `(() => { const r = document.querySelector('#sample').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`,
    )) as { x: number; y: number }[];
    const windowBox = (await clip.locator(".live-clip-window").boundingBox())!;
    const pageBox = (await clip.locator("webview").boundingBox())!;
    const pageScale = pageBox.width / (await clip.locator("webview").evaluate((el) => (el as HTMLElement).offsetWidth));
    expect(Math.abs(pageBox.x + shown!.x * pageScale - windowBox.x)).toBeLessThan(3);
    expect(Math.abs(pageBox.y + shown!.y * pageScale - windowBox.y)).toBeLessThan(3);
    // The window keeps the dragged area's shape.
    expect(Math.abs(windowBox.width / windowBox.height - region!.width / region!.height)).toBeLessThan(0.05);
    // Changes on the page appear without any refresh.
    await inGuests(app, url, `document.querySelector('#label').textContent = 'Status red'`);
    const [text] = await inGuests(app, url, `document.querySelector('#label').textContent`);
    expect(text).toBe("Status red");
    await expect(clip.getByRole("button", { name: "Refresh clip" })).toHaveCount(0);
  } finally {
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});

test("Desktop pins a picked element live and can let it fill the clip", async ({}, info) => {
  test.setTimeout(150_000);
  const site = createServer((request, response) => {
    if (request.url === "/never") return; // Left open until the test ends.
    response.setHeader("content-type", "text/html");
    response.end(fixture);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("Fixture port unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  const app = await launch(info, "5213");
  try {
    const page = await app.firstWindow();
    const browser = await openPage(page, url);
    await inGuests(app, url, "window.scrollTo(0, 300)");
    await tool(browser, "Pin a live element");
    // Point at the label inside #sample, widen once to #sample, click.
    const view = browser.locator("webview.browser-webview").first();
    const viewBox = (await view.boundingBox())!;
    const viewScale = viewBox.width / (await view.evaluate((el) => (el as HTMLElement).offsetWidth));
    const [label] = (await inGuests(
      app,
      url,
      `(() => { const r = document.querySelector('#label').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 15 }; })()`,
    )) as { x: number; y: number }[];
    const at = { x: viewBox.x + label!.x * viewScale, y: viewBox.y + label!.y * viewScale };
    await page.mouse.move(at.x, at.y);
    await page.mouse.move(at.x + 2, at.y + 2);
    await expect
      .poll(async () => (await inGuests(app, url, "!!window.__orvaneClipPick"))[0], { timeout: 5000 })
      .toBe(true);
    await page.keyboard.press("ArrowUp");
    await page.mouse.click(at.x + 2, at.y + 2);

    const clip = page.getByRole("region", { name: /Live clip · Live fixture/ });
    await expect(clip.locator(".live-clip-window.ready")).toBeVisible({ timeout: 20000 });
    // Fit: the window has #sample's shape (320 × 180).
    const fitBox = (await clip.locator(".live-clip-window").boundingBox())!;
    expect(Math.abs(fitBox.width / fitBox.height - 320 / 180)).toBeLessThan(0.05);
    // The element is found again after its position on the page changes.
    await inGuests(app, url, `document.querySelector('#lead').style.height = '900px'`);
    await expect
      .poll(
        async () => {
          const [shown] = (await inGuests(
            app,
            url,
            `(() => { const r = document.querySelector('#sample').getBoundingClientRect(); return r.y; })()`,
          )) as number[];
          const windowBox = (await clip.locator(".live-clip-window").boundingBox())!;
          const pageBox = (await clip.locator("webview").boundingBox())!;
          const s = pageBox.width / (await clip.locator("webview").evaluate((el) => (el as HTMLElement).offsetWidth));
          return Math.abs(pageBox.y + shown! * s - windowBox.y) < 3;
        },
        { timeout: 10000 },
      )
      .toBe(true);
    // Fill: the element covers the clip's whole page.
    await clip.getByRole("button", { name: "Fill clip" }).click();
    await expect(clip.getByRole("button", { name: "Fit to page" })).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await inGuests(
              app,
              url,
              `(() => { const r = document.querySelector('#sample').getBoundingClientRect(); return Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight && r.x === 0; })()`,
            )
          )[0],
        { timeout: 10000 },
      )
      .toBe(true);
  } finally {
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});

test("A live clip whose page reloads while paused off-screen shows again when back on screen", async ({}, info) => {
  test.setTimeout(150_000);
  const site = createServer((request, response) => {
    if (request.url === "/never") return; // Left open until the test ends.
    response.setHeader("content-type", "text/html");
    response.end(fixture);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("Fixture port unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  const app = await launch(info, "5214");
  try {
    const page = await app.firstWindow();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 60000 });
    await page.evaluate((url) => {
      window.dispatchEvent(
        new CustomEvent("orvane:workbench-widget", {
          detail: {
            kind: "browser-clip",
            title: "Live clip · Live fixture",
            value: { mode: "live", pick: "element", selector: "#sample", url, rect: { x: 40, y: 500, width: 320, height: 180 },
              viewport: { width: 1000, height: 700 }, blockId: "none", tabId: "none" },
          },
        }),
      );
    }, url);
    const clip = page.getByRole("region", { name: /Live clip · Live fixture/ });
    await expect(clip.locator(".live-clip-window.ready")).toBeVisible({ timeout: 20000 });
    const pan = (dx: number) =>
      page.evaluate((dx) => window.dispatchEvent(new CustomEvent("orvane-canvas-pan", { detail: { dx, dy: 0 } })), dx);
    const responds = () =>
      app.evaluate(async ({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!;
        // Orvane pauses a page by attaching a debugger to it.
        return !guest.debugger.isAttached();
      }, url);
    // Off screen long enough to pause, then the page loads again.
    await pan(-6000);
    await expect.poll(responds, { timeout: 20000 }).toBe(false);
    await app.evaluate(({ webContents }, url) => {
      webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!.reload();
    }, url);
    await page.waitForTimeout(2000);
    await pan(6000);
    await expect.poll(responds, { timeout: 15000 }).toBe(true);
    await expect(clip.locator(".live-clip-window.ready")).toBeVisible({ timeout: 15000 });
    // And it still follows the element.
    await app.evaluate(({ webContents }, url) => {
      void webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!
        .mainFrame.executeJavaScript("document.querySelector('#lead').style.height = '800px'");
    }, url);
    await expect
      .poll(async () => {
        const windowBox = (await clip.locator(".live-clip-window").boundingBox())!;
        const pageBox = (await clip.locator("webview").boundingBox())!;
        const s = pageBox.width / (await clip.locator("webview").evaluate((el) => (el as HTMLElement).offsetWidth));
        const y = await app.evaluate(({ webContents }, url) =>
          webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!
            .mainFrame.executeJavaScript("document.querySelector('#sample').getBoundingClientRect().y"), url);
        return Math.abs(pageBox.y + (y as number) * s - windowBox.y) < 3;
      }, { timeout: 10000 })
      .toBe(true);
  } finally {
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});
