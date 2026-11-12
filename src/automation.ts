import { z } from "zod";
import {
  emptyWorkspace,
  appMinimum,
  flatten,
  makeBlock,
  uid,
  type Block,
  type CanvasApp,
  type Rule,
  type Workspace,
} from "./model";
import {
  appPatchSchema,
  graphSchema,
  parseWorkspace,
  ruleSchema,
} from "./validation";
import { mergeWorkspace } from "./imports";

const id = z.string().min(1).max(200);
const kind = z.enum([
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
  "netsuite",
  "certificates",
  "claude",
]);
const componentPatch = z
  .object({
    label: z.string(),
    value: z.string(),
    checked: z.boolean(),
    count: z.number().finite(),
    items: z
      .array(z.object({ id, text: z.string(), done: z.boolean() }))
      .max(10000),
    layout: z.enum(["column", "row", "grid"]),
    gap: z.number().finite().min(0),
    code: z.string(),
    height: z.number().finite().positive(),
    sizing: z.enum(["fill", "fixed"]),
    gitWorkspaceId: id,
  })
  .partial()
  .strict();
const target = { appId: id };
const componentTarget = { ...target, componentId: id };
export const operationSchemas = {
  workspace_get: z.object({}).strict(),
  app_list: z
    .object({
      includeArchived: z.boolean().optional(),
      includeDeleted: z.boolean().optional(),
    })
    .strict(),
  app_get: z.object(target).strict(),
  app_focus: z.object(target).strict(),
  app_create: z
    .object({ id: id.optional(), properties: appPatchSchema.optional() })
    .strict(),
  app_update: z.object({ ...target, patch: appPatchSchema }).strict(),
  app_duplicate: z.object({ ...target, name: z.string().optional() }).strict(),
  app_archive: z
    .object({ ...target, acknowledgeDependencies: z.boolean().optional() })
    .strict(),
  app_delete: z
    .object({ ...target, acknowledgeDependencies: z.boolean().optional() })
    .strict(),
  app_restore: z.object(target).strict(),
  component_create: z
    .object({
      ...target,
      id: id.optional(),
      kind,
      parentId: id.optional(),
      index: z.number().int().min(0).optional(),
      properties: componentPatch.optional(),
    })
    .strict(),
  component_update: z
    .object({ ...componentTarget, patch: componentPatch })
    .strict(),
  component_get: z.object(componentTarget).strict(),
  component_move: z
    .object({
      ...componentTarget,
      parentId: id.nullable().optional(),
      index: z.number().int().min(0).optional(),
    })
    .strict(),
  component_delete: z
    .object({
      ...componentTarget,
      disconnectReferences: z.boolean().optional(),
    })
    .strict(),
  rules_set: z
    .object({
      ...componentTarget,
      rules: z.array(ruleSchema).max(500),
      graph: graphSchema.nullable().optional(),
    })
    .strict(),
  action_list: z.object({}).strict(),
  action_set: z
    .object({
      id: id.optional(),
      name: z.string().min(1),
      mode: z.enum(["code", "flow"]),
      code: z.string().optional(),
      rules: z.array(ruleSchema).optional(),
      graph: graphSchema.nullable().optional(),
    })
    .strict(),
  action_delete: z
    .object({ actionId: id, disconnectReferences: z.boolean().optional() })
    .strict(),
  group_list: z.object({}).strict(),
  group_create: z
    .object({ id: id.optional(), name: z.string().min(1) })
    .strict(),
  group_update: z.object({ groupId: id, name: z.string().min(1) }).strict(),
  group_assign: z.object({ ...target, groupId: id.nullable() }).strict(),
  group_delete: z.object({ groupId: id }).strict(),
  workspace_import: z
    .object({ workspace: z.unknown(), mode: z.enum(["merge", "replace"]) })
    .strict(),
} as const;
export type Operation = keyof typeof operationSchemas;
export const readOperations = new Set<Operation>([
  "workspace_get",
  "app_list",
  "app_get",
  "app_focus",
  "component_get",
  "action_list",
  "group_list",
]);
export const operationDescriptions: Record<Operation, string> = {
  workspace_get:
    "Read the full connected browser workspace, including apps, component trees, rules, reusable actions and groups.",
  app_list:
    "List app IDs, names, placement, sizes and lifecycle state. Archived/deleted apps are hidden unless requested.",
  app_get:
    "Read an app and its complete nested components. Use IDs returned by this tool to target edits.",
  app_focus:
    "Bring an existing app into view in the connected browser, fitting its dimensions to the canvas. Does not change app content or geometry. Use after creating an app.",
  app_create:
    "Create an independent blank app in the visible canvas. Optionally supply a stable unique ID and app properties.",
  app_update:
    "Patch app name, icon, geometry, appearance or exposed interface without replacing components or moving other apps.",
  app_duplicate:
    "Deep-copy an app, detach shared components, clone referenced actions, and remap internal references. Other apps stay in place.",
  app_archive:
    "Archive an app recoverably. Dependencies are returned on failure; acknowledgeDependencies must be true to pause connected apps.",
  app_delete:
    "Move an app to recoverable trash, keeping IDs and data. Dependencies require explicit acknowledgement. Never permanently deletes.",
  app_restore:
    "Restore an archived or trashed app with its original IDs, content, connections and position.",
  component_create:
    "Create a component in an app or nested layout container. kind=git creates the local Git viewer; properties.gitWorkspaceId links a saved git_workspace_list/add ID. kind=projects creates Projects Hub; properties.value is its absolute local projects root, or empty to choose it in the app. kind=notes creates the Notes workspace; properties.value is optional JSON {active, tabs} of page IDs from notes_data. kind=browser creates a web browser; properties.value is optional JSON {tabs:[{id,url}], active} with http(s) URLs. Return includes its ID. Optional IDs enable references within atomic batches.",
  component_update:
    "Patch component content, data, code or layout properties. This preserves IDs, children and existing rules. Use rules_set for behavior.",
  component_get:
    "Read one component, including its current data, nested children, rules and graph.",
  component_move:
    "Move/reorder a component within its app, optionally into/out of a container. Cycles are rejected. index is its position after removal.",
  component_delete:
    "Remove a component subtree. Rejects incoming dependencies unless disconnectReferences is true; a local snapshot allows recovery.",
  rules_set:
    'Atomically replace a component action list and optional graph. Supply unique rule IDs; local targets use appId="". Omitting graph selects sequential rules. Supports explicit failure edges and nested rule.flow.',
  action_list: "Read reusable code actions and grouped action flows.",
  action_set:
    "Create or replace a reusable action. mode=code requires code; mode=flow requires rules. Supplying an existing ID updates that action. Code is stored, never evaluated by the MCP process.",
  action_delete:
    "Delete a reusable action. Rejects callers unless disconnectReferences is explicitly true. Snapshots allow recovery.",
  group_list: "List spatial groups and their member app IDs.",
  group_create: "Create a named spatial group without moving any apps.",
  group_update:
    "Rename a spatial group and update membership labels, preserving all geometry.",
  group_assign:
    "Assign an app to an existing group; null removes membership without moving it.",
  group_delete:
    "Delete a spatial group and clear its memberships, preserving the apps and their geometry.",
  workspace_import:
    "Validate and explicitly Merge or Replace a workspace. Merge remaps IDs and preserves existing placement/order. Every mutation retains a local recovery snapshot.",
};
export interface Command {
  operation: Operation;
  args: unknown;
}
export const commandSchema = z
  .object({
    operation: z.enum(
      Object.keys(operationSchemas) as [Operation, ...Operation[]],
    ),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export const batchSchema = z.array(commandSchema).min(1).max(100);
export function parseCommand(command: Command): Command {
  return {
    operation: command.operation,
    args: operationSchemas[command.operation].parse(command.args),
  };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function getApp(w: Workspace, appId: string) {
  const app = w.apps.find((a) => a.id === appId);
  if (!app) throw Error(`App ${appId} does not exist.`);
  return app;
}
function getBlock(app: CanvasApp, id: string) {
  const block = flatten(app.blocks).find((b) => b.id === id);
  if (!block)
    throw Error(`Component ${id} does not exist in ${app.name || app.id}.`);
  return block;
}
function childList(app: CanvasApp, parentId?: string | null) {
  if (!parentId) return app.blocks;
  const block = getBlock(app, parentId);
  if (block.kind !== "container")
    throw Error("Only a Layout/container component can contain children.");
  return block.children;
}
function removeBlock(blocks: Block[], id: string): Block | undefined {
  const index = blocks.findIndex((b) => b.id === id);
  if (index >= 0) return blocks.splice(index, 1)[0];
  for (const block of blocks) {
    const found = removeBlock(block.children, id);
    if (found) return found;
  }
}
function insert(blocks: Block[], block: Block, index?: number) {
  if (index !== undefined && index > blocks.length)
    throw Error("Component index exceeds the destination length.");
  blocks.splice(index ?? blocks.length, 0, block);
}
function ruleCollections(
  w: Workspace,
): { owner: string; rules: Rule[]; graph?: Block["graph"] }[] {
  const result: { owner: string; rules: Rule[]; graph?: Block["graph"] }[] = [];
  function add(
    owner: string,
    source: { rules: Rule[]; graph?: Block["graph"] },
  ) {
    result.push({
      get rules() {
        return source.rules;
      },
      set rules(v) {
        source.rules = v;
      },
      owner,
      graph: source.graph,
    });
    source.rules.forEach((r) => {
      if (r.flow) add(owner, r.flow);
    });
  }
  w.apps.forEach((a) => flatten(a.blocks).forEach((b) => add(a.id, b)));
  w.customNodes.forEach((n) => {
    if (n.rules) add("", n as { rules: Rule[]; graph?: Block["graph"] });
  });
  w.library.forEach((l) => flatten([l.block]).forEach((b) => add("", b)));
  return result;
}
function pruneRules(
  w: Workspace,
  matches: (rule: Rule, owner: string) => boolean,
  disconnect: boolean,
) {
  const impacted = ruleCollections(w).filter((c) =>
    c.rules.some((r) => matches(r, c.owner)),
  );
  if (impacted.length && !disconnect)
    throw Error(
      `This is referenced by ${impacted.length} action flow(s). Read the workspace and pass disconnectReferences=true to deliberately remove those rules.`,
    );
  impacted.forEach((c) => {
    const removed = new Set(
      c.rules.filter((r) => matches(r, c.owner)).map((r) => r.id),
    );
    c.rules = c.rules.filter((r) => !removed.has(r.id));
    if (c.graph) {
      c.graph.edges = c.graph.edges.filter(
        (e) => !removed.has(e.source) && !removed.has(e.target),
      );
      removed.forEach((id) => delete c.graph!.positions[id]);
    }
  });
}
function dependencies(w: Workspace, appId: string) {
  return [
    ...new Set(
      ruleCollections(w)
        .filter(
          (c) => c.owner !== appId && c.rules.some((r) => r.appId === appId),
        )
        .map((c) => c.owner || "Reusable action/library"),
    ),
  ];
}
function assertNoActionCycles(w: Workspace) {
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id))
      throw Error("Reusable actions cannot recursively call themselves.");
    if (done.has(id)) return;
    visiting.add(id);
    function rules(list: Rule[]) {
      list.forEach((r) => {
        if (r.flow) rules(r.flow.rules);
        else if (r.action === "custom" && r.nodeId) visit(r.nodeId);
      });
    }
    rules(w.customNodes.find((n) => n.id === id)?.rules || []);
    visiting.delete(id);
    done.add(id);
  }
  w.customNodes.forEach((n) => visit(n.id));
}
export function duplicateApp(w: Workspace, app: CanvasApp, name?: string) {
  const incoming = emptyWorkspace();
  incoming.apps = [clone(app)];
  const needed = new Set<string>();
  function gather(rules: Rule[]) {
    rules.forEach((r) => {
      if (r.flow) gather(r.flow.rules);
      if (r.nodeId && !needed.has(r.nodeId)) {
        needed.add(r.nodeId);
        gather(w.customNodes.find((n) => n.id === r.nodeId)?.rules || []);
      }
    });
  }
  flatten(app.blocks).forEach((b) => gather(b.rules));
  incoming.customNodes = clone(w.customNodes.filter((n) => needed.has(n.id)));
  const merged = mergeWorkspace(w, incoming),
    copy = merged.apps.at(-1)!;
  function external(source: Rule[], target: Rule[]) {
    source.forEach((r, i) => {
      if (r.appId && r.appId !== app.id) {
        target[i]!.appId = r.appId;
        target[i]!.target = r.target;
      }
      if (r.flow) external(r.flow.rules, target[i]!.flow!.rules);
    });
  }
  const blocks = flatten(copy.blocks);
  flatten(app.blocks).forEach((b, i) => {
    external(b.rules, blocks[i]!.rules);
    delete blocks[i]!.sharedId;
  });
  incoming.customNodes.forEach((n, i) =>
    external(
      n.rules || [],
      merged.customNodes[w.customNodes.length + i]!.rules || [],
    ),
  );
  copy.name = name ?? `${app.name || "Untitled"} copy`;
  copy.x += 32;
  copy.y += 32;
  copy.archived = false;
  copy.deleted = false;
  copy.groupId = app.groupId;
  w.apps.push(copy);
  w.customNodes = merged.customNodes;
  return copy;
}
export function applyCommands(
  input: Workspace,
  commands: Command[],
  placement?: Pick<CanvasApp, "x" | "y" | "width" | "height">,
) {
  let w = clone(input);
  const results: unknown[] = [];
  for (const raw of commands) {
    const parsed = parseCommand(raw);
    // Each discriminant is re-parsed below so TypeScript infers the exact input.
    const args = parsed.args;
    switch (parsed.operation) {
      case "workspace_get":
        results.push(clone(w));
        break;
      case "app_list": {
        const p = operationSchemas.app_list.parse(args);
        results.push(
          w.apps
            .filter(
              (a) =>
                (!a.deleted || p.includeDeleted) &&
                (!a.archived || a.deleted || p.includeArchived),
            )
            .map(({ blocks, ...a }) => ({
              ...a,
              componentCount: flatten(blocks).length,
            })),
        );
        break;
      }
      case "app_get":
        results.push(
          clone(getApp(w, operationSchemas.app_get.parse(args).appId)),
        );
        break;
      case "app_focus": {
        const app = getApp(w, operationSchemas.app_focus.parse(args).appId);
        if (app.archived || app.deleted)
          throw Error("Restore this app before navigating to it.");
        results.push({ appId: app.id });
        break;
      }
      case "app_create": {
        const p = operationSchemas.app_create.parse(args);
        const a: CanvasApp = {
          id: p.id || uid(),
          name: "Untitled",
          icon: "app",
          x: 140,
          y: 140,
          width: 600,
          height: 440,
          ...placement,
          blocks: [],
          archived: false,
          group: "",
          exposed: false,
          accent: "#6f8998",
          padding: 26,
          gap: 18,
          radius: 8,
          ...p.properties,
        };
        if (w.apps.some((a) => a.id === p.id))
          throw Error("App ID already exists.");
        w.apps.push(a);
        results.push(clone(a));
        break;
      }
      case "app_update": {
        const p = operationSchemas.app_update.parse(args);
        const app = Object.assign(getApp(w, p.appId), p.patch);
        const minimum = appMinimum(app);
        app.width = Math.max(app.width, minimum.width);
        app.height = Math.max(app.height, minimum.height);
        results.push(clone(app));
        break;
      }
      case "app_duplicate": {
        const p = operationSchemas.app_duplicate.parse(args);
        results.push(clone(duplicateApp(w, getApp(w, p.appId), p.name)));
        break;
      }
      case "app_archive":
      case "app_delete": {
        const p = operationSchemas.app_archive.parse(args),
          a = getApp(w, p.appId),
          deps = dependencies(w, p.appId);
        if (deps.length && !p.acknowledgeDependencies)
          throw Error(
            `Connected flows will pause: ${deps.join(", ")}. Read these dependencies and pass acknowledgeDependencies=true to continue.`,
          );
        a.archived = true;
        a.deleted = parsed.operation === "app_delete";
        results.push({ app: clone(a), dependencies: deps });
        break;
      }
      case "app_restore": {
        const p = operationSchemas.app_restore.parse(args),
          a = getApp(w, p.appId);
        a.archived = false;
        a.deleted = false;
        results.push(clone(a));
        break;
      }
      case "component_create": {
        const p = operationSchemas.component_create.parse(args),
          a = getApp(w, p.appId),
          b = Object.assign(makeBlock(p.kind), p.properties);
        if (p.id) b.id = p.id;
        if (
          w.apps.some((a) =>
            flatten(a.blocks).some((other) => other.id === b.id),
          )
        )
          throw Error("Component ID already exists.");
        insert(childList(a, p.parentId), b, p.index);
        results.push(clone(b));
        break;
      }
      case "component_update": {
        const p = operationSchemas.component_update.parse(args);
        results.push(
          clone(
            Object.assign(getBlock(getApp(w, p.appId), p.componentId), p.patch),
          ),
        );
        break;
      }
      case "component_get": {
        const p = operationSchemas.component_get.parse(args);
        results.push(clone(getBlock(getApp(w, p.appId), p.componentId)));
        break;
      }
      case "component_move": {
        const p = operationSchemas.component_move.parse(args),
          a = getApp(w, p.appId),
          b = getBlock(a, p.componentId);
        if (p.parentId && flatten([b]).some((child) => child.id === p.parentId))
          throw Error(
            "A component cannot be moved inside itself or its descendants.",
          );
        const list = childList(a, p.parentId);
        removeBlock(a.blocks, b.id);
        insert(list, b, p.index);
        results.push(clone(b));
        break;
      }
      case "component_delete": {
        const p = operationSchemas.component_delete.parse(args),
          a = getApp(w, p.appId),
          b = getBlock(a, p.componentId),
          ids = new Set(flatten([b]).map((c) => c.id));
        removeBlock(a.blocks, b.id);
        pruneRules(
          w,
          (r, owner) =>
            r.action !== "custom" &&
            !r.flow &&
            ids.has(r.target) &&
            (r.appId === a.id || (!r.appId && (!owner || owner === a.id))),
          !!p.disconnectReferences,
        );
        results.push({ deletedComponentIds: [...ids] });
        break;
      }
      case "rules_set": {
        const p = operationSchemas.rules_set.parse(args),
          b = getBlock(getApp(w, p.appId), p.componentId);
        b.rules = clone(p.rules);
        if (p.graph) b.graph = clone(p.graph);
        else delete b.graph;
        results.push({
          componentId: b.id,
          rules: clone(b.rules),
          graph: b.graph,
        });
        break;
      }
      case "action_list":
        results.push(clone(w.customNodes));
        break;
      case "action_set": {
        const p = operationSchemas.action_set.parse(args);
        if (
          (p.mode === "code" && p.code === undefined) ||
          (p.mode === "flow" && !p.rules)
        )
          throw Error("Code mode requires code; flow mode requires rules.");
        const node = {
          id: p.id || uid(),
          name: p.name,
          code: p.mode === "code" ? p.code! : "",
          ...(p.mode === "flow"
            ? {
                rules: clone(p.rules!),
                ...(p.graph ? { graph: clone(p.graph) } : {}),
              }
            : {}),
        };
        const i = w.customNodes.findIndex((n) => n.id === node.id);
        if (i < 0) w.customNodes.push(node);
        else w.customNodes.splice(i, 1, node);
        results.push(clone(node));
        break;
      }
      case "action_delete": {
        const p = operationSchemas.action_delete.parse(args);
        if (!w.customNodes.some((n) => n.id === p.actionId))
          throw Error("Reusable action does not exist.");
        pruneRules(
          w,
          (r) => r.action === "custom" && r.nodeId === p.actionId,
          !!p.disconnectReferences,
        );
        w.customNodes = w.customNodes.filter((n) => n.id !== p.actionId);
        results.push({ deletedActionId: p.actionId });
        break;
      }
      case "group_list":
        results.push(
          (w.groups || []).map((g) => ({
            ...g,
            appIds: w.apps.filter((a) => a.groupId === g.id).map((a) => a.id),
          })),
        );
        break;
      case "group_create": {
        const p = operationSchemas.group_create.parse(args),
          g = { id: p.id || uid(), name: p.name };
        w.groups ||= [];
        if (w.groups.some((other) => other.id === g.id))
          throw Error("Group ID already exists.");
        w.groups.push(g);
        results.push(clone(g));
        break;
      }
      case "group_update": {
        const p = operationSchemas.group_update.parse(args),
          g = w.groups?.find((g) => g.id === p.groupId);
        if (!g) throw Error("Group does not exist.");
        g.name = p.name;
        w.apps
          .filter((a) => a.groupId === g.id)
          .forEach((a) => (a.group = g.name));
        results.push(clone(g));
        break;
      }
      case "group_assign": {
        const p = operationSchemas.group_assign.parse(args),
          a = getApp(w, p.appId),
          g = w.groups?.find((g) => g.id === p.groupId);
        if (p.groupId && !g) throw Error("Group does not exist.");
        a.groupId = g?.id;
        a.group = g?.name || "";
        results.push(clone(a));
        break;
      }
      case "group_delete": {
        const p = operationSchemas.group_delete.parse(args);
        if (!w.groups?.some((g) => g.id === p.groupId))
          throw Error("Group does not exist.");
        w.groups = w.groups.filter((g) => g.id !== p.groupId);
        w.apps
          .filter((a) => a.groupId === p.groupId)
          .forEach((a) => {
            delete a.groupId;
            a.group = "";
          });
        results.push({ deletedGroupId: p.groupId });
        break;
      }
      case "workspace_import": {
        const p = operationSchemas.workspace_import.parse(args),
          incoming = parseWorkspace(p.workspace);
        w = p.mode === "merge" ? mergeWorkspace(w, incoming) : incoming;
        results.push({ mode: p.mode, appIds: w.apps.map((a) => a.id) });
        break;
      }
    }
  }
  const changed = commands.some((c) => !readOperations.has(c.operation));
  if (changed) {
    w = parseWorkspace(w);
    // Existing unfinished UI rules may already have unresolved references. Never
    // introduce a new one, or let an import hide a broken connection.
    const previous = new Set(invalidReferences(input)),
      issues = invalidReferences(w);
    if (
      issues.some((issue) => !previous.has(issue)) ||
      (commands.some((c) => c.operation === "workspace_import") &&
        issues.length)
    )
      throw Error(`Invalid action references: ${issues.join("; ")}`);
    assertNoActionCycles(w);
  }
  return { workspace: w, results, changed };
}
function invalidReferences(w: Workspace) {
  const issues: string[] = [];
  for (const collection of ruleCollections(w))
    for (const rule of collection.rules) {
      if (rule.flow) continue;
      if (rule.action === "message") continue;
      if (rule.action === "workspace-action") {
        if (!w.actions?.some((a) => a.id === rule.nodeId))
          issues.push(
            `rule ${rule.id}: workspace action ${rule.nodeId || "(missing)"}`,
          );
        continue;
      }
      if (rule.action === "navigate" || rule.action === "open-view") {
        const app = w.apps.find((a) => a.id === rule.appId);
        if (!app) issues.push(`rule ${rule.id}: destination app ${rule.appId}`);
        else if (
          rule.action === "open-view" &&
          rule.view === "graph" &&
          !flatten(app.blocks).some((b) => b.id === rule.target)
        )
          issues.push(`rule ${rule.id}: component ${rule.target}`);
        continue;
      }
      if (rule.action === "custom") {
        if (!rule.nodeId || !w.customNodes.some((n) => n.id === rule.nodeId))
          issues.push(
            `rule ${rule.id}: reusable action ${rule.nodeId || "(missing)"}`,
          );
      } else {
        const appId = rule.appId || collection.owner;
        const app = w.apps.find((a) => a.id === appId);
        const candidates = app
          ? flatten(app.blocks)
          : !appId
            ? w.apps.flatMap((a) => flatten(a.blocks))
            : [];
        if (!rule.target || !candidates.some((b) => b.id === rule.target))
          issues.push(
            `rule ${rule.id}: component ${rule.target || "(missing)"} in ${appId || "calling app"}`,
          );
      }
    }
  return issues;
}
