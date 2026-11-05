import { test, expect } from "./fixtures";

test("slash menu scrolls the highlighted option with arrow keys at canvas zoom", async ({
  page,
}, info) => {
  await page.route("**/__orvane/notes/data", async (route) => {
    const args = route.request().postDataJSON();
    const timestamp = "2026-11-05";
    await route.fulfill({
      json:
        args.action !== "list"
          ? {}
          : args.collection === "pages"
            ? [
                {
                  id: "a",
                  title: "Slash menu",
                  type: "page",
                  parentId: null,
                  position: 0,
                  icon: null,
                  trashedAt: null,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ]
            : [
                {
                  id: "empty",
                  pageId: "a",
                  type: "paragraph",
                  html: "",
                  indent: 0,
                  position: 0,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ],
    });
  });
  await page.goto("/tests/notes-slash.html");
  await page.waitForFunction(
    () => typeof (window as any).mountNotesLoadingFixture === "function",
  );
  await page.evaluate(() => {
    (window as any).notesSlashFixture = (
      window as any
    ).mountNotesLoadingFixture();
    document.getElementById("notes-loading-fixture")!.style.cssText =
      "position:fixed;left:80px;top:80px;width:1000px;height:600px;transform:scale(.6);transform-origin:top left;z-index:500;background:white";
  });
  const content = page.locator(".block-content").first();
  await content.click();
  await page.keyboard.type("/");
  const menu = page.locator(".slash-menu");
  await expect(menu).toBeVisible();
  const noteScroll = await page
    .locator(".notes-page-scroll")
    .evaluate((el) => el.scrollTop);
  const highlightedIsVisible = () =>
    menu.evaluate((el) => {
      const selected = el
        .querySelector(".menu-item.selected")!
        .getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      return selected.top >= bounds.top && selected.bottom <= bounds.bottom;
    });
  for (let index = 1; index < 14; index++) {
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator(".selected")).toHaveText(
      (await menu.locator(".menu-item").nth(index).innerText()).trim(),
    );
    await expect.poll(highlightedIsVisible).toBe(true);
  }
  expect(await menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await menu.screenshot({ path: info.outputPath("slash-menu-bottom.png") });
  await expect(content).toBeFocused();
  for (let index = 13; index > 0; index--) {
    await page.keyboard.press("ArrowUp");
    await expect.poll(highlightedIsVisible).toBe(true);
  }
  expect(
    await page.locator(".notes-page-scroll").evaluate((el) => el.scrollTop),
  ).toBe(noteScroll);
  await page.keyboard.type("code");
  await expect(menu.locator(".menu-item")).toHaveCount(1);
  await expect.poll(highlightedIsVisible).toBe(true);
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".type-code")).toHaveCount(1);
  await page.evaluate(() => (window as any).notesSlashFixture.unmount());
});
