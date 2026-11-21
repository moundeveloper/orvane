import { test, expect } from "./fixtures";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UiMakerService } from "../server/uimaker";

const page = (text: string, radius: string) =>
  `<!doctype html><html><head><style>body{margin:0;display:grid;place-items:center;height:100vh;background:#e9edf0;font:14px Inter,sans-serif}#card{padding:24px 32px;background:#fff;border-radius:${radius}}</style></head><body><div id="card">${text}</div></body></html>`;

test("UI Maker Lab shows a round's variants as tabs, follows the agent's writes and picks a winner", async ({ page: p }) => {
  test.setTimeout(90_000);
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.goto("/");
  p.setDefaultTimeout(8000);
  await p.getByRole("button", { name: "Workspace options" }).click();
  await p.getByRole("button", { name: "Create UI Maker" }).click();
  const app = p.locator(".canvas-app").last();
  await p.locator(".help").waitFor();
  await p.locator(".help").dispatchEvent("pointerdown");
  await app.getByTitle("New component").click();
  await app.getByLabel("New component name").fill("Card");
  await app.getByLabel("New component name").press("Enter");
  await app.locator(".library-item").first().click();
  await expect(app.locator(".timeline button")).toHaveCount(1);

  const api = async (op: string, body: object) => {
    const r = await p.request.post(`/__orvane/uimaker/${op}`, { data: body });
    return { ok: r.ok(), json: await r.json() };
  };
  // The Lab is a mode next to Review, Inspect and Compare.
  await app.locator(".top .pills").getByRole("button", { name: "Lab" }).click();
  await expect(app.locator(".lab-empty")).toHaveText("No rounds yet");
  await expect(app.locator(".lab-rounds")).toContainText("No rounds yet");

  // An agent starts a round and writes the first variant whole …
  expect((await api("lab-start", { c: "card", title: "Card corners", kind: "redesign" })).ok).toBe(true);
  expect((await api("lab-write", { c: "card", variant: "soft", label: "Soft", html: page("Soft", "14px") })).ok).toBe(true);
  // … and forks it with exact edits instead of resending the page.
  const fork = await api("lab-write", {
    c: "card", variant: "sharp", label: "Sharp", from: "soft",
    edits: [{ find: "border-radius:14px", replace: "border-radius:0" }, { find: ">Soft<", replace: ">Sharp<" }],
  });
  expect(fork.ok).toBe(true);
  // An edit whose text is missing is refused, naming the edit.
  const bad = await api("lab-write", { c: "card", variant: "sharp", edits: [{ find: "not there", replace: "x" }] });
  expect(bad.ok).toBe(false);
  expect(bad.json.error).toContain("Edit 1");

  // The editor follows live: the open round, its tabs, and the first variant shown.
  const tabs = app.getByRole("tablist", { name: "Variants" }).getByRole("tab");
  await expect(tabs).toHaveText(["Soft", "Sharp"]);
  await expect(app.locator(".lab-title")).toHaveText("Card corners");
  await expect(app.locator(".lab-kind")).toHaveText("Redesign");
  await expect(app.locator(".lab-round").first()).toContainText("Now");
  const frame = app.frameLocator(".lab-stage iframe");
  await expect(frame.locator("#card")).toHaveText("Soft");

  // Number keys switch tabs while the pointer is over the app.
  await app.locator(".lab-stage").hover();
  await p.keyboard.press("2");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(frame.locator("#card")).toHaveText("Sharp");
  await expect(frame.locator("#card")).toHaveCSS("border-radius", "0px");

  // A rewrite of the shown variant reloads it in place.
  await api("lab-write", { c: "card", variant: "sharp", edits: [{ find: ">Sharp<", replace: ">Sharp 2<" }] });
  await expect(frame.locator("#card")).toHaveText("Sharp 2");
  await p.screenshot({ path: "artifacts/uimaker-lab.png" });

  // Picking saves the variant as the next iteration and closes the round.
  await app.locator(".lab-bar").getByRole("button", { name: "Pick" }).click();
  await expect(app.locator(".lab-bar .chip")).toHaveText("Picked as v2");
  await expect(app.locator(".timeline button")).toHaveCount(2);
  await expect(app.locator(".lab-round").first()).toContainText("Sharp → v2");
  await expect(app.locator(".lab-round").first()).not.toContainText("Now");
  expect((await api("lab-write", { c: "card", variant: "late", html: page("Late", "4px") })).ok).toBe(false);

  // A new round becomes the one shown; the earlier one stays in the history.
  await api("lab-start", { c: "card", title: "Card shadow", kind: "new" });
  await expect(app.locator(".lab-title")).toHaveText("Card shadow");
  await expect(app.locator(".lab-empty")).toHaveText("No variants yet");
  await expect(app.locator(".lab-round")).toHaveCount(2);
  await app.locator(".lab-round").nth(1).click();
  await expect(app.locator(".lab-title")).toHaveText("Card corners");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

  // Review mode is unchanged: its tools and the artboard come back.
  await app.locator(".top .pills").getByRole("button", { name: "Review" }).click();
  await expect(app.locator('[data-el="viewport"]')).toBeVisible();
  await expect(app.locator(".right .card")).toBeVisible();
});

test("UI Maker Lab MCP tools write, fork, read, render and pick variants", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "orvane-lab-"));
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
  const client = new Client({ name: "orvane-lab-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return result as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
    };
    const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.content[0]!.text!);
    expect(json(await call("uimaker_lab_round", { component: id, title: "Card corners", kind: "redesign" }))).toMatchObject({ round: "r1", base: "v1" });
    expect(json(await call("uimaker_lab_write", { component: id, variant: "soft", label: "Soft", html: page("Soft", "14px") }))).toMatchObject({ round: "r1", variant: "soft" });
    const forked = json(await call("uimaker_lab_write", {
      component: id, variant: "sharp", label: "Sharp", from: "soft", edits: [{ find: "border-radius:14px", replace: "border-radius:0" }],
    }));
    expect(forked.variant).toBe("sharp");
    const read = await call("uimaker_lab_read", { component: id, variant: "sharp" });
    expect(read.content[1]!.text).toContain("border-radius:0");
    expect(json(await call("uimaker_lab_read", { component: id })).variants).toEqual([{ id: "soft", label: "Soft" }, { id: "sharp", label: "Sharp" }]);
    const view = await call("uimaker_lab_view", { component: id, variant: "sharp", width: 600, height: 400 });
    expect(view.isError).toBeFalsy();
    expect(view.content[1]!.type).toBe("image");
    const png = Buffer.from(view.content[1]!.data!, "base64");
    expect(png.readUInt32BE(16)).toBe(600);
    expect(json(await call("uimaker_lab_pick", { component: id, variant: "sharp" }))).toEqual({ picked: "sharp", round: "r1", iteration: "v2" });
    const list = json(await call("uimaker_list", {}));
    expect(list[0].lab).toEqual([{ round: "r1", title: "Card corners", kind: "redesign", status: "picked", picked: "sharp", as: "v2", variants: 2 }]);
    expect((await call("uimaker_lab_write", { component: id, variant: "late", html: page("Late", "4px") })).isError).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});
