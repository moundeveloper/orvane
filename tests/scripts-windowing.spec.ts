import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
const baseline = process.env.ORVANE_SCRIPTS_BASELINE === "1";
async function mount(
  page: Page,
  kind: "scripts" | "search" = "scripts",
  count = 5000,
) {
  await page.goto("/");
  await page.evaluate(
    async ({ kind, count }) => {
      const module = "/tests/scripts-windowing-harness.ts";
      (window as any).scriptsFixture = (
        await import(module)
      ).mountScriptsFixture(kind, count);
    },
    { kind, count },
  );
  const root = page.locator("#scripts-fixture");
  if (kind === "scripts")
    await expect(root.locator(".script-row").first()).toBeInViewport();
  return root;
}

test("script and bridge-bounded search rendering diagnostics", async ({
  page,
}, info) => {
  let root = await mount(page);
  const metrics = await root.evaluate((root) => {
    const body = root.querySelector<HTMLElement>(".ns-script-body")!;
    const row = root.querySelector<HTMLElement>(".script-row")!;
    return {
      elements: root.querySelectorAll("*").length,
      records: root.querySelectorAll(".ns-record").length,
      bodyHeight: body.clientHeight,
      scrollHeight: body.scrollHeight,
      rowHeight: row.offsetHeight,
      columns: getComputedStyle(row).gridTemplateColumns,
    };
  });
  console.log(
    "Scripts diagnostic",
    baseline ? "baseline" : "candidate",
    metrics,
  );
  await info.attach("scripts-layout.json", {
    body: JSON.stringify(metrics),
    contentType: "application/json",
  });
  if (!baseline) expect(metrics.records).toBeLessThan(100);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({
    path: `artifacts/performance/scripts-${baseline ? "baseline" : "candidate"}.png`,
  });
  await root.locator(".script-row").first().click();
  const panel = root.locator(".ns-deployments").first();
  await panel
    .getByRole("button", { name: "Execution logs", exact: true })
    .click();
  await expect(panel.locator(".ns-log-row")).toHaveCount(100);
  console.log(
    "Expanded scripts diagnostic",
    await root.evaluate((root) => ({
      elements: root.querySelectorAll("*").length,
      deploymentRows: root.querySelectorAll(".ns-deployment").length,
      logRows: root.querySelectorAll(".ns-log-row").length,
    })),
  );
  await page.evaluate(() => (window as any).scriptsFixture.unmount());
  root = await mount(page, "search");
  await root
    .getByRole("textbox", { name: "Search all files and folders", exact: true })
    .fill("fixture");
  await root
    .getByRole("textbox", { name: "Search all files and folders", exact: true })
    .press("Enter");
  await expect(root.locator(".fc-result")).toHaveCount(200);
  console.log(
    "Bridge-bounded search diagnostic",
    await root.evaluate((root) => ({
      elements: root.querySelectorAll("*").length,
      resultElements: root
        .querySelector(".fc-search-results")!
        .querySelectorAll("*").length,
      results: root.querySelectorAll(".fc-result").length,
    })),
  );
});

const script = (root: import("@playwright/test").Locator, i: number) =>
  root
    .locator(".script-row")
    .filter({ hasText: `Script ${String(i).padStart(5, "0")}` });

test("keyboard traversal visits unmounted scripts, keeps focus on scroll and enters/leaves through surrounding controls", async ({
  page,
}) => {
  const root = await mount(page),
    body = root.locator(".ns-script-body");
  await script(root, 0).focus();
  for (let i = 0; i < 75; i++) await page.keyboard.press("Tab");
  await expect(script(root, 75)).toBeFocused();
  await expect(script(root, 75)).toBeInViewport();
  await page.keyboard.press("Shift+Tab");
  await expect(script(root, 74)).toBeFocused();
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(script(root, 4999)).toBeInViewport();
  await expect(script(root, 74)).toBeFocused();
  await expect.poll(() => root.locator(".ns-record").count()).toBeLessThan(60);
  await root.locator(".ns-table-head button").last().focus();
  await page.keyboard.press("Tab");
  await expect(script(root, 0)).toBeFocused();
  await expect(script(root, 0)).toBeInViewport();
  await root.evaluate((element) => {
    const footer = document.createElement("button");
    footer.id = "after-scripts";
    footer.textContent = "After scripts";
    footer.style.cssText = "position:fixed;bottom:0;right:0";
    element.appendChild(footer);
  });
  await root.locator("#after-scripts").focus();
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.keyboard.press("Shift+Tab");
  await expect(script(root, 4999)).toBeFocused();
  await expect(script(root, 4999)).toBeInViewport();
  await page.keyboard.press("Tab");
  await expect(root.locator("#after-scripts")).toBeFocused();
});

test("expanded panels retain native controls, preview and log scroll; offscreen size changes keep the visible anchor", async ({
  page,
}) => {
  const root = await mount(page),
    body = root.locator(".ns-script-body");
  await script(root, 0).click();
  const record = root.locator('[data-script-key="1"]');
  await expect(record.locator(".ns-deployment")).toHaveCount(5);
  await script(root, 0).focus();
  await page.keyboard.press("Tab");
  await expect(
    record.getByRole("button", { name: "Copy internal ID", exact: true }),
  ).toBeFocused();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await record
    .getByRole("button", { name: "Copy script ID", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "customscript_fixture_0",
  );
  await record
    .getByRole("button", { name: "Execution logs", exact: true })
    .click();
  await expect(record.locator(".ns-log-row")).toHaveCount(100);
  await record
    .getByRole("button", { name: "View script file", exact: true })
    .click();
  await expect(record.locator(".ns-script-preview pre")).toContainText(
    "// Script fixture",
  );
  await record
    .getByRole("button", { name: "Edit script file", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as any).scriptsFixture.edited),
  ).toEqual([{ id: 10000, name: "fixture-0.js" }]);
  await record
    .getByRole("button", { name: "Open in NetSuite", exact: true })
    .click();
  await record
    .getByRole("button", { name: "customdeploy_1_4", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as any).scriptsFixture.opened),
  ).toEqual([
    { kind: "script", id: 1 },
    { kind: "deployment", id: 14 },
  ]);
  await record
    .getByRole("button", { name: "customdeploy_1_4", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(script(root, 1)).toBeFocused();
  await record.locator(".ns-script-logs").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const logScroll = await record
    .locator(".ns-script-logs")
    .evaluate((element) => element.scrollTop);
  expect(logScroll).toBeGreaterThan(0);
  await record.evaluate((element) => {
    (window as any).retainedScriptRecord = element;
  });
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(script(root, 4999)).toBeInViewport();
  expect(
    await record.evaluate(
      (element) => element === (window as any).retainedScriptRecord,
    ),
  ).toBe(true);
  expect(
    await record
      .locator(".ns-script-logs")
      .evaluate((element) => element.scrollTop),
  ).toBe(logScroll);
  const before = (await script(root, 4999).boundingBox())!.y;
  await record
    .locator(".ns-script-logs")
    .getByRole("button", { name: "Close", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect
    .poll(async () => (await script(root, 4999).boundingBox())!.y)
    .toBeCloseTo(before, 0);
  await script(root, 0).evaluate((element) =>
    (element as HTMLButtonElement).click(),
  );
  await expect(record.locator(".ns-deployments")).toHaveCount(0);
  await expect(script(root, 4999)).toBeInViewport();
  expect(
    await page.evaluate(
      () =>
        (window as any).scriptsFixture.calls.filter(
          (call: any) => call.op === "deployments",
        ).length,
    ),
  ).toBe(1);
});

test("filtering, script types, sorting and environment changes operate on the complete record set", async ({
  page,
}) => {
  const root = await mount(page),
    body = root.locator(".ns-script-body"),
    filter = root.getByRole("textbox", { name: "Filter scripts", exact: true });
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(script(root, 4999)).toBeInViewport();
  await filter.fill("Script 04999");
  await expect(root.locator(".script-row")).toHaveCount(1);
  await expect(script(root, 4999)).toBeInViewport();
  await filter.fill("");
  await expect(script(root, 0)).toBeInViewport();
  expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
  await root
    .getByRole("button", { name: "Filter script types", exact: true })
    .click();
  await root.getByRole("checkbox", { name: "Scheduled", exact: true }).check();
  await root
    .getByRole("button", { name: "Filter script types", exact: true })
    .click();
  await expect(script(root, 1)).toBeInViewport();
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(script(root, 4999)).toBeInViewport();
  await root.locator(".ns-table-head button").first().click();
  await expect(script(root, 4999)).toBeInViewport();
  expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
  await page.evaluate(() => (window as any).scriptsFixture.changeEnvironment());
  await expect(script(root, 4999)).toBeInViewport(); // Descending order is retained.
  await expect(
    root.getByRole("button", { name: "Filter script types", exact: true }),
  ).toContainText("All script types");
  await expect.poll(() => root.locator(".ns-record").count()).toBeLessThan(60);
});

test("async expansion, errors, resize and hidden hosts preserve the window and clean up on close", async ({
  page,
}) => {
  const root = await mount(page),
    body = root.locator(".ns-script-body");
  await page.evaluate(() => (window as any).scriptsFixture.holdDeployments());
  await script(root, 0).click();
  await expect(
    root.getByText("Loading deployments…", { exact: true }),
  ).toBeVisible();
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(script(root, 4999)).toBeInViewport();
  await page.evaluate(() =>
    (window as any).scriptsFixture.releaseDeployments(),
  );
  await expect(root.locator(".ns-deployment")).toHaveCount(5);
  await expect(script(root, 4999)).toBeInViewport();
  await page.evaluate(() =>
    (window as any).scriptsFixture.resize(760, 650, 0.6),
  );
  await expect(script(root, 4999)).toBeInViewport();
  await root.evaluate((element) => {
    element.style.display = "none";
  });
  await root.evaluate((element) => {
    element.style.display = "flex";
  });
  await expect(script(root, 4999)).toBeInViewport();
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(script(root, 1)).toBeInViewport();
  await page.evaluate(() => (window as any).scriptsFixture.holdDeployments());
  await script(root, 1).click();
  await page.evaluate(() => (window as any).scriptsFixture.rejectDeployments());
  await expect(
    root.getByText("Fixture deployment error", { exact: true }),
  ).toBeVisible();
  await script(root, 1).click();
  await script(root, 1).click();
  await expect(
    root.locator('[data-script-key="2"] .ns-deployment'),
  ).toHaveCount(5);
  await expect(
    root.getByText("Fixture deployment error", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => (window as any).scriptsFixture.unmount());
  await expect(root).toHaveCount(0);
  await page.keyboard.press("Tab");
});

test("small script lists remain complete at the windowing boundary", async ({
  page,
}) => {
  let root = await mount(page, "scripts", 100);
  await expect(root.locator(".script-row")).toHaveCount(100);
  await page.evaluate(() => (window as any).scriptsFixture.unmount());
  root = await mount(page, "scripts", 101);
  await expect
    .poll(() => root.locator(".script-row").count())
    .toBeLessThan(101);
  await root.locator(".ns-script-body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(script(root, 100)).toBeInViewport();
});
