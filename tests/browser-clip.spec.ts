import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";

test("Desktop pins a region and refreshes it from the live Browser page", async ({}, info) => {
  test.setTimeout(120_000);
  let signInRequired = false;
  const site = createServer((request, response) => {
    if (request.url === "/sign-in") {
      response.setHeader("Set-Cookie", "clip-session=active; Path=/; HttpOnly");
      return response.end("Signed in");
    }
    if (request.url === "/login") return response.end("<title>Sign in</title>Sign in");
    if (signInRequired && !request.headers.cookie?.includes("clip-session=active")) {
      response.writeHead(302, { Location: "/login" });
      return response.end();
    }
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><title>Clip fixture</title><style>body{margin:0;height:1800px} #sample{position:absolute;top:150px;left:24px;width:330px;height:165px;background:royalblue;color:white;font:36px sans-serif;}</style><div id="sample">Status blue</div>',
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string")
    throw Error("Fixture port unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ORVANE_PORT: "5211",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({
      timeout: 60000,
    });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page
      .getByRole("button", { name: "Create Browser", exact: true })
      .click();
    const browser = page.locator(".browser-view");
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    await addressBar.fill(url);
    await page.keyboard.press("Enter");
    await expect(browser.locator(".browser-tab.active")).toContainText(
      "Clip fixture",
      { timeout: 15000 },
    );
    const region = (await app.evaluate(async ({ webContents }, origin) => {
      const guest = webContents
        .getAllWebContents()
        .find(
          (item) => item.getType() === "webview" && item.getURL() === origin,
        )!;
      return guest.executeJavaScript(
        `(() => { window.scrollTo(0, 120); const r = document.querySelector('#sample').getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; })()`,
      );
    }, url)) as { x: number; y: number; width: number; height: number };
    await browser.getByRole("button", { name: "Browser menu" }).click();
    await browser
      .getByRole("menu")
      .getByText("Browser tools", { exact: true })
      .click();
    await browser
      .getByRole("menu")
      .getByText("Pin a snapshot clip", { exact: true })
      .click();
    const crop = browser.locator(".browser-crop");
    const box = await crop.boundingBox();
    const scale = await crop.evaluate(
      (element) =>
        element.getBoundingClientRect().width /
        (element as HTMLElement).offsetWidth,
    );
    await page.mouse.move(
      box!.x + (region.x + 5) * scale,
      box!.y + (region.y + 5) * scale,
    );
    await page.mouse.down();
    await page.mouse.move(
      box!.x + (region.x + region.width - 5) * scale,
      box!.y + (region.y + region.height - 5) * scale,
      { steps: 6 },
    );
    await page.mouse.up();
    const clip = page.getByRole("region", { name: /Clip · Clip fixture/ });
    const picture = clip.getByRole("img", {
      name: "Clipped area of the source page",
    });
    await expect(picture).toBeVisible({ timeout: 15000 });
    const original = await picture.getAttribute("src");
    await app.evaluate(async ({ webContents }, origin) => {
      const guest = webContents
        .getAllWebContents()
        .find(
          (item) => item.getType() === "webview" && item.getURL() === origin,
        )!;
      await guest.executeJavaScript(
        `document.querySelector('#sample').style.background = 'orangered'; document.querySelector('#sample').textContent = 'Status red'; window.scrollTo(0, 0)`,
      );
    }, url);
    await clip.getByRole("button", { name: "Refresh clip" }).click();
    await expect(clip.getByRole("status")).toHaveText("Clip refreshed.", {
      timeout: 15000,
    });
    await expect(picture).not.toHaveAttribute("src", original!);
    await clip.getByRole("button", { name: "Open original" }).click();
    await expect(browser.locator(".browser-tab")).toHaveCount(1);
    await expect(addressBar).toHaveValue(url);

    signInRequired = true;
    await browser.getByRole("button", { name: "Browser menu" }).click();
    await browser.getByRole("menu").getByText("Browser tools", { exact: true }).click();
    await browser.getByRole("menu").getByText("Pin a live area", { exact: true }).click();
    const liveBounds = (await crop.boundingBox())!;
    const liveScale = await crop.evaluate((element) => element.getBoundingClientRect().width / (element as HTMLElement).offsetWidth);
    await page.mouse.move(liveBounds.x + 30 * liveScale, liveBounds.y + 155 * liveScale);
    await page.mouse.down();
    await page.mouse.move(liveBounds.x + 280 * liveScale, liveBounds.y + 275 * liveScale, { steps: 6 });
    await page.mouse.up();
    const live = page.locator(".live-clip-view");
    const livePage = live.locator("webview");
    await expect(livePage).toBeAttached();
    const getLiveUrl = () => livePage.evaluate((element) => (element as HTMLElement & { getURL(): string }).getURL()).catch(() => "");
    await expect.poll(getLiveUrl).toBe(`${url}login`);
    await app.evaluate(async ({ webContents }, origin) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview" && item.getURL() === origin)!;
      await guest.mainFrame.executeJavaScript("fetch('/sign-in').then(response => response.text())");
    }, url);
    await live.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(getLiveUrl).toBe(url);
    await expect(addressBar).toHaveValue(url);
  } finally {
    await app.close();
    site.close();
  }
});
