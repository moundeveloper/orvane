import { expect, test, _electron as electron } from "@playwright/test";

test("desktop inbox keeps clipboard captures and moves them into Orvane", async ({}, info) => {
  test.setTimeout(120_000);
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ORVANE_PORT: "5208",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({
      timeout: 60_000,
    });
    const url = "https://example.com/release-notes";
    await app.evaluate(({ BrowserWindow, clipboard, nativeImage }, text) => {
      // Use the same Electron IPC path while leaving the system clipboard alone.
      clipboard.readImage = () => nativeImage.createEmpty();
      clipboard.readText = () => text;
      BrowserWindow.getAllWindows()[0]!.webContents.send(
        "orvane:inbox-capture",
      );
    }, url);
    const inbox = page.getByRole("dialog", { name: "Workspace inbox" });
    await expect(inbox.getByText(url, { exact: true })).toBeVisible();
    await inbox
      .getByRole("textbox", { name: "New capture" })
      .fill("Review the release notes");
    await inbox.getByRole("button", { name: "Save capture" }).click();

    await app.evaluate(({ clipboard, nativeImage }) => {
      clipboard.readImage = () =>
        nativeImage.createFromBitmap(Buffer.from([95, 100, 150, 255]), {
          width: 1,
          height: 1,
        });
    });
    await inbox.getByRole("button", { name: "Capture clipboard" }).click();
    const image = inbox.getByRole("img", { name: "Captured clipboard image" });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(1);
    await inbox.getByRole("button", { name: "Close inbox" }).click();
    await expect(page.locator('main[data-saved="true"]')).toBeVisible();

    const options = page.getByRole("button", { name: "Workspace options" });
    await options.click();
    await page.evaluate(() => {
      // Capture the exported bytes without opening Electron's save dialog.
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download.startsWith("orvane-")) return click.call(this);
        HTMLAnchorElement.prototype.click = click;
        void fetch(this.href)
          .then((res) => res.text())
          .then((data) => {
            document.documentElement.dataset.testBackup = data;
          });
      };
    });
    await page
      .getByRole("button", { name: "Export backup", exact: true })
      .click();
    const exported = page.locator("html[data-test-backup]");
    await expect(exported).toHaveCount(1);
    const backup = JSON.parse(
      (await exported.getAttribute("data-test-backup"))!,
    );
    const imageId = backup.workspace.inbox.find(
      (capture: { kind: string }) => capture.kind === "image",
    ).value;
    expect(backup.images[imageId]).toBeTruthy();

    await page.reload();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible();
    await options.click();
    await page
      .getByRole("button", { name: "Workspace inbox", exact: true })
      .click();
    await expect(inbox.getByRole("listitem")).toHaveCount(3);
    // Triage: pick a row, then act with its button or its key.
    await inbox.getByRole("listitem").filter({ hasText: "release-notes" }).getByRole("button").first().click();
    await expect(inbox.getByText(url, { exact: true })).toBeVisible();
    await inbox.getByRole("button", { name: "Sticky note" }).click();
    await expect(inbox.getByRole("listitem")).toHaveCount(2);
    await inbox.getByRole("listitem").filter({ hasText: "Review the release notes" }).getByRole("button").first().click();
    await page.keyboard.press("c");
    await expect(inbox.getByRole("listitem")).toHaveCount(1);
    await expect(inbox.getByText("1 to sort")).toBeVisible();
    await expect(inbox.getByText("2 sorted today")).toBeVisible();
    await inbox.getByRole("button", { name: "Place on canvas" }).click();
    await expect(inbox.getByText("No captures yet.")).toBeVisible();
    await inbox.getByRole("textbox", { name: "New capture" }).fill("Plan the inbox page\nSecond line");
    await inbox.getByRole("button", { name: "Save capture" }).click();
    await inbox.getByRole("listitem").getByRole("button").first().click();
    await page.keyboard.press("s");
    await expect(inbox.getByRole("status")).toHaveText("Sent to Notes.");
    await expect(inbox.getByText("No captures yet.")).toBeVisible();
    await inbox.getByRole("button", { name: "Close inbox" }).click();
    await expect(page.locator(".board-note")).toContainText(url);
    await expect(
      page.getByRole("textbox", { name: "Item", exact: true }),
    ).toHaveValue("Review the release notes");
    await expect(
      page.locator(`img[src="/__orvane/files/image/${imageId}"]`),
    ).toHaveCount(1);
  } finally {
    await app.close();
  }
});
