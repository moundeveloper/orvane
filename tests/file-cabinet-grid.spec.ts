import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
const baseline = process.env.ORVANE_GRID_BASELINE === "1";
const filename = (i: number) => `File ${String(i).padStart(5, "0")}.txt`;
async function mount(page: Page, count = 5000) {
  await page.goto("/");
  await page.evaluate(async (count) => {
    const module = "/tests/large-lists-harness.ts";
    (window as any).largeList = (await import(module)).mountLargeListFixture(
      "cabinet-files",
      count,
    );
  }, count);
  const root = page.locator("#large-list-fixture");
  await root.getByRole("button", { name: "Grid view", exact: true }).click();
  await expect(root.locator(".fc-tile").first()).toBeInViewport();
  return root;
}

test("large grid DOM and layout comparison", async ({ page }, info) => {
  const root = await mount(page),
    content = root.locator(".fc-content");
  const metrics = await root.evaluate((root) => {
    const content = root.querySelector<HTMLElement>(".fc-content")!;
    const tiles = Array.from(content.querySelectorAll<HTMLElement>(".fc-tile"));
    const first = tiles[0]!.getBoundingClientRect();
    return {
      viewerElements: root.querySelectorAll("*").length,
      contentElements: content.querySelectorAll("*").length,
      tiles: tiles.length,
      height: content.clientHeight,
      scrollHeight: content.scrollHeight,
      columns: getComputedStyle(content).gridTemplateColumns,
      tile: {
        width: first.width,
        height: first.height,
        left: first.left,
        top: first.top,
      },
      rowAdvance:
        tiles
          .find((tile) => tile.getBoundingClientRect().top > first.top)
          ?.getBoundingClientRect().top! - first.top,
    };
  });
  console.log("Grid diagnostic", baseline ? "baseline" : "candidate", metrics);
  await info.attach("grid-layout.json", {
    body: JSON.stringify(metrics),
    contentType: "application/json",
  });
  if (!baseline) expect(metrics.tiles).toBeLessThan(160);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({
    path: `artifacts/performance/grid-${baseline ? "baseline" : "candidate"}.png`,
  });
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    root.getByRole("row", { name: filename(4999), exact: true }),
  ).toBeInViewport();
});

test("grid keyboard navigation, range selection and clipboard cover unmounted files", async ({
  page,
}) => {
  const root = await mount(page),
    content = root.locator(".fc-content");
  await root.getByRole("row", { name: filename(0), exact: true }).click();
  await content.focus();
  await content.evaluate((element) => {
    for (let i = 0; i < 250; i++)
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
  });
  await expect(
    root.getByRole("row", { name: filename(250), exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    root.getByRole("row", { name: filename(250), exact: true }),
  ).toBeInViewport();
  await content.press("Control+a");
  await expect(root.locator(".fc-status")).toContainText("5000 selected");
  await content.press("Escape");
  await root.getByRole("row", { name: filename(250), exact: true }).click();
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const last = root.getByRole("row", { name: filename(4999), exact: true });
  await last.click({ modifiers: ["Shift"] });
  await expect(root.locator(".fc-status")).toContainText("4750 selected");
  await content.focus();
  await content.press("Escape");
  await last.click();
  await last.click({ button: "right" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await root.getByRole("menuitem", { name: "Copy Name", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    filename(4999),
  );
  await expect.poll(() => root.locator(".fc-tile").count()).toBeLessThan(160);
  await last.dblclick();
  await expect(
    root.getByRole("textbox", { name: "File content" }),
  ).toContainText("Fixture content");
  expect(
    await page.evaluate(() =>
      (window as any).largeList.calls.some(
        (call: any) => call.op === "file" && call.args.id === 5000,
      ),
    ),
  ).toBe(true);
});

test("a pinned rename survives scroll, column-count changes and zoom; filtering and view switches remain complete", async ({
  page,
}) => {
  const root = await mount(page),
    content = root.locator(".fc-content");
  await root.getByRole("row", { name: filename(0), exact: true }).click();
  await content.focus();
  await content.press("F2");
  const rename = root.getByRole("textbox", { name: "New name", exact: true });
  await expect(rename).toBeFocused();
  await rename.evaluate((input: HTMLInputElement) =>
    input.setSelectionRange(2, 8),
  );
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    root.getByRole("row", { name: filename(4999), exact: true }),
  ).toBeInViewport();
  await expect(rename).toBeFocused();
  await page.evaluate(() => (window as any).largeList.resize(750, 700, 0.65));
  await expect(
    root.getByRole("row", { name: filename(4999), exact: true }),
  ).toBeInViewport();
  await expect(rename).toBeFocused();
  expect(
    await rename.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([2, 8]);
  await expect.poll(() => root.locator(".fc-tile").count()).toBeLessThan(100);
  await rename.fill("Renamed grid fixture.txt");
  await rename.press("Enter");
  await expect(rename).toHaveCount(0);
  const filter = root.getByRole("textbox", { name: "Filter files" });
  await filter.fill("Renamed grid");
  await expect(root.locator(".fc-tile")).toHaveCount(1);
  await expect(root.locator(".fc-tile span")).toHaveText(
    "Renamed grid fixture.txt",
  );
  await root.getByRole("button", { name: "List view", exact: true }).click();
  await expect(root.locator(".fc-td-name span")).toHaveText(
    "Renamed grid fixture.txt",
  );
  await root.getByRole("button", { name: "Grid view", exact: true }).click();
  await filter.fill("");
  await expect(
    root.getByRole("row", { name: filename(1), exact: true }),
  ).toBeInViewport();
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    root.getByRole("row", { name: "Renamed grid fixture.txt", exact: true }),
  ).toBeInViewport();
});

test("split grids retain separate windows and resize anchors across hidden tabs", async ({
  page,
}) => {
  const root = await mount(page);
  await root
    .getByRole("button", { name: "New File Cabinet tab", exact: true })
    .click();
  await root
    .locator(".fc-content:visible")
    .getByRole("row", { name: "Large folder", exact: true })
    .dblclick();
  await expect(
    root.locator(".fc-content:visible .fc-tile").first(),
  ).toBeInViewport();
  await root.getByRole("tab").nth(1).click({ button: "right" });
  await root
    .getByRole("menuitem", { name: "Open in right split", exact: true })
    .click();
  const contents = root.locator(".fc-content:visible");
  await expect(contents).toHaveCount(2);
  await contents.nth(0).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    contents.nth(0).getByRole("row", { name: filename(4999), exact: true }),
  ).toBeInViewport();
  expect(await contents.nth(1).evaluate((element) => element.scrollTop)).toBe(
    0,
  );
  await page.evaluate(() => (window as any).largeList.resize(1100, 780, 0.6));
  await expect(
    contents.nth(0).getByRole("row", { name: filename(4999), exact: true }),
  ).toBeInViewport();
  await expect(
    contents.nth(1).getByRole("row", { name: filename(0), exact: true }),
  ).toBeInViewport();
  await root.getByRole("tab").nth(1).click({ button: "right" });
  await root
    .getByRole("menuitem", { name: "Open in left split", exact: true })
    .click();
  await root.getByRole("tab").nth(0).click();
  await expect(
    root
      .locator(".fc-content:visible")
      .getByRole("row", { name: filename(4999), exact: true }),
  ).toBeInViewport();
  await root.getByRole("tab").nth(1).click();
  expect(
    await root
      .locator(".fc-content:visible")
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  await page.evaluate(() => (window as any).largeList.unmount());
  await expect(root).toHaveCount(0);
});

test("small grids keep all tiles; large grids preserve a middle anchor when columns change", async ({
  page,
}) => {
  let root = await mount(page, 100);
  await expect(root.locator(".fc-tile")).toHaveCount(100);
  await page.evaluate(() => (window as any).largeList.unmount());
  root = await mount(page, 101);
  await expect.poll(() => root.locator(".fc-tile").count()).toBeLessThan(101);
  await root.locator(".fc-content").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    root.getByRole("row", { name: filename(100), exact: true }),
  ).toBeInViewport();
  await page.evaluate(() => (window as any).largeList.unmount());
  root = await mount(page);
  const content = root.locator(".fc-content");
  await content.evaluate((element) => {
    element.scrollTop = 10000;
  });
  await expect(
    root.getByRole("row", { name: filename(918), exact: true }),
  ).toBeInViewport();
  const anchor = await content.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(
      element.querySelectorAll<HTMLElement>("[data-grid-index]"),
    )
      .find((tile) => tile.getBoundingClientRect().top >= bounds.top)!
      .getAttribute("aria-label")!;
  });
  await page.evaluate(() => (window as any).largeList.resize(750, 700));
  await expect(
    root.getByRole("row", { name: anchor, exact: true }),
  ).toBeInViewport();
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.evaluate(() => (window as any).largeList.resize(380, 650, 0.6));
  await expect(
    root.getByRole("row", { name: filename(4999), exact: true }),
  ).toBeInViewport();
  expect(
    await content.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(/\s+/).length,
    ),
  ).toBe(1);
  await expect.poll(() => root.locator(".fc-tile").count()).toBeLessThan(20);
});
