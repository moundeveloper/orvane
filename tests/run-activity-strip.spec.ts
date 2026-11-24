import { test, expect } from "./fixtures";

// A clicked call row is the current call: Left/Right step through the calls
// from it (as from the strip), and Ctrl+Left/Right stay Orvane's
// previous/next app shortcut.
test("a clicked tool call row steps with Left/Right and leaves Ctrl+arrows alone", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.evaluate(async () => {
    const harness = await import("/tests/run-activity-strip-harness.ts");
    (window as any).stripFixture = harness.mountStripFixture();
  });
  const root = page.locator("#strip-fixture");
  const label = root.locator(".strip-label");
  const row = (tool: string) => root.getByRole("button", { name: new RegExp(`orvane / ${tool}`) });
  await row("app_list").click();
  await expect(label).toContainText("2 of 3");
  await expect(row("app_list")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(label).toContainText("3 of 3");
  await expect(row("app_get")).toHaveAttribute("aria-pressed", "true");
  await expect(row("app_get")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(label).toContainText("1 of 3");
  await expect(row("workspace_status")).toBeFocused();
  // Ctrl+arrows on a row or on the strip reach Orvane untouched.
  await page.keyboard.press("Control+ArrowRight");
  await expect(label).toContainText("1 of 3");
  await root.locator("summary").focus();
  await page.keyboard.press("Control+ArrowRight");
  await expect(label).toContainText("1 of 3");
  expect(await page.evaluate(() => (window as any).stripFixture.reached)).toEqual([
    "Control+ArrowRight",
    "Control+ArrowRight",
  ]);
  // Plain arrows on the strip still step.
  await page.keyboard.press("ArrowRight");
  await expect(label).toContainText("2 of 3");
});
