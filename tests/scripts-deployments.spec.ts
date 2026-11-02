import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const baseline = process.env.ORVANE_DEPLOYMENTS_BASELINE === "1";
async function mount(page: Page, count = 1000, scripts = 20) {
  await page.goto("/");
  await page.evaluate(
    async ({ count, scripts }) => {
      const module = "/tests/scripts-windowing-harness.ts";
      (window as any).scriptsFixture = (
        await import(module)
      ).mountScriptsFixture("scripts", scripts, count);
    },
    { count, scripts },
  );
  const root = page.locator("#scripts-fixture");
  await expect(root.locator(".script-row")).toHaveCount(scripts);
  return root;
}

test("many expanded deployment panels retain all data with bounded row rendering", async ({
  page,
}, info) => {
  const root = await mount(page);
  for (let i = 0; i < 20; i++) {
    await root.locator(".script-row").nth(i).click();
    await expect(root.locator(".ns-deployments")).toHaveCount(i + 1);
  }
  const metrics = await root.evaluate((root) => ({
    elements: root.querySelectorAll("*").length,
    panels: root.querySelectorAll(".ns-deployments").length,
    deploymentRows: root.querySelectorAll(".ns-deployment").length,
  }));
  console.log(
    "Expanded deployments",
    baseline ? "baseline" : "candidate",
    metrics,
  );
  await info.attach("deployment-retention.json", {
    body: JSON.stringify(metrics),
    contentType: "application/json",
  });
  expect(metrics.panels).toBe(20);
  expect(metrics.deploymentRows).toBe(baseline ? 20000 : 2000);
  expect(
    await page.evaluate(
      () =>
        (window as any).scriptsFixture.calls.filter(
          (call: any) => call.op === "deployments",
        ).length,
    ),
  ).toBe(20);
});

test("deployment pages reach every row, preserve actions and support keyboard navigation", async ({
  page,
}) => {
  const root = await mount(page, 210, 2);
  await root.locator(".script-row").first().click();
  const panel = root.locator('[data-script-key="1"]');
  const previous = panel.getByRole("button", {
    name: "Previous deployments",
    exact: true,
  });
  const next = panel.getByRole("button", {
    name: "Next deployments",
    exact: true,
  });
  await expect(previous).toBeDisabled();
  await expect(panel.getByRole("status")).toHaveText(
    "Showing 1–100 of 210 deployments",
  );
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    seen.push(...(await panel.locator(".ns-record-link").allTextContents()));
    if (i < 2) {
      await next.focus();
      await page.keyboard.press("Enter");
    }
  }
  expect(seen.map((text) => text.trim())).toEqual(
    Array.from({ length: 210 }, (_, i) => `customdeploy_1_${i}`),
  );
  await expect(panel.locator(".ns-deployment")).toHaveCount(10);
  await expect(next).toBeDisabled();
  await expect(panel.getByRole("status")).toHaveText(
    "Showing 201–210 of 210 deployments",
  );
  const last = panel.getByRole("button", {
    name: "customdeploy_1_209",
    exact: true,
  });
  await last.click();
  expect(
    await page.evaluate(() => (window as any).scriptsFixture.opened),
  ).toEqual([{ kind: "deployment", id: 219 }]);
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(root.locator(".script-row").nth(1)).toBeFocused();
  await previous.click();
  await expect(panel.getByRole("status")).toHaveText(
    "Showing 101–200 of 210 deployments",
  );
});

test("expanded page state survives other panels, logs, sorting, scrolling and resizing", async ({
  page,
}) => {
  const root = await mount(page, 210, 20);
  await root.locator(".script-row").first().click();
  const panel = root.locator('[data-script-key="1"]');
  await panel
    .getByRole("button", { name: "Next deployments", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Execution logs", exact: true })
    .click();
  await expect(panel.locator(".ns-log-row")).toHaveCount(100);
  await root.locator('[data-script-key="2"] .script-row').click();
  await expect(
    root.locator('[data-script-key="2"] .ns-deployment'),
  ).toHaveCount(100);
  await root.locator(".ns-table-head button").first().click();
  await expect(panel.getByRole("status")).toHaveText(
    "Showing 101–200 of 210 deployments",
  );
  await root.locator(".ns-script-body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.evaluate(() =>
    (window as any).scriptsFixture.resize(600, 650, 0.75),
  );
  await panel
    .getByRole("button", { name: "Previous deployments", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Showing 1–100 of 210 deployments",
  );
  await expect(
    panel.getByRole("button", { name: "Next deployments", exact: true }),
  ).toBeInViewport();
  await root.screenshot({
    path: "artifacts/performance/script-deployment-pages.png",
  });
  await root.getByRole("button", { name: "Load scripts", exact: true }).click();
  await expect(root.locator(".ns-deployments")).toHaveCount(0);
  await root.locator('[data-script-key="1"] .script-row').click();
  await expect(panel.getByRole("status")).toHaveText(
    "Showing 1–100 of 210 deployments",
  );
});

test("small and empty deployment lists stay complete; 101 rows exposes a final one-row page", async ({
  page,
}) => {
  for (const count of [0, 100, 101]) {
    const root = await mount(page, count, 1);
    await root.locator(".script-row").click();
    await expect(root.locator(".ns-deployment")).toHaveCount(
      Math.min(100, count),
    );
    await expect(
      root.getByRole("navigation", { name: "Deployment pages", exact: true }),
    ).toHaveCount(count > 100 ? 1 : 0);
    if (!count)
      await expect(
        root.getByText("No deployments found.", { exact: true }),
      ).toBeVisible();
    if (count === 101) {
      await root
        .getByRole("button", { name: "Next deployments", exact: true })
        .click();
      await expect(root.locator(".ns-deployment")).toHaveCount(1);
      await expect(root.getByRole("status")).toHaveText(
        "Showing 101–101 of 101 deployments",
      );
    }
    await page.evaluate(() => (window as any).scriptsFixture.unmount());
  }
});
