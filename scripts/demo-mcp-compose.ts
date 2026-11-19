// Demo: an MCP agent uses chains, code, custom tools, the whiteboard, the
// wheel and layouts. Runs against an isolated temporary workspace (never the
// real one) and records a video plus one screenshot per step into
// artifacts/demo-compose/.
//   pnpm exec tsx scripts/demo-mcp-compose.ts
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

const out = resolve("artifacts/demo-compose");
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
await rm(out, { recursive: true, force: true });
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
/** Calls a tool; also reports how many characters reached the agent. */
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw Error(`${name}: ${JSON.stringify(result.content)}`);
  const chars = JSON.stringify(result.content).length;
  return { value: (result.structuredContent as { result: any }).result, chars };
};
let step = 0;
const shot = async (label: string) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${String(++step).padStart(2, "0")}-${label}.png`) });
  console.log(`step ${step}: ${label}`);
};
const cmd = (operation: string, args: Record<string, unknown>) => ({ operation, args });

try {
  await page.goto(origin);
  await page.locator('main[data-ready="true"]').waitFor();
  for (let i = 0; i < 40 && !(await call("workspace_status")).value.sessions.length; i++)
    await page.waitForTimeout(250);

  // Setup: two small apps and a workflow.
  await call("workspace_batch", {
    commands: [
      cmd("app_create", { id: "inbox", properties: { name: "Inbox", x: 80, y: 90, width: 420, height: 460 } }),
      cmd("component_create", { appId: "inbox", id: "col", kind: "container", properties: { layout: "column", gap: 12 } }),
      cmd("component_create", { appId: "inbox", id: "count", parentId: "col", kind: "counter", properties: { label: "Captured", count: 0 } }),
      cmd("component_create", { appId: "inbox", id: "items", parentId: "col", kind: "list", properties: { label: "Tasks" } }),
      cmd("app_update", { appId: "inbox", patch: { exposed: true } }),
      cmd("app_create", { id: "done", properties: { name: "Done", x: 560, y: 90, width: 380, height: 300 } }),
      cmd("component_create", { appId: "done", id: "log", kind: "list", properties: { label: "Finished" } }),
      cmd("app_update", { appId: "done", patch: { exposed: true } }),
      cmd("workflow_set", {
        id: "capture",
        name: "Capture task",
        icon: "list",
        inputs: ["task"],
        steps: [
          { action: "add-item", appId: "inbox", target: "items", value: "{task}" },
          { action: "increment", appId: "inbox", target: "count", value: "1" },
        ],
      }),
      cmd("app_focus", { appId: "inbox" }),
    ],
  });
  await shot("two-apps");

  // 1. code_run: ten workflow runs and a summary, one round trip.
  const code = await call("code_run", {
    code: [
      "for (const t of input.tasks) await tools.workflow_run({ workflowId: 'capture', inputs: { task: t } });",
      "const w = (await tools.workspace_get({})).results[0];",
      "const inbox = w.apps.find((a) => a.id === 'inbox');",
      "const list = inbox.blocks[0].children.find((b) => b.id === 'items');",
      "return { added: list.items.length, longest: list.items.map((i) => i.text).sort((a, b) => b.length - a.length)[0] };",
    ].join("\n"),
    input: {
      tasks: ["Reply to NetSuite ticket", "Book dentist", "Review UI Maker brief", "Renew certificate", "Plan sprint",
        "Pay invoice", "Call the bank", "Update README", "Clean Downloads", "Water plants"],
    },
  });
  const full = await call("workspace_get");
  console.log(`  code_run -> ${JSON.stringify(code.value.result)} (${code.value.toolCalls} tool calls inside Orvane)`);
  console.log(`  context: code_run sent ${code.chars} chars; one workspace_get alone would send ${full.chars}`);
  await shot("code-run-ten-tasks");

  // 2. A custom tool, saved once, then used like any other tool.
  await call("custom_tool_save", {
    tool: {
      name: "finish_task",
      description: "Move the first Inbox task to the Done app.",
      params: {},
      code: [
        "const inbox = (await tools.component_get({ appId: 'inbox', componentId: 'items' })).results[0];",
        "const first = inbox.items[0];",
        "if (!first) return 'Inbox is empty';",
        "await tools.component_update({ appId: 'inbox', componentId: 'items', patch: { items: inbox.items.slice(1) } });",
        "const log = (await tools.component_get({ appId: 'done', componentId: 'log' })).results[0];",
        "await tools.component_update({ appId: 'done', componentId: 'log', patch: { items: [...log.items, { ...first, done: true }] } });",
        "return 'Finished: ' + first.text;",
      ].join("\n"),
    },
  });
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log(`  custom tool listed: ${tools.includes("custom_finish_task")}`);
  for (let i = 0; i < 3; i++) console.log(`  custom_finish_task -> ${(await call("custom_finish_task")).value.result}`);
  await shot("custom-tool-moved-three");

  // 3. tools_chain: read, then reference the result, return one line.
  const chain = await call("tools_chain", {
    steps: [
      { tool: "component_get", args: { appId: "inbox", componentId: "items" }, as: "inbox" },
      { tool: "component_get", args: { appId: "done", componentId: "log" }, as: "done" },
    ],
    return: "{{inbox.results[0].items.length}} open, {{done.results[0].items.length}} done",
  });
  console.log(`  tools_chain -> ${chain.value.result}`);

  // 4. The whiteboard: a note explaining the setup, arrows to both apps.
  const note = (await call("board_note_set", { x: 300, y: 600, width: 260, height: 130, text: "Agent: tasks flow Inbox → Done.\n" + chain.value.result })).value.results[0];
  await call("board_arrow_set", { from: { noteId: note.id }, to: { appId: "inbox" }, label: "captured" });
  await call("board_arrow_set", { from: { noteId: note.id }, to: { appId: "done" }, label: "finished" });
  await page.mouse.click(1200, 700);
  await shot("board-note-and-arrows");

  // 5. Layouts: arrange side by side and save, scatter, then switch back.
  const layout = (await call("layout_save", {
    name: "Inbox and Done",
    apps: {
      inbox: { x: 80, y: 90, width: 420, height: 460 },
      done: { x: 540, y: 90, width: 420, height: 460 },
    },
  })).value;
  await shot("layout-saved");
  await call("workspace_batch", { commands: [cmd("app_update", { appId: "done", patch: { x: 1500, y: 900 } })] });
  await shot("done-moved-away");
  await call("layout_apply", { layoutId: layout.saved });
  await shot("layout-applied");

  // 6. The wheel: a group with both apps, plus the workflow.
  await call("wheel_set", {
    entries: [
      { id: "apps", name: "Apps", kind: "group" },
      { parent: "apps", name: "Inbox", kind: "app", appId: "inbox" },
      { parent: "apps", name: "Done", kind: "app", appId: "done" },
      { name: "Capture task", kind: "action", actionId: "capture", bindings: { task: "From the wheel" } },
    ],
  });
  await page.mouse.move(640, 300);
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await page.getByLabel("Action wheel").waitFor();
  await shot("wheel-set-by-agent");
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  await page.keyboard.press("Escape").catch(() => {});

  // 7. Run history.
  await client.callTool({ name: "workflow_run", arguments: { workflowId: "capture", inputs: {} } });
  const runs = (await call("automation_runs")).value;
  console.log(`  automation_runs -> latest: ${runs.runs[0].action} ${runs.runs[0].to}: ${runs.runs[0].error}`);
} finally {
  await client.close().catch(() => {});
  await context.close();
  await browser.close();
  await vite.close();
  await rm(directory, { recursive: true, force: true });
  const video = (await readdir(out)).find((f) => f.endsWith(".webm") && f !== "demo.webm");
  if (video) await rename(join(out, video), join(out, "demo.webm"));
}
