import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SiteMemoryStore } from "../server/site-memory.ts";

// flow_tests: approved flows with expect steps are tests. run films each one
// and keeps the evidence of a failure; failure returns it; rerun compares.
test("flow_tests runs saved flows as tests, explains a failure and confirms the fix", async ({}, info) => {
  test.setTimeout(240_000);
  let fixed = false;
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/order")
      // The bug: a customer without a VAT number gets no tax code until fixed.
      return response.end(`<!doctype html><title>Sales Order</title><h1>Sales Order</h1>
<p>Customer <b id="customer">${url.searchParams.get("c") ?? ""}</b></p>
<button onclick="tax.textContent = ${fixed ? "'IT 22%'" : "(customer.textContent.startsWith('B') ? 'IT 22%' : '')"}">Add line</button>
<table><tr><td>SEDIA-ERG-01</td><td id="tax"></td></tr></table>`);
    response.end(`<!doctype html><title>Home</title><h1>Welcome to the demo shop</h1>`);
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
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...env, ORVANE_PORT: "5244", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5244" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-flow-tests-test", version: "1.0.0" });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    await expect(page.locator(".browser-view")).toBeVisible();
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return result as { structuredContent: { result: any }; content: { type: string }[] };
    };
    await expect.poll(async () => (await call("workspace_status")).structuredContent.result.sessions.length, { timeout: 30_000 }).toBe(1);
    const { tabId } = (await call("browser_open", { url: `${origin}/` })).structuredContent.result;

    // An expect step checks one thing.
    const twoChecks = await raw("browser_memory", {
      action: "save_flow", tabId, name: "Bad", description: "Two checks",
      steps: [{ action: "expect", selector: "h1", equals: "a", contains: "b" }],
    });
    expect(JSON.stringify(twoChecks.content)).toContain("expect checks one thing");

    // Flows the user approved (saved as the user's), one the AI saved
    // (unapproved), and one with no expect step (not a test).
    const store = new SiteMemoryStore(data);
    store.saveFlow(host, "user", {
      name: "Order tax", description: "A line gets the IT VAT code", params: ["customer"],
      steps: [
        { action: "navigate", path: "/order?c={customer}" },
        { action: "click", text: "Add line" },
        { action: "expect", selector: "#tax", equals: "IT 22%", timeoutMs: 1500 },
      ],
    });
    store.saveFlow(host, "user", {
      name: "Home title", description: "The home page greets",
      steps: [{ action: "navigate", path: "/" }, { action: "expect", contains: "Welcome" }],
    });
    store.saveFlow(host, "user", { name: "Open home", description: "Just opens home", steps: [{ action: "navigate", path: "/" }] });
    store.close();
    await call("browser_memory", {
      action: "save_flow", tabId, name: "Unapproved check", description: "Waits for approval",
      steps: [{ action: "navigate", path: "/" }, { action: "expect", selector: "h1" }],
    });

    // A flow that needs a parameter it was not given is skipped, not failed.
    const missing = (await call("flow_tests", { action: "run", tabId, flows: ["Order tax", "Unapproved check"] })).structuredContent.result;
    expect(missing.flows.map((f: any) => f.status)).toEqual(["skipped", "skipped"]);
    expect(missing.flows[0].reason).toContain('needs the parameter "customer"');
    expect(missing.flows[1].reason).toContain("approval");

    // Run: default tests are the approved flows with expect steps.
    const first = await call("flow_tests", { action: "run", tabId, params: { "Order tax": { customer: "C1043 Mobili Riva" } } });
    const run = first.structuredContent.result;
    expect(run.flows.map((f: any) => [f.name, f.status])).toEqual([["Order tax", "failed"], ["Home title", "passed"]]);
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    expect(run.flows[0].failed).toMatchObject({ step: 3, action: "expect" });
    expect(run.flows[0].failed.error).toBe('expected #tax to be "IT 22%", got empty');
    expect(run.next).toContain("flow_tests failure");
    expect(first.content.filter((c) => c.type === "image")).toHaveLength(1);

    // Failure: the evidence bundle with screenshot and recorded frame.
    const failure = await call("flow_tests", { action: "failure" });
    const bundle = failure.structuredContent.result;
    expect(bundle.runId).toBe(run.runId);
    expect(bundle.flow).toBe("Order tax");
    expect(bundle.params).toEqual({ customer: "C1043 Mobili Riva" });
    expect(bundle.failed.definition).toMatchObject({ action: "expect", selector: "#tax" });
    expect(bundle.page.url).toContain("/order?c=C1043");
    expect(bundle.page.text).toContain("SEDIA-ERG-01");
    expect(bundle.steps.map((s: any) => s.ok)).toEqual([true, true, false]);
    const times = bundle.steps.map((s: any) => s.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(bundle.recording.frames).toBeGreaterThan(0);
    expect(existsSync(bundle.frameAtFailure.file)).toBe(true);
    expect(bundle.pictures[0]).toBe("failure screenshot");
    expect(failure.content.filter((c) => c.type === "image").length).toBeGreaterThanOrEqual(2);

    // The fix lands; rerun says what changed.
    fixed = true;
    const again = (await call("flow_tests", { action: "rerun", tabId })).structuredContent.result;
    expect(again.passed).toBe(2);
    expect(again.previousRunId).toBe(run.runId);
    expect(again.compared).toEqual([
      { flow: "Order tax", before: "failed", after: "passed", change: "fixed" },
      { flow: "Home title", before: "passed", after: "passed", change: "passing" },
    ]);
    expect(again.next).toBeUndefined();
    // Only the failures of the first run.
    const onlyFailed = (await call("flow_tests", { action: "rerun", tabId, runId: run.runId, only: "failed", record: false })).structuredContent.result;
    expect(onlyFailed.flows.map((f: any) => f.name)).toEqual(["Order tax"]);
    expect(onlyFailed.flows[0].recording).toBeUndefined();

    const history = (await call("flow_tests", { action: "history" })).structuredContent.result;
    expect(history.runs.map((r: any) => r.runId).slice(0, 3)).toEqual([onlyFailed.runId, again.runId, run.runId]);
    expect(history.runs[1].rerunOf).toBe(run.runId);
    expect(history.runs[2].failed).toEqual(["Order tax"]);

    // browser_flow runs expect steps too.
    expect((await call("browser_flow", { tabId, name: "Home title" })).structuredContent.result.ok).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    site.close();
  }
});
