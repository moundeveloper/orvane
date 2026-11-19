import { localStorageApi } from "../server/storage-api";
import { test, expect } from "./fixtures";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpDiscovery } from "../server/discovery";
import { BrowserBridge } from "../server/bridge";
import { WebSocket as NodeWebSocket } from "ws";
import { applyCommands, type Command } from "../src/automation";
import { emptyWorkspace, type Workspace } from "../src/model";

const command = (
  operation: Command["operation"],
  args: Record<string, unknown>,
): Command => ({ operation, args });
const notebook: Command[] = [
  command("app_create", {
    id: "notes",
    properties: {
      name: "MCP Notebook",
      x: 120,
      y: 100,
      width: 700,
      height: 520,
    },
  }),
  command("component_create", {
    appId: "notes",
    id: "main",
    kind: "container",
    properties: { layout: "column", gap: 12 },
  }),
  command("component_create", {
    appId: "notes",
    id: "count",
    parentId: "main",
    kind: "counter",
    properties: { label: "MCP count", count: 0 },
  }),
  command("component_create", {
    appId: "notes",
    id: "field",
    parentId: "main",
    kind: "input",
    properties: { label: "MCP note" },
  }),
  command("component_create", {
    appId: "notes",
    id: "items",
    parentId: "main",
    kind: "list",
    properties: { label: "MCP items" },
  }),
  command("component_create", {
    appId: "notes",
    id: "add",
    parentId: "main",
    kind: "button",
    properties: { label: "Capture note" },
  }),
  command("rules_set", {
    appId: "notes",
    componentId: "add",
    rules: [
      {
        id: "add-rule",
        action: "add-item",
        appId: "",
        target: "items",
        value: "{field}",
      },
    ],
  }),
  command("group_create", { id: "group", name: "Writing" }),
  command("group_assign", { appId: "notes", groupId: "group" }),
];
test("MCP batches build valid nested apps without mutating their input", () => {
  const input = emptyWorkspace(),
    output = applyCommands(input, notebook);
  expect(input.apps).toEqual([]);
  expect(output.changed).toBe(true);
  expect(output.workspace.apps[0]!.blocks[0]!.children).toHaveLength(4);
  expect(output.workspace.apps[0]!.group).toBe("Writing");
  expect(() =>
    applyCommands(output.workspace, [
      command("component_update", {
        appId: "notes",
        componentId: "count",
        patch: { count: 99 },
      }),
      command("component_create", {
        appId: "notes",
        kind: "text",
        parentId: "missing",
      }),
    ]),
  ).toThrow("does not exist");
  expect(output.workspace.apps[0]!.blocks[0]!.children[0]!.count).toBe(0);
});
test("MCP rejects cycles, invalid references and silent dependency removal", () => {
  const w = applyCommands(emptyWorkspace(), notebook).workspace;
  expect(() =>
    applyCommands(w, [
      command("component_move", {
        appId: "notes",
        componentId: "main",
        parentId: "count",
      }),
    ]),
  ).toThrow("itself");
  expect(() =>
    applyCommands(w, [
      command("component_delete", { appId: "notes", componentId: "items" }),
    ]),
  ).toThrow("referenced");
  const removed = applyCommands(w, [
    command("component_delete", {
      appId: "notes",
      componentId: "items",
      disconnectReferences: true,
    }),
  ]);
  expect(
    removed.workspace.apps[0]!.blocks[0]!.children.find((b) => b.id === "add")!
      .rules,
  ).toEqual([]);
  expect(() =>
    applyCommands(w, [
      command("rules_set", {
        appId: "notes",
        componentId: "add",
        rules: [
          {
            id: "bad",
            action: "increment",
            target: "missing",
            appId: "",
            value: "1",
          },
        ],
      }),
    ]),
  ).toThrow("Invalid action references");
  expect(() =>
    applyCommands(w, [
      command("action_set", {
        id: "cycle",
        name: "Loop",
        mode: "flow",
        rules: [
          {
            id: "loop",
            action: "custom",
            appId: "",
            target: "",
            value: "",
            nodeId: "cycle",
          },
        ],
      }),
    ]),
  ).toThrow("recursively");
});
test("MCP duplication remaps internal flows and keeps original data independent", () => {
  const w = applyCommands(emptyWorkspace(), notebook).workspace;
  const output = applyCommands(w, [
    command("app_duplicate", { appId: "notes" }),
  ]);
  const copy = output.workspace.apps[1]!,
    children = copy.blocks[0]!.children;
  expect(copy.id).not.toBe("notes");
  expect(children[3]!.rules[0]!.target).toBe(children[2]!.id);
  const renamed = applyCommands(output.workspace, [
    command("component_update", {
      appId: copy.id,
      componentId: children[0]!.id,
      patch: { count: 42 },
    }),
  ]);
  expect(renamed.workspace.apps[0]!.blocks[0]!.children[0]!.count).toBe(0);
});

test("browser bridge rejects invalid authentication and ambiguous session selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvane-mcp-test-"));
  const origin = "http://127.0.0.1:5174",
    bridge = new BrowserBridge(directory, [origin]);
  const sockets: NodeWebSocket[] = [];
  try {
    await bridge.listen(0);
    const config = JSON.parse(
      await readFile(join(directory, "mcp-bridge.json"), "utf8"),
    );
    for (const [token, allowedOrigin] of [
      [config.token, "https://untrusted.example"],
      ["wrong-token", origin],
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new NodeWebSocket(config.url, ["orvane", token], {
          origin: allowedOrigin,
        });
        sockets.push(socket);
        socket.on("unexpected-response", (_request, response) => {
          resolve(response.statusCode!);
          socket.terminate();
        });
        socket.on("error", () => {});
        socket.on("open", () =>
          reject(Error("Unauthorized connection was accepted.")),
        );
      });
      expect(status).toBe(403);
    }
    for (const id of ["browser-one", "browser-two"]) {
      await new Promise<void>((resolve, reject) => {
        const socket = new NodeWebSocket(config.url, ["orvane", config.token], {
          origin,
        });
        sockets.push(socket);
        socket.on("error", reject);
        socket.on("open", () => {
          socket.send(
            JSON.stringify({
              type: "hello",
              session: { id, origin, title: "Test workspace" },
            }),
          );
          resolve();
        });
      });
    }
    await expect.poll(() => bridge.list().length).toBe(2);
    await expect(bridge.request({ commands: [] })).rejects.toThrow(
      "More than one workspace",
    );
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await bridge.close();
    if (!directory.startsWith(join(tmpdir(), "orvane-mcp-test-")))
      throw Error("Unexpected test directory.");
    await rm(directory, { recursive: true, force: true });
  }
});

test("real stdio MCP tools edit the browser, reject stale/invalid writes, recover, and transfer tabs", async ({
  page,
  context,
}) => {
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
    if (!address || typeof address === "string")
      throw Error("Test server has no port");
    const origin = `http://127.0.0.1:${address.port}`;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/launch.mjs")],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ORVANE_MCP_STATE_DIR: directory,
        ORVANE_DATA_DIR: directory,
        ORVANE_MCP_PORT: "0",
        ORVANE_MCP_ORIGINS: origin,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "orvane-integration-test", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("workspace_batch");
    expect(tools.tools.map((t) => t.name)).toContain("rules_set");
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client!.callTool({ name, arguments: args });
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    }
    expect((await call("workspace_status")).connected).toBe(false);
    expect(
      (await client.callTool({ name: "workspace_get", arguments: {} })).isError,
    ).toBe(true);
    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("orvane.examples.v1", "installed");
    });
    await page.goto(origin);
    await expect
      .poll(async () => (await call("workspace_status")).sessions.length)
      .toBe(1);
    const firstSession = (await call("workspace_status")).sessions[0].id;
    const created = await call("workspace_batch", { commands: notebook });
    expect(created.changed).toBe(true);
    await expect(page.locator(".dock-tab")).toHaveText("MCP Notebook");
    await expect(page.locator("output")).toHaveText("0");
    await page.getByRole("button", { name: "Build app", exact: true }).click();
    await page
      .locator(".tree-select")
      .filter({ hasText: "Capture note" })
      .click();
    await page
      .getByRole("button", { name: "Expand to graph", exact: true })
      .click();
    await expect(page.locator(".node-workspace")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await call("rules_set", {
      appId: "notes",
      componentId: "add",
      rules: [
        {
          id: "add-rule",
          action: "add-item",
          appId: "",
          target: "items",
          value: "{field}",
        },
      ],
      graph: {
        positions: {
          trigger: { x: 40, y: 100 },
          "add-rule": { x: 440, y: 160 },
        },
        edges: [{ id: "remote-edge", source: "trigger", target: "add-rule" }],
      },
    });
    await expect(page.locator('.vue-flow__node[data-id="add-rule"]')).toHaveCSS(
      "transform",
      "matrix(1, 0, 0, 1, 440, 160)",
    );
    await call("rules_set", {
      appId: "notes",
      componentId: "add",
      rules: [
        {
          id: "capture-note",
          action: "add-item",
          appId: "",
          target: "items",
          value: "{field}",
        },
      ],
    });
    await expect(
      page.locator('.vue-flow__node[data-id="capture-note"]'),
    ).toHaveCount(1);
    await expect(page.locator(".vue-flow__edge")).toHaveCount(1);
    await page.getByRole("button", { name: "Layout", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("textbox", { name: "MCP note", exact: true })
      .fill("A live note");
    await page
      .getByRole("button", { name: "Capture note", exact: true })
      .click();
    await expect(page.locator(".list-item")).toContainText("A live note");
    const before = await call("workspace_get");
    await call("component_update", {
      appId: "notes",
      componentId: "count",
      patch: { count: 7 },
      expectedRevision: before.revision,
    });
    await expect(page.locator("output")).toHaveText("7");
    const stale = await client.callTool({
      name: "component_update",
      arguments: {
        appId: "notes",
        componentId: "count",
        patch: { count: 99 },
        expectedRevision: before.revision,
      },
    });
    expect(stale.isError).toBe(true);
    const invalid = await client.callTool({
      name: "workspace_batch",
      arguments: {
        commands: [
          command("component_update", {
            appId: "notes",
            componentId: "count",
            patch: { count: 99 },
          }),
          command("component_create", {
            appId: "notes",
            kind: "text",
            parentId: "missing",
          }),
        ],
      },
    });
    expect(invalid.isError).toBe(true);
    await expect(page.locator("output")).toHaveText("7");
    let rejectMcpWrite = true;
    await page.route("**/__orvane/storage/state", (route) =>
      rejectMcpWrite && route.request().method() === "PUT"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Simulated storage failure" }),
          })
        : route.continue(),
    );
    expect(
      (
        await client.callTool({
          name: "component_update",
          arguments: {
            appId: "notes",
            componentId: "count",
            patch: { count: 99 },
          },
        })
      ).isError,
    ).toBe(true);
    await expect(page.locator("output")).toHaveText("7");
    rejectMcpWrite = false;
    const preview = await call("workspace_recovery");
    expect(preview.snapshot.workspace.apps[0].blocks[0].children[1].value).toBe(
      "A live note",
    );
    await call("workspace_recovery", { restore: true });
    await expect(page.locator("output")).toHaveText("0");
    await call("component_update", {
      appId: "notes",
      componentId: "count",
      patch: { count: 7 },
    });
    const viewer = await context.newPage();
    await viewer.goto(origin);
    await expect(viewer.locator("main")).toHaveAttribute(
      "data-editable",
      "false",
    );
    await expect(viewer.locator("output")).toHaveText("7");
    await page.close();
    await expect(viewer.locator("main")).toHaveAttribute(
      "data-editable",
      "true",
      { timeout: 20000 },
    );
    await expect
      .poll(async () => {
        const sessions = (await call("workspace_status")).sessions;
        return sessions.length === 1 && sessions[0].id !== firstSession;
      })
      .toBe(true);
    await call("app_update", {
      appId: "notes",
      patch: { name: "Updated through MCP" },
    });
    await expect(viewer.locator(".dock-tab")).toHaveText("Updated through MCP");
    await viewer.reload();
    await expect(viewer.locator(".dock-tab")).toHaveText("Updated through MCP");
    await expect(viewer.locator("output")).toHaveText("7");
    const csrf = await fetch(`${origin}/__orvane/mcp`, {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(csrf.status).toBe(403);
  } finally {
    await client?.close();
    await transport?.close();
    await vite.close();
    if (!directory.startsWith(join(tmpdir(), "orvane-mcp-test-")))
      throw Error("Unexpected test directory.");
    await rm(directory, { recursive: true, force: true });
  }
});

test("several MCP clients drive the same workspace at once, even on one preferred port", async ({
  page,
}) => {
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
  // A port nobody else uses, shared by both servers like the default 43765.
  const blocker = (await import("node:net")).createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const sharedPort = (blocker.address() as { port: number }).port;
  await new Promise<void>((r) => blocker.close(() => r()));
  const clients: { client: Client; transport: StdioClientTransport }[] = [];
  try {
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string")
      throw Error("Test server has no port");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const name of ["claude", "codex"]) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve("server/launch.mjs")],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          ORVANE_MCP_STATE_DIR: directory,
          ORVANE_DATA_DIR: directory,
          ORVANE_MCP_PORT: String(sharedPort),
          ORVANE_MCP_ORIGINS: origin,
        },
        stderr: "pipe",
      });
      const client = new Client({ name, version: "1.0.0" });
      await client.connect(transport);
      clients.push({ client, transport });
    }
    const call = async (
      client: Client,
      name: string,
      args: Record<string, unknown> = {},
    ) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("orvane.examples.v1", "installed");
    });
    await page.goto(origin);
    for (const { client } of clients)
      await expect
        .poll(async () => (await call(client, "workspace_status")).sessions.length, {
          timeout: 15000,
        })
        .toBe(1);
    await call(clients[0]!.client, "workspace_batch", {
      commands: [command("app_create", { id: "from-claude", properties: { name: "From Claude" } })],
    });
    await call(clients[1]!.client, "workspace_batch", {
      commands: [command("app_create", { id: "from-codex", properties: { name: "From Codex" } })],
    });
    await expect(page.locator(".dock-tab")).toHaveText(["From Claude", "From Codex"]);
    // Closing one client leaves the other connected.
    await clients[0]!.client.close();
    await clients[0]!.transport.close();
    const names = (await call(clients[1]!.client, "app_list")).results[0].map(
      (app: { name: string }) => app.name,
    );
    expect(names).toEqual(["From Claude", "From Codex"]);
  } finally {
    for (const { client, transport } of clients) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
    await vite.close();
    if (!directory.startsWith(join(tmpdir(), "orvane-mcp-test-")))
      throw Error("Unexpected test directory.");
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP agents build, wire and run Action-library workflows", async ({
  page,
}) => {
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
    if (!address || typeof address === "string")
      throw Error("Test server has no port");
    const origin = `http://127.0.0.1:${address.port}`;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/launch.mjs")],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ORVANE_MCP_STATE_DIR: directory,
        ORVANE_DATA_DIR: directory,
        ORVANE_MCP_PORT: "0",
        ORVANE_MCP_ORIGINS: origin,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "orvane-workflow-test", version: "1.0.0" });
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) =>
      client!.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of ["automation_catalog", "workflow_list", "workflow_set", "workflow_delete", "workflow_run", "component_trigger"])
      expect(names).toContain(tool);
    // Running needs the window.
    expect((await raw("workflow_run", { workflowId: "x" })).isError).toBe(true);

    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("orvane.examples.v1", "installed");
    });
    await page.goto(origin);
    await expect
      .poll(async () => (await call("workspace_status")).sessions.length)
      .toBe(1);
    // A tasks app, exposed so workflows may change it.
    await call("workspace_batch", {
      commands: [
        ...notebook.slice(0, 6),
        command("app_update", { appId: "notes", patch: { exposed: true } }),
      ],
    });
    const catalog = await call("automation_catalog");
    expect(catalog.stepKinds.map((k: { action: string }) => k.action)).toContain("add-item");
    expect(catalog.targets.apps[0]).toMatchObject({ appId: "notes", exposed: true });

    // Build a workflow from a plain list of steps.
    const created = await call("workflow_set", {
      id: "log-task",
      name: "Log a task",
      inputs: ["task"],
      steps: [
        { action: "add-item", appId: "notes", target: "items", value: "{task}" },
        { action: "increment", appId: "notes", target: "count", value: "2" },
        { action: "message", value: "Logged {task}" },
      ],
    });
    const workflow = created.results[0].workflow;
    expect(created.results[0].warnings).toEqual([]);
    expect(workflow.graph.edges.map((e: { source: string }) => e.source)[0]).toBe("trigger");
    expect(workflow.rules).toHaveLength(3);
    // Bad targets are refused with a clear reason.
    const bad = await raw("workflow_set", {
      name: "Broken",
      steps: [{ action: "add-item", appId: "notes", target: "nope", value: "x" }],
    });
    expect(JSON.stringify(bad.content)).toContain("component nope is not in app");

    // Run it directly.
    const ran = await call("workflow_run", { workflowId: "log-task", inputs: { task: "Write docs" } });
    expect(ran.message).toBe("Logged Write docs");
    await expect(page.locator(".canvas-app .list-item")).toContainText(["Write docs"]);
    await expect(page.locator("output")).toHaveText("2");

    // Wire the button to it and press the button with a typed value.
    await call("rules_set", {
      appId: "notes",
      componentId: "add",
      rules: [
        { id: "run-log", action: "workspace-action", appId: "", target: "", value: "", nodeId: "log-task", bindings: { task: "{field}" } },
      ],
    });
    // Type into the field, then press the button.
    await call("component_trigger", { appId: "notes", componentId: "field", value: "Ship demo" });
    const pressed = await call("component_trigger", { appId: "notes", componentId: "add" });
    expect(pressed.message).toBe("Logged Ship demo");
    await expect(page.locator(".canvas-app .list-item")).toContainText(["Write docs", "Ship demo"]);
    await expect(page.locator("output")).toHaveText("4");

    // Failures come back as errors.
    const failed = await raw("workflow_run", { workflowId: "log-task", inputs: {} });
    expect(JSON.stringify(failed.content)).toContain("requires input");

    // Deleting a workflow a button uses needs explicit consent.
    expect((await raw("workflow_delete", { workflowId: "log-task" })).isError).toBe(true);
    await call("workflow_delete", { workflowId: "log-task", disconnectReferences: true });
    expect((await call("workflow_list")).results[0]).toEqual([]);
  } finally {
    await client?.close();
    await transport?.close();
    await vite.close();
    if (!directory.startsWith(join(tmpdir(), "orvane-mcp-test-")))
      throw Error("Unexpected test directory.");
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP chains, code, custom tools, wheel, board, layouts and run history", async ({
  page,
}) => {
  test.setTimeout(150000);
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
    if (!address || typeof address === "string")
      throw Error("Test server has no port");
    const origin = `http://127.0.0.1:${address.port}`;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/launch.mjs")],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ORVANE_MCP_STATE_DIR: directory,
        ORVANE_DATA_DIR: directory,
        ORVANE_MCP_PORT: "0",
        ORVANE_MCP_ORIGINS: origin,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "orvane-compose-test", version: "1.0.0" });
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) =>
      client!.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    const errorOf = async (name: string, args: Record<string, unknown>) => {
      const result = await raw(name, args);
      expect(result.isError).toBe(true);
      return JSON.stringify(result.content);
    };

    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("orvane.examples.v1", "installed");
    });
    await page.goto(origin);
    await expect
      .poll(async () => (await call("workspace_status")).sessions.length)
      .toBe(1);
    await call("workspace_batch", {
      commands: [
        ...notebook,
        command("app_update", { appId: "notes", patch: { exposed: true } }),
        command("app_create", { id: "side", properties: { name: "Side", x: 900, y: 100, width: 400, height: 300 } }),
        command("workflow_set", {
          id: "log",
          name: "Log",
          inputs: ["task"],
          steps: [{ action: "add-item", appId: "notes", target: "items", value: "{task}" }],
        }),
      ],
    });

    // tools_chain: only the final value comes back.
    const chained = await call("tools_chain", {
      steps: [
        { tool: "app_list", as: "apps" },
        { tool: "app_get", args: { appId: "{{apps.results[0][0].id}}" } },
      ],
      return: "{{step2.results[0].name}} has {{step2.results[0].blocks[0].children.length}} parts",
    });
    expect(chained.result).toBe("MCP Notebook has 4 parts");
    expect(chained.steps.map((s: { tool: string }) => s.tool)).toEqual(["app_list", "app_get"]);
    expect(
      await errorOf("tools_chain", { steps: [{ tool: "app_get", args: { appId: "{{nope.id}}" } }] }),
    ).toContain("no input or earlier step named nope");

    // code_run: loops and filters inside Orvane, isolated from the machine.
    const coded = await call("code_run", {
      code: [
        "const w = (await tools.workspace_get({})).results[0];",
        "console.log('apps', w.apps.length);",
        "for (const t of input.tasks) await tools.workflow_run({ workflowId: 'log', inputs: { task: t } });",
        "return { names: w.apps.map((a) => a.name), sandbox: [typeof process, typeof require, typeof fetch].join() };",
      ].join("\n"),
      input: { tasks: ["one", "two"] },
    });
    expect(coded.result).toEqual({ names: ["MCP Notebook", "Side"], sandbox: "undefined,undefined,undefined" });
    expect(coded.logs).toEqual(["apps 2"]);
    expect(coded.toolCalls).toBe(3);
    await expect(page.locator(".canvas-app .list-item")).toContainText(["one", "two"]);
    expect(await errorOf("code_run", { code: "return eval('1')" })).toContain(
      "Code generation from strings disallowed",
    );
    expect(await errorOf("code_run", { code: "while (true) {}", timeoutSeconds: 2 })).toContain(
      "Code stopped after 2 s",
    );

    // Custom tools: saved once, exposed as their own tool.
    const saved = await call("custom_tool_save", {
      tool: {
        name: "list_items",
        description: "Item texts of the notebook list, optionally filtered.",
        params: { contains: { type: "string", optional: true } },
        code: [
          "const b = (await tools.component_get({ appId: 'notes', componentId: 'items' })).results[0];",
          "return b.items.map((i) => i.text).filter((t) => !input.contains || t.includes(input.contains));",
        ].join("\n"),
      },
    });
    expect(saved).toEqual({ saved: "custom_list_items", kind: "code" });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("custom_list_items");
    expect(await call("custom_list_items", {})).toEqual({ result: ["one", "two"], logs: [], toolCalls: 1 });
    expect((await call("custom_tool_run", { name: "list_items", input: { contains: "tw" } })).result).toEqual([
      "two",
    ]);
    await call("custom_tool_save", {
      tool: {
        name: "app_name",
        description: "Name of an app.",
        params: { appId: { type: "string" } },
        steps: [{ tool: "app_get", args: { appId: "{{input.appId}}" } }],
        return: "{{step1.results[0].name}}",
      },
    });
    expect((await call("custom_app_name", { appId: "side" })).result).toBe("Side");
    expect((await call("custom_tool_list")).map((t: { name: string }) => t.name)).toEqual([
      "list_items",
      "app_name",
    ]);
    expect(
      await errorOf("custom_tool_save", { tool: { name: "bad", description: "x", steps: [{ tool: "nope" }] } }),
    ).toContain("unknown tool nope");
    await call("custom_tool_delete", { name: "app_name" });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("custom_app_name");

    // Wheel.
    await call("wheel_set", {
      entries: [
        { id: "g", name: "Work", kind: "group" },
        { id: "open", parent: "g", name: "Notebook", kind: "app", appId: "notes" },
        { id: "run", name: "Log", kind: "action", actionId: "log", bindings: { task: "from wheel" } },
      ],
    });
    expect((await call("wheel_list")).results[0].map((e: { id: string }) => e.id)).toEqual(["g", "open", "run"]);
    expect(
      await errorOf("wheel_set", { entries: [{ name: "X", kind: "action", actionId: "missing" }] }),
    ).toContain("workflow missing does not exist");
    expect(
      await errorOf("wheel_set", {
        entries: Array.from({ length: 9 }, (_, i) => ({ name: `A${i}`, kind: "app", appId: "notes" })),
      }),
    ).toContain("at most 8 entries");

    // Board: a note with an arrow to an app.
    const note = (await call("board_note_set", { x: 120, y: 700, text: "Plan from the agent" })).results[0];
    await expect(page.locator(".board-note")).toContainText("Plan from the agent");
    await call("board_arrow_set", { id: "arrow", from: { noteId: note.id }, to: { appId: "notes" }, label: "feeds" });
    const board = (await call("board_get")).results[0];
    expect(board.arrows[0]).toMatchObject({ id: "arrow", from: { noteId: note.id }, to: { appId: "notes" } });
    await call("board_note_set", { id: note.id, text: "Plan, edited" });
    await expect(page.locator(".board-note")).toContainText("Plan, edited");
    await call("board_delete", { ids: [note.id] });
    expect((await call("board_get")).results[0]).toMatchObject({ notes: [], arrows: [] });

    // Layouts: arrange and save, move something, switch back.
    const layout = await call("layout_save", {
      name: "Side by side",
      apps: { side: { x: 860, y: 100, width: 420, height: 320 } },
    });
    expect(layout).toMatchObject({ name: "Side by side", apps: 2 });
    await call("app_update", { appId: "side", patch: { x: 2000 } });
    await call("layout_apply", { layoutId: layout.saved });
    expect((await call("app_get", { appId: "side" })).results[0]).toMatchObject({ x: 860, width: 420 });
    expect((await call("layout_list")).results[0]).toMatchObject({ active: layout.saved });

    // Run history shows failures.
    expect(await errorOf("workflow_run", { workflowId: "log", inputs: {} })).toContain("requires input");
    const runs = await call("automation_runs");
    expect(runs.runs[0]).toMatchObject({ from: "MCP agent", to: "Log", action: "Run workflow" });
    expect(runs.runs[0].error).toContain("requires input");
  } finally {
    await client?.close();
    await transport?.close();
    await vite.close();
    if (!directory.startsWith(join(tmpdir(), "orvane-mcp-test-")))
      throw Error("Unexpected test directory.");
    await rm(directory, { recursive: true, force: true });
  }
});
