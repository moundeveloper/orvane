import { test, expect } from "./fixtures";

async function mount(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/query-performance-harness.ts";
    (window as any).queryFixture = (await import(module)).mountQueryFixture();
  });
  return page.locator("#query-fixture");
}

test("closing a SuiteQL tab releases output without rerunning its query", async ({
  page,
}) => {
  const root = await mount(page);
  await root
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query", exact: true })
    .click();
  await expect(root.locator(".ns-result-row")).toContainText("Result: SELECT");
  await root
    .getByRole("button", { name: "Close Alpha tab", exact: true })
    .click();
  await root
    .locator(".ns-query-list")
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(root.locator(".ns-result-row")).toHaveCount(0);
  await expect(root.locator(".ns-empty")).toContainText("Run a query");
  expect(await page.evaluate(() => (window as any).queryFixture.queries)).toBe(
    1,
  );
  await page.evaluate(() => (window as any).queryFixture.unmount());
});

test("open tabs retain results and traces; closing active and background tabs releases both", async ({
  page,
}) => {
  const root = await mount(page);
  const run = root
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query", exact: true });
  await run.click();
  await expect(root.locator(".ns-result-row")).toContainText("customer");
  await root
    .locator(".ns-query-list")
    .getByRole("button", { name: "Trace query", exact: true })
    .click();
  await expect(root.locator(".ns-trace details").first()).toContainText(
    "success",
  );
  const executions = await page.evaluate(
    () => (window as any).queryFixture.queries,
  );
  await root.getByRole("tab", { name: "Beta", exact: true }).click();
  await run.click();
  await expect(root.locator(".ns-result-row")).toContainText("vendor");
  await root.getByRole("tab", { name: "Alpha", exact: true }).click();
  await expect(root.locator(".ns-result-row")).toContainText("customer");
  await root
    .getByRole("button", { name: "Execution trace", exact: true })
    .click();
  await expect(root.locator(".ns-trace details").first()).toContainText(
    "success",
  );
  expect(await page.evaluate(() => (window as any).queryFixture.queries)).toBe(
    executions + 1,
  );
  await root
    .getByRole("button", { name: "Close Alpha tab", exact: true })
    .click();
  await expect(root.locator(".ns-result-row")).toContainText("vendor");
  await root
    .locator(".ns-query-list")
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(root.locator(".ns-result-row")).toHaveCount(0);
  await root
    .getByRole("button", { name: "Execution trace", exact: true })
    .click();
  await expect(root.locator(".ns-trace")).toContainText("Trace a query");
  await root
    .getByRole("button", { name: "Close Beta tab", exact: true })
    .click();
  await root
    .locator(".ns-query-list")
    .getByRole("button", { name: "Beta", exact: true })
    .click();
  await expect(root.locator(".ns-result-row")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).queryFixture.queries)).toBe(
    executions + 1,
  );
  await run.click();
  await expect(root.locator(".ns-result-row")).toContainText("vendor");
  expect(await page.evaluate(() => (window as any).queryFixture.queries)).toBe(
    executions + 2,
  );
  await page.evaluate(() => (window as any).queryFixture.unmount());
});

for (const deletion of ["local", "remote"] as const) {
  test(`SQL and undo survive tab closure; ${deletion} deletion forgets the editor history`, async ({
    page,
  }) => {
    const root = await mount(page);
    const content = root.locator(".cm-content");
    const original = "SELECT id, name FROM customer";
    const edited = `${original} WHERE id = 1`;
    await content.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" WHERE id = 1");
    await expect(content).toHaveText(edited);
    await root.getByRole("tab", { name: "Beta", exact: true }).click();
    await root
      .getByRole("button", { name: "Close Alpha tab", exact: true })
      .click();
    await root
      .locator(".ns-query-list")
      .getByRole("button", { name: "Alpha", exact: true })
      .click();
    await expect(content).toHaveText(edited);
    await content.click();
    await page.keyboard.press("Control+z");
    await expect(content).toHaveText(original);
    await page.keyboard.press("Control+y");
    await expect(content).toHaveText(edited);
    if (deletion === "local")
      await root
        .getByRole("button", { name: "Delete query", exact: true })
        .click();
    else
      await page.evaluate(() => (window as any).queryFixture.remove("alpha"));
    await expect(
      root.getByRole("tab", { name: "Alpha", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(
      (sql) => (window as any).queryFixture.recreate("alpha", sql),
      edited,
    );
    await root
      .locator(".ns-query-list")
      .getByRole("button", { name: "Recreated", exact: true })
      .click();
    await expect(content).toHaveText(edited);
    await content.click();
    await page.keyboard.press("Control+z");
    await expect(content).toHaveText(edited);
    await page.evaluate(() => (window as any).queryFixture.unmount());
  });
}

for (const operation of ["query", "trace"] as const) {
  for (const change of ["environment", "deletion", "unmount"] as const) {
    test(`late ${operation} output is ignored after ${change}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const root = await mount(page);
      await page.evaluate(() => (window as any).queryFixture.defer());
      if (operation === "query")
        await root
          .locator(".ns-query-toolbar")
          .getByRole("button", { name: "Run query", exact: true })
          .click();
      else
        await root
          .locator(".ns-query-list")
          .getByRole("button", { name: "Trace query", exact: true })
          .click();
      await expect
        .poll(() => page.evaluate(() => (window as any).queryFixture.queries))
        .toBe(1);
      await page.evaluate((action) => {
        const fixture = (window as any).queryFixture;
        if (action === "environment") fixture.changeEnvironment();
        else if (action === "deletion") fixture.remove("alpha");
        else fixture.unmount();
      }, change);
      if (change === "deletion")
        await expect(
          root.getByRole("tab", { name: "Beta", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
      if (change === "environment")
        await expect(root.locator(".ns-result-row")).toHaveCount(0);
      await page.evaluate(() => (window as any).queryFixture.complete());
      if (change !== "unmount") {
        await expect(
          root
            .locator(".ns-query-toolbar")
            .getByRole("button", { name: "Run query", exact: true }),
        ).toBeEnabled();
        await expect(root.locator(".ns-result-row")).toHaveCount(0);
        await root
          .getByRole("button", { name: "Execution trace", exact: true })
          .click();
        await expect(root.locator(".ns-trace details")).toHaveCount(0);
        await page.evaluate(() => (window as any).queryFixture.unmount());
      }
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(errors).toEqual([]);
    });
  }
}
