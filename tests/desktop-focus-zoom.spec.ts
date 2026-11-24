import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";

// Focus mode shows the app's own interface at actual size whatever the canvas
// zoom; only a Browser page keeps the size it was read at on the canvas, so
// focusing gives it more room without making its content bigger.
test("focus shows the app at actual size and keeps the page at its canvas zoom", async ({}, info) => {
  test.setTimeout(150000);
  const site = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>Zoom fixture</title><h1>Zoom fixture</h1>`);
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
      ORVANE_PORT: "5198",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    const bar = browser.getByRole("textbox", { name: "Address" });
    await bar.fill(`${origin}/`);
    await bar.focus();
    await page.keyboard.press("Enter");
    await expect(browser.locator(".browser-tab").first()).toContainText("Zoom fixture", { timeout: 15000 });
    await page.keyboard.press("Escape");

    // Zoom the canvas out with Ctrl+wheel over empty canvas.
    const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    await page.mouse.move(viewport.width - 30, viewport.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100);
    await page.keyboard.up("Control");
    const appScale = () =>
      page.locator(".canvas-app").first().evaluate((e) => e.getBoundingClientRect().width / (e as HTMLElement).offsetWidth);
    await expect.poll(appScale).toBeLessThan(0.95);
    await page.waitForTimeout(800);
    const canvasZoom = await appScale();
    // On-screen pixels per page CSS pixel.
    const pageScale = async () => {
      const width = await page.locator(".browser-webview").first().evaluate((e) => e.getBoundingClientRect().width);
      const inner = await app.evaluate(async ({ webContents }, origin) => {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.getURL().startsWith(origin))!;
        return guest.executeJavaScript("innerWidth");
      }, origin);
      return width / inner;
    };
    await expect.poll(pageScale).toBeCloseTo(canvasZoom, 1);

    await page.getByRole("button", { name: "Focus Browser full-window" }).click();
    await expect(page.locator(".canvas-app.focused-app")).toHaveCount(1);
    // The app's interface is at actual size, not the canvas zoom.
    await expect.poll(appScale).toBeCloseTo(1, 2);
    const barHeight = await bar.evaluate((e) => [e.getBoundingClientRect().height, (e as HTMLElement).offsetHeight]);
    expect(barHeight[0]).toBeCloseTo(barHeight[1]!, 1);
    // The page keeps the size it had on the canvas.
    await expect.poll(pageScale).toBeCloseTo(canvasZoom, 1);
    await page.screenshot({ path: info.outputPath("focused.png") });

    // Leaving focus gives the page back to the canvas zoom.
    await page.keyboard.press("Escape");
    await expect(page.locator(".canvas-app.focused-app")).toHaveCount(0);
    await expect.poll(appScale).toBeCloseTo(canvasZoom, 2);
    await expect.poll(pageScale).toBeCloseTo(canvasZoom, 1);
  } finally {
    await app.close();
    site.close();
  }
});
