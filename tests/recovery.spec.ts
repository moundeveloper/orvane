test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    () =>
      window === window.top &&
      localStorage.setItem("orvane.examples.v1", "installed"),
  );
});
import { test, expect } from "./fixtures";
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

test("backup import previews replacement and retains a local recovery snapshot", async ({
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
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await file.setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replacement)),
  });
  await expect(
    page.getByRole("dialog", { name: "Backup import preview" }),
  ).toBeVisible();
  await expect(page.locator(".dock-tab")).toContainText("Keep me safe");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  expect(downloads).toEqual([]);
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

test("advisory statuses without actions dismiss themselves; save failures stay", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
  await page.getByLabel("Import workspace file").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":1}'),
  });
  const status = page.locator(".status-area");
  await expect(status).toContainText("not a valid Orvane workspace");
  await expect(status).toHaveCount(0, { timeout: 8000 });

  await page.route("**/__orvane/storage/state", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(status).toContainText("Saving is unavailable");
  await page.waitForTimeout(7000);
  await expect(status).toContainText("Saving is unavailable");
});

test("a save that fails once is retried quietly and never shows the warning", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
  let failed = 0;
  await page.route("**/__orvane/storage/state", (route) => {
    if (route.request().method() === "PUT" && failed < 2) {
      failed++;
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await expect.poll(() => failed).toBe(2);
  await expect(page.locator("main")).toHaveAttribute("data-saved", "true");
  await page.waitForTimeout(1500);
  await expect(page.locator(".status-area")).toHaveCount(0);
  await page.unroute("**/__orvane/storage/state");
  await page.reload();
  await expect(page.locator(".dock-tab")).toHaveCount(1);
});

test("saves still go through while another large keepalive request is in flight", async ({
  page,
}) => {
  // Record save calls that the page itself sees rejected (a quota rejection
  // never reaches the network, and the quiet retry would hide it).
  await page.addInitScript(() => {
    const failures: string[] = ((window as any).__saveFailures = []);
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const save =
        String(input).includes("/__orvane/storage/state") && init?.method === "PUT";
      // Another part of the page (like UI Maker) sending a large keepalive
      // request at the same moment, holding most of the 64 KB budget.
      const other = (window as any).__otherKeepalive as string | undefined;
      if (save && other)
        void original(other, {
          method: "POST",
          mode: "no-cors",
          body: "x".repeat(65400),
          keepalive: true,
        }).catch(() => {});
      const promise = original(input, init);
      if (save) promise.catch((error) => failures.push(String(error)));
      return promise;
    };
  });
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
  const slow =(await import("node:http")).createServer((req, res) => {
    req.resume();
    req.on("end", () => setTimeout(() => res.end("{}"), 8000));
  });
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
  const slowUrl = `http://127.0.0.1:${(slow.address() as { port: number }).port}/slow-keepalive`;
  const failures: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().includes("/__orvane/storage/state")) failures.push(r.failure()?.errorText || "");
  });
  await page.evaluate((url) => ((window as any).__otherKeepalive = url), slowUrl);
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(page.locator("main")).toHaveAttribute("data-saved", "true");
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => (window as any).__saveFailures)).toEqual([]);
  await expect(page.locator(".status-area")).toHaveCount(0);
  slow.closeAllConnections();
  slow.close();
});
