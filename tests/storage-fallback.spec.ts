import { test, expect } from "./fixtures";

test("a broken IndexedDB never blocks loading or editing", async ({ page }) => {
  await page.addInitScript(() => {
    // What Chromium reports when the profile's IndexedDB is locked or unreadable.
    indexedDB.open = () => {
      throw new DOMException(
        "Internal error opening backing store for indexedDB.open.",
        "UnknownError",
      );
    };
  });
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
  await expect(page.getByText("Internal error opening backing store")).toHaveCount(0);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  await expect(page.locator(".ns-workspace")).toBeVisible();
  await page.locator('main[data-saved="true"]').waitFor();
  await page.reload();
  await expect(page.locator(".ns-workspace")).toBeVisible();
});
