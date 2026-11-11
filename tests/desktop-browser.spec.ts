import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";

// Desktop-only Browser features: links inside a real page (<webview>) open in
// a Peek or a Split View, a pinned page previews links that leave its site,
// shortcuts work while the page has focus, and a page can be captured.
test("links in a desktop page open in Peek and Split View", async ({}, info) => {
  test.setTimeout(120000);
  const site = createServer((request, response) => {
    const name = (request.url || "/").slice(1) || "home";
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><title>Fixture ${name}</title><h1>${name}</h1>` +
        `<a id="same" href="/two">two</a> <a id="away" href="http://localhost:${port}/away">away</a>`,
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const port = address.port;
  const origin = `http://127.0.0.1:${port}`;
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
    await bar.fill(`${origin}/one`);
    await bar.focus();
    await page.keyboard.press("Enter");
    const tabs = browser.locator(".browser-tab");
    await expect(tabs.first()).toContainText("Fixture one", { timeout: 15000 });

    // Click a link in the first page, optionally with a modifier held.
    const clickLink = (selector: string, modifiers: string[] = []) =>
      app.evaluate(
        async ({ webContents }, { selector, modifiers, first }) => {
          const guest = webContents
            .getAllWebContents()
            .find((c) => c.getType() === "webview" && c.getURL() === first)!;
          const pos = await guest.executeJavaScript(
            `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
          );
          const input = { button: "left" as const, clickCount: 1, modifiers: modifiers as any, ...pos };
          guest.sendInputEvent({ type: "mouseDown", ...input });
          guest.sendInputEvent({ type: "mouseUp", ...input });
        },
        { selector, modifiers, first: `${origin}/one` },
      );
    const guests = () =>
      app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((c) => c.getType() === "webview")
          .map((c) => c.getURL())
          .sort(),
      );

    // Shift-click: a Peek over the page; the page itself stays where it was.
    await clickLink("#same", ["shift"]);
    const peek = browser.getByRole("toolbar", { name: "Peek View" });
    await expect(peek).toBeVisible();
    await expect.poll(guests).toEqual([`${origin}/one`, `${origin}/two`]);
    await expect(tabs).toHaveCount(1);
    await page.screenshot({ path: "artifacts/desktop-peek.png" });
    await peek.getByRole("button", { name: "Close Peek" }).click();
    await expect.poll(guests).toEqual([`${origin}/one`]);

    // Alt-click: the link opens beside the page as a Split View.
    await clickLink("#same", ["alt"]);
    await expect(browser.getByRole("toolbar", { name: "Split View" })).toBeVisible();
    await expect(tabs).toHaveCount(2);
    await expect.poll(guests).toEqual([`${origin}/one`, `${origin}/two`]);
    const panes = browser.locator("webview:not(.browser-hidden)");
    await expect(panes).toHaveCount(2);
    await expect(bar).toHaveValue(`${origin}/two`);
    await clickLink("h1");
    await expect(bar).toHaveValue(`${origin}/one`);
    await page.screenshot({ path: "artifacts/desktop-split.png" });
    await browser
      .getByRole("toolbar", { name: "Split View" })
      .getByRole("button", { name: "Close Split View", exact: true })
      .first()
      .click();
    await expect(panes).toHaveCount(1);

    // Pinned: a link to another site previews in a Peek; a same-site link
    // navigates as usual.
    await tabs.first().click({ button: "right" });
    await browser.getByRole("menu").getByText("Pin tab", { exact: true }).click();
    await expect(tabs.first()).toHaveClass(/pinned/);
    await page.waitForTimeout(400);
    await clickLink("#away");
    await expect(peek).toBeVisible();
    await expect
      .poll(guests)
      .toContain(`http://localhost:${port}/away`);
    expect(await guests()).toContain(`${origin}/one`);
    await page.keyboard.press("Escape");
    await peek.getByRole("button", { name: "Close Peek" }).click().catch(() => undefined);
    await expect(peek).toBeHidden();

    // A shortcut pressed inside the page reaches the Browser: Ctrl+L.
    await app.evaluate(({ webContents }, first) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === "webview" && c.getURL() === first)!;
      guest.focus();
      guest.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: ["control"] });
      guest.sendInputEvent({ type: "keyUp", keyCode: "L", modifiers: ["control"] });
    }, `${origin}/one`);
    await expect(bar).toBeFocused();

    // Capturing a page copies a PNG: record what is written, without
    // touching the real clipboard.
    await page.evaluate(() => {
      const w = window as any;
      w.copied = [] as { width: number; height: number }[];
      navigator.clipboard.write = async (items: ClipboardItem[]) => {
        const bitmap = await createImageBitmap(await items[0]!.getType("image/png"));
        w.copied.push({ width: bitmap.width, height: bitmap.height });
      };
    });
    const copied = () =>
      page.evaluate(() => (window as any).copied as { width: number; height: number }[]);
    const shoot = async (item: string) => {
      await browser.getByRole("button", { name: "Browser menu" }).click();
      const menu = browser.getByRole("menu");
      await menu.getByText("Browser tools", { exact: true }).click();
      await menu.getByText(item, { exact: true }).click();
    };
    await shoot("Screenshot: visible page");
    await expect(browser.getByRole("status")).toContainText("Screenshot copied");
    await expect.poll(async () => (await copied()).length).toBe(1);
    const visible = (await copied())[0]!;
    expect(visible.width).toBeGreaterThan(100);
    // The whole page, through a short debugger session.
    await shoot("Screenshot: full page");
    await expect.poll(async () => (await copied()).length).toBe(2);
    expect((await copied())[1]!.width).toBeGreaterThan(100);
    // A dragged area is smaller than the page.
    await shoot("Screenshot: select an area");
    const box = (await browser.locator(".browser-crop").boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 160, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await copied()).length).toBe(3);
    expect((await copied())[2]!.width).toBeLessThan(visible.width);
  } finally {
    await app.close();
    site.close();
  }
});
