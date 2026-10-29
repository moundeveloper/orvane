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
