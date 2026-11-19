import { test, expect, _electron as electron } from "@playwright/test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The owner chose: scheduled triggers keep running while Orvane sits in the
// tray. Closing the window hides it; the page keeps checking (throttled).
test("a scheduled trigger runs while Orvane is hidden in the tray", async ({}, info) => {
  test.setTimeout(240_000);
  const data = info.outputPath("data");
  const env = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...env, ORVANE_PORT: "5231", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5231" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-tray-trigger-test", version: "1.0.0" });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await expect.poll(async () => (await call("workspace_status")).sessions.length, { timeout: 30_000 }).toBe(1);
    const cmd = (operation: string, args: Record<string, unknown>) => ({ operation, args });
    await call("workspace_batch", {
      commands: [
        cmd("app_create", { id: "log", properties: { name: "Log", x: 120, y: 100, width: 420, height: 360 } }),
        cmd("component_create", { appId: "log", id: "items", kind: "list", properties: { label: "Runs" } }),
        cmd("app_update", { appId: "log", patch: { exposed: true } }),
        cmd("workflow_set", {
          id: "note",
          name: "Note",
          inputs: [],
          steps: [{ action: "add-item", appId: "log", target: "items", value: "ran in tray" }],
        }),
        cmd("trigger_set", { id: "tick", name: "Tick", workflowId: "note", schedule: { kind: "interval", minutes: 1 } }),
      ],
    });
    // Close = hide to the tray.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.isVisible())?.close();
    });
    // (Playwright keeps document.visibilityState "visible"; ask the window.)
    const shown = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
    await expect.poll(shown).toBe(false);
    await expect
      .poll(
        async () => (await call("component_get", { appId: "log", componentId: "items" })).results[0].items.length,
        { timeout: 150_000, intervals: [5_000] },
      )
      .toBeGreaterThan(0);
    expect(await shown()).toBe(false);
    const [trigger] = (await call("trigger_list")).results[0];
    expect(trigger.lastRun).toEqual(expect.any(Number));
    expect(trigger.lastError).toBeUndefined();
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
  }
});
