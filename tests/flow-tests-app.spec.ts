import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SiteMemoryStore } from "../server/site-memory.ts";

// The Test runs app runs a site's tests itself (no AI needed): the run map
// fills in live, the Browser tab shows REC and the step trail, the failed
// test opens a filmstrip and a replay with its error. Runs an AI starts
// through flow_tests show up in the same app.
test("Test runs app: run all, live map and overlay, filmstrip and replay", async ({}, info) => {
  test.setTimeout(240_000);
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/order")
      return response.end(`<!doctype html><title>Sales Order</title><body style="font:16px sans-serif;padding:20px">
<h1>Sales Order</h1><p>Customer C1043 Mobili Riva</p>
<button onclick="setTimeout(() => { tax.textContent = ''; }, 200)">Add line</button>
<table><tr><td>SEDIA-ERG-01</td><td id="tax"></td></tr></table></body>`);
    response.end(`<!doctype html><title>Home</title><body style="font:16px sans-serif;padding:20px"><h1>Welcome to the demo shop</h1><a href="/order">Orders</a></body>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const host = `127.0.0.1:${address.port}`;
  const data = info.outputPath("data");
  const env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const store = new SiteMemoryStore(data);
  store.saveFlow(host, "user", {
    name: "Line gets IT VAT", description: "A new line gets the IT 22% tax code",
    steps: [
      { action: "navigate", path: "/order" },
      { action: "click", text: "Add line" },
      { action: "expect", selector: "#tax", equals: "IT 22%", timeoutMs: 1500 },
    ],
  });
  store.saveFlow(host, "user", {
    name: "Home greets", description: "The home page says welcome",
    steps: [{ action: "navigate", path: "/" }, { action: "expect", selector: "h1", contains: "Welcome" }],
  });
  store.close();

  const app = await electron.launch({ args: ["electron/main.mjs"], env: { ...env, ORVANE_PORT: "5246", ORVANE_USER_DATA: info.outputPath("profile") } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5246" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-flow-tests-app", version: "1.0.0" });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 950 }).catch(() => undefined);
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await expect.poll(async () => (await call("workspace_status")).sessions.length, { timeout: 30_000 }).toBe(1);
    // The site is open in the Browser (signed in, in real life).
    const opened = await call("browser_open", { url: `${origin}/`, purpose: "user" });
    await call("browser_control", { tabId: opened.tabId, action: "release" });

    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Test runs" }).click();
    const ft = page.locator(".ft");
    await expect(ft).toBeVisible();
    await expect(ft.getByRole("option", { name: /Line gets IT VAT/ })).toBeVisible({ timeout: 15_000 });
    await expect(ft.getByRole("option", { name: /Home greets/ })).toContainText("never");

    // Run all: the map draws live and the Browser tab shows REC and the trail.
    await ft.getByRole("button", { name: /Run all/ }).click();
    await expect(ft.getByRole("tab", { name: "Map", selected: true })).toBeVisible();
    const trail = page.locator(".browser-test-run .test-trail");
    await expect(trail).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".browser-test-run .test-rec")).toBeVisible();
    await expect(trail).toContainText(/Line gets IT VAT|Home greets/);
    await page.screenshot({ path: info.outputPath("running.png") });
    await expect(ft.locator(".ft-prog")).toContainText("Run finished", { timeout: 60_000 });
    await expect(ft.locator(".ft-node.bad")).toHaveCount(1);
    await expect(ft.locator(".ft-node.bad .ft-node-path")).toHaveText("order");
    await expect(ft.locator(".ft-node.ok")).toHaveCount(1);
    await expect(ft.locator(".ft-node .ft-shot img").first()).toHaveJSProperty("complete", true);
    await page.locator("nav.dock").getByRole("button", { name: "Test runs", exact: true }).click();
    await page.screenshot({ path: info.outputPath("map.png") });

    // Tests: the failure, its filmstrip of recorded steps. (The run brought
    // the Browser to the front; bring Test runs back.)
    await ft.getByRole("tab", { name: "Tests" }).click();
    const failing = ft.getByRole("option", { name: /Line gets IT VAT/ });
    await expect(failing).toHaveClass(/bad/);
    await failing.click();
    const open = ft.locator(".ft-open");
    await expect(open).toContainText('expected #tax to be "IT 22%", got empty');
    await expect(open.locator(".ft-frame")).toHaveCount(3);
    await expect(open.locator(".ft-frame.bad")).toHaveCount(1);
    await expect.poll(() => open.locator(".ft-frame img").first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath("tests.png") });

    // Replay at the failure: the frame, the steps, the error.
    await open.getByRole("button", { name: /Open replay/ }).click();
    const replay = ft.locator(".ft-replay");
    await expect(replay.locator(".ft-step.bad")).toContainText("#tax");
    await expect(replay.locator(".ft-detail")).toContainText('expected #tax to be "IT 22%", got empty');
    await expect.poll(() => replay.locator(".ft-video img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(replay.locator(".ft-cap")).toContainText("expect #tax");
    await replay.getByRole("tab", { name: "Page" }).click();
    await expect(replay.locator(".ft-page code")).toContainText("/order");
    await page.screenshot({ path: info.outputPath("replay.png") });

    // A run an AI starts through flow_tests lands in the same app.
    const tab = (await call("browser_open", { url: `${origin}/` })).tabId;
    await call("flow_tests", { action: "run", tabId: tab, record: false });
    await page.locator("nav.dock").getByRole("button", { name: "Test runs", exact: true }).click();
    await ft.getByRole("tab", { name: "Tests" }).click();
    await expect(ft.getByRole("option", { name: /Home greets/ }).locator(".ft-hist i")).toHaveCount(2, { timeout: 15_000 });
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    site.close();
  }
});
