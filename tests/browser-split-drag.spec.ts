import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";

test("Browser split drag crosses live Electron webviews", async ({}, info) => {
  test.setTimeout(120000);
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<title>Split fixture ${request.url}</title><p>${request.url}</p>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no port");
  const url = `http://127.0.0.1:${address.port}`;
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ORVANE_PORT: "5226",
      ORVANE_DATA_DIR: info.outputPath("data"),
      ORVANE_MCP_STATE_DIR: info.outputPath("data"),
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(async () => {
      const component = "/src/components/BrowserView.vue";
      const view = await import(component).catch(() => null);
      return !!view && !!document.querySelector('main[data-ready="true"]');
    });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    await addressBar.fill(url + "/first");
    await addressBar.press("Enter");
    await expect(browser.locator(".browser-tab.active")).toContainText("Split fixture /first");
    await browser.getByRole("button", { name: "New tab", exact: true }).click();
    await addressBar.fill(url + "/second");
    await addressBar.press("Enter");
    await expect(browser.locator(".browser-tab.active")).toContainText("Split fixture /second");
    const panel = await browser.locator(".browser-page").boundingBox();
    if (!panel) throw new Error("Missing page bounds");
    const drag = async (source: ReturnType<typeof browser.locator>) => {
      await source.hover();
      await page.mouse.down();
      await page.mouse.move(panel.x + panel.width * 0.75, panel.y + panel.height * 0.4, { steps: 8 });
      await expect(page.locator(".browser-drag-preview.detached")).toBeVisible();
      await expect(source).toBeHidden();
      await expect(browser.locator(".browser-split-target .drop-selected")).toHaveText("Split Right");
      await page.mouse.up();
    };
    await drag(browser.locator(".browser-tab", { hasText: "Split fixture /first" }));
    await expect(browser.locator("webview.pane-second")).toHaveAttribute("src", url + "/first");
    await drag(browser.locator(".inline-split .browser-tab", { hasText: "Split fixture /second" }));
    await expect(browser.locator("webview.pane-first")).toHaveAttribute("src", url + "/first");
    await expect(browser.locator("webview.pane-second")).toHaveAttribute("src", url + "/second");
  } finally {
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});
