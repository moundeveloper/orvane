import { test, expect, type Page } from "./fixtures";
import { emptyWorkspace, makeBlock, type CanvasApp } from "../src/model";

// The performance architecture's behavior, not its timings (those are in
// bench/): pan feedback that never restyles app content, staged startup,
// off-screen rendering, and the runtime every code app receives.
const CODE = `<div id="rows" style="height:160px"></div><output id="ticks">0</output>
<script>
  let ticks = 0;
  const timer = setInterval(() => (document.getElementById("ticks").textContent = String(++ticks)), 20);
  window.stop = () => clearInterval(timer);
  window.list = orvane.list({
    container: document.getElementById("rows"),
    count: 50000,
    rowHeight: 20,
    render: (index) => "Row " + index,
  });
  window.seen = [];
  orvane.onVisibility((visible) => window.seen.push(visible));
</script>`;

async function seed(page: Page, far = 12) {
  const workspace = emptyWorkspace();
  const app = (
    id: string,
    x: number,
    y: number,
    block = makeBlock("input"),
  ): CanvasApp => ({
    id,
    name: id,
    icon: "app",
    x,
    y,
    width: 420,
    height: 320,
    blocks: [{ ...block, id: `${id}-block` }],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 24,
    gap: 12,
    radius: 8,
  });
  workspace.apps = [
    app("near", 200, 160, { ...makeBlock("code"), label: "Rows", code: CODE }),
    ...Array.from({ length: far }, (_, i) =>
      app(`far-${i}`, 6000 + (i % 4) * 500, 4000 + Math.floor(i / 4) * 400, {
        ...makeBlock("input"),
        label: `Far field ${i}`,
        value: `kept ${i}`,
      }),
    ),
  ];
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/");
}

test("pan feedback is one overlay and never a rule on app content", async ({
  page,
}) => {
  await seed(page, 2);
  const shield = page.locator(".pan-shield");
  const field = page.locator('[data-app-id="near"] .app-title');
  await expect(shield).toBeHidden();
  const resting = await field.evaluate((el) => getComputedStyle(el).cursor);

  await page.mouse.move(900, 620);
  await page.keyboard.down("Space");
  await expect(shield).toBeVisible();
  await expect(shield).toHaveCSS("cursor", "grab");
  // Content under the overlay keeps its own style: nothing was restyled.
  expect(await field.evaluate((el) => getComputedStyle(el).cursor)).toBe(
    resting,
  );
  // The top bar and dock stay above the overlay and remain usable.
  expect(
    await page.evaluate(() => {
      const dock = document.querySelector(".dock")!.getBoundingClientRect();
      return document
        .elementFromPoint(dock.x + 30, dock.y + dock.height / 2)
        ?.closest(".dock,.pan-shield")?.className;
    }),
  ).toContain("dock");

  // Space-drag over an app pans the canvas instead of using the app.
  const plane = page.locator(".canvas-plane");
  const before = await plane.evaluate((el: HTMLElement) => el.style.transform);
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await expect(shield).toHaveCSS("cursor", "grabbing");
  await page.mouse.move(520, 380, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(shield).toBeHidden();
  expect(await plane.evaluate((el: HTMLElement) => el.style.transform)).not.toBe(
    before,
  );
  await expect
    .poll(() => plane.evaluate((el: HTMLElement) => el.style.transform))
    .toContain("translate(120px, 80px)");

  // Middle-drag shows the same feedback and releases it afterwards.
  await page.mouse.move(900, 620);
  await page.mouse.down({ button: "middle" });
  await expect(shield).toHaveCSS("cursor", "grabbing");
  await page.mouse.move(880, 600, { steps: 2 });
  await page.mouse.up({ button: "middle" });
  await expect(shield).toBeHidden();
});

test("startup mounts the app in view first and the rest while idle", async ({
  page,
}) => {
  await seed(page);
  // The app on screen is live as soon as the workspace is ready.
  await expect(page.locator('[data-app-id="near"] iframe')).toBeAttached();
  // Every other app arrives without being visited, with its content.
  await expect(page.locator(".app-pending")).toHaveCount(0);
  await expect(page.locator(".canvas-app")).toHaveCount(13);
  await expect(
    page.locator('[data-app-id="far-11"]').getByLabel("Far field 11"),
  ).toHaveValue("kept 11");
  // Off-screen apps skip rendering; the one in view does not.
  expect(
    await page.evaluate(() =>
      ["near", "far-11"].map(
        (id) =>
          getComputedStyle(
            document.querySelector(`[data-app-id="${id}"] > .app-surface`)!,
          ).contentVisibility,
      ),
    ),
  ).toEqual(["auto", "auto"]);
  // Each was laid out once in the background and released again.
  await expect(page.locator(".is-warming")).toHaveCount(0);

  // Navigating to a far app shows it complete and usable.
  await page.locator(".dock-tab", { hasText: "far-7" }).click();
  const field = page.locator('[data-app-id="far-7"]').getByLabel("Far field 7");
  await expect(field).toBeInViewport();
  await field.fill("edited after travel");
  await expect(field).toHaveValue("edited after travel");
});

test("an app opened during startup mounts immediately", async ({ page }) => {
  await seed(page, 40);
  // Do not wait for the idle queue: go straight to the last app.
  await page.locator(".dock-tab", { hasText: /^far-39$/ }).click();
  await expect(
    page.locator('[data-app-id="far-39"]').getByLabel("Far field 39"),
  ).toHaveValue("kept 39");
  await expect(page.locator(".app-pending")).toHaveCount(0);
});

test("code apps receive the runtime, windowed lists and off-screen throttling", async ({
  page,
}) => {
  await seed(page, 1);
  const frame = page.frameLocator('[data-app-id="near"] iframe');
  await expect(frame.locator("#rows")).toBeVisible();
  // Functions passed to evaluate run in the app's frame; its CSP forbids eval.
  const body = frame.locator("body");
  expect(
    await body.evaluate(() => Object.keys((window as any).orvane).sort()),
  ).toEqual([
    "debounce",
    "frame",
    "idle",
    "list",
    "onCleanup",
    "onVisibility",
    "throttle",
    "visible",
  ]);
  // 50,000 rows, a few dozen elements.
  const mounted = await body.evaluate(
    () => document.querySelectorAll("#rows > div > div > div").length,
  );
  expect(mounted).toBeGreaterThan(5);
  expect(mounted).toBeLessThan(40);
  expect(
    await body.evaluate(() => document.getElementById("rows")!.scrollHeight),
  ).toBe(50000 * 20);
  await body.evaluate(() => {
    document.getElementById("rows")!.scrollTop = 600000;
  });
  await expect(frame.locator("#rows")).toContainText("Row 30000");
  const visible = () =>
    body.evaluate(() => (window as any).orvane.visible as boolean);

  // On screen: the interval runs at its own pace.
  const rate = async () => {
    const start = Number(await frame.locator("#ticks").textContent());
    await page.waitForTimeout(1000);
    return Number(await frame.locator("#ticks").textContent()) - start;
  };
  expect(await rate()).toBeGreaterThan(20);

  // Travel far away: the app is told, and its interval drops to about 1 Hz.
  await page.locator(".dock-tab", { hasText: /^far-0$/ }).click();
  await expect(page.locator('[data-app-id="near"] iframe')).not.toBeInViewport();
  await expect
    .poll(visible, { timeout: 5000 })
    .toBe(false);
  await page.waitForTimeout(1100);
  expect(await rate()).toBeLessThan(4);

  // Back again: the cadence returns and the app heard both changes.
  await page.locator(".dock-tab", { hasText: /^near$/ }).click();
  await expect
    .poll(visible, { timeout: 5000 })
    .toBe(true);
  expect(await rate()).toBeGreaterThan(20);
  // It may pass the viewport edge more than once on the way.
  const seen = await body.evaluate(() => (window as any).seen as boolean[]);
  expect(seen).toContain(false);
  expect(seen.at(-1)).toBe(true);
  // Its own clearInterval still stops the wrapped timer.
  await body.evaluate(() => (window as any).stop());
  expect(await rate()).toBe(0);
});
