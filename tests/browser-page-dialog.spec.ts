import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";

// A page's confirm(), prompt() and alert() show as an Orvane card on the
// tab instead of Electron's native popup, and the page gets the answer.
test("page confirm, prompt and alert show as an Orvane card on their tab", async ({}, info) => {
  test.setTimeout(120_000);
  const site = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Record</title><p>Script record</p>");
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("Fixture port unavailable");
  const host = `127.0.0.1:${address.port}`;
  const url = `http://${host}/`;
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
  // Runs the call in the page without waiting for it: it blocks until answered.
  const inPage = (code: string) =>
    app.evaluate(({ webContents }, { url, code }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!;
      void guest.mainFrame.executeJavaScript(`setTimeout(() => { ${code} }, 0)`);
    }, { url, code });
  const title = () =>
    app.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === url)!.getTitle(), url);
  try {
    const page = await app.firstWindow();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    await browser.getByRole("textbox", { name: "Address" }).fill(url);
    await page.keyboard.press("Enter");
    await expect(browser.locator(".browser-tab.active")).toContainText("Record", { timeout: 15000 });
    const card = browser.getByRole("alertdialog", { name: `${host} asks` });

    // confirm(): the card names the site, the tab shows it waits; Esc cancels.
    await inPage(`document.title = "confirm:" + confirm("Are you sure you want to delete this record?")`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator(".page-dialog-message")).toHaveText("Are you sure you want to delete this record?");
    await expect(browser.locator(".browser-tab.active .tab-asks")).toBeVisible();
    await expect(card.getByRole("button", { name: "OK" })).toBeFocused();
    // Let the short fade-in finish before the screenshot.
    await page.waitForTimeout(600);
    await page.screenshot({ path: info.outputPath("page-confirm.png") });
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect.poll(title).toBe("confirm:false");
    await expect(browser.locator(".browser-tab.active .tab-asks")).toHaveCount(0);

    // OK answers true.
    await inPage(`document.title = "confirm:" + confirm("Delete again?")`);
    await card.getByRole("button", { name: "OK" }).click();
    await expect.poll(title).toBe("confirm:true");

    // prompt(): the default value is offered, Enter sends the typed answer.
    await inPage(`document.title = "prompt:" + prompt("Link URL:", "https://old.example")`);
    const answer = card.getByRole("textbox", { name: "Answer" });
    await expect(answer).toHaveValue("https://old.example");
    await expect(answer).toBeFocused();
    await answer.fill("https://new.example");
    await page.keyboard.press("Enter");
    await expect.poll(title).toBe("prompt:https://new.example");

    // alert(): only OK.
    await inPage(`alert("Saved."); document.title = "alert:done"`);
    await expect(card.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await card.getByRole("button", { name: "OK" }).click();
    await expect.poll(title).toBe("alert:done");
  } finally {
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});
