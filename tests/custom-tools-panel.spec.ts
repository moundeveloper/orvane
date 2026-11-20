import { test, expect, _electron as electron } from "@playwright/test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Workspace options → Custom tools shows the tools agents saved; the user can
// search, create, edit, turn off (hidden from agents, kept even when an agent
// saves it again) and delete them.
test("the Custom tools panel lists, edits, turns off and deletes agent tools", async ({}, info) => {
  test.setTimeout(240_000);
  const data = info.outputPath("data");
  const env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...env, ORVANE_PORT: "5238", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5238" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-custom-tools-test", version: "1.0.0" });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    const double = {
      name: "double_it",
      description: "Doubles a number",
      params: { n: { type: "number" } },
      code: "return input.n * 2;",
    };
    await call("custom_tool_save", { tool: double });
    expect(await call("custom_tool_run", { name: "double_it", input: { n: 21 } })).toEqual(expect.objectContaining({ result: 42 }));

    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Custom tools", exact: true }).click();
    const panel = page.getByRole("region", { name: "Custom tools" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("double_it")).toBeVisible();
    await panel.getByRole("button", { name: /double_it/ }).first().click();
    await expect(panel.locator(".tools-pre")).toHaveText("return input.n * 2;");

    // Turned off: not runnable, gone from the agent's tool list, and an
    // agent's save keeps it off.
    await panel.getByRole("button", { name: "Turn off double_it" }).click();
    await expect(panel.getByText("Off", { exact: true })).toBeVisible();
    expect(JSON.stringify((await raw("custom_tool_run", { name: "double_it", input: { n: 1 } })).content)).toContain("turned off");
    await expect
      .poll(async () => (await client.listTools()).tools.some((t) => t.name === "custom_double_it"), { timeout: 15_000 })
      .toBe(false);
    await call("custom_tool_save", { tool: { ...double, description: "Doubles a number (v2)" } });
    expect((await call("custom_tool_list")).find((t: any) => t.name === "double_it").disabled).toBe(true);
    await panel.getByRole("button", { name: "Turn on double_it" }).click();
    await expect(panel.getByText("Off", { exact: true })).toHaveCount(0);

    // The user edits it and creates one.
    await panel.getByRole("button", { name: "Edit double_it" }).click();
    const editor = panel.getByRole("textbox", { name: "Tool definition" });
    await editor.fill(JSON.stringify({ ...double, code: "return input.n * 3;" }));
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await raw("custom_tool_run", { name: "double_it", input: { n: 2 } })).structuredContent).toEqual(
      expect.objectContaining({ result: expect.objectContaining({ result: 6 }) }),
    );
    await panel.getByRole("button", { name: "New tool" }).click();
    await editor.fill(JSON.stringify({ name: "shout", description: "Upper-cases text", params: { text: { type: "string" } }, code: "return input.text.toUpperCase();" }));
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText("shout", { exact: true })).toBeVisible();
    expect(await call("custom_tool_run", { name: "shout", input: { text: "hi" } })).toEqual(expect.objectContaining({ result: "HI" }));

    // Invalid definitions are explained, not saved.
    await panel.getByRole("button", { name: "New tool" }).click();
    await editor.fill('{"name": "Bad Name", "description": "x", "code": "return 1"}');
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("name");
    await panel.getByRole("button", { name: "Cancel" }).click();

    // Search and delete.
    await panel.getByRole("textbox", { name: "Search custom tools" }).fill("upper");
    await expect(panel.locator(".tools-list > li")).toHaveCount(1);
    await panel.getByRole("button", { name: "Delete shout" }).click();
    await panel.getByRole("button", { name: "Click again to delete" }).click();
    await expect(panel.locator(".tools-list > li")).toHaveCount(0);
    expect((await call("custom_tool_list")).map((t: any) => t.name)).toEqual(["double_it"]);
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
  }
});
