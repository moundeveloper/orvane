import { test, expect } from "./fixtures";

test("action results dismiss automatically after leaving the action library", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Action library", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Go to app preset", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Target app", exact: true }).click();
  await page.getByRole("option", { name: "Daily list", exact: true }).click();
  await page.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(
    page.getByText("Action completed.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close action library" }).click();
  const toast = page.locator(".action-notice");
  await expect(toast).toHaveText("Action completed.");
  await expect(toast).toBeHidden({ timeout: 5000 });
});

test("releasing Alt+Q in the center opens a centered config popup with a blurred backdrop", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page
    .locator(".canvas-background")
    .click({ position: { x: 720, y: 500 } });
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect(
    page.getByRole("button", { name: "Edit wheel config" }),
  ).toBeVisible();
  await page.keyboard.up("Alt");
  await page.keyboard.up("q");
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
  await page
    .getByRole("button", { name: "Action library", exact: true })
    .click();
  await page.getByRole("button", { name: "New action", exact: true }).click();
  await page.getByLabel("Action name").fill("Existing action");
  await page.getByRole("button", { name: "Close action library" }).click();
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Edit action wheel" }).click();
  await page.getByRole("button", { name: "Add group" }).click();
  await page.getByLabel("Wheel entry name").fill("Apps");
  await page.getByRole("button", { name: "Open group" }).click();
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await page
    .getByRole("button", { name: "Create action", exact: true })
    .click();
  await expect(page.getByLabel("Action name")).toHaveValue("New action");
  await expect(
    page
      .getByRole("navigation", { name: "Shared actions" })
      .getByText("Existing action"),
  ).toBeVisible();
  await expect(page.locator(".vue-flow__node")).toHaveCount(1);
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  await page.getByRole("button", { name: "Go to app", exact: true }).click();
  const targetApp = page.getByRole("combobox", {
    name: "Target app",
    exact: true,
  });
  await targetApp.click();
  const search = page.getByRole("combobox", { name: "Search apps" });
  await expect(search).toBeFocused();
  await search.fill("no such app");
  await expect(page.getByText("No matches")).toBeVisible();
  await search.fill("LY LI");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: "Daily list", exact: true }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(targetApp).toHaveText("Daily list");
  await page.getByRole("button", { name: "Close action library" }).click();
  await expect(
    page.getByRole("combobox", { name: "Assigned action" }),
  ).toHaveText("New action");
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
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect(page.getByLabel("Action wheel")).toBeVisible();
  for (let i = 0; i < 5; i++) await page.keyboard.down("q");
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
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  await expect(page.locator(".radial-overlay")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Edit action wheel" }),
  ).toBeVisible();
});

test("wheel consumes the held shortcut after cancellation and releases normal focus navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page
    .locator(".canvas-background")
    .click({ position: { x: 720, y: 200 } });
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect(page.getByLabel("Action wheel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Action wheel")).toHaveCount(0);
  await page.keyboard.down("q");
  await expect(page.locator("body")).toBeFocused();
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  const options = page.getByRole("button", { name: "Workspace options" });
  await options.focus();
  await page.keyboard.press("Tab");
  await expect(options).not.toBeFocused();
  await expect(page.getByLabel("Action wheel")).toHaveCount(0);
});

test("arrow keys drive the open wheel: Left/Right select, Up enters a group, Down goes back, release runs", async ({
  page,
}) => {
  const { emptyWorkspace, makeBlock } = await import("../src/model");
  const workspace = emptyWorkspace();
  for (const [index, name] of ["Alpha", "Beta", "Gamma"].entries())
    workspace.apps.push({
      id: `app-${name.toLowerCase()}`, name, icon: "text",
      x: 120 + index * 460, y: 180, width: 420, height: 300,
      blocks: [makeBlock("input")], archived: false, group: "", exposed: false,
      accent: "#6f8998", padding: 12, gap: 12, radius: 8,
    });
  workspace.wheel = [
    { id: "w-alpha", parent: "", name: "Go Alpha", kind: "app", appId: "app-alpha", bindings: {} },
    { id: "w-more", parent: "", name: "More", kind: "group", appId: "", bindings: {} },
    { id: "w-beta", parent: "w-more", name: "Go Beta", kind: "app", appId: "app-beta", bindings: {} },
    { id: "w-gamma", parent: "w-more", name: "Go Gamma", kind: "app", appId: "app-gamma", bindings: {} },
  ];
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page.mouse.move(720, 450);
  await page.locator(".canvas-background").click({ position: { x: 20, y: 300 } });
  // The level being left fades out for a moment; only the live one counts.
  const selected = page.locator(".radial-layer:not(.leaving) .radial-entry.selected");
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect(page.getByLabel("Action wheel")).toBeVisible();
  // Left/Right step through the slots, wrapping.
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveAttribute("aria-label", "Go Alpha");
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveAttribute("aria-label", "More");
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveAttribute("aria-label", "Go Alpha");
  await page.keyboard.press("ArrowLeft");
  await expect(selected).toHaveAttribute("aria-label", "More");
  // Up enters the selected group; Down goes back with the group selected.
  await page.keyboard.press("ArrowUp");
  await expect(selected).toHaveAttribute("aria-label", "Go Beta");
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveAttribute("aria-label", "More");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveAttribute("aria-label", "Go Gamma");
  // Releasing the shortcut runs the slot chosen with the keys.
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  await expect(page.locator(".radial-overlay")).toHaveCount(0);
  await expect(page.locator(".dock-tab.active")).toHaveText("Gamma");
});

test("the wheel is a frosted Halo ring and levels crossfade in place", async ({
  page,
}) => {
  const { emptyWorkspace, makeBlock } = await import("../src/model");
  const workspace = emptyWorkspace();
  for (const [index, name] of ["Alpha", "Beta"].entries())
    workspace.apps.push({
      id: `app-${name.toLowerCase()}`, name, icon: "text",
      x: 120 + index * 460, y: 180, width: 420, height: 300,
      blocks: [makeBlock("input")], archived: false, group: "", exposed: false,
      accent: "#6f8998", padding: 12, gap: 12, radius: 8,
    });
  workspace.wheel = [
    { id: "w-alpha", parent: "", name: "Go Alpha", kind: "app", appId: "app-alpha", bindings: {} },
    { id: "w-more", parent: "", name: "More", kind: "group", appId: "", bindings: {} },
    { id: "w-beta", parent: "w-more", name: "Go Beta", kind: "app", appId: "app-beta", bindings: {} },
  ];
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page.mouse.move(720, 450);
  await page.locator(".canvas-background").click({ position: { x: 20, y: 300 } });
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  const ring = page.getByLabel("Action wheel");
  await expect(ring).toBeVisible();
  // Frosted glass like the top bar.
  await expect(ring).toHaveCSS("backdrop-filter", "blur(8px) saturate(1.2)");
  await expect(ring).toHaveCSS("background-color", "rgba(247, 250, 252, 0.08)");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const center = page.locator(".radial-center-text:not(.leaving)");
  await expect(center).toContainText("More");
  await expect(center).toContainText("Group · 1 item");
  await expect(page.locator(".radial-layer:not(.leaving) .radial-glow")).toHaveCSS("opacity", "1");
  // The center shows the chosen thing's icon above its name.
  await expect(center.locator(".radial-center-icon svg")).toHaveCount(1);
  const before = await ring.elementHandle();
  // Entering a group keeps the ring and center disc; the old level fades out
  // over the new one, then leaves the DOM.
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".radial-layer.leaving")).toHaveCount(1);
  await expect(page.locator(".radial-layer")).toHaveCount(2);
  await expect(page.locator(".radial-layer")).toHaveCount(1);
  await expect(center).toContainText("‹ More");
  await expect(center).toContainText("Go Beta");
  expect(await before!.evaluate((node) => node.isConnected)).toBe(true);
  await page.screenshot({ path: "artifacts/action-wheel-halo.png" });
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".radial-layer")).toHaveCount(1);
  await expect(page.locator(".radial-layer:not(.leaving) .radial-entry.selected")).toHaveAttribute("aria-label", "More");
  await page.keyboard.press("Escape");
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
});

test("the slot glow hands off to the center ring with the pointer, and the wheel animates out", async ({
  page,
}) => {
  const { emptyWorkspace, makeBlock } = await import("../src/model");
  const workspace = emptyWorkspace();
  workspace.apps.push({
    id: "app-alpha", name: "Alpha", icon: "text",
    x: 120, y: 180, width: 420, height: 300,
    blocks: [makeBlock("input")], archived: false, group: "", exposed: false,
    accent: "#6f8998", padding: 12, gap: 12, radius: 8,
  });
  workspace.wheel = [
    { id: "w-alpha", parent: "", name: "Go Alpha", kind: "app", appId: "app-alpha", bindings: {} },
  ];
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  const size = page.viewportSize()!;
  const cx = size.width / 2, cy = size.height / 2;
  await page.locator(".canvas-background").click({ position: { x: 20, y: 300 } });
  await page.mouse.move(cx, cy - 150);
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect(page.getByLabel("Action wheel")).toBeVisible();
  const glow = page.locator(".radial-layer:not(.leaving) .radial-glow");
  const center = page.getByRole("button", { name: "Edit wheel config" });
  const levels = async () => ({
    glow: Number(await glow.evaluate((el) => (el as HTMLElement).style.opacity)),
    ring: Number(await center.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--ring"))),
  });
  // On the slot: all glow, no center ring.
  expect(await levels()).toEqual({ glow: 1, ring: 0 });
  // At the center's edge: half and half, in step with the distance.
  await page.mouse.move(cx, cy - 86);
  const half = await levels();
  expect(half.glow).toBeGreaterThan(0.4);
  expect(half.glow).toBeLessThan(0.6);
  expect(half.glow + half.ring).toBeCloseTo(1, 5);
  // Inside the center: all ring.
  await page.mouse.move(cx, cy - 20);
  expect(await levels()).toEqual({ glow: 0, ring: 1 });
  await expect(page.locator(".radial-center-text:not(.leaving)")).toContainText("Edit config");
  // Back on the slot, release: the wheel plays its exit, then leaves the DOM,
  // and the app is focused straight away.
  await page.mouse.move(cx, cy - 150);
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  await expect(page.locator(".radial-overlay[inert]")).toHaveCount(1);
  await expect(page.locator(".dock-tab.active")).toHaveText("Alpha");
  await expect(page.locator(".radial-overlay")).toHaveCount(0);
});
