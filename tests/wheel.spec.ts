import { test, expect } from "./fixtures";

test("releasing Tab in the center opens a centered config popup with a blurred backdrop", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page
    .locator(".canvas-background")
    .click({ position: { x: 720, y: 500 } });
  await page.keyboard.down("Tab");
  await expect(
    page.getByRole("button", { name: "Edit wheel config" }),
  ).toBeVisible();
  await page.keyboard.up("Tab");
  const dialog = page.getByRole("dialog", { name: "Edit action wheel" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("transform", "none");
  const bounds = await dialog.boundingBox();
  expect(Math.abs(bounds!.x + bounds!.width / 2 - 720)).toBeLessThan(2);
  expect(Math.abs(bounds!.y + bounds!.height / 2 - 500)).toBeLessThan(2);
  await expect(page.locator(".wheel-config-backdrop")).toHaveCSS(
    "backdrop-filter",
    "blur(4px)",
  );
  await expect(
    page.getByRole("button", { name: "Close wheel editor" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Action library", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close wheel editor" }),
  ).toBeFocused();
  await page.screenshot({ path: "artifacts/wheel-config-popup.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("wheel groups and app entries persist and support nested navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Edit action wheel" }).click();
  await page.getByRole("button", { name: "Add group" }).click();
  await page.getByLabel("Wheel entry name").fill("Apps");
  await page.getByRole("button", { name: "Open group" }).click();
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await page
    .getByRole("button", { name: "Create action", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Go to app preset", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Target app", exact: true }).click();
  await page.getByRole("option", { name: "Daily list", exact: true }).click();
  await page.getByRole("button", { name: "Close action library" }).click();
  await page.getByLabel("Wheel entry name").fill("Visit app");
  await expect(page.locator(".wheel-editor select")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Assigned action" }).click();
  await expect(
    page.getByRole("listbox", { name: "Assigned action" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close wheel editor" }).click();
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page.mouse.move(720, 200);
  await page
    .locator(".canvas-background")
    .click({ position: { x: 720, y: 200 } });
  await page.keyboard.down("Tab");
  await expect(page.getByLabel("Action wheel")).toBeVisible();
  for (let i = 0; i < 5; i++) await page.keyboard.down("Tab");
  await expect(page.locator("body")).toBeFocused();
  await expect(page.getByRole("button", { name: /Apps/ })).toBeVisible();
  await expect(page.locator(".radial-entry")).toHaveCount(6);
  await page.screenshot({ path: "artifacts/action-wheel-ring.png" });
  await page
    .getByRole("button", { name: /Apps/ })
    .click({ position: { x: 180, y: 50 } });
  await expect(page.getByRole("button", { name: "Visit app" })).toBeVisible();
  await page.mouse.click(720, 500, { button: "right" });
  await expect(page.getByRole("button", { name: /Apps/ })).toBeVisible();
  await page.mouse.click(720, 150);
  await expect(page.getByRole("button", { name: "Visit app" })).toBeVisible();
  await page.mouse.click(720, 500, { button: "right" });
  await page.keyboard.up("Tab");
  await expect(page.locator('.radial-overlay')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Edit action wheel' })).toBeVisible();
});

test("wheel consumes held Tab after cancellation and releases normal focus navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page
    .locator(".canvas-background")
    .click({ position: { x: 720, y: 200 } });
  await page.keyboard.down("Tab");
  await expect(page.getByLabel("Action wheel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Action wheel")).toHaveCount(0);
  await page.keyboard.down("Tab");
  await expect(page.locator("body")).toBeFocused();
  await page.keyboard.up("Tab");
  const options = page.getByRole("button", { name: "Workspace options" });
  await options.focus();
  await page.keyboard.press("Tab");
  await expect(options).not.toBeFocused();
  await expect(page.getByLabel("Action wheel")).toHaveCount(0);
});
