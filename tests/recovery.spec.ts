test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    () =>
      window === window.top &&
      localStorage.setItem("orvane.examples.v1", "installed"),
  );
});
import { test, expect } from "@playwright/test";
import { emptyWorkspace, makeBlock, uid, type CanvasApp } from "../src/model";
function fixtureApp(name: string, x = 140): CanvasApp {
  return {
    id: uid(),
    name,
    icon: "app",
    x,
    y: 160,
    width: 490,
    height: 500,
    blocks: [],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 26,
    gap: 18,
    radius: 8,
  };
}

test("backup import validates before replacing and exports the previous workspace", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("Keep me safe");
  const file = page.getByLabel("Import workspace file");
  await file.setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":1}'),
  });
  await expect(page.locator(".status-area")).toContainText(
    "not a valid Orvane workspace",
  );
  await expect(page.locator(".dock-tab")).toContainText("Keep me safe");
  const replacement = emptyWorkspace();
  replacement.apps = [fixtureApp("Restored backup")];
  const downloaded = page.waitForEvent("download");
  await file.setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replacement)),
  });
  const backup = await downloaded;
  expect(backup.suggestedFilename()).toMatch(/^orvane-.*\.json$/);
  await expect(page.locator(".dock-tab")).toContainText("Restored backup");
  await expect(page.locator(".status-area")).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator(".dock-tab")).toContainText("Restored backup");
});

test("dock order persists and switching retains counter state", async ({
  page,
}) => {
  const w = emptyWorkspace(),
    one = fixtureApp("One"),
    two = fixtureApp("Two", 1500);
  const count = makeBlock("counter");
  count.count = 8;
  one.blocks = [count];
  w.apps = [one, two];
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    if (!localStorage.getItem("orvane.workspace.v1"))
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, w);
  await page.goto("/");
  await page.getByRole("button", { name: "Two", exact: true }).click();
  await page.getByRole("button", { name: "One", exact: true }).click();
  await expect(page.locator("output")).toHaveText("8");
  await page
    .getByRole("button", { name: "One", exact: true })
    .press("Alt+ArrowRight");
  await expect(page.locator(".dock-tab")).toHaveText(["Two", "One"]);
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator(".dock-tab")).toHaveText(["Two", "One"]);
  await expect(page.locator("output")).toHaveText("8");
});

test("touch pinch scales the background without changing internal dimensions", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 800 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.addInitScript(
    () =>
      window === window.top &&
      localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  const before = await page
    .locator(".canvas-app")
    .evaluate((el) => (el as HTMLElement).offsetWidth);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 50, y: 100, id: 1 },
      { x: 150, y: 100, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 30, y: 100, id: 1 },
      { x: 200, y: 100, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const transform = await page.locator(".canvas-plane").getAttribute("style");
  expect(transform).not.toContain("zoom:");
  expect(transform).toContain("scale(1.7)");
  expect(
    await page
      .locator(".canvas-app")
      .evaluate((el) => (el as HTMLElement).offsetWidth),
  ).toBe(before);
  await context.close();
});
