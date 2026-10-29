import { test, expect, type Page } from "./fixtures";
import {
  emptyWorkspace,
  makeBlock,
  uid,
  type CanvasApp,
  type Rule,
} from "../src/model";
import { parseWorkspace } from "../src/validation";
import { mergeWorkspace } from "../src/imports";
import { executeGraph } from "../src/flow";
import { readStored } from "./storage-helper";

function fixture() {
  const workspace = emptyWorkspace();
  const counter = makeBlock("counter"),
    button = makeBlock("button");
  counter.label = "Count";
  button.label = "Add";
  button.rules = [
    {
      id: uid(),
      action: "increment",
      appId: "",
      target: counter.id,
      value: "1",
    },
  ];
  const app: CanvasApp = {
    id: uid(),
    name: "Notes",
    icon: "app",
    x: 100,
    y: 100,
    width: 1000,
    height: 650,
    blocks: [counter, button],
    archived: false,
    group: "",
    exposed: true,
    accent: "#6f8998",
    padding: 24,
    gap: 18,
    radius: 8,
  };
  workspace.apps = [app];
  return workspace;
}
async function seed(page: Page, workspace = fixture()) {
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    if (!localStorage.getItem("orvane.workspace.v1"))
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
}
test("migration preserves legacy bytes and retries SQLite saving after reconnecting", async ({
  page,
  context,
}) => {
  const original = fixture();
  await seed(page, original);
  await page
    .getByRole("button", { name: "Increase Count", exact: true })
    .click();
  await expect
    .poll(async () => (await readStored(page)).apps[0]!.blocks[0]!.count)
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("orvane.workspace.v1")!).apps[0]
          .blocks[0].count,
    ),
  ).toBe(0);
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Increase Count", exact: true })
    .click();
  await expect(page.locator("output")).toHaveText("2");
  await expect(page.locator(".status-area")).toContainText(
    "Saving is unavailable",
  );
  await context.setOffline(false);
  await expect
    .poll(async () => (await readStored(page)).apps[0]!.blocks[0]!.count)
    .toBe(2);
  await page.reload();
  await expect(page.locator("output")).toHaveText("2");
});
test("secondary tab is read-only, synchronizes, and safely acquires ownership after close", async ({
  page,
  context,
}) => {
  await seed(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.locator("main")).toHaveAttribute(
    "data-editable",
    "false",
  );
  await expect(
    second.getByRole("button", { name: "Create app", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Increase Count", exact: true })
    .click();
  await expect(second.locator("output")).toHaveText("1");
  await page.close();
  await expect(second.locator("main")).toHaveAttribute("data-editable", "true");
  await second
    .getByRole("button", { name: "Increase Count", exact: true })
    .click();
  await expect
    .poll(async () => (await readStored(second)).apps[0]!.blocks[0]!.count)
    .toBe(2);
});
test("merge keeps same-named apps, remaps targets, preserves existing geometry, and recovery restores prior state", async ({
  page,
}) => {
  const original = fixture();
  await seed(page, original);
  const incoming = fixture();
  await page.getByLabel("Import workspace file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(incoming)),
  });
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.locator(".dock-tab")).toHaveCount(2);
  const stored = await readStored(page);
  expect(stored.apps[0]).toEqual(original.apps[0]);
  const copy = stored.apps[1]!;
  expect(copy.id).not.toBe(incoming.apps[0]!.id);
  expect(copy.blocks[1]!.rules[0]!.target).toBe(copy.blocks[0]!.id);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Restore previous workspace" })
    .click();
  await expect(page.locator(".dock-tab")).toHaveCount(1);
  expect((await readStored(page)).apps[0]).toEqual(original.apps[0]);
});
test("dock duplication is independent; trash is recoverable and shows incoming dependencies", async ({
  page,
}) => {
  const w = fixture();
  const dependent = JSON.parse(JSON.stringify(w.apps[0])) as CanvasApp;
  dependent.id = uid();
  dependent.name = "Dependent";
  dependent.blocks = [makeBlock("button")];
  dependent.blocks[0]!.rules = [
    {
      id: uid(),
      action: "increment",
      appId: w.apps[0]!.id,
      target: w.apps[0]!.blocks[0]!.id,
      value: "1",
    },
  ];
  w.apps.push(dependent);
  await seed(page, w);
  const tab = page.getByRole("button", { name: "Notes", exact: true });
  await tab.click({ button: "right" });
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.locator(".dock-tab")).toHaveCount(3);
  await expect.poll(async () => (await readStored(page)).apps.length).toBe(3);
  const stored = await readStored(page);
  expect(stored.apps[2]!.blocks[1]!.rules[0]!.target).toBe(
    stored.apps[2]!.blocks[0]!.id,
  );
  await tab.click({ button: "right" });
  await page.getByRole("button", { name: "Manage app", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Manage app" })).toContainText(
    "Dependent",
  );
  await page.screenshot({ path: "artifacts/handoff-management.png" });
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(page.locator(".dock-tab")).toHaveCount(2);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".dock-tab")).toHaveCount(3);
});
test("inspecting a graph keeps simple representation; individual rule expansion retains behavior", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page.locator(".tree-select").filter({ hasText: "Add" }).first().click();
  await page
    .getByRole("button", { name: "Expand to graph", exact: true })
    .click();
  await expect(page.locator(".node-workspace")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  expect((await readStored(page)).apps[0]!.blocks[1]!.graph).toBeUndefined();
  await expect(
    page.getByRole("button", { name: "Expand this rule", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand this rule", exact: true })
    .click();
  await expect(page.locator(".action-node")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Action value", exact: true })
    .fill("2");
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator("output")).toHaveText("2");
});
test("dismissed gesture hint stays dismissed after reload", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(page.locator(".context-hint")).toBeVisible();
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(page.locator(".context-hint")).toHaveCount(0);
});
test("schema rejects malformed graphs, nested rules, duplicate IDs and future versions; strips unknown fields", () => {
  const w = fixture();
  expect(parseWorkspace({ ...w, secret: "discard" })).not.toHaveProperty(
    "secret",
  );
  expect(() => parseWorkspace({ ...w, version: 2 })).toThrow("unsupported");
  expect(() => parseWorkspace({ ...w, apps: [w.apps[0], w.apps[0]] })).toThrow(
    "duplicate",
  );
  w.customNodes = [
    {
      id: uid(),
      name: "Bad",
      code: "",
      rules: [{ id: "x", action: "invalid" } as unknown as Rule],
    },
  ];
  expect(() => parseWorkspace(w)).toThrow("valid");
  w.customNodes = [];
  w.apps[0]!.blocks[1]!.graph = {
    positions: {},
    edges: [{ id: "x", source: "missing", target: "also-missing" }],
  };
  expect(() => parseWorkspace(w)).toThrow("connection");
});
test("merge does not bind unresolved references to existing identifiers", () => {
  const current = fixture(),
    incoming = fixture();
  incoming.apps[0]!.blocks[1]!.rules[0]!.appId = current.apps[0]!.id;
  const merged = mergeWorkspace(current, incoming);
  expect(merged.apps[1]!.blocks[1]!.rules[0]!.appId).not.toBe(
    current.apps[0]!.id,
  );
});
test("failed branches stop dependents, preserve independent work, and execute explicit fallbacks once", async () => {
  const rule = (id: string): Rule => ({
    id,
    action: "set-text",
    appId: "",
    target: "",
    value: "",
  });
  const calls: string[] = [];
  await expect(
    executeGraph(
      ["bad", "dependent", "good", "fallback"].map(rule),
      {
        positions: {},
        edges: [
          { id: "a", source: "trigger", target: "bad" },
          { id: "b", source: "bad", target: "dependent" },
          { id: "c", source: "trigger", target: "good" },
          { id: "d", source: "bad", target: "fallback", on: "failure" },
        ],
      },
      "",
      async (r) => {
        calls.push(r.id);
        if (r.id === "bad") throw "broken";
        return "ok";
      },
    ),
  ).rejects.toThrow("broken");
  expect(calls).toEqual(["bad", "good", "fallback"]);
});
test("graph joins execute once and disconnected nodes do not run", async () => {
  const rules = ["a", "b", "join", "unused"].map((id) => ({
    id,
    action: "clear" as const,
    appId: "",
    target: "",
    value: "",
  }));
  const calls: string[] = [];
  await executeGraph(
    rules,
    {
      positions: {},
      edges: [
        { id: "1", source: "trigger", target: "a" },
        { id: "2", source: "trigger", target: "b" },
        { id: "3", source: "a", target: "join" },
        { id: "4", source: "b", target: "join" },
      ],
    },
    "",
    async (r) => {
      calls.push(r.id);
      return "";
    },
  );
  expect(calls).toEqual(["a", "b", "join"]);
});

test("sandbox treats non-Error throws including empty values as failures", async ({
  page,
}) => {
  await seed(page);
  const results = await page.evaluate(async () => {
    const path = "/src/sandbox.ts";
    const { runIsolated } = await import(path);
    const errors = [];
    for (const code of ['throw "bad"', 'throw ""', "throw null", "throw 0"]) {
      try {
        await runIsolated(code, "");
        errors.push(false);
      } catch {
        errors.push(true);
      }
    }
    return errors;
  });
  expect(results).toEqual([true, true, true, true]);
});
test("invalid import leaves workspace intact and preview is keyboard reachable", async ({
  page,
}) => {
  const w = fixture();
  await seed(page, w);
  const malformed = fixture();
  malformed.apps.push(malformed.apps[0]!);
  await page.getByLabel("Import workspace file").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(page.locator(".status-area")).toContainText("duplicate");
  expect((await readStored(page)).apps).toEqual(w.apps);
  await page.getByLabel("Import workspace file").setInputFiles({
    name: "valid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture())),
  });
  await expect(
    page.getByRole("button", { name: "Merge", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Cancel import", exact: true }),
  ).toBeFocused();
  await page.screenshot({ path: "artifacts/handoff-import.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/handoff-import-mobile.png" });
  const box = await page
    .getByRole("dialog", { name: "Backup import preview" })
    .boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("failed import transaction rolls back both workspace and recovery snapshot", async ({
  page,
}) => {
  const w = fixture();
  await seed(page, w);
  const snapshot = () =>
    page.evaluate(async () =>
      (await fetch("/__orvane/storage/snapshot")).json(),
    );
  const before = await snapshot();
  await page.route("**/__orvane/storage/state", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Disk full" }),
        })
      : route.continue(),
  );
  await page.getByLabel("Import workspace file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture())),
  });
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.locator(".status-area")).toContainText(
    "Your existing workspace was kept",
  );
  expect((await readStored(page)).apps).toEqual(w.apps);
  expect(await snapshot()).toEqual(before);
});
test("unavailable backend preserves browser data and offers export without enabling edits", async ({
  page,
}) => {
  const w = fixture();
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
    Object.defineProperty(navigator, "locks", { value: undefined });
  }, w);
  await page.route("**/__orvane/storage/lease", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Local SQLite backend is unavailable." }),
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Create app", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".status-area")).toContainText(
    "Local SQLite backend is unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Export current data", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("orvane.workspace.v1")!).apps[0].name,
    ),
  ).toBe("Notes");
});
