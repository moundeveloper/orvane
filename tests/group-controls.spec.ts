import { test, expect, type Page } from "./fixtures";
import { emptyWorkspace, type CanvasApp } from "../src/model";
import { readStored } from "./storage-helper";

async function seed(page: Page) {
  const w = emptyWorkspace();
  w.groups = [{ id: "cluster", name: "Together" }];
  w.apps = [160, 550, 980].map((x, i): CanvasApp => ({
    id: `app-${i}`,
    name: `App ${i + 1}`,
    icon: "app",
    x,
    y: 180,
    width: 280,
    height: 250,
    blocks: [],
    archived: false,
    group: i < 2 ? "Together" : "",
    groupId: i < 2 ? "cluster" : undefined,
    exposed: false,
    accent: "#6f8998",
    padding: 24,
    gap: 12,
    radius: 8,
  }));
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    if (!localStorage.getItem("orvane.workspace.v1"))
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, w);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
}
const positions = (page: Page) =>
  page.locator(".canvas-app").evaluateAll((elements) =>
    elements.map((el) => {
      const style = (el as HTMLElement).style;
      return {
        x: parseFloat(style.left),
        y: parseFloat(style.top),
        width: parseFloat(style.width),
        height: parseFloat(style.height),
      };
    }),
  );
async function drag(
  page: Page,
  selector: string,
  dx: number,
  dy: number,
  button: "left" | "middle" = "left",
) {
  const box = (await page.locator(selector).boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up({ button });
}
for (const zoom of [0.65, 1, 1.35]) {
  test(`group label and border drag members together at zoom ${zoom}, leaving other apps independent`, async ({
    page,
  }) => {
    await seed(page);
    if (zoom !== 1) {
      await page.mouse.move(260, 200);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -Math.log(zoom) / 0.0025);
      await page.keyboard.up("Control");
      await expect
        .poll(() =>
          page
            .locator(".canvas-plane")
            .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a),
        )
        .toBeCloseTo(zoom, 5);
    }
    const before = await positions(page);
    for (const selector of [".spatial-group-label", ".group-edge-s"]) {
      const previous = await positions(page);
      await drag(page, selector, 40, 26);
      const after = await positions(page);
      for (const i of [0, 1]) {
        expect(after[i]!.x - previous[i]!.x).toBeCloseTo(40 / zoom, 1);
        expect(after[i]!.y - previous[i]!.y).toBeCloseTo(26 / zoom, 1);
        expect(after[i]!.width).toBe(previous[i]!.width);
      }
      expect(after[2]).toEqual(before[2]);
      await expect(page.locator(".groups-panel")).toHaveCount(0);
    }
    const grouped = await positions(page);
    await expect
      .poll(async () => (await readStored(page)).apps[0]!.x)
      .toBeCloseTo(grouped[0]!.x, 1);
    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
    expect(await positions(page)).toEqual(grouped);
    const first = (await page.locator('[data-app-id="app-0"]').boundingBox())!;
    await page.keyboard.down("Alt");
    await page.mouse.move(first.x + 40, first.y + 80);
    await page.mouse.down();
    await page.mouse.move(first.x + 60, first.y + 95, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    expect((await positions(page))[1]).toEqual(grouped[1]);
  });
}
test("group label click opens management, middle/Space drags pan, and interrupted group moves stop", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByRole("button", { name: "Edit group Together", exact: true })
    .click();
  await expect(page.locator(".groups-panel")).toBeVisible();
  await page.getByRole("button", { name: "Close groups", exact: true }).click();
  const before = await positions(page);
  await drag(page, ".spatial-group-label", 30, 20, "middle");
  expect(await positions(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await page.keyboard.down("Space");
  await drag(page, ".group-edge-s", -20, -10);
  await page.keyboard.up("Space");
  expect(await positions(page)).toEqual(before);
  const label = (await page.locator(".spatial-group-label").boundingBox())!;
  await page.mouse.move(label.x + 20, label.y + 10);
  await page.mouse.down();
  await page.mouse.move(label.x + 45, label.y + 35, { steps: 3 });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const interrupted = await positions(page);
  await page.mouse.move(label.x + 95, label.y + 80, { steps: 3 });
  expect(await positions(page)).toEqual(interrupted);
  await page.mouse.up();
  await drag(page, ".spatial-group-label", 15, 10);
  expect((await positions(page))[0]!.x).toBeCloseTo(interrupted[0]!.x + 15, 1);
});
test("custom numeric fields have authored steppers and never save empty or invalid drafts", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByRole("button", { name: "Options for App 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position & size", exact: true })
    .click();
  const width = page.getByRole("spinbutton", { name: "Width", exact: true });
  await expect(page.locator('input[type="number"]')).toHaveCount(0);
  await expect(width).toHaveAttribute("type", "text");
  await width.fill("");
  expect((await positions(page))[0]!.width).toBe(280);
  await width.press("Tab");
  await expect(width).toHaveValue("280");
  await page
    .getByRole("button", { name: "Increase Width", exact: true })
    .click();
  await expect(width).toHaveValue("281");
  await width.focus();
  await width.press("ArrowUp");
  await expect(width).toHaveValue("282");
  await width.press("Shift+ArrowDown");
  await expect(width).toHaveValue("272");
  await width.fill("not a number");
  await width.press("Enter");
  await expect(width).toHaveValue("272");
  await width.fill("1");
  await width.press("Enter");
  await expect(width).toHaveValue("180");
  await expect(
    page.getByRole("button", { name: "Decrease Width", exact: true }),
  ).toBeDisabled();
  const horizontal = page.getByRole("spinbutton", {
    name: "Horizontal",
    exact: true,
  });
  await horizontal.fill("-12,5");
  await horizontal.press("Enter");
  await expect(horizontal).toHaveValue("-12.5");
  await page.screenshot({ path: "artifacts/custom-number-geometry.png" });
  await expect
    .poll(async () => (await readStored(page)).apps[0]!.width)
    .toBe(180);
  await page.reload();
  expect((await positions(page))[0]!.width).toBe(180);
  expect((await positions(page))[0]!.x).toBe(-12.5);
});
