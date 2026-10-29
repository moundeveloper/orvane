import { test, expect } from "./fixtures";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createProjectsService } from "../server/projects";
import { projectsApi } from "../server/projects-api";
import { localStorageApi } from "../server/storage-api";
import { mcpDiscovery } from "../server/discovery";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Projects Hub persists groups in SQLite, creates/imports projects, runs commands and protects roots", async ({}, info) => {
  test.setTimeout(60000);
  const root = info.outputPath("projects");
  await mkdir(join(root, "Existing project"), { recursive: true });
  const service = createProjectsService(info.outputPath("data"));
  const invoke = async (
    operation: string,
    args: Record<string, unknown> = {},
  ) => (await service.invoke(operation, { rootPath: root, ...args })) as any;
  try {
    expect((await invoke("workspace")).projects).toHaveLength(1);
    const group = await invoke("groups", { name: "Client work" });
    await invoke("projects", {
      groupId: group.id,
      name: "New project",
      template: "empty",
    });
    await invoke("groups/add-project", {
      groupId: group.id,
      path: join(root, "Existing project"),
    });
    await invoke("groups/rename", {
      groupId: group.id,
      name: "Delivery",
      workspacePath: join(root, "Client work"),
    });
    expect((await invoke("workspace")).groups[0].projects).toHaveLength(2);
    expect((await invoke("workspace")).groups[0].name).toBe("Delivery");
    const output = await invoke("terminal/run", {
      path: root,
      command: "echo Orvane-terminal-check",
    });
    expect(output.stdOut).toContain("Orvane-terminal-check");
    expect(output.exitCode).toBe(0);
    await expect(
      invoke("projects/delete", {
        path: root,
        deleteFolder: true,
        confirmed: true,
      }),
    ).rejects.toThrow("cannot be deleted");
    await expect(
      invoke("projects/delete", { path: join(root, "Existing project") }),
    ).rejects.toThrow("Confirm");
    await invoke("projects/delete", {
      path: join(root, "Existing project"),
      deleteFolder: false,
      confirmed: true,
    });
    expect(
      (await invoke("workspace")).projects.map((p: any) => p.name),
    ).not.toContain("Existing project");
    service.close();
    const reopened = createProjectsService(info.outputPath("data"));
    try {
      expect(
        ((await reopened.invoke("workspace", { rootPath: root })) as any)
          .groups[0].name,
      ).toBe("Delivery");
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
  }
});

test("Projects Hub MCP creates a native Orvane app with folders, groups, terminal and reload persistence", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const directory = info.outputPath("data"),
    root = info.outputPath("projects");
  await mkdir(join(root, "Website"), { recursive: true });
  await mkdir(join(root, "Integration"), { recursive: true });
  const vite = await createServer({
    configFile: false,
    cacheDir: info.outputPath("vite-cache"),
    root: resolve("."),
    plugins: [
      vue(),
      projectsApi(directory),
      localStorageApi(directory),
      mcpDiscovery(directory),
    ],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("No local port");
    const origin = `http://127.0.0.1:${address.port}`;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/launch.mjs")],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (e): e is [string, string] => e[1] !== undefined,
          ),
        ),
        ORVANE_MCP_STATE_DIR: directory,
        ORVANE_DATA_DIR: directory,
        ORVANE_MCP_PORT: "0",
        ORVANE_MCP_ORIGINS: origin,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "projects-test", version: "1.0.0" });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await call("projects_hub", {
      operation: "groups",
      args: { rootPath: root, name: "Client work" },
    });
    await page.addInitScript(() =>
      localStorage.setItem("orvane.examples.v1", "installed"),
    );
    await page.goto(origin);
    await expect
      .poll(async () => (await call("workspace_status")).connected, {
        timeout: 15000,
      })
      .toBe(true);
    await call("workspace_batch", {
      commands: [
        {
          operation: "app_create",
          args: {
            id: "projects-app",
            properties: {
              name: "Projects Hub",
              icon: "folder",
              width: 1220,
              height: 800,
              padding: 0,
              gap: 0,
            },
          },
        },
        {
          operation: "component_create",
          args: {
            appId: "projects-app",
            kind: "projects",
            properties: { value: root, sizing: "fill" },
          },
        },
      ],
    });
    await call("app_focus", { appId: "projects-app" });
    const hub = page.getByRole("main", { name: "Projects Hub" });
    await expect(hub.locator(".project-row")).toHaveCount(2);
    await expect(
      hub.locator(".group-name").filter({ hasText: "Client work" }),
    ).toBeVisible();
    await expect(hub.locator(".terminal-panel")).toBeVisible();
    await hub.getByPlaceholder("Filter projects...").fill("Website");
    await expect(hub.locator(".project-row")).toHaveCount(1);
    await hub.getByPlaceholder("Filter projects...").clear();
    await hub
      .getByRole("button", { name: "Create group", exact: true })
      .click();
    await hub.getByPlaceholder("Client Apps", { exact: true }).fill("Personal");
    await hub
      .locator(".create-group-panel")
      .getByRole("button", { name: "Create Group", exact: true })
      .click();
    await expect(
      hub.locator(".group-name").filter({ hasText: "Personal" }),
    ).toBeVisible();
    await hub
      .locator(".group-name")
      .filter({ hasText: "All Projects" })
      .click();
    await expect(hub.locator(".project-row")).toHaveCount(2);
    await expect(page.locator(".canvas-plane")).not.toHaveClass(
      /camera-moving/,
    );
    await page.screenshot({ path: "artifacts/projects-hub.png" });
    await Promise.all(
      Array.from({ length: 28 }, (_, index) =>
        mkdir(join(root, `Project ${String(index).padStart(2, "0")}`)),
      ),
    );
    await hub
      .locator(".toolbar")
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
    await expect(hub.locator(".project-row")).toHaveCount(30);
    const header = hub.locator(".table-head"),
      body = hub.locator(".project-rows");
    const headerBefore = (await header.boundingBox())!;
    await body.evaluate((element) => {
      element.scrollTop = 200;
    });
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(
      0,
    );
    const headerAfter = (await header.boundingBox())!,
      bodyAfter = (await body.boundingBox())!;
    expect(headerAfter.y).toBeCloseTo(headerBefore.y, 1);
    expect(bodyAfter.y).toBeGreaterThanOrEqual(
      headerAfter.y + headerAfter.height - 1,
    );
    expect(
      await header.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          ),
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: "artifacts/projects-table-scroll.png" });
    await page.reload();
    await expect(
      page
        .getByRole("main", { name: "Projects Hub" })
        .locator(".group-name")
        .filter({ hasText: "Personal" }),
    ).toBeVisible();
    const denied = await fetch(`${origin}/__orvane/projects/workspace`, {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rootPath: root }),
    });
    expect(denied.status).toBe(403);
  } finally {
    await client?.close();
    await transport?.close();
    await vite.close();
  }
});
