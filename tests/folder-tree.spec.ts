import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
async function mount(page: Page, cabinet = false) {
  await page.goto("/");
  await page.evaluate(async (cabinet) => {
    const module = cabinet
      ? "/tests/large-lists-harness.ts"
      : "/tests/folder-tree-harness.ts";
    const harness = await import(module);
    (window as any).treeFixture = cabinet
      ? harness.mountLargeListFixture("cabinet")
      : harness.mountTreeFixture();
  }, cabinet);
  const root = page.locator(cabinet ? "#large-list-fixture" : "#tree-fixture");
  await expect
    .poll(() => root.locator("[data-folder-key]").count())
    .toBeGreaterThan(0);
  return root;
}

test("5,000 root folders remain bounded from first to last, including keyboard and surrounding sidebar controls", async ({
  page,
}) => {
  const root = await mount(page, true),
    sidebar = root.locator(".fc-sidebar");
  await expect
    .poll(() => root.locator("[data-folder-key]").count())
    .toBeLessThan(60);
  const first = root.locator("button.folder-tree-name").first();
  await first.focus();
  // Cross the mounted window using native sequential keyboard navigation.
  for (let i = 0; i < 110; i++) await page.keyboard.press("Tab");
  await expect(
    root.locator("button.folder-tree-name").filter({ hasText: "Folder 00055" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    root.getByRole("button", { name: "Expand Folder 00055", exact: true }),
  ).toBeFocused();
  // Scrolling away must keep the currently focused control alive.
  await sidebar.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    root.locator("button.folder-tree-name").filter({ hasText: "Folder 04999" }),
  ).toBeVisible();
  await expect(
    root.getByRole("button", { name: "Expand Folder 00055", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() => root.locator("[data-folder-key]").count())
    .toBeLessThan(60);
  await root
    .locator("button.folder-tree-name")
    .filter({ hasText: "Folder 04999" })
    .focus();
  await page.keyboard.press("Tab");
  await expect(root.getByRole("button", { name: "Bookmarks" })).toBeFocused();
  await root.getByRole("button", { name: "Bookmarks" }).press("Shift+Tab");
  await expect(
    root.locator("button.folder-tree-name").filter({ hasText: "Folder 04999" }),
  ).toBeFocused();
  await sidebar.evaluate((element) => {
    element.scrollTop = 0;
  });
  await root.getByRole("button", { name: "Bookmarks" }).focus();
  await sidebar.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.keyboard.press("Shift+Tab");
  await expect(
    root.locator("button.folder-tree-name").filter({ hasText: "Folder 04999" }),
  ).toBeFocused();
  await root.getByRole("textbox", { name: "Search folders" }).focus();
  await sidebar.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.keyboard.press("Tab");
  await expect(
    root.getByRole("button", { name: "Expand Folder 00000", exact: true }),
  ).toBeFocused();
  await root.getByRole("textbox", { name: "Search folders" }).fill("04999");
  await expect(root.locator("[data-folder-key]")).toHaveCount(1);
  await expect(root.locator("button.folder-tree-name")).toHaveText(
    "Folder 04999",
  );
  await root.getByRole("textbox", { name: "Search folders" }).fill("");
  await expect(root.locator("button.folder-tree-name").first()).toHaveText(
    "Folder 00000",
  );
  await root
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(root.locator(".folder-tree")).toHaveCount(0);
});

test("expanded descendants keep filtering, full navigation paths, badges, loading and empty hints", async ({
  page,
}) => {
  const root = await mount(page),
    sidebar = root.locator(".fc-sidebar");
  await expect(
    root.locator("button.folder-tree-name").first().locator("small"),
  ).toHaveText("7");
  await sidebar.evaluate((element) => {
    element.scrollTop = 11000;
  });
  const toggle = root.getByRole("button", {
    name: "Expand Child 0400",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const leaf = root
    .locator("button.folder-tree-name")
    .filter({ hasText: "Leaf" });
  await expect(leaf).toBeVisible();
  await expect(leaf.locator("..")).toHaveClass(/selected/);
  await leaf.click();
  expect(
    await page.evaluate(() => (window as any).treeFixture.navigations.at(-1)),
  ).toEqual([
    { id: 1, name: "Parent" },
    { id: 1400, name: "Child 0400" },
    { id: 9999, name: "Leaf" },
  ]);
  await sidebar.evaluate((element) => {
    element.scrollTop = 0;
  });
  await root.getByRole("textbox", { name: "Filter fixture" }).fill("Leaf");
  await expect(root.locator("[data-folder-key]")).toHaveCount(3);
  await expect(leaf).toBeVisible();
  expect(
    await leaf
      .locator("../..")
      .evaluate((element) => getComputedStyle(element).marginLeft),
  ).toBe("32px");
  await root.getByRole("button", { name: "Expand Leaf", exact: true }).click();
  await expect(
    root
      .locator(".folder-tree > .folder-tree-entry .folder-tree-hint")
      .filter({ hasText: "No subfolders" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).treeFixture.state.loading = [9999];
  });
  await expect(
    root
      .locator(".folder-tree > .folder-tree-entry .folder-tree-hint")
      .filter({ hasText: "Loading…" }),
  ).toBeVisible();
  await expect(
    root
      .locator(".folder-tree > .folder-tree-entry .folder-tree-hint")
      .filter({ hasText: "No subfolders" }),
  ).toHaveCount(0);
  await root
    .getByRole("button", { name: "Collapse Parent", exact: true })
    .click();
  await expect(root.locator("[data-folder-key]")).toHaveCount(0);
  await root.getByRole("textbox", { name: "Filter fixture" }).fill("");
  await expect(root.locator("[data-folder-key]")).toHaveCount(2);
});

test("nested tree window follows resize, hidden hosts, canvas zoom and final rows", async ({
  page,
}) => {
  const root = await mount(page),
    sidebar = root.locator(".fc-sidebar");
  await root.evaluate((element) => {
    element.style.transform = "scale(0.6)";
    element.style.transformOrigin = "top left";
  });
  await sidebar.evaluate((element) => {
    element.style.height = "420px";
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    root.locator("button.folder-tree-name").filter({ hasText: "Child 0499" }),
  ).toBeVisible();
  await expect(root.locator("#tree-footer")).toBeVisible();
  await sidebar.evaluate((element) => {
    element.style.display = "none";
  });
  await sidebar.evaluate((element) => {
    element.style.display = "block";
    element.style.height = "600px";
    element.scrollTop = 0;
  });
  await expect(root.locator("button.folder-tree-name").first()).toHaveText(
    "Parent7",
  );
  await expect
    .poll(() => root.locator("[data-folder-key]").count())
    .toBeLessThan(50);
  await page.evaluate(() => (window as any).treeFixture.unmount());
  await expect(root).toHaveCount(0);
});

test("mixed loading and empty rows preserve the full scroll extent when hints wrap", async ({
  page,
}) => {
  const root = await mount(page),
    sidebar = root.locator(".fc-sidebar");
  await page.evaluate(() => {
    const state = (window as any).treeFixture.state;
    state.expanded = [1, ...Array.from({ length: 250 }, (_, i) => 1000 + i)];
    state.loading = Array.from({ length: 100 }, (_, i) => 1000 + i);
  });
  async function extentError() {
    return root.locator(".folder-tree").evaluate((tree) => {
      const probes = tree.querySelector<HTMLElement>(".folder-tree-probes")!;
      const folder = parseFloat(
        getComputedStyle(probes.firstElementChild!).height,
      );
      const hints = Array.from(
        probes.querySelectorAll<HTMLElement>("[data-hint-probe]"),
      );
      const loading = hints.find((hint) =>
        hint.textContent?.includes("Loading"),
      )!;
      const empty = hints.find((hint) =>
        hint.textContent?.includes("No subfolders"),
      )!;
      if (!loading || !empty) return Infinity;
      const expected =
        502 * folder +
        100 * parseFloat(getComputedStyle(loading).height) +
        150 * parseFloat(getComputedStyle(empty).height);
      return Math.abs(parseFloat(getComputedStyle(tree).height) - expected);
    });
  }
  await expect.poll(extentError).toBeLessThan(1);
  await sidebar.evaluate((element) => {
    element.style.width = "105px";
  });
  await expect.poll(extentError).toBeLessThan(1);
  await sidebar.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    root.locator("button.folder-tree-name").filter({ hasText: "Child 0499" }),
  ).toBeVisible();
  await expect(root.locator("#tree-footer")).toBeVisible();
  await expect
    .poll(() => root.locator("[data-folder-key]").count())
    .toBeLessThan(60);
});
