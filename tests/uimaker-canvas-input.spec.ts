import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function openCard(page: Page) {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  page.setDefaultTimeout(8000);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create UI Maker" }).click();
  const app = page.locator(".canvas-app").last();
  await page.locator(".help").waitFor();
  await page.locator(".help").dispatchEvent("pointerdown");
  await app.getByTitle("New component").click();
  await app.getByLabel("New component name").fill("Card");
  await app.getByLabel("New component name").press("Enter");
  await app.locator(".library-item").first().click();
  await expect
    .poll(() => app.locator('[data-el="frame"]').evaluate((f) => (f as HTMLIFrameElement).contentDocument?.URL.includes("/v1/") && (f as HTMLIFrameElement).contentDocument?.readyState === "complete"))
    .toBe(true);
  await page.waitForTimeout(500);
  return app;
}

// A note pin can be dragged off the component onto the surrounding canvas.
test("UI Maker pins drag outside the artboard", async ({ page }) => {
  test.setTimeout(60_000);
  const app = await openCard(page);
  const art = (await app.locator('[data-el="artboard"]').boundingBox())!;
  await page.keyboard.press("n");
  await page.mouse.click(art.x + art.width / 2, art.y + art.height / 2);
  await page.keyboard.press("Enter");
  await page.keyboard.press("v");
  const pin = app.locator('[data-el="overlay"] [data-nid]').first();
  const box = (await pin.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const to = { x: art.x - 60, y: art.y + art.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.mouse.up();
  const moved = (await pin.boundingBox())!;
  expect(moved.x + moved.width / 2).toBeLessThan(art.x);
});

// With the component live (I), Ctrl+wheel over it still zooms Orvane's canvas.
test("Ctrl+wheel over a live UI Maker component zooms the canvas", async ({ page }) => {
  test.setTimeout(60_000);
  const app = await openCard(page);
  await page.keyboard.press("i");
  const art = (await app.locator('[data-el="artboard"]').boundingBox())!;
  const scale = () => app.evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
  const before = await scale();
  await page.mouse.move(art.x + art.width / 2, art.y + art.height / 2);
  await page.waitForTimeout(300);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await expect.poll(scale).toBeGreaterThan(before * 1.1);
});

// A dragged label follows the pointer sideways past the component and the
// view's edge, as it already does up and down; it never flips back.
test("UI Maker pin labels drag freely sideways", async ({ page }) => {
  test.setTimeout(60_000);
  const app = await openCard(page);
  for (const [name, value] of [["Artboard width", "1180"], ["Artboard height", "760"]]) {
    const field = app.getByRole("spinbutton", { name });
    await field.fill(value);
    await field.press("Enter");
  }
  await app.locator(".zoom").getByText("Fit").click();
  await page.waitForTimeout(400);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const art = (await app.locator('[data-el="artboard"]').boundingBox())!;
  const view = (await app.locator('[data-el="labels"]').boundingBox())!;
  await page.mouse.move(art.x + art.width * 0.97, art.y + art.height * 0.85);
  await page.keyboard.press("n");
  await page.mouse.click(art.x + art.width * 0.97, art.y + art.height * 0.85);
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
  await page.keyboard.press("v");
  const label = app.locator(".plabel").first();
  await expect(label).toBeVisible();
  const drag = async (to: number) => {
    const b = (await label.boundingBox())!;
    const from = { x: b.x + 14, y: b.y + b.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(from.x + ((to - b.x) * i) / 15, from.y);
    await page.mouse.up();
    return (await label.boundingBox())!;
  };
  // Right, past the component and the view's right edge.
  const right = await drag(view.x + view.width - 20);
  expect(right.x).toBeGreaterThan(art.x + art.width);
  expect(right.x + right.width).toBeGreaterThan(view.x + view.width);
  // Undo, then left, past the component's left edge.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await label.boundingBox())?.x).toBeLessThan(view.x + view.width - 60);
  const left = await drag(art.x - 30 - (await label.boundingBox())!.width);
  expect(left.x + left.width).toBeLessThan(art.x);
});

// While dragged, a label stays under the cursor at the point where it was
// grabbed, at any canvas zoom and when it crosses its pin.
test("UI Maker pin labels follow the cursor while dragged", async ({ page }) => {
  test.setTimeout(60_000);
  const app = await openCard(page);
  const art = (await app.locator('[data-el="artboard"]').boundingBox())!;
  // Zoom the canvas out a little so app pixels and screen pixels differ.
  await page.mouse.move(art.x - 30, art.y + 30);
  await page.waitForTimeout(200);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 120);
  await page.keyboard.up("Control");
  await page.waitForTimeout(600);
  const board = (await app.locator('[data-el="artboard"]').boundingBox())!;
  await page.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
  await page.keyboard.press("n");
  await page.mouse.click(board.x + board.width / 2, board.y + board.height / 2);
  await page.keyboard.type("hello there");
  await page.keyboard.press("Enter");
  await page.keyboard.press("v");
  const label = app.locator(".plabel").first();
  await expect(label).toBeVisible();
  const b = (await label.boundingBox())!;
  const grab = { x: b.x + 20, y: b.y + b.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  const offsets: number[][] = [];
  // Left across the pin, then down and right again.
  const path = [...Array(20)].map((_, i) => [grab.x - 14 * (i + 1), grab.y + 4 * (i + 1)]);
  for (const [x, y] of path) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(30);
    const now = (await label.boundingBox())!;
    offsets.push([Math.round(now.x - x), Math.round(now.y - y)]);
  }
  await page.mouse.up();
  const first = [b.x - grab.x, b.y - grab.y];
  for (const [dx, dy] of offsets) {
    expect(Math.abs(dx - first[0]), JSON.stringify(offsets)).toBeLessThan(3);
    expect(Math.abs(dy - first[1]), JSON.stringify(offsets)).toBeLessThan(3);
  }
});
