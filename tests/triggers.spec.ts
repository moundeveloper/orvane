import { localStorageApi } from "../server/storage-api";
import { test, expect } from "./fixtures";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpDiscovery } from "../server/discovery";
import { applyCommands } from "../src/automation";
import { emptyWorkspace } from "../src/model";
import { describeSchedule, latestOccurrence, triggerDue, type Trigger } from "../src/triggers";

const MIN = 60_000;
const at = (h: number, m: number, day = 19) => new Date(2026, 10, day, h, m).getTime();
const trigger = (schedule: Trigger["schedule"], extra: Partial<Trigger> = {}): Trigger => ({
  id: "t",
  name: "T",
  workflowId: "w",
  inputs: {},
  enabled: true,
  schedule,
  createdAt: at(8, 0),
  ...extra,
});

test("interval and daily triggers fall due once per occurrence", () => {
  const every15 = trigger({ kind: "interval", minutes: 15 });
  expect(triggerDue(every15, at(8, 14)).due).toBe(false);
  expect(triggerDue(every15, at(8, 15)).due).toBe(true);
  expect(latestOccurrence(every15, at(8, 47))).toBe(at(8, 45));
  expect(triggerDue({ ...every15, lastRun: at(8, 45) }, at(8, 50)).due).toBe(false);
  expect(triggerDue({ ...every15, enabled: false }, at(9, 0)).due).toBe(false);

  const nine = trigger({ kind: "daily", time: "09:00" });
  expect(triggerDue(nine, at(8, 59)).due).toBe(false);
  expect(triggerDue(nine, at(9, 0))).toEqual({ due: true, stale: false });
  expect(triggerDue({ ...nine, lastRun: at(9, 0) }, at(18, 0)).due).toBe(false);
  expect(triggerDue({ ...nine, lastRun: at(9, 0) }, at(9, 0, 20)).due).toBe(true);
  // Weekdays only: 21 Nov 2026 is a Saturday, so Monday's run is the next.
  const weekdays = trigger({ kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] }, { lastRun: at(9, 0, 20) });
  expect(triggerDue(weekdays, at(10, 0, 21)).due).toBe(false);
  expect(triggerDue(weekdays, at(9, 1, 23)).due).toBe(true);
  // A daily run missed while closed for days runs once (today's occurrence).
  expect(triggerDue(nine, at(9, 30, 22))).toEqual({ due: true, stale: false });
  // Mondays only, Orvane opened on Thursday: Monday's run is over a day old, skipped.
  const mondays = trigger({ kind: "daily", time: "09:00", days: [1] }, { createdAt: at(8, 0, 20) });
  expect(triggerDue(mondays, at(10, 0, 26))).toEqual({ due: true, stale: true });
  expect(describeSchedule({ kind: "interval", minutes: 120 })).toBe("Every 2 hours");
  expect(describeSchedule({ kind: "daily", time: "09:00", days: [5, 1] })).toBe("Mon, Fri at 09:00");
});

test("trigger_set validates the workflow and its inputs; deleting the workflow needs consent", () => {
  const base = applyCommands(emptyWorkspace(), [
    { operation: "workflow_set", args: { id: "w", name: "Note", inputs: ["text"], steps: [{ action: "message", value: "{text}" }] } },
  ]).workspace;
  const set = (args: Record<string, unknown>) => applyCommands(base, [{ operation: "trigger_set", args }]);
  expect(() => set({ name: "X", workflowId: "nope", schedule: { kind: "interval", minutes: 5 } })).toThrow("does not exist");
  expect(() => set({ name: "X", workflowId: "w", schedule: { kind: "interval", minutes: 5 } })).toThrow("inputs must give text");
  expect(() => set({ name: "X", workflowId: "w", inputs: { text: "a", other: "b" }, schedule: { kind: "interval", minutes: 5 } })).toThrow("no input named other");
  expect(() => set({ name: "X", workflowId: "w", inputs: { text: "a" }, schedule: { kind: "daily", time: "25:00" } })).toThrow();
  const w = set({ id: "t", name: "X", workflowId: "w", inputs: { text: "a" }, schedule: { kind: "daily", time: "09:00" } }).workspace;
  expect(w.triggers).toHaveLength(1);
  expect(() => applyCommands(w, [{ operation: "workflow_delete", args: { workflowId: "w" } }])).toThrow("scheduled trigger");
  const removed = applyCommands(w, [{ operation: "workflow_delete", args: { workflowId: "w", disconnectReferences: true } }]).workspace;
  expect(removed.triggers).toEqual([]);
});

test("scheduled triggers run their workflow in the editing window by themselves", async ({ page }) => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), "orvane-mcp-test-"));
  const vite = await createServer({
    configFile: false,
    cacheDir: join(directory, "vite-cache"),
    root: resolve("."),
    plugins: [vue(), localStorageApi(directory), mcpDiscovery(directory)],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("Test server has no port");
    const origin = `http://127.0.0.1:${address.port}`;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/launch.mjs")],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        ORVANE_MCP_STATE_DIR: directory,
        ORVANE_DATA_DIR: directory,
        ORVANE_MCP_PORT: "0",
        ORVANE_MCP_ORIGINS: origin,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "orvane-trigger-test", version: "1.0.0" });
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) => client!.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await page.clock.install({ time: new Date(2026, 10, 19, 8, 58) });
    await page.addInitScript(() => {
      if (window === window.top) localStorage.setItem("orvane.examples.v1", "installed");
    });
    await page.goto(origin);
    await expect.poll(async () => (await call("workspace_status")).sessions.length).toBe(1);
    const cmd = (operation: string, args: Record<string, unknown>) => ({ operation, args });
    await call("workspace_batch", {
      commands: [
        cmd("app_create", { id: "log", properties: { name: "Log", x: 120, y: 100, width: 420, height: 360 } }),
        cmd("component_create", { appId: "log", id: "items", kind: "list", properties: { label: "Runs" } }),
        cmd("app_update", { appId: "log", patch: { exposed: true } }),
        cmd("workflow_set", {
          id: "note",
          name: "Note",
          inputs: ["text"],
          steps: [{ action: "add-item", appId: "log", target: "items", value: "{text}" }],
        }),
        cmd("trigger_set", { id: "tick", name: "Tick", workflowId: "note", inputs: { text: "tick" }, schedule: { kind: "interval", minutes: 5 } }),
        cmd("trigger_set", { id: "nine", name: "Nine", workflowId: "note", inputs: { text: "nine" }, schedule: { kind: "daily", time: "09:00" } }),
      ],
    });
    const items = page.locator(".canvas-app .list-item");
    await expect(items).toHaveCount(0);
    // 09:00 passes: the daily trigger runs once.
    await page.clock.runFor(3 * 60_000);
    await expect(items).toHaveText(["nine"]);
    // Created at 08:58, so the 5-minute marks are 09:03 and 09:08.
    await page.clock.runFor(8 * 60_000);
    await expect(items).toHaveText(["nine", "tick", "tick"]);
    const listed = (await call("trigger_list")).results[0];
    const nineRun = listed.find((t: Trigger) => t.id === "nine").lastRun;
    expect(nineRun - at(9, 0)).toBeGreaterThanOrEqual(0);
    expect(nineRun - at(9, 0)).toBeLessThan(MIN);
    // Paused triggers don't run; trigger_run runs one now.
    await call("trigger_set", { id: "tick", name: "Tick", workflowId: "note", inputs: { text: "tick" }, enabled: false, schedule: { kind: "interval", minutes: 5 } });
    await page.clock.runFor(10 * 60_000);
    await expect(items).toHaveCount(3);
    expect((await call("trigger_run", { triggerId: "nine" })).workflow).toBe("Note");
    await expect(items).toHaveCount(4);
  } finally {
    await client?.close();
    await transport?.close();
    await vite.close();
    if (!directory.startsWith(join(tmpdir(), "orvane-mcp-test-"))) throw Error("Unexpected test directory.");
    await rm(directory, { recursive: true, force: true });
  }
});
