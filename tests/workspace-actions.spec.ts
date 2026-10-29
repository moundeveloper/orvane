import { test, expect, type Page } from "./fixtures";
import {
  emptyWorkspace,
  makeBlock,
  uid,
  type CanvasApp,
  type Rule,
  type WorkspaceAction,
} from "../src/model";
import { readStored } from "./storage-helper";
import { parseWorkspace } from "../src/validation";
import { mergeWorkspace } from "../src/imports";
function fixture() {
  const w = emptyWorkspace();
  const app = (name: string, x: number): CanvasApp => ({
    id: uid(),
    name,
    icon: "app",
    x,
    y: 120,
    width: 450,
    height: 400,
    blocks: [],
    exposed: true,
    archived: false,
    group: "",
    accent: "#6f8998",
    padding: 20,
    gap: 12,
    radius: 6,
  });
  const source = app("Sender", 120),
    destination = app("Receiver", 1800);
  const field = {
    ...makeBlock("input"),
    label: "Task",
    value: "Bring the graph to life",
  };
  const list = { ...makeBlock("list"), label: "Received tasks" };
  const actionId = uid();
  const rule = (action: Rule["action"], target = "", value = ""): Rule => ({
    id: uid(),
    action,
    target,
    value,
    appId: destination.id,
  });
  const action: WorkspaceAction = {
    id: actionId,
    name: "Send and open",
    icon: "workflow",
    inputs: ["task"],
    rules: [rule("add-item", list.id, "{task}"), rule("navigate")],
  };
  const button = {
    ...makeBlock("button"),
    label: "Send task",
    rules: [
      {
        id: uid(),
        action: "workspace-action" as const,
        target: "",
        value: "",
        appId: "",
        nodeId: actionId,
        bindings: { task: `{${field.id}}` },
      },
    ],
  };
  source.blocks = [field, button];
  destination.blocks = [list];
  w.apps = [source, destination];
  w.actions = [action];
  w.wheel = [
    {
      id: uid(),
      parent: "",
      name: "Send and open",
      kind: "action",
      appId: "",
      actionId,
      bindings: { task: "From the wheel" },
    },
  ];
  return { w, source, destination, action, list, button, rule };
}
async function load(page: Page, w: ReturnType<typeof fixture>["w"]) {
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    if (!localStorage.getItem("orvane.workspace.v1"))
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, w);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
}
test("app button maps fields into shared graph, updates destination then navigates; wheel reuses it", async ({
  page,
}) => {
  const f = fixture();
  await load(page, f.w);
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  await expect(page.locator(".dock-tab.active")).toContainText("Receiver");
  await expect
    .poll(
      async () => (await readStored(page)).apps[1]?.blocks[0]?.items[0]?.text,
    )
    .toBe("Bring the graph to life");
  await page
    .locator(".canvas-background")
    .click({ position: { x: 10, y: 500 } });
  await page.mouse.move(720, 100);
  await page.keyboard.down("Tab");
  await page.screenshot({ path: "artifacts/action-wheel-shared-actions.png" });
  await page.keyboard.up("Tab");
  await expect
    .poll(async () => (await readStored(page)).apps[1]?.blocks[0]?.items.length)
    .toBe(2);
  await expect(
    page.getByRole("status").filter({ hasText: "Action completed." }),
  ).toBeVisible();
});
test("failed data node stops navigation", async ({ page }) => {
  const f = fixture();
  f.destination.exposed = false;
  const update = f.action.rules[0]!,
    navigation = f.action.rules[1]!;
  f.action.graph = {
    positions: {},
    edges: [
      { id: uid(), source: "trigger", target: update.id },
      { id: uid(), source: update.id, target: navigation.id },
    ],
  };
  await load(page, f.w);
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("no longer exposes");
  await expect(page.locator(".dock-tab.active")).not.toContainText("Receiver");
});
test("library creates real graph actions and opens app settings", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.classList.contains("action-studio"))
        document.documentElement.dataset.studioEntrance =
          JSON.stringify(frames);
      return animate.call(this, frames, options);
    };
  });
  const f = fixture();
  await load(page, f.w);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Action library", exact: true })
    .click();
  await expect(page.getByLabel("Workspace action library")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-studio-entrance",
    /translate\(.*scale\(/,
  );
  await expect(page.locator(".action-studio")).toHaveCSS("transform", "none");
  const studioBounds = await page.locator(".action-studio").boundingBox();
  const closeBounds = await page
    .getByRole("button", { name: "Close action library" })
    .boundingBox();
  expect(closeBounds!.y - studioBounds!.y).toBeLessThanOrEqual(12);
  expect(
    studioBounds!.x + studioBounds!.width - closeBounds!.x - closeBounds!.width,
  ).toBeLessThanOrEqual(12);
  await expect(page.locator(".action-studio .node-workspace")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(page.locator(".action-studio .node-workspace")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.screenshot({ path: "artifacts/action-library-graph.png" });
  await page.getByRole("button", { name: "Go to app preset" }).click();
  await page
    .getByRole("textbox", { name: "Action name", exact: true })
    .fill("Open receiver settings");
  await page.getByRole("combobox", { name: "Action", exact: true }).click();
  await page.getByRole("option", { name: "Open app settings / graph" }).click();
  await page.getByRole("combobox", { name: "Target app", exact: true }).click();
  await page.getByRole("option", { name: "Receiver", exact: true }).click();
  await page.getByRole("button", { name: "Run action", exact: true }).click();
  await page.getByRole("button", { name: "Close action library" }).click();
  await expect(page.locator(".dock-tab.active")).toContainText("Receiver");
  await expect(
    page
      .getByRole("region", { name: "Receiver", exact: true })
      .getByText("App foundations", { exact: true }),
  ).toBeVisible();
});

test("fixed exposed source reads data, triggers app flow and opens its component graph", async ({
  page,
}) => {
  const f = fixture();
  f.list.rules = [{ ...f.rule("add-item", f.list.id), appId: "" }];
  f.action.inputs = [];
  f.action.rules = [
    { ...f.rule("read-field", f.source.blocks[0]!.id), appId: f.source.id },
    f.rule("emit", f.list.id),
    { ...f.rule("open-view", f.list.id), view: "graph" },
  ];
  await load(page, f.w);
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  const receiver = page.getByRole("region", { name: "Receiver", exact: true });
  await expect(receiver.locator(".node-workspace")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect
    .poll(
      async () => (await readStored(page)).apps[1]?.blocks[0]?.items[0]?.text,
    )
    .toBe("Bring the graph to life");
});

test("missing trigger inputs fail visibly before data changes", async ({
  page,
}) => {
  const f = fixture();
  f.button.rules[0]!.bindings = {};
  await load(page, f.w);
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("requires input “task”");
  await expect(page.locator(".dock-tab.active")).not.toContainText("Receiver");
});

test("backup merge remaps shared action references and legacy wheel slots upgrade", () => {
  const f = fixture();
  const merged = parseWorkspace(mergeWorkspace(f.w, f.w));
  expect(merged.actions).toHaveLength(2);
  expect(merged.actions![1]!.id).not.toBe(f.action.id);
  expect(merged.wheel![1]!.actionId).toBe(merged.actions![1]!.id);
  expect(merged.apps[2]!.blocks[1]!.rules[0]!.nodeId).toBe(
    merged.actions![1]!.id,
  );
  expect(merged.actions![1]!.rules[0]!.appId).toBe(merged.apps[3]!.id);
  f.w.wheel = [
    {
      id: uid(),
      name: "Go to app",
      parent: "",
      appId: f.destination.id,
      kind: "app",
    },
  ];
  const upgraded = parseWorkspace(f.w);
  expect(upgraded.wheel![0]!.name).toBe("Open Receiver");
  expect(upgraded.wheel![0]!.kind).toBe("action");
  expect(upgraded.actions!.at(-1)!.rules[0]!.action).toBe("navigate");
});

test("workspace graph groups remain reusable and forward named inputs", async ({
  page,
}) => {
  const f = fixture();
  await load(page, f.w);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Action library", exact: true })
    .click();
  await expect(page.locator(".action-studio .node-workspace")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await page
    .locator(`.vue-flow__node[data-id="${f.action.rules[0]!.id}"] .node-drag`)
    .click();
  await page.keyboard.down("Shift");
  await page
    .locator(`.vue-flow__node[data-id="${f.action.rules[1]!.id}"] .node-drag`)
    .click();
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await expect(page.locator(".vue-flow__node")).toHaveCount(2);
  await page.getByLabel("Test input task").fill("Grouped payload");
  await page.getByRole("button", { name: "Run action", exact: true }).click();
  await expect
    .poll(
      async () => (await readStored(page)).apps[1]?.blocks[0]?.items[0]?.text,
    )
    .toBe("Grouped payload");
  await expect
    .poll(async () => (await readStored(page)).actions?.length)
    .toBe(2);
});

test("explicit failure path recovers without running the success branch", async ({
  page,
}) => {
  const f = fixture();
  f.destination.exposed = false;
  const update = f.action.rules[0]!,
    navigation = f.action.rules[1]!;
  const recovery = f.rule("message", "", "Receiver must expose its interface.");
  f.action.rules.push(recovery);
  f.action.graph = {
    positions: {},
    edges: [
      { id: uid(), source: "trigger", target: update.id },
      { id: uid(), source: update.id, target: navigation.id },
      { id: uid(), source: update.id, target: recovery.id, on: "failure" },
    ],
  };
  await load(page, f.w);
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  await expect(page.locator(".action-notice")).toContainText(
    "Receiver must expose its interface.",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".dock-tab.active")).not.toContainText("Receiver");
});
