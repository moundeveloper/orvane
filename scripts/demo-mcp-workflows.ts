// Demo: an MCP agent builds, wires and runs an automation in Orvane.
// Runs against an isolated temporary workspace (never the real one) and
// records a video plus one screenshot per step into artifacts/demo/.
//   pnpm exec tsx scripts/demo-mcp-workflows.ts
import { mkdtemp, rm, mkdir, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { localStorageApi } from "../server/storage-api.ts";
import { mcpDiscovery } from "../server/discovery.ts";

const out = resolve("artifacts/demo");
const directory = await mkdtemp(join(tmpdir(), "orvane-demo-"));
const vite = await createServer({
  configFile: false,
  cacheDir: join(directory, "vite-cache"),
  root: resolve("."),
  plugins: [vue(), localStorageApi(directory), mcpDiscovery(directory)],
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
await vite.listen();
const port = (vite.httpServer!.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 760 },
  recordVideo: { dir: out, size: { width: 1280, height: 760 } },
});
const page = await context.newPage();
await page.addInitScript(() => {
  if (window === window.top) localStorage.setItem("orvane.examples.v1", "installed");
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("server/launch.mjs")],
  env: {
    ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    ORVANE_MCP_STATE_DIR: directory,
    ORVANE_DATA_DIR: directory,
    ORVANE_MCP_PORT: "0",
    ORVANE_MCP_ORIGINS: origin,
  },
  stderr: "pipe",
});
const client = new Client({ name: "orvane-demo-agent", version: "1.0.0" });
await client.connect(transport);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw Error(`${name}: ${JSON.stringify(result.content)}`);
  return (result.structuredContent as { result: any }).result;
};
let step = 0;
const shot = async (label: string) => {
  await page.waitForTimeout(700);
  const file = join(out, `${String(++step).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file });
  console.log(`step ${step}: ${label}`);
};
const cmd = (operation: string, args: Record<string, unknown>) => ({ operation, args });

try {
  await page.goto(origin);
  await page.locator('main[data-ready="true"]').waitFor();
  for (let i = 0; i < 40 && !(await call("workspace_status")).sessions.length; i++)
    await page.waitForTimeout(250);
  await shot("empty-canvas");

  // 1. The agent builds a small "Inbox" app and exposes it.
  await call("workspace_batch", {
    commands: [
      cmd("app_create", { id: "inbox", properties: { name: "Inbox", x: 80, y: 90, width: 420, height: 470 } }),
      cmd("component_create", { appId: "inbox", id: "col", kind: "container", properties: { layout: "column", gap: 12 } }),
      cmd("component_create", { appId: "inbox", id: "task", parentId: "col", kind: "input", properties: { label: "Task" } }),
      cmd("component_create", { appId: "inbox", id: "capture", parentId: "col", kind: "button", properties: { label: "Capture" } }),
      cmd("component_create", { appId: "inbox", id: "count", parentId: "col", kind: "counter", properties: { label: "Captured today", count: 0 } }),
      cmd("component_create", { appId: "inbox", id: "items", parentId: "col", kind: "list", properties: { label: "Tasks" } }),
      cmd("app_update", { appId: "inbox", patch: { exposed: true } }),
      cmd("app_focus", { appId: "inbox" }),
    ],
  });
  await shot("agent-built-inbox-app");

  // 2. It reads the catalog, then creates a workflow from plain steps.
  const catalog = await call("automation_catalog");
  console.log(`  catalog: ${catalog.stepKinds.length} step kinds, ${catalog.targets.apps.length} app(s)`);
  await call("workflow_set", {
    id: "capture-task",
    name: "Capture task",
    icon: "list",
    inputs: ["task"],
    steps: [
      { action: "add-item", appId: "inbox", target: "items", value: "{task}" },
      { action: "increment", appId: "inbox", target: "count", value: "1" },
      { action: "clear", appId: "inbox", target: "task" },
      { action: "message", value: "Captured: {task}" },
    ],
  });
  // Show it in the Action library.
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: /Action library/ }).first().click().catch(() => {});
  await shot("workflow-in-action-library");
  await page.keyboard.press("Escape");
  await page.mouse.click(1100, 650);

  // 3. It wires the Capture button to the workflow.
  await call("rules_set", {
    appId: "inbox",
    componentId: "capture",
    rules: [{ id: "run-capture", action: "workspace-action", appId: "", target: "", value: "", nodeId: "capture-task", bindings: { task: "{Task}" } }],
  });

  // 4. It tests the automation like a person: type, press.
  for (const task of ["Review UI Maker brief", "Reply to NetSuite ticket", "Book dentist"]) {
    await call("component_trigger", { appId: "inbox", componentId: "task", value: task });
    await page.waitForTimeout(500);
    const pressed = await call("component_trigger", { appId: "inbox", componentId: "capture" });
    console.log(`  pressed Capture -> ${pressed.message}`);
    await shot(`pressed-capture-${task.split(" ")[0]!.toLowerCase()}`);
  }

  // 5. It runs the workflow directly too.
  const ran = await call("workflow_run", { workflowId: "capture-task", inputs: { task: "Run from the agent" } });
  console.log(`  workflow_run -> ${ran.message}`);
  await shot("workflow-run-directly");
} finally {
  await client.close().catch(() => {});
  await context.close();
  await browser.close();
  await vite.close();
  await rm(directory, { recursive: true, force: true });
  const video = (await readdir(out)).find((f) => f.endsWith(".webm") && f !== "demo.webm");
  if (video) await rename(join(out, video), join(out, "demo.webm"));
}
