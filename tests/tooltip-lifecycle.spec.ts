import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
async function mount(page: Page, initial?: string) {
  await page.goto("/");
  await page.evaluate(async (initial) => {
    const module = "/tests/tooltip-lifecycle-harness.ts";
    (window as any).tooltipFixture = (await import(module)).mountTooltipFixture(
      initial,
    );
  }, initial);
  return page.locator("#tooltip-fixture");
}
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("queued completion measurements cannot follow a SuiteQL document switch into an empty file", async ({
  page,
}, info) => {
  const root = await mount(page);
  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(error.message));
  let restoredCompletions = 0;
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => (window as any).tooltipFixture.open());
    await expect(root.locator(".cm-tooltip-autocomplete")).toBeVisible();
    await page.evaluate(async () => {
      const fixture = (window as any).tooltipFixture;
      fixture.queueTooltipMeasure();
      await fixture.switchDoc("b", "");
    });
    await frames(page);
    await expect(root.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
    await page.evaluate(() =>
      (window as any).tooltipFixture.switchDoc("a", "SELECT * FROM c"),
    );
    await frames(page);
    restoredCompletions += await root
      .locator(".cm-tooltip-autocomplete")
      .count();
    await page.evaluate(() => (window as any).tooltipFixture.close());
  }
  const errors = await page.evaluate(
    () => (window as any).tooltipFixture.errors,
  );
  console.log("Tooltip switch diagnostic:", {
    switches: 10,
    errors,
    restoredCompletions,
  });
  await info.attach("tooltip-switch-errors.json", {
    body: JSON.stringify({
      switches: 10,
      errors,
      restoredCompletions,
      uncaught,
    }),
    contentType: "application/json",
  });
  expect(restoredCompletions).toBe(0);
  expect(errors).toEqual([]);
  expect(uncaught).toEqual([]);
});

test("completion stays live for edits; document switches preserve independent history, selection, scroll and current settings", async ({
  page,
}) => {
  const initial = "-- fixture line\n".repeat(150) + "SELECT * FROM c";
  const root = await mount(page, initial);
  const content = root.locator(".cm-content");
  await page.evaluate(() => (window as any).tooltipFixture.open());
  await expect(root.locator(".cm-tooltip-autocomplete")).toBeVisible();
  await page.evaluate(() => (window as any).tooltipFixture.edit("u"));
  await expect(
    root
      .locator(".cm-tooltip-autocomplete")
      .getByText("currency", { exact: true }),
  ).toBeVisible();
  await root.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 1000;
  });
  await frames(page);
  const saved = await page.evaluate(() => {
    const fixture = (window as any).tooltipFixture;
    return {
      scroll: fixture.scroll,
      left: fixture.scrollLeft,
      selection: fixture.selection,
    };
  });
  expect(saved.scroll).toBeGreaterThan(0);
  expect(saved.selection).toBe(initial.length + 1);
  await page.evaluate(async () => {
    const fixture = (window as any).tooltipFixture;
    fixture.queueTooltipMeasure();
    await fixture.switchDoc("b", "");
    await fixture.edit("SELECT 2");
  });
  await page.evaluate(
    (value) => (window as any).tooltipFixture.switchDoc("a", value),
    initial + "u",
  );
  await frames(page);
  await expect(root.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await expect(content).toBeFocused();
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.selection),
  ).toBe(saved.selection);
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.scroll),
  ).toBeCloseTo(saved.scroll, 0);
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.scrollLeft),
  ).toBeCloseTo(saved.left, 0);
  await page.evaluate(() => (window as any).tooltipFixture.undo());
  expect(await page.evaluate(() => (window as any).tooltipFixture.text)).toBe(
    initial,
  );
  await page.evaluate(() => (window as any).tooltipFixture.redo());
  expect(await page.evaluate(() => (window as any).tooltipFixture.text)).toBe(
    initial + "u",
  );
  await page.evaluate(() =>
    (window as any).tooltipFixture.switchDoc("b", "SELECT 2"),
  );
  await page.evaluate(() => (window as any).tooltipFixture.undo());
  expect(await page.evaluate(() => (window as any).tooltipFixture.text)).toBe(
    "",
  );
  await page.evaluate(() => (window as any).tooltipFixture.redo());
  expect(await page.evaluate(() => (window as any).tooltipFixture.text)).toBe(
    "SELECT 2",
  );
  await page.evaluate(async (value) => {
    const fixture = (window as any).tooltipFixture;
    await fixture.settings(true);
    await fixture.switchDoc("a", value);
  }, initial + "u");
  await expect(content).toHaveAttribute("contenteditable", "false");
  await page.evaluate(async () => {
    const fixture = (window as any).tooltipFixture;
    await fixture.settings(false);
    await fixture.replace("SELECT * FROM em");
    fixture.open();
  });
  await expect(
    root
      .locator(".cm-tooltip-autocomplete")
      .getByText("employee", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).tooltipFixture.accept()))
    .toBe(true);
  expect(await page.evaluate(() => (window as any).tooltipFixture.text)).toBe(
    "SELECT * FROM employee",
  );
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.errors),
  ).toEqual([]);
});

test("pending completion stays dismissed across document switches and teardown; late results cannot reopen a popup", async ({
  page,
}) => {
  const root = await mount(page);
  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(error.message));
  await page.evaluate(() => (window as any).tooltipFixture.delayedCompletion());
  await expect
    .poll(() => page.evaluate(() => (window as any).tooltipFixture.requested))
    .toBe(1);
  await page.evaluate(() => (window as any).tooltipFixture.switchDoc("b", ""));
  await page.evaluate(() => (window as any).tooltipFixture.resolveCompletion());
  await frames(page);
  expect(await page.evaluate(() => (window as any).tooltipFixture.text)).toBe(
    "",
  );
  await expect(root.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await page.evaluate(async () => {
    const fixture = (window as any).tooltipFixture;
    await fixture.switchDoc("a", "SELECT * FROM c");
  });
  await frames(page);
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.requested),
  ).toBe(1);
  await expect(root.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await page.evaluate(() => {
    const fixture = (window as any).tooltipFixture;
    fixture.delayedCompletion();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).tooltipFixture.requested))
    .toBe(2);
  await page.evaluate(() => (window as any).tooltipFixture.unmount());
  await page.evaluate(() => (window as any).tooltipFixture.resolveCompletion());
  await frames(page);
  await expect(root).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.errors),
  ).toEqual([]);
  expect(uncaught).toEqual([]);
});

test("document scroll snapshots restore horizontal position for wide SQL", async ({
  page,
}) => {
  const initial = `-- ${"x".repeat(400)}\nSELECT * FROM c`;
  const root = await mount(page, initial);
  await root.locator(".cm-content").focus();
  await frames(page);
  await root.locator(".cm-scroller").evaluate((element) => {
    element.scrollLeft = 100;
  });
  await frames(page);
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.scrollLeft),
  ).toBe(100);
  await page.evaluate(() => (window as any).tooltipFixture.switchDoc("b", ""));
  await frames(page);
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.scrollLeft),
  ).toBe(0);
  await page.evaluate(
    (value) => (window as any).tooltipFixture.switchDoc("a", value),
    initial,
  );
  await frames(page);
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.scrollLeft),
  ).toBe(100);
  expect(
    await page.evaluate(() => (window as any).tooltipFixture.errors),
  ).toEqual([]);
});
