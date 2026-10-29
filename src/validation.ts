import { z } from "zod";
import {
  flatten,
  appMinimum,
  type Workspace,
  type Block,
  type Rule,
  type ActionGraph,
} from "./model";

const id = z.string().min(1).max(200);
const number = z.number().finite();
const rule: z.ZodType<Rule> = z.lazy(() =>
  z.object({
    id,
    action: z.enum([
      "add-item",
      "clear",
      "increment",
      "toggle",
      "set-text",
      "emit",
      "custom",
      "workspace-action",
      "navigate",
      "open-view",
      "read-field",
      "message",
    ]),
    target: z.string(),
    appId: z.string(),
    value: z.string(),
    nodeId: id.optional(),
    bindings: z.record(z.string(), z.string()).optional(),
    view: z.enum(["settings", "graph"]).optional(),
    flow: z
      .object({ rules: z.array(rule).max(500), graph: graph.optional() })
      .optional(),
  }),
);
const graph: z.ZodType<ActionGraph> = z.object({
  edges: z
    .array(
      z.object({
        id,
        source: id,
        target: id,
        on: z.enum(["success", "failure"]).optional(),
      }),
    )
    .max(20000),
  positions: z.record(z.string(), z.object({ x: number, y: number })),
});
const block: z.ZodType<Block> = z.lazy(() =>
  z.object({
    id,
    kind: z.enum([
      "text",
      "input",
      "button",
      "checkbox",
      "list",
      "counter",
      "divider",
      "container",
      "code",
      "git",
      "projects",
      "notes",
      "browser",
    ]),
    label: z.string(),
    value: z.string(),
    checked: z.boolean(),
    items: z
      .array(z.object({ id, text: z.string(), done: z.boolean() }))
      .max(10000),
    count: number,
    layout: z.enum(["column", "row", "grid"]),
    gap: number.min(0),
    children: z.array(block),
    rules: z.array(rule).max(500),
    sharedId: id.optional(),
    code: z.string(),
    height: number.positive().optional(),
    sizing: z.enum(["fill", "fixed"]).optional(),
    graph: graph.optional(),
    gitWorkspaceId: id.optional(),
  }),
);
const schema = z.object({
  version: z.literal(1),
  apps: z
    .array(
      z.object({
        id,
        name: z.string(),
        icon: z.string(),
        x: number,
        y: number,
        width: number.min(180),
        height: number.min(160),
        minWidth: number.min(180).optional(),
        minHeight: number.min(160).optional(),
        blocks: z.array(block),
        archived: z.boolean(),
        deleted: z.boolean().optional(),
        group: z.string(),
        groupId: z.string().optional(),
        exposed: z.boolean(),
        accent: z.string().regex(/^#[\da-f]{6}$/i),
        padding: number.min(0),
        gap: number.min(0),
        radius: number.min(0),
        showName: z.boolean().optional(),
        breakpoint: number.positive().optional(),
        editorWidth: number.positive().optional(),
      }),
    )
    .max(300),
  library: z.array(z.object({ id, name: z.string(), block })),
  customNodes: z.array(
    z.object({
      id,
      name: z.string(),
      code: z.string(),
      rules: z.array(rule).optional(),
      graph: graph.optional(),
    }),
  ),
  shortcuts: z.object({
    create: z.string().regex(/^[a-z0-9]$/i),
    search: z.string().regex(/^[a-z0-9]$/i),
    home: z.string().regex(/^[a-z0-9]$/i),
  }),
  groups: z.array(z.object({ id, name: z.string() })).optional(),
  wheel: z
    .array(
      z.object({
        id,
        parent: z.string(),
        name: z.string(),
        kind: z.enum(["group", "app", "action"]),
        appId: z.string(),
        actionId: id.optional(),
        bindings: z.record(z.string(), z.string()).optional(),
      }),
    )
    .max(500)
    .optional(),
  actions: z
    .array(
      z.object({
        id,
        name: z.string(),
        icon: z.string(),
        inputs: z.array(id).max(50),
        rules: z.array(rule).max(500),
        graph: graph.optional(),
      }),
    )
    .max(500)
    .optional(),
});
export const appPatchSchema = schema.shape.apps.element
  .omit({
    id: true,
    blocks: true,
    archived: true,
    deleted: true,
    group: true,
    groupId: true,
  })
  .partial()
  .strict();
export { rule as ruleSchema, graph as graphSchema };
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw Error("This backup contains duplicate IDs.");
}
function checkFlow(rules: Rule[], value?: ActionGraph, depth = 0) {
  if (rules.some((rule) => rule.id === "trigger"))
    throw Error('The rule ID "trigger" is reserved for the graph trigger.');
  if (depth > 16)
    throw Error("This backup contains excessively nested action flows.");
  unique(rules.map((r) => r.id));
  rules.forEach((r) => {
    if (r.flow) checkFlow(r.flow.rules, r.flow.graph, depth + 1);
  });
  if (!value) return;
  unique(value.edges.map((e) => e.id));
  const ids = new Set(["trigger", ...rules.map((r) => r.id)]);
  if (
    value.edges.some(
      (e) => !ids.has(e.source) || !ids.has(e.target) || e.target === "trigger",
    )
  )
    throw Error(
      "This backup contains an invalid graph connection or position.",
    );
  // Earlier group editors retained layout positions of nodes moved into a
  // reusable group. They carry no behavior; drop that obsolete layout metadata.
  value.positions = Object.fromEntries(
    Object.entries(value.positions).filter(([key]) => ids.has(key)),
  );
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw Error("This backup contains a graph loop.");
    if (done.has(key)) return;
    visiting.add(key);
    value!.edges
      .filter((e) => e.source === key)
      .forEach((e) => visit(e.target));
    visiting.delete(key);
    done.add(key);
  }
  ids.forEach(visit);
}
export function parseWorkspace(input: unknown): Workspace {
  // Bound nesting before recursive schema parsing or flattening touches untrusted
  // input. Backup files can be valid JSON while exhausting the JS call stack.
  const pending: { value: unknown; depth: number }[] = [
    { value: input, depth: 0 },
  ];
  let objects = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    if (++objects > 200000 || depth > 60)
      throw Error(
        "This backup is too deeply nested or contains too many records.",
      );
    for (const item of Object.values(value))
      pending.push({ value: item, depth: depth + 1 });
  }
  if (JSON.stringify(input).length > 25_000_000)
    throw Error("This backup is too large (maximum 25 MB).");
  if (
    input &&
    typeof input === "object" &&
    "version" in input &&
    input.version !== 1
  )
    throw Error(
      "This workspace format is unsupported. Open it with the version that created it; your saved data has been kept.",
    );
  const result = schema.safeParse(input);
  if (!result.success)
    throw Error(
      "This file is not a valid Orvane workspace. Check its fields and format.",
    );
  const w = result.data;
  for (const app of w.apps) {
    const minimum = appMinimum(app);
    app.width = Math.max(app.width, minimum.width);
    app.height = Math.max(app.height, minimum.height);
  }
  // Upgrade navigation-only wheel entries to shared actions without changing IDs
  // used by wheel groups or removing any existing action definitions.
  for (const entry of w.wheel || []) {
    if (entry.kind !== "app") continue;
    w.actions ||= [];
    const actionId = crypto.randomUUID();
    const app = w.apps.find((a) => a.id === entry.appId);
    const name =
      entry.name === "Go to app" ? `Open ${app?.name || "app"}` : entry.name;
    w.actions.push({
      id: actionId,
      name,
      icon: app?.icon || "arrow",
      inputs: [],
      rules: [
        {
          id: crypto.randomUUID(),
          action: "navigate",
          appId: entry.appId,
          target: "",
          value: "",
        },
      ],
    });
    entry.kind = "action";
    entry.actionId = actionId;
    entry.name = name;
  }
  unique(w.apps.map((a) => a.id));
  unique(w.customNodes.map((n) => n.id));
  unique(w.library.map((l) => l.id));
  unique((w.groups || []).map((g) => g.id));
  unique((w.wheel || []).map((entry) => entry.id));
  unique((w.actions || []).map((action) => action.id));
  (w.actions || []).forEach((action) => {
    unique(action.inputs);
    checkFlow(action.rules, action.graph);
  });
  const blocks = w.apps.flatMap((a) => flatten(a.blocks));
  if (blocks.length > 10000)
    throw Error("This backup contains too many components.");
  unique(blocks.map((b) => b.id));
  [...blocks, ...w.library.flatMap((l) => flatten([l.block]))].forEach((b) => {
    unique(b.items.map((i) => i.id));
    checkFlow(b.rules, b.graph);
  });
  w.customNodes.forEach((n) => checkFlow(n.rules || [], n.graph));
  if (new Set(Object.values(w.shortcuts)).size !== 3)
    throw Error("Workspace shortcuts must be distinct.");
  return w;
}
export function referenceIssues(w: Workspace): string[] {
  const issues = new Set<string>();
  function inspect(rules: Rule[], owner?: string) {
    rules.forEach((r) => {
      if (r.flow) {
        inspect(r.flow.rules, owner);
        return;
      }
      if (r.action === "workspace-action") {
        if (!w.actions?.some((a) => a.id === r.nodeId))
          issues.add("A workspace action is missing.");
      } else if (r.action === "navigate" || r.action === "open-view") {
        if (!w.apps.some((a) => a.id === r.appId))
          issues.add("An action destination app is missing.");
      } else if (r.action === "custom") {
        if (r.nodeId && !w.customNodes.some((n) => n.id === r.nodeId))
          issues.add("A reusable action is missing.");
      } else if (r.target) {
        const app = w.apps.find((a) => a.id === (r.appId || owner));
        if (r.appId && !app) issues.add("A connected app is missing.");
        else if (app && !flatten(app.blocks).some((b) => b.id === r.target))
          issues.add("A connected component is missing.");
      }
    });
  }
  w.apps.forEach((a) =>
    flatten(a.blocks).forEach((b) => inspect(b.rules, a.id)),
  );
  w.customNodes.forEach((n) => inspect(n.rules || []));
  w.actions?.forEach((a) => inspect(a.rules));
  return [...issues];
}
