import { test, expect } from "./fixtures";

test("workspace titles show Orvane's tooltip with shortcuts instead of the system one", async ({ page }) => {
  // A cold Vite server can take ~30s to serve the app on this machine.
  test.setTimeout(120_000);
  await page.goto("/", { timeout: 90_000 });
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  const sticky = page.locator(".board-rail").getByRole("button", { name: "Sticky note", exact: true });
  await expect(sticky).toHaveAttribute("title", "Sticky note (Ctrl+Shift+N)");
  await sticky.hover();
  // The title is set aside while hovered, so the system tooltip never shows.
  await expect(sticky).not.toHaveAttribute("title", /.*/);
  const tooltip = page.locator(".app-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator("span")).toHaveText("Sticky note");
  await expect(tooltip.locator("kbd")).toHaveText("Ctrl+Shift+N");
  expect(await tooltip.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  // Leaving puts the title back and hides the tooltip.
  await page.mouse.move(5, 300);
  await expect(tooltip).toHaveCount(0);
  await expect(sticky).toHaveAttribute("title", "Sticky note (Ctrl+Shift+N)");
  await expect(sticky).toHaveAccessibleName("Sticky note");
});
