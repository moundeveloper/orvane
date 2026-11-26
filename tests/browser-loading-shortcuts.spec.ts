import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createServer } from "node:http";

// Streaming sites can stay "loading" for minutes; Browser shortcuts pressed
// in such a page must work anyway.
test("Ctrl+T and Ctrl+Shift+T work in a page that never finishes loading", async ({}, info) => {
  test.setTimeout(120_000);
  const site = createServer((request, response) => {
    if (request.url === "/never") return; // Left open until the test ends.
    response.setHeader("content-type", "text/html");
    if (request.url === "/done") return response.end("<!doctype html><title>Finished</title><p>Loaded.</p>");
    response.end('<!doctype html><title>Still loading</title><p>Page</p><img src="/never" alt="">');
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("Fixture port unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      ORVANE_PORT: "5220",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  // Keys typed in the page itself (Playwright's keyboard reaches the window).
  const pressInPage = (app: ElectronApplication, modifiers: string[]) =>
    app.evaluate(({ webContents }, { url, modifiers }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!;
      guest.focus();
      guest.sendInputEvent({ type: "keyDown", keyCode: "T", modifiers } as Electron.KeyboardInputEvent);
      guest.sendInputEvent({ type: "keyUp", keyCode: "T", modifiers } as Electron.KeyboardInputEvent);
    }, { url, modifiers });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    await addressBar.fill(url);
    await page.keyboard.press("Enter");
    await expect(browser.locator(".browser-tab.active")).toContainText("Still loading", { timeout: 15000 });
    expect(
      await app.evaluate(({ webContents }, url) =>
        webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!.isLoadingMainFrame(), url),
    ).toBe(true);
    const stop = browser.getByRole("button", { name: "Stop loading", exact: true });
    await expect(stop).toBeVisible();
    await expect(browser.locator(".browser-tab.active .tab-load-ring")).toBeVisible();
    const controlBox = await stop.boundingBox();
    const tabs = browser.locator(".browser-tab");
    await expect(tabs).toHaveCount(1);
    await expect
      .poll(async () => {
        await pressInPage(app, ["control"]);
        return tabs.count();
      }, { timeout: 15000, intervals: [1000] })
      .toBeGreaterThan(1);
    const opened = await tabs.count();
    await expect(browser.getByRole("button", { name: "Stop loading", exact: true })).toHaveCount(0);
    await expect(browser.locator(".browser-tab:not(.active) .tab-load-ring")).toBeVisible();
    // Close the new tabs, back to the page, then reopen them from the page.
    for (let i = 1; i < opened; i++) {
      await addressBar.click();
      await page.keyboard.press("Control+w");
    }
    await expect(tabs).toHaveCount(1);
    await expect(browser.locator(".browser-tab.active")).toContainText("Still loading");
    for (let i = 1; i < opened; i++) {
      await pressInPage(app, ["control", "shift"]);
      await expect(tabs).toHaveCount(1 + i);
      await browser.locator(".browser-tab", { hasText: "Still loading" }).click();
    }
    await stop.click();
    const reload = browser.getByRole("button", { name: "Reload", exact: true });
    await expect(reload).toBeVisible();
    expect(await reload.boundingBox()).toEqual(controlBox);
    await expect(browser.locator(".browser-tab.active .tab-load-ring")).toHaveCount(0);
    await addressBar.fill(url + "done");
    await addressBar.evaluate((input) => (input as HTMLInputElement).form!.requestSubmit());
    await expect(browser.locator(".browser-tab.active")).toContainText("Finished");
    await expect(reload).toBeVisible();
    await addressBar.fill("http://127.0.0.1:1/");
    await addressBar.evaluate((input) => (input as HTMLInputElement).form!.requestSubmit());
    await expect(browser.locator(".browser-error")).toBeVisible();
    await expect(reload).toBeVisible();
    await expect(browser.locator(".browser-tab.active .tab-load-ring")).toHaveCount(0);
  } finally {
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});

test("Ctrl+T and Ctrl+Shift+T reach a Browser app selected by its frame", async ({}, info) => {
  test.setTimeout(120_000);
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      ORVANE_PORT: "5221",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    const tabs = browser.locator(".browser-tab");
    await expect(tabs).toHaveCount(1);
    const frame = page.locator(".canvas-app", { has: browser });
    const title = frame.locator(".app-topline");
    const box = (await title.boundingBox())!;
    // The empty middle of the title bar: no button, no text field.
    const press = async (keys: string) => {
      await page.mouse.click(box.x + box.width * 0.55, box.y + box.height / 2);
      // Clicking the frame leaves focus wherever it was; the case here is
      // focus on the canvas, outside the Browser.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(await page.evaluate(() => !!document.activeElement?.closest(".browser-view"))).toBe(false);
      await page.keyboard.press(keys);
    };
    await press("Control+t");
    await expect(tabs).toHaveCount(2);
    await press("Control+t");
    await expect(tabs).toHaveCount(3);
    // Close both new tabs, then bring them back one press at a time.
    for (let i = 0; i < 2; i++) {
      await browser.getByRole("textbox", { name: "Address" }).click();
      await page.keyboard.press("Control+w");
    }
    await expect(tabs).toHaveCount(1);
    await press("Control+Shift+t");
    await expect(tabs).toHaveCount(2);
    await press("Control+Shift+t");
    await expect(tabs).toHaveCount(3);

    // The other Browser shortcuts act on the current tab too, without first
    // clicking a tab or the page.
    const active = browser.locator(".browser-tab.active");
    const activeId = await active.getAttribute("data-drag-tab");
    // The closed tab leaves the list at once (no slide-out animation).
    await page.evaluate(() => {
      const w = window as unknown as { slid?: string[] };
      w.slid = [];
      new MutationObserver((records) => records.forEach((r) => {
        const el = r.target as HTMLElement;
        if (el.dataset?.closing !== undefined) {
          w.slid!.push(el.dataset.dragTab ?? "");
          // The slide-out is quick: at most 100ms before the tab leaves.
          const timing = el.getAnimations()[0]?.effect?.getTiming();
          (w as { slideMs?: number }).slideMs = Number(timing?.duration);
        }
      })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-closing"] });
    });
    await press("Control+w");
    await expect(tabs).toHaveCount(2);
    // Closing is instant: the tab never slides out first.
    expect(await page.evaluate(() => (window as unknown as { slid: string[] }).slid)).toEqual([]);
    // A short list has nothing to scroll: no scrollbar on the tabs.
    expect(await browser.locator(".browser-side .browser-tabs").evaluate((list) => list.scrollHeight - list.clientHeight)).toBeLessThanOrEqual(0);
    await expect(browser.locator(`[data-drag-tab="${activeId}"]`)).toHaveCount(0);
    const first = await tabs.first().getAttribute("data-drag-tab");
    await press("Control+1");
    await expect(active).toHaveAttribute("data-drag-tab", first!);
    const second = await tabs.nth(1).getAttribute("data-drag-tab");
    await press("Control+2");
    await expect(active).toHaveAttribute("data-drag-tab", second!);
    // Ctrl+Tab's switcher commits when Ctrl is released on the canvas.
    await press("Control+Tab");
    await expect(browser.locator(".browser-switcher")).toHaveCount(0);
    await expect(active).toHaveAttribute("data-drag-tab", first!);
  } finally {
    await app.close();
  }
});
