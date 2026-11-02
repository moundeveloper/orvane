import { test, expect } from "./fixtures";
async function mount(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/large-lists-harness.ts";
    (window as any).largeList = (await import(module)).mountLargeListFixture(
      "cabinet-files",
    );
  });
  const root = page.locator("#large-list-fixture");
  await expect.poll(() => root.locator(".fc-item").count()).toBeGreaterThan(0);
  return root;
}
const filename = (index: number) =>
  `File ${index.toString().padStart(5, "0")}.txt`;

test("windowed file table scrolls through all records and keeps keyboard and bulk selection complete", async ({
  page,
}) => {
  const root = await mount(page);
  const content = root.locator(".fc-content");
  await expect.poll(() => root.locator(".fc-item").count()).toBeLessThan(80);
  await expect(root.locator(".fc-table")).toHaveAttribute(
    "aria-rowcount",
    "5001",
  );
  await root.getByRole("row", { name: filename(0), exact: true }).click();
  await content.focus();
  await content.evaluate((element) => {
    for (let i = 0; i < 90; i++)
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
  });
  const selected = root.getByRole("row", { name: filename(90), exact: true });
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toBeVisible();
  await expect(selected.locator(".fc-td-name span")).toBeVisible();
  const widths = await root
    .locator("th")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
  expect(
    await content.evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  await content.press("Control+a");
  await expect(root.locator(".fc-status")).toContainText("5000 selected");
  await content.press("Escape");
  await root.getByRole("row", { name: filename(90), exact: true }).click();
  await content.evaluate(
    (element) => (element.scrollTop = element.scrollHeight),
  );
  const last = root.getByRole("row", { name: filename(4999), exact: true });
  await expect(last).toBeVisible();
  await expect(last).toHaveAttribute("aria-rowindex", "5001");
  const afterWidths = await root
    .locator("th")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
  afterWidths.forEach((width, index) =>
    expect(width).toBeCloseTo(widths[index]!, 1),
  );
  await last.click({ modifiers: ["Shift"] });
  await expect(root.locator(".fc-status")).toContainText("4910 selected");
  await content.focus();
  await content.press("Escape");
  await last.click();
  await last.click({ button: "right" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await root.getByRole("menuitem", { name: "Copy Name", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    filename(4999),
  );
  await page.evaluate(() => (window as any).largeList.unmount());
});

test("filtering and sorting reset the row window; inline renaming stays mounted while scrolled away", async ({
  page,
}) => {
  const root = await mount(page);
  const content = root.locator(".fc-content");
  const filter = root.getByRole("textbox", {
    name: "Filter files",
    exact: true,
  });
  await content.evaluate(
    (element) => (element.scrollTop = element.scrollHeight),
  );
  await expect(
    root.getByRole("row", { name: filename(4999), exact: true }),
  ).toBeVisible();
  await filter.fill("File 00001");
  await expect(root.locator(".fc-item")).toHaveCount(1);
  await expect(
    root.getByRole("row", { name: filename(1), exact: true }),
  ).toBeVisible();
  await filter.fill("does-not-exist");
  await expect(root.locator(".fc-item")).toHaveCount(0);
  await expect(content).toContainText("No matching items");
  await filter.clear();
  await expect(
    root.getByRole("row", { name: filename(0), exact: true }),
  ).toBeVisible();
  await root.getByRole("columnheader", { name: /Name/ }).click();
  await expect(
    root.getByRole("row", { name: filename(4999), exact: true }),
  ).toBeVisible();
  await expect(
    root.getByRole("columnheader", { name: /Name/ }),
  ).toHaveAttribute("aria-sort", "descending");
  await root.getByRole("columnheader", { name: /Name/ }).click();
  await root.getByRole("row", { name: filename(0), exact: true }).click();
  await content.focus();
  await content.press("F2");
  const rename = root.getByRole("textbox", { name: "New name", exact: true });
  await expect(rename).toBeFocused();
  await content.evaluate(
    (element) => (element.scrollTop = element.scrollHeight),
  );
  await expect(
    root.getByRole("row", { name: filename(4999), exact: true }),
  ).toBeVisible();
  await expect(rename).toHaveCount(1);
  await expect(rename).toBeFocused();
  await rename.fill("Renamed fixture.txt");
  await rename.press("Enter");
  await expect(rename).toHaveCount(0);
  await filter.fill("Renamed fixture");
  await expect(
    root.getByRole("row", { name: "Renamed fixture.txt", exact: true }),
  ).toBeVisible();
  await root.getByRole("button", { name: "Grid view", exact: true }).click();
  await expect(root.locator(".fc-tile span")).toHaveText("Renamed fixture.txt");
  await root.getByRole("button", { name: "List view", exact: true }).click();
  await expect(root.locator(".fc-item .fc-td-name span")).toHaveText(
    "Renamed fixture.txt",
  );
  expect(
    await page.evaluate(() =>
      (window as any).largeList.calls.some(
        (call: any) =>
          call.op === "rename-item" &&
          call.args.id === 1 &&
          call.args.name === "Renamed fixture.txt",
      ),
    ),
  ).toBe(true);
  await page.evaluate(() => (window as any).largeList.unmount());
});

test("large split panes retain independent scroll windows when hidden, resized and zoomed", async ({
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
    root.locator(".fc-content:visible .fc-item").first(),
  ).toBeVisible();
  await root.getByRole("tab").nth(1).click({ button: "right" });
  await root
    .getByRole("menuitem", { name: "Open in right split", exact: true })
    .click();
  const contents = root.locator(".fc-content:visible");
  await expect(contents).toHaveCount(2);
  await contents
    .nth(0)
    .evaluate((element) => (element.scrollTop = element.scrollHeight));
  await expect(
    contents.nth(0).getByRole("row", { name: filename(4999), exact: true }),
  ).toBeVisible();
  expect(await contents.nth(1).evaluate((element) => element.scrollTop)).toBe(
    0,
  );
  await page.evaluate(() => (window as any).largeList.resize(1100, 780, 0.6));
  await expect.poll(() => root.locator(".fc-item").count()).toBeLessThan(140);
  await expect(
    contents.nth(0).getByRole("row", { name: filename(4999), exact: true }),
  ).toBeVisible();
  await root.getByRole("tab").nth(1).click({ button: "right" });
  await root
    .getByRole("menuitem", { name: "Open in left split", exact: true })
    .click();
  await root.getByRole("tab").nth(0).click();
  await expect(
    root
      .locator(".fc-content:visible")
      .getByRole("row", { name: filename(4999), exact: true }),
  ).toBeVisible();
  await root.getByRole("tab").nth(1).click();
  expect(
    await root
      .locator(".fc-content:visible")
      .evaluate((element) => element.scrollTop),
  ).toBe(0);
  await page.evaluate(() => (window as any).largeList.unmount());
});
