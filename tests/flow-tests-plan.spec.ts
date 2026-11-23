import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { netSuiteProduction, pagePattern } from "../server/flow-tests.ts";

// From one sentence: explore → plan → the owner approves the plan once (header
// Site memory button) → generate each case → run.
test("an AI explores a site, plans tests, and generates them after one approval", async ({}, info) => {
  test.setTimeout(240_000);
  const opened: string[] = [];
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const url = new URL(request.url ?? "/", "http://x");
    opened.push(url.pathname);
    if (url.pathname === "/order")
      return response.end(`<!doctype html><title>Sales Order</title><h1>Sales Order</h1>
<label>Memo <input id="memo"></label>
<button onclick="tax.textContent = ''">Add line</button>
<button onclick="out.textContent = 'Saved'">Save</button><button onclick="out.textContent = 'Deleted'">Delete</button>
<table><tr><td>SEDIA-ERG-01</td><td id="tax"></td></tr></table><p id="out"></p><a href="/">Home</a>`);
    if (url.pathname === "/orders")
      return response.end(`<!doctype html><title>Orders</title><h1>Orders</h1><a href="/order?id=1">SO-1</a><a href="/order?id=2">SO-2</a>`);
    response.end(`<!doctype html><title>Home</title><h1>Demo shop</h1>
<a href="/orders">Orders</a><a href="/logout">Log out</a><a href="/order/delete?id=1">Delete order</a>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const data = info.outputPath("data");
  const env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const app = await electron.launch({ args: ["electron/main.mjs"], env: { ...env, ORVANE_PORT: "5245", ORVANE_USER_DATA: info.outputPath("profile") } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5245" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-flow-plan-test", version: "1.0.0" });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await expect.poll(async () => (await call("workspace_status")).sessions.length, { timeout: 30_000 }).toBe(1);
    const { tabId } = await call("browser_open", { url: `${origin}/` });

    expect(netSuiteProduction("https://1234567.app.netsuite.com/app/center/card.nl")).toBe(true);
    expect(netSuiteProduction("https://1234567-sb1.app.netsuite.com/app/center/card.nl")).toBe(false);
    expect(pagePattern(`${origin}/order?id=2&e=T`)).toBe("/order?e&id");

    // Explore: kinds of pages, not every record; log-out and delete links skipped.
    const map = await call("flow_tests", { action: "explore", tabId });
    expect(map.pages.map((p: any) => p.page)).toEqual(["/", "/orders", "/order?id"]);
    const order = map.pages.find((p: any) => p.page === "/order?id");
    expect(order.buttons).toEqual(["Add line", "Save", "Delete"]);
    expect(order.fields).toEqual([{ label: "Memo", type: "text" }]);
    expect(order.reachedBy).toBe('"SO-1" on /orders');
    expect(opened).not.toContain("/logout");
    expect(opened).not.toContain("/order/delete");
    expect((await call("browser_act", { tabId, action: "eval", expression: "location.pathname" })).value).toBe("/");

    // Plan: waits for the owner.
    const { plan } = await call("flow_tests", {
      action: "plan", tabId, title: "Sales orders", goal: "Test that orders get VAT and can be saved",
      cases: [
        { name: "Line gets IT VAT", useCase: "Sales", description: "Add a line to order 1; the line's tax code is IT 22%" },
        { name: "Order saves", useCase: "Sales", description: "Add a line and save order 1; the page says Saved" },
      ],
    });
    expect(plan.status).toBe("pending");
    const vatSteps = [
      { action: "navigate", path: "/order?id=1" },
      { action: "click", text: "Add line" },
      { action: "expect", selector: "#tax", equals: "IT 22%", timeoutMs: 800 },
    ];
    const early = await raw("flow_tests", { action: "generate", tabId, planId: plan.id, case: "Line gets IT VAT", steps: vatSteps });
    expect(JSON.stringify(early.content)).toContain("waits for the user");

    // The owner approves the whole plan once, from the header button's badge.
    const button = page.getByRole("button", { name: "Site memory", exact: true });
    await button.click();
    await expect(button.locator(".memory-pending")).toHaveText("1");
    const card = page.getByRole("article", { name: "Sales orders" });
    await expect(card).toContainText("Line gets IT VAT");
    await card.getByRole("button", { name: "Approve plan" }).click();
    await expect(card).toContainText("Approved");
    await expect(button.locator(".memory-pending")).toHaveCount(0);
    expect((await call("flow_tests", { action: "plans", tabId })).plans[0].status).toBe("approved");

    // Generate: guards first.
    const evalStep = await raw("flow_tests", { action: "generate", tabId, planId: plan.id, case: "Line gets IT VAT", steps: [...vatSteps, { action: "eval", expression: "1" }] });
    expect(JSON.stringify(evalStep.content)).toContain("run eval");
    const risky = await raw("flow_tests", {
      action: "generate", tabId, planId: plan.id, case: "Line gets IT VAT",
      steps: [vatSteps[0], vatSteps[1], { action: "click", text: "Delete" }, vatSteps[2]],
    });
    expect(JSON.stringify(risky.content)).toContain("would delete something");
    // A broken step: nothing saved, the page comes back to fix it.
    const broken = await call("flow_tests", {
      action: "generate", tabId, planId: plan.id, case: "Order saves",
      steps: [{ action: "navigate", path: "/order?id=1" }, { action: "click", selector: "#nope", timeoutMs: 500 }, { action: "expect", selector: "#out", equals: "Saved" }],
    });
    expect(broken.saved).toBe(false);
    expect(broken.failed.step).toBe(2);
    expect(broken.page.url).toContain("/order?id=1");
    // A check that fails: the test is kept (it caught a bug).
    const vat = await call("flow_tests", { action: "generate", tabId, planId: plan.id, case: "Line gets IT VAT", steps: vatSteps });
    expect(vat.saved).toBe(true);
    expect(vat.case.status).toBe("fails now");
    expect(vat.failsNow.error).toBe('expected #tax to be "IT 22%", got empty');
    // Saving is allowed: the approved case says it saves.
    const saves = await call("flow_tests", {
      action: "generate", tabId, planId: plan.id, case: "Order saves",
      steps: [{ action: "navigate", path: "/order?id=1" }, { action: "click", text: "Add line" }, { action: "click", text: "Save" }, { action: "expect", selector: "#out", equals: "Saved" }],
    });
    expect(saves.saved).toBe(true);
    expect(saves.case.status).toBe("generated");

    // Run the plan's tests.
    const run = await call("flow_tests", { action: "run", tabId, planId: plan.id, record: false });
    expect(run.flows.map((f: any) => [f.name, f.status])).toEqual([["Line gets IT VAT", "failed"], ["Order saves", "passed"]]);

    // The panel shows each case's state.
    await page.getByRole("button", { name: "Close site memory" }).click();
    await button.click();
    // Nothing waits now, so it opens on routes; plans are one tab away.
    await page.getByRole("button", { name: /^Test plans/ }).click();
    await expect(card).toContainText("2 turned into tests");
    // Withdrawing the plan stops its tests.
    await card.getByRole("button", { name: "Withdraw" }).click();
    await expect(card).toContainText("Rejected");
    const after = await call("flow_tests", { action: "run", tabId, flows: ["Order saves"], record: false });
    expect(after.flows[0].status).toBe("skipped");
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    site.close();
  }
});
