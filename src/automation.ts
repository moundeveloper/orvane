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
  type WorkspaceAction,
} from "./model";
import {
  appPatchSchema,
  graphSchema,
  parseWorkspace,
  ruleSchema,
} from "./validation";
import { mergeWorkspace } from "./imports";
import { BOARD_COLORS, ensureBoard, NOTE_COLORS } from "./board";
import { readRecordPreview } from "./netsuiteCanvas";

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
  "uimaker",
  "browser",
  "netsuite",
  "certificates",
  "claude",
  "netsuite-record",
  "browser-clip",
  "folder-compare",
  "test-results",
  "files",
  "image",
  "file",
  "calendar",
  "terminal",
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
const stepKinds = [
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
] as const;
// One workflow step. IDs are generated when left out.
const stepSchema = z
  .object({
    id: id.optional(),
    action: z.enum(stepKinds),
    appId: z.string().default(""),
    target: z.string().default(""),
    value: z.string().default(""),
    nodeId: id.optional(),
    bindings: z.record(z.string(), z.string()).optional(),
    view: z.enum(["settings", "graph"]).optional(),
  })
  .strict();
const hex = z.string().regex(/^#[\da-f]{6}$/i, "Colors are #rrggbb.");
const boardEndInput = z
  .object({ appId: id.optional(), noteId: id.optional(), x: z.number().finite().optional(), y: z.number().finite().optional() })
  .strict()
  .refine(
    (e) => [e.appId, e.noteId, e.x !== undefined && e.y !== undefined ? 1 : undefined].filter(Boolean).length === 1,
    "An arrow end is one of: {appId}, {noteId} or {x, y}.",
  );
const wheelEntryInput = z
  .object({
    id: id.optional(),
    parent: z.string().default(""),
    name: z.string().min(1).max(80),
    kind: z.enum(["group", "app", "action"]),
    appId: z.string().default(""),
    actionId: id.optional(),
    bindings: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const placeInput = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().min(180),
    height: z.number().finite().min(160),
    shown: z.boolean().default(true),
  })
  .strict();
const scheduleInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(1).max(10080) }).strict(),
  z
    .object({
      kind: z.literal("daily"),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time is local HH:MM, 24-hour."),
      days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    })
    .strict(),
]);
const inputName = z
  .string()
  .regex(/^[\w-]{1,80}$/, "Input names use letters, digits, - and _.");
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
  workflow_list: z.object({}).strict(),
  workflow_set: z
    .object({
      id: id.optional(),
      name: z.string().min(1).max(120),
      icon: z.string().min(1).max(40).default("action"),
      inputs: z.array(inputName).max(50).default([]),
      steps: z.array(stepSchema).min(1).max(200).optional(),
      rules: z.array(ruleSchema).max(500).optional(),
      graph: graphSchema.optional(),
    })
    .strict(),
  workflow_delete: z
    .object({ workflowId: id, disconnectReferences: z.boolean().optional() })
    .strict(),
  wheel_list: z.object({}).strict(),
  wheel_set: z.object({ entries: z.array(wheelEntryInput).max(500) }).strict(),
  layout_list: z.object({}).strict(),
  layout_delete: z.object({ layoutId: id }).strict(),
  board_get: z.object({}).strict(),
  board_note_set: z
    .object({
      id: id.optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      width: z.number().finite().min(60).max(4000).optional(),
      height: z.number().finite().min(40).max(4000).optional(),
      text: z.string().max(20000).optional(),
      color: hex.optional(),
      link: z
        .object({
          kind: z.enum(["file", "folder", "page"]),
          target: z.string().min(1).max(4000),
          label: z.string().max(300).default(""),
        })
        .strict()
        .nullable()
        .optional(),
    })
    .strict(),
  board_arrow_set: z
    .object({
      id: id.optional(),
      from: boardEndInput,
      to: boardEndInput,
      label: z.string().max(200).optional(),
      color: hex.optional(),
    })
    .strict(),
  board_delete: z.object({ ids: z.array(id).min(1).max(500) }).strict(),
  trigger_list: z.object({}).strict(),
  trigger_set: z
    .object({
      id: id.optional(),
      name: z.string().min(1).max(120),
      workflowId: id,
      inputs: z.record(z.string(), z.string()).default({}),
      enabled: z.boolean().default(true),
      schedule: scheduleInput,
    })
    .strict(),
  trigger_delete: z.object({ triggerId: id }).strict(),
} as const;
export type Operation = keyof typeof operationSchemas;
/** Runs something in the live editing window, the way a person would. */
export const runSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workflow"),
      workflowId: id,
      inputs: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal("component"),
      appId: id,
      componentId: id,
      value: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("runs") }).strict(),
  z
    .object({
      kind: z.literal("layout-save"),
      id: id.optional(),
      name: z.string().min(1).max(80),
      apps: z.record(id, placeInput).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("layout-apply"), layoutId: id }).strict(),
  z.object({ kind: z.literal("trigger-run"), triggerId: id }).strict(),
]);
export type RunRequest = z.infer<typeof runSchema>;
export const readOperations = new Set<Operation>([
  "workspace_get",
  "app_list",
  "app_get",
  "app_focus",
  "component_get",
  "action_list",
  "group_list",
  "workflow_list",
  "wheel_list",
  "layout_list",
  "board_get",
  "trigger_list",
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
    "Create a component in an app or nested layout container. kind=git creates the local Git viewer; properties.gitWorkspaceId links a saved git_workspace_list/add ID. kind=projects creates Projects Hub; properties.value is its absolute local projects root, or empty to choose it in the app. kind=notes creates the Notes workspace; properties.value is optional JSON {active, tabs} of page IDs from notes_data. kind=uimaker creates the UI Maker editor (its data is read and written with the uimaker_* tools); properties.value is optional JSON {c, v} for the open component and iteration. kind=browser creates a web browser; properties.value is optional JSON {tabs:[{id,url}], active} with http(s) URLs. Return includes its ID. Optional IDs enable references within atomic batches.",
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
  workflow_list:
    "List Action-library workflows (Workspace -> Action library): named automations with inputs and a node graph that buttons, the wheel and other workflows can run.",
  workflow_set:
    'Create or replace an Action-library workflow. Easiest: give steps, an ordered list run one after another (the graph trigger -> step 1 -> step 2 ... and node positions are generated). For branching or failure paths give rules plus graph instead (edges from "trigger", on="failure" for recovery). Inputs are names; steps use {input name} in value. Steps that change or read another app need that app exposed (app_update patch exposed=true). Call automation_catalog for every step kind and its fields. Returns the workflow and warnings.',
  workflow_delete:
    "Delete an Action-library workflow. Rejects while buttons, workflows, wheel entries or scheduled triggers use it unless disconnectReferences is true (which removes those triggers). Snapshots allow recovery.",
  wheel_list:
    "Read the radial wheel (opened with the wheel shortcut): entries with id, parent (\"\" = first ring, or a group entry's id), name and kind (group, app, action).",
  wheel_set:
    'Replace the whole radial wheel. kind=group holds other entries (their parent is its id); kind=app opens appId; kind=action runs Action-library workflow actionId with bindings {input: value}. Each ring holds at most 8 entries. Read wheel_list first and keep entries you are not changing.',
  layout_list:
    "List named layouts (saved arrangements of where apps sit and which are shown) and which one is active.",
  layout_delete: "Delete a named layout. Apps stay where they are.",
  board_get:
    "Read the canvas whiteboard: sticky notes (position, size, text, color, link) and arrows (ends attached to an app, a note or a point). Freehand strokes are only counted.",
  board_note_set:
    "Create or edit a sticky note on the canvas whiteboard. New notes need x and y (canvas coordinates; apps' x/y from app_list are in the same space); default size 200x160. Give an existing id to change only the fields you pass. link (file, folder or http(s) page) makes it open that target; null removes it.",
  board_arrow_set:
    "Create or replace an arrow on the canvas whiteboard. Each end is {appId}, {noteId} (it follows that item) or {x, y}. Optional label and #rrggbb color.",
  trigger_list:
    "List scheduled triggers: which workflow each runs, with what inputs, on what schedule, whether it is enabled, and its last run and last error.",
  trigger_set:
    'Create or replace a scheduled trigger that runs an Action-library workflow by itself: schedule {kind:"interval", minutes} or {kind:"daily", time:"HH:MM" local, days:[0=Sun..6]} (no days = every day). inputs must give every workflow input. Triggers run in the open Orvane window, also while it sits in the tray (up to about a minute late while hidden); a run missed while Orvane was closed runs once if due in the last day. enabled=false pauses it. Test with trigger_run.',
  trigger_delete: "Delete a scheduled trigger. The workflow stays.",
  board_delete: "Delete whiteboard notes, arrows or strokes by id. Arrows attached to a deleted note are deleted with it, as on the canvas.",
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
  includeWorkspaceActions = false,
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
  if (includeWorkspaceActions) w.actions?.forEach((action) => add("", action));
  return result;
}
function pruneRules(
  w: Workspace,
  matches: (rule: Rule, owner: string) => boolean,
  disconnect: boolean,
  includeWorkspaceActions = false,
) {
  const impacted = ruleCollections(w, includeWorkspaceActions).filter((c) =>
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
export function removeWorkspaceAction(workspace: Workspace, id: string) {
  const index = workspace.actions?.findIndex((action) => action.id === id) ?? -1;
  if (index < 0) return;
  workspace.actions!.splice(index, 1);
  pruneRules(workspace, (rule) => !rule.flow && rule.action === "workspace-action" && rule.nodeId === id, true, true);
  for (const entry of workspace.wheel ?? []) {
    if (entry.actionId !== id) continue;
    delete entry.actionId;
    entry.bindings = {};
  }
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
  const originalBlocks = flatten(app.blocks);
  originalBlocks.forEach((b, i) => {
    external(b.rules, blocks[i]!.rules);
    delete blocks[i]!.sharedId;
    if (b.kind === "netsuite-record") {
      const link = readRecordPreview(b.value);
      if (link && !originalBlocks.some((source) => source.id === link.sourceBlockId))
        blocks[i]!.value = b.value;
    }
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
      case "workflow_list":
        results.push(clone(w.actions || []));
        break;
      case "workflow_set": {
        const p = operationSchemas.workflow_set.parse(args);
        if (!p.steps === !p.rules)
          throw Error("Give either steps (a simple ordered list) or rules with an optional graph.");
        let rules: Rule[], graph: WorkspaceAction["graph"];
        if (p.steps) {
          rules = p.steps.map((step) => ({ ...step, id: step.id || uid() }));
          const ids = ["trigger", ...rules.map((r) => r.id)];
          graph = {
            edges: rules.map((r, i) => ({ id: uid(), source: ids[i]!, target: r.id })),
            positions: Object.fromEntries(
              ids.map((nodeId, i) => [nodeId, { x: 80 + i * 260, y: 120 }]),
            ),
          };
        } else {
          rules = clone(p.rules!);
          graph = p.graph ? clone(p.graph) : undefined;
        }
        const ruleIds = new Set(rules.map((r) => r.id));
        if (ruleIds.size !== rules.length) throw Error("Step IDs must be unique.");
        if (graph)
          for (const edge of graph.edges)
            for (const end of [edge.source, edge.target])
              if (end !== "trigger" && !ruleIds.has(end))
                throw Error(`Graph edge ${edge.id} points to missing step ${end}.`);
        const workflow: WorkspaceAction = {
          id: p.id || uid(),
          name: p.name,
          icon: p.icon,
          inputs: [...new Set(p.inputs)],
          rules,
          ...(graph ? { graph } : {}),
        };
        const warnings = workflowIssues(w, workflow);
        w.actions ||= [];
        const i = w.actions.findIndex((a) => a.id === workflow.id);
        if (i < 0) w.actions.push(workflow);
        else w.actions.splice(i, 1, workflow);
        results.push({ workflow: clone(workflow), warnings });
        break;
      }
      case "workflow_delete": {
        const p = operationSchemas.workflow_delete.parse(args);
        if (!w.actions?.some((a) => a.id === p.workflowId))
          throw Error(`Workflow ${p.workflowId} does not exist.`);
        const scheduled = (w.triggers || []).filter((t) => t.workflowId === p.workflowId);
        if (scheduled.length && !p.disconnectReferences)
          throw Error(
            `${scheduled.length} scheduled trigger(s) run this workflow. Pass disconnectReferences=true to delete them too.`,
          );
        w.triggers = (w.triggers || []).filter((t) => t.workflowId !== p.workflowId);
        const pinned = (w.wheel || []).filter((e) => e.actionId === p.workflowId);
        pruneRules(
          w,
          (r) => !r.flow && r.action === "workspace-action" && r.nodeId === p.workflowId,
          !!p.disconnectReferences,
          true,
        );
        if (pinned.length && !p.disconnectReferences)
          throw Error(
            `This workflow is pinned to the wheel ${pinned.length} time(s). Pass disconnectReferences=true to remove those entries.`,
          );
        w.wheel = (w.wheel || []).filter((e) => e.actionId !== p.workflowId);
        w.actions = w.actions.filter((a) => a.id !== p.workflowId);
        results.push({ deletedWorkflowId: p.workflowId });
        break;
      }
      case "wheel_list":
        results.push(clone(w.wheel || []));
        break;
      case "wheel_set": {
        const p = operationSchemas.wheel_set.parse(args);
        const entries = p.entries.map((e) => ({ ...e, id: e.id || uid() }));
        const byId = new Map(entries.map((e) => [e.id, e]));
        if (byId.size !== entries.length) throw Error("Wheel entry IDs must be unique.");
        const rings = new Map<string, number>();
        for (const e of entries) {
          const where = `wheel entry ${e.name} (${e.id})`;
          if (e.parent && byId.get(e.parent)?.kind !== "group")
            throw Error(`${where}: parent ${e.parent} is not a group entry.`);
          for (let at = e.parent, hops = 0; at; at = byId.get(at)?.parent || "", hops++)
            if (at === e.id || hops > entries.length) throw Error(`${where}: groups cannot contain themselves.`);
          rings.set(e.parent, (rings.get(e.parent) || 0) + 1);
          if (rings.get(e.parent)! > 8)
            throw Error(`A ring holds at most 8 entries; ${e.parent ? "group " + byId.get(e.parent)!.name : "the first ring"} has more. Add a group.`);
          if (e.kind === "app" && !w.apps.some((a) => a.id === e.appId && !a.deleted))
            throw Error(`${where}: app ${e.appId || "(missing appId)"} does not exist.`);
          if (e.kind === "action" && !w.actions?.some((a) => a.id === e.actionId))
            throw Error(`${where}: workflow ${e.actionId || "(missing actionId)"} does not exist. Call workflow_list.`);
          if (e.kind !== "action") delete e.actionId;
        }
        w.wheel = entries;
        results.push(clone(entries));
        break;
      }
      case "layout_list":
        results.push({
          active: w.activeLayout || null,
          layouts: (w.layouts || []).map((l) => ({
            id: l.id,
            name: l.name,
            apps: l.apps,
            camera: l.camera,
          })),
        });
        break;
      case "layout_delete": {
        const p = operationSchemas.layout_delete.parse(args);
        if (!w.layouts?.some((l) => l.id === p.layoutId))
          throw Error(`Layout ${p.layoutId} does not exist.`);
        w.layouts = w.layouts.filter((l) => l.id !== p.layoutId);
        if (w.activeLayout === p.layoutId) delete w.activeLayout;
        results.push({ deletedLayoutId: p.layoutId });
        break;
      }
      case "board_get": {
        const board = w.board || { notes: [], arrows: [], strokes: [] };
        results.push({
          notes: clone(board.notes),
          arrows: clone(board.arrows),
          strokeCount: board.strokes.length,
          strokeIds: board.strokes.map((s) => s.id),
        });
        break;
      }
      case "board_note_set": {
        const p = operationSchemas.board_note_set.parse(args);
        const board = ensureBoard(w);
        const existing = p.id ? board.notes.find((n) => n.id === p.id) : undefined;
        if (!existing && (p.x === undefined || p.y === undefined))
          throw Error("A new note needs x and y.");
        const { link, ...fields } = p;
        const note = existing || {
          id: p.id || uid(),
          x: 0,
          y: 0,
          width: 200,
          height: 160,
          text: "",
          color: NOTE_COLORS[0]!,
        };
        Object.assign(
          note,
          Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
        );
        if (link === null) delete note.link;
        else if (link) {
          if (link.kind === "page" && !/^https?:\/\//i.test(link.target))
            throw Error("Page links must be http(s) URLs.");
          note.link = link;
        }
        if (!existing) board.notes.push(note);
        results.push(clone(note));
        break;
      }
      case "board_arrow_set": {
        const p = operationSchemas.board_arrow_set.parse(args);
        const board = ensureBoard(w);
        const end = (e: z.infer<typeof boardEndInput>) => {
          if (e.appId) {
            const app = w.apps.find((a) => a.id === e.appId && !a.deleted);
            if (!app) throw Error(`App ${e.appId} does not exist.`);
            return { appId: app.id, x: app.x + app.width / 2, y: app.y + app.height / 2 };
          }
          if (e.noteId) {
            const n = board.notes.find((n) => n.id === e.noteId);
            if (!n) throw Error(`Note ${e.noteId} does not exist.`);
            return { noteId: n.id, x: n.x + n.width / 2, y: n.y + n.height / 2 };
          }
          return { x: e.x!, y: e.y! };
        };
        const arrow = {
          id: p.id || uid(),
          from: end(p.from),
          to: end(p.to),
          ...(p.label ? { label: p.label } : {}),
          color: p.color || BOARD_COLORS[0]!,
        };
        const i = board.arrows.findIndex((a) => a.id === arrow.id);
        if (i < 0) board.arrows.push(arrow);
        else board.arrows.splice(i, 1, arrow);
        results.push(clone(arrow));
        break;
      }
      case "board_delete": {
        const p = operationSchemas.board_delete.parse(args);
        const board = ensureBoard(w);
        const ids = new Set(p.ids);
        const known = new Set([...board.notes, ...board.arrows, ...board.strokes].map((x) => x.id));
        const missing = p.ids.filter((x) => !known.has(x));
        if (missing.length) throw Error(`Not on the board: ${missing.join(", ")}.`);
        board.notes = board.notes.filter((n) => !ids.has(n.id));
        // Like deleting a note on the canvas: arrows attached to it go too.
        board.arrows = board.arrows.filter(
          (a) => !ids.has(a.id) && !ids.has(a.from.noteId || "") && !ids.has(a.to.noteId || ""),
        );
        board.strokes = board.strokes.filter((s) => !ids.has(s.id));
        results.push({ deleted: p.ids });
        break;
      }
      case "trigger_list":
        results.push(clone(w.triggers || []));
        break;
      case "trigger_set": {
        const p = operationSchemas.trigger_set.parse(args);
        const workflow = w.actions?.find((a) => a.id === p.workflowId);
        if (!workflow) throw Error(`Workflow ${p.workflowId} does not exist. Call workflow_list.`);
        const missing = workflow.inputs.filter((name) => !(name in p.inputs));
        if (missing.length) throw Error(`inputs must give ${missing.join(", ")} (the workflow's inputs).`);
        const extra = Object.keys(p.inputs).filter((name) => !workflow.inputs.includes(name));
        if (extra.length) throw Error(`${workflow.name} has no input named ${extra.join(", ")}.`);
        w.triggers ||= [];
        const existing = p.id ? w.triggers.find((t) => t.id === p.id) : undefined;
        const trigger = {
          id: p.id || uid(),
          name: p.name,
          workflowId: p.workflowId,
          inputs: p.inputs,
          enabled: p.enabled,
          schedule: p.schedule,
          // A changed schedule starts counting again from now.
          createdAt:
            existing && JSON.stringify(existing.schedule) === JSON.stringify(p.schedule)
              ? existing.createdAt
              : Date.now(),
          ...(existing?.lastRun !== undefined ? { lastRun: existing.lastRun } : {}),
        };
        if (existing && JSON.stringify(existing.schedule) !== JSON.stringify(p.schedule)) delete trigger.lastRun;
        if (existing) w.triggers.splice(w.triggers.indexOf(existing), 1, trigger);
        else w.triggers.push(trigger);
        results.push(clone(trigger));
        break;
      }
      case "trigger_delete": {
        const p = operationSchemas.trigger_delete.parse(args);
        if (!w.triggers?.some((t) => t.id === p.triggerId))
          throw Error(`Trigger ${p.triggerId} does not exist.`);
        w.triggers = w.triggers.filter((t) => t.id !== p.triggerId);
        results.push({ deletedTriggerId: p.triggerId });
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
/** Problems that make a workflow step fail when it runs. Missing targets are
 * errors; an app that does not expose its interface is reported as a warning
 * because the owner may expose it later. */
function workflowIssues(w: Workspace, workflow: WorkspaceAction) {
  const warnings: string[] = [];
  const visit = (rules: Rule[]) => {
    for (const rule of rules) {
      if (rule.flow) {
        visit(rule.flow.rules);
        continue;
      }
      const where = `step ${rule.id} (${rule.action})`;
      if (rule.action === "message") continue;
      if (rule.action === "workspace-action") {
        if (rule.nodeId === workflow.id) throw Error(`${where}: a workflow cannot run itself.`);
        if (!w.actions?.some((a) => a.id === rule.nodeId))
          throw Error(`${where}: workflow ${rule.nodeId || "(missing nodeId)"} does not exist.`);
        continue;
      }
      if (rule.action === "custom") {
        if (!w.customNodes.some((n) => n.id === rule.nodeId))
          throw Error(`${where}: reusable node ${rule.nodeId || "(missing nodeId)"} does not exist.`);
        continue;
      }
      const app = w.apps.find((a) => a.id === rule.appId);
      if (!app) throw Error(`${where}: app ${rule.appId || "(missing appId)"} does not exist.`);
      if (rule.action === "navigate") continue;
      if (rule.action === "open-view") {
        if (rule.view === "graph" && !flatten(app.blocks).some((b) => b.id === rule.target))
          throw Error(`${where}: component ${rule.target} is not in app ${app.name}.`);
        continue;
      }
      if (!flatten(app.blocks).some((b) => b.id === rule.target))
        throw Error(`${where}: component ${rule.target || "(missing target)"} is not in app ${app.name}.`);
      if (!app.exposed)
        warnings.push(
          `${where}: app "${app.name}" does not expose its interface, so this step fails when it runs. Expose it with app_update patch {exposed: true}.`,
        );
    }
  };
  visit(workflow.rules);
  return warnings;
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
