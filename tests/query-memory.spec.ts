import { test, expect } from "./fixtures";
const baseline = process.env.ORVANE_QUERY_MEMORY_BASELINE === "1";
test("open query output retention and reactive-wrapper diagnostic", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/query-memory-harness.ts";
    (window as any).queryMemory = (
      await import(module)
    ).mountQueryMemoryFixture();
  });
  const root = page.locator("#query-memory-fixture"),
    run = root
      .locator(".ns-query-toolbar")
      .getByRole("button", { name: "Run query", exact: true });
  for (let i = 0; i < 20; i++) {
    await root.getByRole("tab", { name: `Query ${i}`, exact: true }).click();
    await run.click();
    await expect(root.locator(".ns-result-row").first()).toContainText(
      `fixture_${i}`,
    );
  }
  await root.getByRole("tab", { name: "Query 0", exact: true }).click();
  const stats = await page.evaluate(() => (window as any).queryMemory.stats);
  console.log(
    "Query output diagnostic",
    baseline ? "baseline" : "candidate",
    stats,
  );
  await info.attach("query-memory.json", {
    body: JSON.stringify(stats),
    contentType: "application/json",
  });
  expect(stats.cachedTabs).toBe(19);
  expect(stats.rows).toBe(1900);
  expect(stats.queryRequests).toBe(20);
  if (!baseline) {
    expect(stats.reactiveRows).toBe(0);
    expect(stats.reactiveArrays).toBe(0);
  }
  await page.evaluate(() => (window as any).queryMemory.unmount());
});

test("trace output retention diagnostic", async ({ page }, info) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/query-memory-harness.ts";
    (window as any).queryMemory = (
      await import(module)
    ).mountQueryMemoryFixture(3);
  });
  const root = page.locator("#query-memory-fixture");
  await root
    .locator(".ns-query-list")
    .getByRole("button", { name: "Trace query", exact: true })
    .click();
  await expect(root.locator(".ns-trace details").last()).toContainText(
    "success",
  );
  await root.getByRole("tab", { name: "Query 1", exact: true }).click();
  const stats = await page.evaluate(() => (window as any).queryMemory.stats);
  console.log(
    "Trace output diagnostic",
    baseline ? "baseline" : "candidate",
    stats,
  );
  await info.attach("trace-memory.json", {
    body: JSON.stringify(stats),
    contentType: "application/json",
  });
  expect(stats.traceStages).toBeGreaterThan(0);
  if (!baseline) {
    expect(stats.reactiveStages).toBe(0);
    expect(stats.reactiveTraceRows).toBe(0);
  }
  await page.evaluate(() => (window as any).queryMemory.unmount());
});

async function mountBudgetFixture(
  page: import("@playwright/test").Page,
  budget = 300000,
  views = 1,
) {
  await page.goto("/");
  await page.evaluate(
    async ({ budget, views }) => {
      const module = "/tests/query-memory-harness.ts";
      (window as any).queryMemory = (
        await import(module)
      ).mountQueryMemoryFixture(3, 100, 1024, budget, views);
    },
    { budget, views },
  );
  return page.locator("#query-memory-fixture");
}

test("budget eviction releases old inactive results with an explicit rerun prompt and preserves SQL undo", async ({
  page,
}) => {
  const root = await mountBudgetFixture(page);
  const run = root
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query", exact: true });
  const editor = root.getByRole("textbox", {
    name: "SuiteQL editor",
    exact: true,
  });
  await run.click();
  await expect(root.locator(".ns-result-row").first()).toContainText(
    "fixture_0",
  );
  await root.getByRole("tab", { name: "Query 1", exact: true }).click();
  const original = "SELECT id, memo FROM fixture_1",
    edited = original + " /* edited */";
  await editor.fill(edited);
  await run.click();
  await expect(root.locator(".ns-result-row").first()).toContainText("edited");
  await root.getByRole("tab", { name: "Query 0", exact: true }).click();
  await expect(root.locator(".ns-result-row").first()).toContainText(
    "fixture_0",
  ); // Taking the target precedes admission of the outgoing result.
  await root.getByRole("tab", { name: "Query 2", exact: true }).click();
  await run.click();
  await expect(root.locator(".ns-result-row").first()).toContainText(
    "fixture_2",
  );
  await root.getByRole("tab", { name: "Query 1", exact: true }).click();
  await expect(root.getByRole("status")).toContainText(
    "released to free memory",
  );
  await expect(root.locator(".ns-empty")).toContainText("Run the query again");
  await expect(editor).toHaveText(edited);
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .queryRequests,
  ).toBe(3);
  await editor.press("Control+z");
  await expect(editor).toHaveText(original);
  await editor.press("Control+y");
  await expect(editor).toHaveText(edited);
  await run.click();
  await expect(root.locator(".ns-result-row").first()).toContainText("edited");
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .queryRequests,
  ).toBe(4);
  const stats = await page.evaluate(() => (window as any).queryMemory.stats);
  expect(stats.accountedCacheBytes).toBeLessThanOrEqual(300000);
  await page.evaluate(() => (window as any).queryMemory.unmount());
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .accountedCacheBytes,
  ).toBe(0);
});

test("the budget is shared across query views while displayed outputs remain protected", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2400, height: 1200 });
  const root = await mountBudgetFixture(page, 300000, 2),
    panels = root.locator(".query-memory-panel"),
    a = panels.nth(0),
    b = panels.nth(1);
  await a
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query", exact: true })
    .click();
  await expect(a.locator(".ns-result-row").first()).toContainText("fixture_0");
  await a.getByRole("tab", { name: "Query 1", exact: true }).click();
  await b
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query", exact: true })
    .click();
  await expect(b.locator(".ns-result-row").first()).toContainText("fixture_0");
  await b.getByRole("tab", { name: "Query 1", exact: true }).click();
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .accountedCacheBytes,
  ).toBeLessThanOrEqual(300000);
  await a.getByRole("tab", { name: "Query 0", exact: true }).click();
  await expect(a.locator(".ns-empty")).toContainText("released to free memory");
  await b.getByRole("tab", { name: "Query 0", exact: true }).click();
  await expect(b.locator(".ns-result-row").first()).toContainText("fixture_0");
  await page.evaluate(() => (window as any).queryMemory.setBudget(0));
  await expect(b.locator(".ns-result-row").first()).toContainText("fixture_0");
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .queryRequests,
  ).toBe(2);
  await page.evaluate(() => (window as any).queryMemory.unmount());
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .accountedCacheBytes,
  ).toBe(0);
});

test("trace progress updates explicitly and evicted traces never execute without a user request", async ({
  page,
}) => {
  const root = await mountBudgetFixture(page, 500000);
  await page.evaluate(() => (window as any).queryMemory.deferQueryAt(2));
  const trace = root
    .locator(".ns-query-list")
    .getByRole("button", { name: "Trace query", exact: true });
  await trace.click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as any).queryMemory.stats))
          .queryRequests,
    )
    .toBe(2);
  await expect(root.locator(".ns-trace details").first()).toContainText(
    "success",
  );
  await expect(root.locator(".ns-trace details").last()).toContainText(
    "running",
  );
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .formattedRowSerializations,
  ).toBe(1);
  await page.evaluate(() => (window as any).queryMemory.complete());
  await expect(root.locator(".ns-trace details").last()).toContainText(
    "success",
  );
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .formattedRowSerializations,
  ).toBe(2);
  await root.getByRole("tab", { name: "Query 1", exact: true }).click();
  await root
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query", exact: true })
    .click();
  await expect(root.locator(".ns-result-row").first()).toContainText(
    "fixture_1",
  );
  await root.getByRole("tab", { name: "Query 2", exact: true }).click();
  await root.getByRole("tab", { name: "Query 0", exact: true }).click();
  await root
    .locator(".ns-bottom-tabs")
    .getByRole("button", { name: "Execution trace", exact: true })
    .click();
  await expect(root.locator(".ns-trace-note")).toContainText(
    "released to free memory",
  );
  await expect(root.locator(".ns-trace details")).toHaveCount(0);
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .queryRequests,
  ).toBe(3);
  await trace.click();
  await expect(root.locator(".ns-trace details").last()).toContainText(
    "success",
  );
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .queryRequests,
  ).toBe(5);
  await page.evaluate(() => (window as any).queryMemory.unmount());
});

test("raw result snapshots keep sorting, filtering, clipboard and pagination complete without mutating cached order", async ({
  page,
}) => {
  const root = await mountBudgetFixture(page, 10000000),
    run = root
      .locator(".ns-query-toolbar")
      .getByRole("button", { name: "Run query", exact: true });
  await run.click();
  const id = root.locator(".ns-result-head button").first();
  await id.click();
  await id.click();
  await expect(
    root.locator(".ns-result-row").first().locator("span").first(),
  ).toHaveText("100");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await root.getByRole("button", { name: "Copy JSON", exact: true }).click();
  const copied = await page.evaluate(async () =>
    JSON.parse(await navigator.clipboard.readText()),
  );
  expect(copied).toHaveLength(100);
  expect(copied[0].id).toBe(100);
  expect(copied[99].id).toBe(1);
  await root
    .getByRole("textbox", { name: "Filter results", exact: true })
    .fill("row-99:");
  await expect(root.locator(".ns-result-row")).toHaveCount(1);
  await root.getByRole("button", { name: "Copy CSV", exact: true }).click();
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).split("\r\n"),
  ).toHaveLength(2);
  await root.getByRole("tab", { name: "Query 1", exact: true }).click();
  await root.getByRole("tab", { name: "Query 0", exact: true }).click();
  await expect(
    root.locator(".ns-result-row").first().locator("span").first(),
  ).toHaveText("1");
  await root.getByRole("button", { name: "Next", exact: true }).click();
  await expect(root.locator(".ns-results-title")).toContainText("101–200");
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .queryRequests,
  ).toBe(2);
  await page.evaluate(() => (window as any).queryMemory.unmount());
});

test("the default 64 MiB budget bounds wide inactive output without dropping displayed results or issuing queries", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/query-memory-harness.ts";
    (window as any).queryMemory = (
      await import(module)
    ).mountQueryMemoryFixture(20, 100, 32768, 1024 * 1024 * 1024);
  });
  const root = page.locator("#query-memory-fixture"),
    run = root
      .locator(".ns-query-toolbar")
      .getByRole("button", { name: "Run query", exact: true });
  for (let i = 0; i < 20; i++) {
    await root.getByRole("tab", { name: `Query ${i}`, exact: true }).click();
    await run.click();
    await expect(root.locator(".ns-result-row").first()).toContainText(
      `fixture_${i}`,
    );
  }
  const before = await page.evaluate(() => (window as any).queryMemory.stats);
  expect(before.cachedTabs).toBe(19);
  await page.evaluate(() =>
    (window as any).queryMemory.setBudget(64 * 1024 * 1024),
  );
  const after = await page.evaluate(() => (window as any).queryMemory.stats);
  console.log("Wide-output budget diagnostic", { before, after });
  await info.attach("wide-query-budget.json", {
    body: JSON.stringify({ before, after }),
    contentType: "application/json",
  });
  expect(after.accountedCacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(after.cachedTabs).toBe(10);
  expect(after.queryRequests).toBe(20);
  await expect(root.locator(".ns-result-row").first()).toContainText(
    "fixture_19",
  );
  await root.getByRole("tab", { name: "Query 0", exact: true }).click();
  await expect(root.locator(".ns-empty")).toContainText(
    "released to free memory",
  );
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .queryRequests,
  ).toBe(20);
  await page.screenshot({
    path: "artifacts/performance/query-output-released.png",
  });
  await page.evaluate(() => (window as any).queryMemory.unmount());
  expect(
    (await page.evaluate(() => (window as any).queryMemory.stats))
      .accountedCacheBytes,
  ).toBe(0);
});
