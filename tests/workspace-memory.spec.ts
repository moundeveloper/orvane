import { test, expect } from "./fixtures";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WorkspaceMemoryStore } from "../server/workspace-memory";

test("Memory panel: AI entries wait for review, the owner adds, approves, turns off and deletes", async ({ page: p, context }) => {
  test.setTimeout(60_000);
  await p.setViewportSize({ width: 1400, height: 900 });
  await p.goto("/");
  p.setDefaultTimeout(8000);

  // An AI saves into this test workspace's database (as the MCP tool does).
  const namespace = (await context.cookies()).find((c) => c.name === "orvane-test-workspace")!.value;
  const store = new WorkspaceMemoryStore(resolve(".orvane"), `tests/${namespace}.sqlite`);
  store.saveNote("ai", { text: "Boards means the articempire Pinterest account." });
  store.saveProcedure("ai", { name: "Design lookup", description: "Finding UI references", steps: ["Open the Web design board", "Pick three pins"] });
  store.close();

  // The header button opens the panel; the count shows what waits for review.
  const button = p.locator(".top-actions").getByRole("button", { name: "Memory" });
  await p.reload();
  await expect(button.locator(".memory-pending")).toHaveText("2");
  await button.click();
  const panel = p.getByRole("region", { name: "Memory" });
  const rows = panel.locator(".memory-list > li");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Boards means the articempire Pinterest account.");
  await expect(rows.first()).toContainText("Unreviewed");
  await expect(rows.first()).toContainText("Saved by AI");

  // Approving clears the badge on that entry and lowers the count.
  await rows.first().getByRole("button", { name: "Approve note" }).click();
  await expect(rows.first()).not.toContainText("Unreviewed");
  await expect(button.locator(".memory-pending")).toHaveText("1");

  // The owner adds a note of their own: reviewed from the start.
  await panel.getByRole("button", { name: "New note" }).click();
  await panel.getByLabel("Note", { exact: true }).fill("Open UI Maker full-window when reviewing.");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Yours");
  await expect(rows.nth(1)).not.toContainText("Unreviewed");
  await panel.getByRole("button", { name: /^Procedures/ }).click();
  await p.screenshot({ path: "artifacts/memory-panel.png", clip: { x: 700, y: 0, width: 700, height: 640 } });
  await panel.getByRole("button", { name: /^Notes/ }).click();

  // Secrets are refused with a message.
  await panel.getByRole("button", { name: "New note" }).click();
  await panel.getByLabel("Note", { exact: true }).fill("My password is hunter2");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.locator(".memory-error")).toContainText("secrets");
  await panel.getByRole("button", { name: "Cancel" }).click();

  // Procedures: steps one per line; turning off keeps it but marks it Off.
  await panel.getByRole("button", { name: /^Procedures/ }).click();
  const procedure = rows.filter({ hasText: "Design lookup" });
  await expect(procedure.locator(".memory-steps li")).toHaveText(["Open the Web design board", "Pick three pins"]);
  await procedure.getByRole("button", { name: "Turn off Design lookup" }).click();
  await expect(procedure).toContainText("Off");
  await expect(button.locator(".memory-pending")).toHaveCount(0);

  // Delete needs a second click.
  await procedure.getByRole("button", { name: "Delete Design lookup" }).click();
  await expect(procedure).toHaveCount(1);
  await procedure.getByRole("button", { name: "Click again to delete" }).click();
  await expect(rows).toHaveCount(0);

  // Ctrl+K opens it too; outside click closes it.
  await p.mouse.click(700, 500);
  await expect(panel).toHaveCount(0);
  await p.keyboard.press("Control+k");
  await p.keyboard.type("Memory");
  await p.keyboard.press("Enter");
  await expect(panel).toBeVisible();
});

test("workspace_memory MCP tool saves unreviewed entries that workspace_status returns", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "orvane-memory-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      ORVANE_MCP_STATE_DIR: directory,
      ORVANE_DATA_DIR: directory,
      ORVANE_MCP_PORT: "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-memory-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    type Result = { isError?: boolean; content: { text: string }[] };
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
    const json = (r: Result) => JSON.parse(r.content[0]!.text);

    const saved = json(await call("workspace_memory", { action: "save_note", text: "Boards means the articempire Pinterest account." }));
    expect(saved.notes).toEqual([{ id: expect.any(String), text: "Boards means the articempire Pinterest account.", reviewed: false }]);
    await call("workspace_memory", {
      action: "save_procedure", name: "Design lookup", description: "Finding UI references", steps: ["Open the Web design board"],
    });
    expect((await call("workspace_memory", { action: "save_note", text: "api key is abc" })).isError).toBe(true);
    expect((await call("workspace_memory", { action: "save_procedure", name: "No steps", description: "x", steps: [] })).isError).toBe(true);

    // workspace_status hands every AI the memory, with its notice.
    const status = json(await call("workspace_status", {}));
    expect(status.memory.notice).toContain("reviewed:false");
    expect(status.memory.procedures).toEqual([
      { name: "Design lookup", description: "Finding UI references", steps: ["Open the Web design board"], reviewed: false },
    ]);

    // An AI can't touch what the owner turned off, and the AI doesn't see it.
    const store = new WorkspaceMemoryStore(directory);
    store.setDisabled("procedure", "Design lookup", true);
    store.close();
    expect((await call("workspace_memory", { action: "delete", kind: "procedure", key: "Design lookup" })).isError).toBe(true);
    expect(json(await call("workspace_memory", { action: "get" })).procedures).toEqual([]);

    expect(json(await call("workspace_memory", { action: "delete", kind: "note", key: saved.notes[0].id })).notes).toEqual([]);
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});
