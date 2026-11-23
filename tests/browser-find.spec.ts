import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";

// Ctrl+F in a Browser page opens Orvane's find bar: matches are counted,
// Enter / Shift+Enter move between them and Esc closes the bar.
test("Ctrl+F finds text in the page with a count and next/previous", async ({}, info) => {
  test.setTimeout(120_000);
  const site = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><title>Scripts</title><table>" +
        ["customscript_orvane_test_mr", "customscript_ctk_vat", "customscript_orvane_qr_ue", "customscript_orvane_fc_cs"]
          .map((id) => `<tr><td>${id}</td></tr>`)
          .join("") +
        "</table>",
    );
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
      ORVANE_PORT: "5222",
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
    await browser.getByRole("textbox", { name: "Address" }).fill(url);
    await page.keyboard.press("Enter");
    await expect(browser.locator(".browser-tab.active")).toContainText("Scripts", { timeout: 15000 });

    // Ctrl+F pressed inside the page reaches the Browser.
    const bar = browser.getByRole("search", { name: "Find in page" });
    await expect
      .poll(async () => {
        await app.evaluate(({ webContents }, url) => {
          const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!;
          guest.focus();
          guest.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: ["control"] } as Electron.KeyboardInputEvent);
          guest.sendInputEvent({ type: "keyUp", keyCode: "F", modifiers: ["control"] } as Electron.KeyboardInputEvent);
        }, url);
        return bar.count();
      }, { timeout: 15000, intervals: [1000] })
      .toBe(1);
    const field = bar.getByRole("textbox", { name: "Find in page" });
    await expect(field).toBeFocused();
    await field.pressSequentially("customscript_orvane");
    const count = bar.locator(".browser-find-count");
    await expect(count).toHaveText("1 of 3");
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("2 of 3");
    await page.keyboard.press("Shift+Enter");
    await expect(count).toHaveText("1 of 3");
    await bar.getByRole("button", { name: "Next match" }).click();
    await expect(count).toHaveText("2 of 3");
    await field.fill("not on this page");
    await field.dispatchEvent("input");
    await expect(count).toHaveText("No matches");
    await page.waitForTimeout(300);
    await page.screenshot({ path: info.outputPath("find-bar.png") });
    await field.press("Escape");
    await expect(bar).toHaveCount(0);
    // Ctrl+F from the Browser itself opens it again with the last search selected.
    await browser.getByRole("textbox", { name: "Address" }).focus();
    await page.keyboard.press("Control+f");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("not on this page");
  } finally {
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});
