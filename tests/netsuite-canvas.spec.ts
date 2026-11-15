import { test, expect } from "./fixtures";

test("SuiteQL rows drive a persisted record preview on the canvas", async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    const host = window as Window & {
      orvaneDesktop?: unknown;
      finishFirstPreview?: () => void;
    };
    const environment = "https://123-sb1.app.netsuite.com";
    host.orvaneDesktop = {
      netsuite: {
        tabs: async () => [
          { id: environment, label: "Sandbox", status: "ready", count: 1 },
        ],
        run: async (
          account: string,
          operation: string,
          args: { kind: string; id: number },
        ) => {
          if (operation === "query")
            return {
              rows: [
                { customer_key: "101", company: "North" },
                { customer_key: 202, company: "South" },
                { customer_key: null, company: "No customer" },
              ],
              totalCount: 3,
            };
          if (operation !== "record-preview") return {};
          if (account !== environment || args.kind !== "customer")
            throw Error("Wrong record mapping");
          if (args.id === 101) {
            await new Promise<void>((done) => {
              host.finishFirstPreview = done;
            });
          }
          return {
            fields: [
              {
                id: "email",
                label: "Email",
                value: `customer-${args.id}@example.test`,
              },
            ],
          };
        },
      },
    };
  });
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  const suite = page.locator(".ns-workspace");
  await suite
    .locator(".ns-home .home-open")
    .filter({ hasText: "SuiteQL" })
    .click();
  const run = suite
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query" });
  await run.click();
  await suite
    .getByRole("button", { name: "Add record preview" })
    .dragTo(page.locator(".canvas-background"), {
      targetPosition: { x: page.viewportSize()!.width - 5, y: 260 },
    });
  await suite.getByRole("button", { name: "Show record preview" }).click();

  const preview = page.getByRole("region", { name: "NetSuite record preview" });
  await expect(preview.getByText("Untitled query")).toBeVisible();
  await preview.getByRole("textbox", { name: "Record type" }).fill("customer");
  await preview.getByRole("combobox", { name: "Internal ID column" }).click();
  await page.getByRole("option", { name: "customer_key", exact: true }).click();
  await preview.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(preview).toContainText("Select a row");

  await suite.getByRole("button", { name: "Preview result row 1" }).click();
  await expect(preview).toContainText("customer #101");
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishFirstPreview))
    .toBe("function");
  await suite
    .getByRole("button", { name: "Preview result row 2" })
    .press("Enter");
  await expect(preview).toContainText("customer-202@example.test");
  await page.evaluate(async () => {
    (window as any).finishFirstPreview();
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
  });
  await expect(preview).toContainText("customer-202@example.test");
  await expect(preview).not.toContainText("customer-101@example.test");
  await suite.getByRole("button", { name: "Preview result row 3" }).click();
  await expect(preview).toContainText("no valid internal ID");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await page
    .getByRole("navigation", { name: "Canvas apps" })
    .getByRole("button", { name: "NetSuite", exact: true })
    .click();
  await run.click();
  await suite.getByRole("button", { name: "Show record preview" }).click();
  await expect(preview).toHaveCount(1);
  await expect(
    preview.getByRole("textbox", { name: "Record type" }),
  ).toHaveValue("customer");
  await expect(
    preview.getByRole("combobox", { name: "Internal ID column" }),
  ).toContainText("customer_key");
  await suite.getByRole("button", { name: "Preview result row 2" }).click();
  await expect(preview).toContainText("customer-202@example.test");
});
