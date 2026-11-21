import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UiMakerService } from "../server/uimaker";

async function openUiMaker(p: Page, name: string) {
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.goto("/");
  p.setDefaultTimeout(8000);
  await p.getByRole("button", { name: "Workspace options" }).click();
  await p.getByRole("button", { name: "Create UI Maker" }).click();
  const app = p.locator(".canvas-app").last();
  await p.locator(".help").waitFor();
  await p.locator(".help").dispatchEvent("pointerdown");
  await app.getByTitle("New component").click();
  await app.getByLabel("New component name").fill(name);
  await app.getByLabel("New component name").press("Enter");
  await app.locator(".library-item").first().click();
  const post = async (op: string, body: object) => (await p.request.post(`/__orvane/uimaker/${op}`, { data: body })).json();
  // The editor has saved its own state before any outside write.
  await expect.poll(async () => (await post("state", {})).state.components.length).toBe(1);
  return { app, post };
}

test("UI Maker shows a component added from outside the editor without a reload", async ({ page: p }) => {
  test.setTimeout(60_000);
  const { app, post } = await openUiMaker(p, "Card");
  const list = app.getByRole("navigation", { name: "Components" }).locator(".nav-item");
  await expect(list).toHaveCount(1);

  // An agent or another tool creates a component folder and adds it to the saved state.
  const { id } = await post("component", { name: "Wheel" });
  const { state } = await post("state", {});
  state.components.push({ id, name: "Wheel", width: 320, height: null });
  await post("save", { state });

  // The open editor lists it, keeps its own component, and opens it on click.
  await expect(list).toHaveText([/Card/, /Wheel/]);
  await list.nth(1).click();
  await expect(app.locator(".crumb, header").getByText("Wheel").first()).toBeVisible();
  await expect(app.locator(".timeline button")).toHaveCount(1);

  // The editor's next save keeps the added component.
  await app.getByTitle("New component").click();
  await app.getByLabel("New component name").fill("Third");
  await app.getByLabel("New component name").press("Enter");
  await expect.poll(async () => (await post("state", {})).state.components.map((c: { name: string }) => c.name)).toEqual(["Card", "Wheel", "Third"]);
});

test("UI Maker takes an artboard size set from outside, without undoing its own size changes", async ({ page: p }) => {
  test.setTimeout(60_000);
  const { app, post } = await openUiMaker(p, "Card");
  const width = app.getByRole("spinbutton", { name: "Artboard width" });
  const height = app.getByRole("spinbutton", { name: "Artboard height" });
  const id = (await post("state", {})).state.components[0].id;

  // uimaker_size (here through the same service over HTTP) resizes the open artboard.
  expect(await post("size", { c: id, width: 1060, height: 540 })).toEqual({ width: 1060, height: 540 });
  await expect(width).toHaveValue("1060");
  await expect(height).toHaveValue("540");
  await expect(app.getByRole("button", { name: "Auto" })).not.toHaveClass(/on/);

  // The editor's own change sticks when the next outside change only touches the width.
  await app.getByRole("button", { name: "Auto" }).click();
  await expect.poll(async () => (await post("state", {})).state.components[0].height).toBeNull();
  await post("size", { c: id, width: 900 });
  await expect(width).toHaveValue("900");
  await expect(app.getByRole("button", { name: "Auto" })).toHaveClass(/on/);
  expect((await post("state", {})).state.components[0]).toMatchObject({ width: 900, height: null });
});

test("uimaker_size MCP tool sets and validates the artboard size", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "orvane-size-"));
  const service = new UiMakerService(directory);
  const { id } = await service.createFolder("Card");
  service.saveState({ components: [{ id, name: "Card", width: 320, height: null }], notes: [], strokes: [], tweaks: [] });
  await service.close();
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
  const client = new Client({ name: "orvane-size-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "uimaker_size", arguments: { component: id, ...args } })) as { isError?: boolean; content: { text?: string }[] };
    expect(JSON.parse((await call({ width: 1060, height: 540 })).content[0]!.text!)).toEqual({ width: 1060, height: 540 });
    expect(JSON.parse((await call({ height: "auto" })).content[0]!.text!)).toEqual({ width: 1060, height: null });
    expect((await call({})).isError).toBe(true);
    expect((await call({ width: 10 })).isError).toBe(true);
    const listed = (await client.callTool({ name: "uimaker_list", arguments: {} })) as { content: { text: string }[] };
    const list = JSON.parse(listed.content[0]!.text);
    expect(list[0]).toMatchObject({ width: 1060, height: null });
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("uimaker_create MCP tool adds a component with a blank v1", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "orvane-create-"));
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
  const client = new Client({ name: "orvane-create-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "uimaker_create", arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    const made = JSON.parse((await call({ name: "Agent Sessions", intent: "Sessions app", width: 1180, height: 760 })).content[0]!.text!);
    expect(made).toEqual({ id: "agent-sessions", name: "Agent Sessions", width: 1180, height: 760 });
    expect(JSON.parse((await call({ name: "Agent Sessions", height: "auto" })).content[0]!.text!)).toMatchObject({ height: null });
    expect((await call({ name: "Bad", width: 10 })).isError).toBe(true);
    const listed = (await client.callTool({ name: "uimaker_list", arguments: {} })) as { content: { text: string }[] };
    const list = JSON.parse(listed.content[0]!.text);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: "agent-sessions", intent: "Sessions app", width: 1180, height: 760, latest: 1 });
    const round = (await client.callTool({ name: "uimaker_lab_round", arguments: { component: "agent-sessions", title: "Layout", kind: "new" } })) as { isError?: boolean };
    expect(round.isError).toBeFalsy();
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});
