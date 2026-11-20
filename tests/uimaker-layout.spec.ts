import { test, expect } from "./fixtures";

// UI Maker's header stays on one row, its tab rows share the segmented shape,
// and the note editor fills the panel instead of taking Orvane's global
// .editor width (225px), which drew its border through its own fields.
test("UI Maker header, tabs and note editor keep their layout", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  page.setDefaultTimeout(8000);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create UI Maker" }).click();
  const app = page.locator(".canvas-app").last();
  const help = page.locator(".help");
  await help.waitFor();
  await help.dispatchEvent("pointerdown");
  await app.getByTitle("New component").click();
  await app.getByLabel("New component name").fill("Card");
  await app.getByLabel("New component name").press("Enter");
  await app.locator(".library-item").first().click();
  const viewport = (await app.locator('[data-el="viewport"]').boundingBox())!;
  await page.keyboard.press("n");
  await page.mouse.click(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2 - 60);
  await page.keyboard.type("A long note label that should stay inside the note editor");
  await page.keyboard.press("Enter");
  const editor = app.locator(".right .editor");
  await editor.waitFor();

  // The note editor is as wide as its note row, and its fields stay inside it.
  const row = (await app.locator(".right .nrow").first().boundingBox())!;
  const box = (await editor.boundingBox())!;
  expect(Math.abs(box.width - row.width)).toBeLessThan(2);
  const field = (await editor.locator("input.title").boundingBox())!;
  expect(field.x + field.width).toBeLessThanOrEqual(box.x + box.width);

  // Header controls sit on one row.
  const centre = async (selector: string) => {
    const b = (await app.locator(selector).first().boundingBox())!;
    return b.y + b.height / 2;
  };
  const tabs = await centre(".top .pills");
  for (const selector of [".top .crumb", ".top .size", ".top .zoom"])
    expect(Math.abs((await centre(selector)) - tabs)).toBeLessThan(2);

  // Tabs and note kinds use the app's small radii, not round pills.
  for (const selector of [".top .pills button", ".right .tabs button", ".right .kind"]) {
    const radius = await app.locator(selector).first().evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius));
    expect(radius, selector).toBeLessThanOrEqual(7);
  }
  await page.screenshot({ path: "artifacts/uimaker-layout.png" });

  // A long canvas pin label near the right edge stays fully inside the view.
  const labels = (await app.locator('[data-el="labels"]').boundingBox())!;
  const label = (await app.locator(".plabel").first().boundingBox())!;
  expect(label.x).toBeGreaterThanOrEqual(labels.x);
  expect(label.x + label.width).toBeLessThanOrEqual(labels.x + labels.width);
});
