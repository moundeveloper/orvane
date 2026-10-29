import { test, expect } from "./fixtures";
import { NotesService } from "../server/notes";
import { notesApi } from "../server/notes-api";
import { localStorageApi } from "../server/storage-api";
import { mcpDiscovery } from "../server/discovery";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("SQLite note-body replacement is atomic and survives reopening", async ({}, info) => {
  const service = new NotesService(info.outputPath("data"));
  try {
    service.invoke("data", {
      collection: "blocks",
      action: "replaceBlocks",
      pageId: "page",
      rows: [{ id: "a", pageId: "page", html: "Saved content" }],
    });
    expect(() =>
      service.invoke("data", {
        collection: "blocks",
        action: "replaceBlocks",
        pageId: "page",
        rows: [{ id: "b", pageId: "wrong", html: "Broken" }],
      }),
    ).toThrow();
    expect(
      service.invoke("data", {
        collection: "blocks",
        action: "list",
        pageId: "page",
      }),
    ).toEqual([{ id: "a", pageId: "page", html: "Saved content" }]);
    service.close();
    expect(
      service.invoke("data", {
        collection: "blocks",
        action: "list",
      }) as unknown[],
    ).toHaveLength(1);
  } finally {
    service.close();
  }
});
test("Notes MCP port edits rich text, persists tabs and exposes database views", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const directory = info.outputPath("data");
  const vite = await createServer({
    configFile: false,
    cacheDir: info.outputPath("vite-cache"),
    root: resolve("."),
    plugins: [
      vue(),
      notesApi(directory),
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
    client = new Client({ name: "notes-port-test", version: "1.0.0" });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    const now = new Date().toISOString();
    await call("notes_data", {
      collection: "pages",
      action: "put",
      rows: [
        {
          id: "test-page",
          title: "Ported Notes",
          type: "page",
          parentId: null,
          isFavorite: false,
          trashedAt: null,
          position: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    await call("notes_data", {
      collection: "blocks",
      action: "put",
      rows: [
        {
          id: "test-block",
          pageId: "test-page",
          type: "paragraph",
          html: 'Hello <b>Orvane</b><img src=x onerror="window.notesUnsafe=true">',
          position: 0,
          indent: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
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
            id: "notes-app",
            properties: {
              name: "Notes",
              icon: "text",
              width: 1160,
              height: 800,
              padding: 0,
              gap: 0,
            },
          },
        },
        {
          operation: "component_create",
          args: {
            appId: "notes-app",
            kind: "notes",
            properties: {
              value: JSON.stringify({
                active: "test-page",
                tabs: ["test-page"],
              }),
              sizing: "fill",
            },
          },
        },
      ],
    });
    await call("app_focus", { appId: "notes-app" });
    await expect(page.locator(".notes-workspace .page-title")).toHaveText(
      "Ported Notes",
      { timeout: 15000 },
    );
    const editor = page.locator(".notes-workspace .block-content").first();
    await expect(editor).toContainText("Hello Orvane");
    expect(
      await page.evaluate(
        () => (window as unknown as { notesUnsafe?: boolean }).notesUnsafe,
      ),
    ).toBeUndefined();
    await page.locator(".notes-workspace .page-title").fill("Notes in Orvane");
    await editor.fill("Rich text survives a reload.");
    await expect
      .poll(
        async () =>
          (
            await call("notes_data", {
              collection: "blocks",
              action: "get",
              key: "test-block",
            })
          ).html,
      )
      .toContain("Rich text survives");
    await page.reload();
    await expect(page.locator(".notes-workspace .page-title")).toHaveText(
      "Notes in Orvane",
    );
    await expect(
      page.locator(".notes-workspace .block-content").first(),
    ).toContainText("Rich text survives");
    await expect.poll(async()=> (await call('workspace_status')).connected,{timeout:15000}).toBe(true);
    await call("app_focus", { appId: "notes-app" });
    await expect(page.locator(".canvas-plane")).not.toHaveClass(
      /camera-moving/,
    );
    await page.screenshot({ path: "artifacts/notes-workspace.png" });
    // Orvane's global .editor panel style once leaked into the note body.
    await expect(
      page.locator(".notes-workspace .notes-editor"),
    ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    // Anchored menus follow the canvas camera: same scale as the app, pinned
    // to their block while zooming and panning (including over Notes).
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("/");
    const slash = page.locator(".slash-menu");
    await expect(slash).toBeVisible();
    const placement = () =>
      page.evaluate(() => {
        const block = document.querySelector<HTMLElement>(
          ".notes-workspace .block-content",
        )!;
        const menu = document.querySelector<HTMLElement>(".slash-menu")!;
        const b = block.getBoundingClientRect(),
          m = menu.getBoundingClientRect();
        return {
          blockLeft: b.left,
          blockBottom: b.bottom,
          menuLeft: m.left,
          menuTop: m.top,
          appScale: b.width / block.offsetWidth,
          menuScale: m.width / menu.offsetWidth,
        };
      });
    const expectPinned = async () =>
      expect
        .poll(async () => {
          const p = await placement();
          return (
            Math.abs(p.menuLeft - p.blockLeft) < 2 &&
            p.menuTop > p.blockBottom - 1 &&
            p.menuTop < p.blockBottom + 12 * p.appScale &&
            Math.abs(p.menuScale - p.appScale) < 0.01
          );
        })
        .toBe(true);
    await expectPinned();
    const before = await placement();
    await page.mouse.move(700, 600);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -400);
    await page.keyboard.up("Control");
    await expect
      .poll(async () => (await placement()).appScale)
      .toBeGreaterThan(before.appScale * 1.2);
    await expectPinned();
    const zoomed = await placement();
    // Start beside the menu, on the note page itself.
    const menuBox = (await slash.boundingBox())!;
    const startX = menuBox.x + menuBox.width + 60,
      startY = menuBox.y + 20;
    await page.mouse.move(startX, startY);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(startX - 100, startY - 50, { steps: 5 });
    await page.mouse.up({ button: "middle" });
    await expect
      .poll(async () => (await placement()).blockLeft)
      .toBeLessThan(zoomed.blockLeft - 80);
    await expectPinned();
    await page.keyboard.press("Escape");
    await expect(slash).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await call("app_focus", { appId: "notes-app" });
    await expect(page.locator(".canvas-plane")).not.toHaveClass(
      /camera-moving/,
    );
    await page
      .locator(".notes-workspace .sb")
      .getByRole("button", { name: "New database", exact: true })
      .click();
    await expect(page.locator(".db-table-head-scroll")).toBeVisible();
    await page
      .getByRole("button", { name: "＋ New record", exact: true })
      .click();
    await expect(page.locator(".db-table-body tbody tr")).toHaveCount(1);
    await expect(page.locator(".notes-workspace select")).toHaveCount(0);
    await page.screenshot({ path: "artifacts/notes-database.png" });
    const denied = await fetch(`${origin}/__orvane/notes/data`, {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ collection: "pages", action: "list" }),
    });
    expect(denied.status).toBe(403);
  } finally {
    await client?.close();
    await transport?.close();
    await vite.close();
  }
});
