import { expect, test } from "./fixtures";
import { emptyWorkspace } from "../src/model";

// A window whose lease renewals stall (Orvane in the background, timers
// throttled) lets its 15 s editing lease expire, and its next save is
// refused. When nobody else took editing or saved in the meantime, it must
// take editing back by itself instead of staying read-only until a restart.
test("a window whose editing lease lapsed takes editing back when nobody else saved", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, emptyWorkspace());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const status = page.locator(".status-text");

  // Renewals stop reaching the server, as when the window is throttled.
  const stall = (route: import("@playwright/test").Route) => route.abort();
  await page.route("**/__orvane/storage/lease", stall);
  // The lease runs out; then a change is saved and refused.
  await page.waitForTimeout(16_000);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.keyboard.press("Escape");
  await expect(status).toContainText("Editing ownership changed", { timeout: 40_000 });

  // Renewals work again: editing comes back without a reload.
  await page.unroute("**/__orvane/storage/lease", stall);
  await expect(status).toHaveCount(0, { timeout: 15_000 });

  // And edits save again.
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Action library", exact: true }).click();
  const library = page.getByRole("region", { name: "Workspace action library" });
  await expect(library).toBeVisible({ timeout: 60_000 });
  await library.getByRole("button", { name: "New action" }).click();
  await expect(library.locator(".action-library-item")).toHaveCount(1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Action library", exact: true }).click();
  await expect(page.getByRole("region", { name: "Workspace action library" }).locator(".action-library-item")).toHaveCount(1, { timeout: 60_000 });
});

test("a window that lost editing stays read-only when another window saved meanwhile", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, emptyWorkspace());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const status = page.locator(".status-text");
  const stall = (route: import("@playwright/test").Route) => route.abort();
  await page.route("**/__orvane/storage/lease", stall);
  // The lease runs out; then a change is saved and refused.
  await page.waitForTimeout(16_000);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.keyboard.press("Escape");
  await expect(status).toContainText("Editing ownership changed", { timeout: 40_000 });

  // Another writer takes editing and saves while this window is cut off
  // (same test workspace: page.request shares the page's namespace cookie).
  const request = page.request;
  const other = { client: "00000000-0000-4000-8000-000000000001" };
  const state = await (await request.get("/__orvane/storage/state")).json();
  expect((await (await request.post("/__orvane/storage/lease", { data: other })).json()).owned).toBe(true);
  const saved = await request.put("/__orvane/storage/state", {
    data: { ...other, data: state.data, expectedRevision: state.revision },
  });
  expect(saved.ok()).toBe(true);
  await request.post("/__orvane/storage/release", { data: other });

  // This window must not take over and overwrite that save.
  await page.unroute("**/__orvane/storage/lease", stall);
  await page.waitForTimeout(5_000);
  await expect(status).toContainText("Editing ownership changed");
});
