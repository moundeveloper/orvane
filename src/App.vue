<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import AppSurface from "./components/AppSurface.vue";
import { exampleApps, upgradeExampleApps } from "./examples";
import { runIsolated } from "./sandbox";
import Icon from "./components/Icon.vue";
import CustomSelect from "./components/CustomSelect.vue";
import { migrateGroups, groupBounds } from "./groups";
import { vMotion } from "./motion";
import {
  emptyWorkspace,
  flatten,
  uid,
  validateWorkspace,
  type Block,
  type CanvasApp,
  type Rule,
  type Workspace,
  type ActionGraph,
} from "./model";
const STORAGE = "orvane.workspace.v1";
const EXAMPLES = "orvane.examples.v1";
const status = ref(""),
  loadError = ref(false);
function load(): Workspace {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return emptyWorkspace();
    const value: unknown = JSON.parse(raw);
    if (!validateWorkspace(value)) throw Error("Invalid workspace");
    upgradeExampleApps(value);
    migrateGroups(value);
    return value;
  } catch {
    status.value =
      "Your saved workspace could not be opened. Export the stored data before starting fresh.";
    loadError.value = true;
    return emptyWorkspace();
  }
}
const workspace = reactive<Workspace>(load());
const apps = computed(() => workspace.apps.filter((a) => !a.archived));
const active = ref(""),
  camera = reactive({ x: 0, y: 0, zoom: 1 }),
  movingCamera = ref(false);
const createdAppId = ref("");

const panel = ref<
    "search" | "workspace" | "help" | "geometry" | "groups" | null
  >(null),
  query = ref(""),
  searchInput = ref<HTMLInputElement>(),
  importInput = ref<HTMLInputElement>(),
  geometryApp = ref<CanvasApp>();
const searchButton = ref<HTMLButtonElement>();
const searchOrigin = ref("50% calc(100% + 35px)");
const viewport = reactive({
  width: window.innerWidth,
  height: window.innerHeight,
});
const filtered = computed(() =>
  apps.value.filter((a) =>
    `${a.name} ${a.group}`.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
const searchIndex = ref(0),
  searchResults = ref<HTMLElement>();
watch(query, () => (searchIndex.value = 0));
function moveSearch(step: number) {
  const count = filtered.value.length;
  if (!count) return;
  searchIndex.value = (searchIndex.value + step + count) % count;
  nextTick(() =>
    searchResults.value
      ?.querySelector(".selected")
      ?.scrollIntoView({ block: "nearest" }),
  );
}
function commitSearch() {
  const app = filtered.value[searchIndex.value];
  if (app) focusApp(app, true);
}
const archived = computed(() => workspace.apps.filter((a) => a.archived));
const selectedGroup = ref(""),
  groupNameInput = ref<HTMLInputElement>();
const groups = computed(() => workspace.groups || []);
const currentGroup = computed(() =>
  groups.value.find((g) => g.id === selectedGroup.value),
);
const spatialGroups = computed(() =>
  groups.value
    .map((group) => ({
      ...group,
      members: apps.value.filter((a) => a.groupId === group.id),
    }))
    .map((group) => ({ ...group, bounds: groupBounds(group.members) })),
);
function openGroups(id?: string) {
  selectedGroup.value = id || groups.value[0]?.id || "";
  panel.value = "groups";
}
function createGroup() {
  workspace.groups ||= [];
  const group = { id: uid(), name: "New group" };
  workspace.groups.push(group);
  selectedGroup.value = group.id;
  nextTick(() => {
    groupNameInput.value?.focus();
    groupNameInput.value?.select();
  });
}
function renameGroup(event: Event) {
  if (!currentGroup.value) return;
  const name = (event.target as HTMLInputElement).value;
  currentGroup.value.name = name;
  workspace.apps
    .filter((a) => a.groupId === selectedGroup.value)
    .forEach((a) => (a.group = name));
}
function assignGroup(app: CanvasApp, checked: boolean) {
  app.groupId = checked ? selectedGroup.value : undefined;
  app.group = checked ? currentGroup.value?.name || "" : "";
}
function centerGroup() {
  const group = spatialGroups.value.find((g) => g.id === selectedGroup.value);
  if (group?.bounds) {
    const b = group.bounds;
    panTo(
      viewport.width / 2 - (b.x + b.width / 2) * camera.zoom,
      (viewport.height - 80) / 2 - (b.y + b.height / 2) * camera.zoom,
    );
    panel.value = null;
  }
}
function ungroup() {
  workspace.apps
    .filter((a) => a.groupId === selectedGroup.value)
    .forEach((a) => {
      delete a.groupId;
      a.group = "";
    });
}
const traces = ref<
  {
    id: string;
    from: string;
    to: string;
    action: string;
    at: string;
    error?: string;
  }[]
>([]);
const lastFocus = new Map<string, HTMLElement>();
let saveTimer: ReturnType<typeof setTimeout>;
function persist() {
  if (loadError.value) return;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(workspace));
    if (status.value.startsWith("Saving")) status.value = "";
  } catch {
    status.value =
      "Saving is unavailable. Your changes are still here; export a backup from Workspace.";
  }
}
watch(
  workspace,
  () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 180);
  },
  { deep: true },
);
const typing = (e: EventTarget | null) =>
  e instanceof HTMLElement &&
  !!e.closest("input,textarea,select,[contenteditable=true]");
function createApp() {
  const w = Math.min(600, (viewport.width - 40) / camera.zoom),
    h = Math.min(440, (viewport.height - 170) / camera.zoom);
  const a: CanvasApp = {
    id: uid(),
    name: `Untitled${apps.value.length ? " " + (apps.value.length + 1) : ""}`,
    icon: "app",
    x:
      (viewport.width / 2 - camera.x) / camera.zoom -
      w / 2 +
      (apps.value.length % 4) * 20,
    y:
      (viewport.height / 2 - camera.y - 22) / camera.zoom -
      h / 2 +
      (apps.value.length % 4) * 20,
    width: Math.max(220, w),
    height: Math.max(200, h),
    blocks: [],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 26,
    gap: 18,
    radius: 8,
  };
  workspace.apps.push(a);
  createdAppId.value = a.id;
  active.value = a.id;
  panel.value = null;
}
let panFrame = 0;
function stopPan() {
  cancelAnimationFrame(panFrame);
  panFrame = 0;
  movingCamera.value = false;
}
function panTo(x: number, y: number, done?: () => void) {
  stopPan();
  stopZoom();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    camera.x = x;
    camera.y = y;
    done?.();
    return;
  }
  const fromX = camera.x,
    fromY = camera.y;
  let start: number | undefined;
  movingCamera.value = true;
  const tick = (time: number) => {
    start ??= time;
    const progress = Math.max(0, Math.min(1, (time - start) / 280)),
      eased = 1 - (1 - progress) ** 4;
    camera.x = fromX + (x - fromX) * eased;
    camera.y = fromY + (y - fromY) * eased;
    if (progress < 1) panFrame = requestAnimationFrame(tick);
    else {
      panFrame = 0;
      movingCamera.value = false;
      done?.();
    }
  };
  panFrame = requestAnimationFrame(tick);
}
const locatedAppId = ref("");
const locatorSequence = ref(0);
let locatorTimer: ReturnType<typeof setTimeout> | undefined;
function clearLocator() {
  clearTimeout(locatorTimer);
  locatedAppId.value = "";
}
onBeforeUnmount(clearLocator);
function focusApp(a: CanvasApp, locate = false) {
  clearLocator();
  active.value = a.id;
  panTo(
    viewport.width / 2 - (a.x + a.width / 2) * camera.zoom,
    (viewport.height - 80) / 2 - (a.y + a.height / 2) * camera.zoom,
    () => {
      if (locate) {
        locatedAppId.value = a.id;
        locatorSequence.value++;
        locatorTimer = setTimeout(clearLocator, 1360);
      }
      const el = lastFocus.get(a.id);
      if (el?.isConnected && document.activeElement?.closest(".dock"))
        el.focus({ preventScroll: true });
    },
  );
  panel.value = null;
}
function showSearch() {
  const button = searchButton.value?.getBoundingClientRect();
  const width = Math.min(360, viewport.width - 36);
  if (button)
    searchOrigin.value = `${button.x + button.width / 2 - (viewport.width - width) / 2}px calc(100% + ${(viewport.width <= 600 ? 76 : 85) - (viewport.height - button.y - button.height / 2)}px)`;
  panel.value = panel.value === "search" ? null : "search";
  query.value = "";
  searchIndex.value = 0;
  nextTick(() => searchInput.value?.focus({ preventScroll: true }));
}
function addExamples() {
  const x = (Math.max(24, (viewport.width - 720) / 2) - camera.x) / camera.zoom;
  const y = (80 - camera.y) / camera.zoom;
  workspace.apps.push(...exampleApps(x, y));
  migrateGroups(workspace);
  panel.value = null;
  persist();
  try {
    localStorage.setItem(EXAMPLES, "installed");
  } catch {
    /* Saving failure is reported by persist. */
  }
}
function dismissOutside(event: PointerEvent) {
  const target = event.target as HTMLElement;
  const focused = document.activeElement;
  if (
    focused instanceof HTMLInputElement &&
    focused.matches(".app-name") &&
    focused !== target
  )
    focused.blur();
  if (
    !target.closest(
      ".search-panel,.workspace-panel,.guide-panel,.geometry-panel,.groups-panel,.select-popover,.top-actions,.dock-action",
    )
  )
    panel.value = null;
}
function dismissOnBlur() {
  panel.value = null;
}
function home() {
  if (apps.value.length) {
    const bounds = groupBounds(apps.value)!;
    panTo(
      viewport.width / 2 - (bounds.x + bounds.width / 2) * camera.zoom,
      (viewport.height - 80) / 2 - (bounds.y + bounds.height / 2) * camera.zoom,
    );
  } else panTo(0, 0);
  panel.value = null;
}
let gesture: {
  type: "pan" | "move" | "resize";
  px: number;
  py: number;
  x: number;
  y: number;
  width: number;
  height: number;
  app?: CanvasApp;
  edge: string;
} | null = null;
const space = ref(false),
  dragging = ref(false);
const touches = new Map<number, { x: number; y: number }>();
let pinch: {
  distance: number;
  zoom: number;
  worldX: number;
  worldY: number;
} | null = null;
function touchStart(e: PointerEvent) {
  if (
    e.pointerType !== "touch" ||
    (e.target as HTMLElement).closest(".dock,.floating-panel,.topbar")
  )
    return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) {
    stopZoom();
    const [a, b] = [...touches.values()] as [
      { x: number; y: number },
      { x: number; y: number },
    ];
    gesture = null;
    pinch = {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      zoom: camera.zoom,
      worldX: ((a.x + b.x) / 2 - camera.x) / camera.zoom,
      worldY: ((a.y + b.y) / 2 - camera.y) / camera.zoom,
    };
    stopPan();
  }
}
function touchMove(e: PointerEvent) {
  if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch || touches.size !== 2) return;
  e.preventDefault();
  const [a, b] = [...touches.values()] as [
    { x: number; y: number },
    { x: number; y: number },
  ];
  camera.zoom = Math.max(
    0.2,
    Math.min(
      2.5,
      (pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) /
        Math.max(1, pinch.distance),
    ),
  );
  camera.x = (a.x + b.x) / 2 - pinch.worldX * camera.zoom;
  camera.y = (a.y + b.y) / 2 - pinch.worldY * camera.zoom;
}
function touchEnd(e: PointerEvent) {
  touches.delete(e.pointerId);
  if (touches.size < 2) {
    pinch = null;
  }
}
function pointerDown(e: PointerEvent, app?: CanvasApp, edge = "") {
  if (pinch) return;
  if (e.button !== 0 && e.button !== 1) return;
  if (app) active.value = app.id;
  const target = e.target as HTMLElement;
  const headerDrag =
    !!app &&
    !!target.closest(".app-topline") &&
    !target.closest(
      "button,input,textarea,select,a,[contenteditable],.floating-panel",
    );
  const moveApp =
    !!app && (e.altKey || (headerDrag && !space.value && e.button === 0));
  if (!edge && app && !moveApp && !space.value && e.button !== 1) {
    active.value = app.id;
    return;
  }
  if (
    !app &&
    (e.target as HTMLElement).closest(
      ".floating-panel,.dock,.topbar,.status-area",
    )
  )
    return;
  e.preventDefault();
  stopZoom();
  stopPan();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = true;
  gesture = {
    type: edge ? "resize" : moveApp ? "move" : "pan",
    px: e.clientX,
    py: e.clientY,
    x: app && (edge || moveApp) ? app.x : camera.x,
    y: app && (edge || moveApp) ? app.y : camera.y,
    width: app?.width || 0,
    height: app?.height || 0,
    app,
    edge,
  };
}
function pointerMove(e: PointerEvent) {
  if (!gesture) return;
  const g = gesture,
    dx = (e.clientX - g.px) / (g.type === "pan" ? 1 : camera.zoom),
    dy = (e.clientY - g.py) / (g.type === "pan" ? 1 : camera.zoom);
  if (g.type === "pan") {
    camera.x = g.x + dx;
    camera.y = g.y + dy;
  } else if (g.app && g.type === "move") {
    g.app.x = g.x + dx;
    g.app.y = g.y + dy;
  } else if (g.app) {
    if (g.edge.includes("e")) g.app.width = Math.max(180, g.width + dx);
    if (g.edge.includes("s")) g.app.height = Math.max(160, g.height + dy);
    if (g.edge.includes("w")) {
      g.app.width = Math.max(180, g.width - dx);
      g.app.x = g.x + g.width - g.app.width;
    }
    if (g.edge.includes("n")) {
      g.app.height = Math.max(160, g.height - dy);
      g.app.y = g.y + g.height - g.app.height;
    }
  }
}
function pointerUp() {
  gesture = null;
  dragging.value = false;
  persist();
}
let zoomFrame = 0;
let zoomTarget = camera.zoom;
let wheelDirection = 0;
let zoomAnchor = { x: 0, y: 0, worldX: 0, worldY: 0 };
function stopZoom() {
  cancelAnimationFrame(zoomFrame);
  zoomFrame = 0;
  zoomTarget = camera.zoom;
}
function wheel(e: WheelEvent) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (
    (e.target as HTMLElement).closest(
      ".dock,.floating-panel,.node-workspace,.code-editor,.select-popover",
    )
  )
    return;
  e.preventDefault();
  stopPan();
  const delta =
    e.deltaY *
    (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.height : 1);
  zoomAnchor = {
    x: e.clientX,
    y: e.clientY,
    worldX: (e.clientX - camera.x) / camera.zoom,
    worldY: (e.clientY - camera.y) / camera.zoom,
  };
  if (Math.sign(delta) !== wheelDirection) zoomTarget = camera.zoom;
  wheelDirection = Math.sign(delta);
  zoomTarget = Math.min(
    2.5,
    Math.max(
      0.2,
      (zoomFrame ? zoomTarget : camera.zoom) * Math.exp(-delta * 0.0025),
    ),
  );
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    camera.zoom = zoomTarget;
    camera.x = zoomAnchor.x - zoomAnchor.worldX * camera.zoom;
    camera.y = zoomAnchor.y - zoomAnchor.worldY * camera.zoom;
    return;
  }
  if (zoomFrame) return;
  let previousTime: number | undefined;
  const animate = (time: number) => {
    const elapsed =
      previousTime === undefined
        ? 1000 / 60
        : Math.max(0, Math.min(64, time - previousTime));
    const amount = 1 - Math.exp(-elapsed / 32);
    previousTime = time;
    camera.zoom += (zoomTarget - camera.zoom) * amount;
    if (Math.abs(zoomTarget - camera.zoom) < 0.00005) camera.zoom = zoomTarget;
    camera.x = zoomAnchor.x - zoomAnchor.worldX * camera.zoom;
    camera.y = zoomAnchor.y - zoomAnchor.worldY * camera.zoom;
    zoomFrame = camera.zoom === zoomTarget ? 0 : requestAnimationFrame(animate);
  };
  zoomFrame = requestAnimationFrame(animate);
}
function keydown(e: KeyboardEvent) {
  if (
    e.target instanceof Element &&
    e.target.closest(".node-workspace,.code-editor,.select-popover")
  )
    return;
  if (e.key === "Escape") {
    panel.value = null;
    (document.activeElement as HTMLElement)?.blur();
    return;
  }
  if (typing(e.target)) return;
  if (e.code === "Space") {
    space.value = true;
    e.preventDefault();
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const key = e.key.toLowerCase();
  if (key === workspace.shortcuts.create) {
    e.preventDefault();
    createApp();
  } else if (key === workspace.shortcuts.search) {
    e.preventDefault();
    showSearch();
  } else if (key === workspace.shortcuts.home) {
    e.preventDefault();
    home();
  }
}
const keyup = (e: KeyboardEvent) => {
  if (e.code === "Space") space.value = false;
};
const resize = () => {
  viewport.width = window.innerWidth;
  viewport.height = window.innerHeight;
};
function archive(a: CanvasApp) {
  a.archived = true;
  if (active.value === a.id) active.value = "";
}
function duplicate(a: CanvasApp) {
  const copy = JSON.parse(JSON.stringify(a)) as CanvasApp;
  copy.id = uid();
  copy.name = `${a.name} copy`;
  copy.x += 32;
  copy.y += 32;
  const ids = new Map<string, string>();
  const ruleIds = new Map<string, string>();
  flatten(copy.blocks).forEach((b) => {
    const old = b.id;
    b.id = uid();
    ids.set(old, b.id);
  });
  flatten(copy.blocks).forEach((b) => {
    b.rules.forEach((r) => {
      const previousId = r.id;
      r.id = uid();
      ruleIds.set(previousId, r.id);
      if (!r.appId || r.appId === a.id) {
        r.appId = "";
        r.target = ids.get(r.target) || r.target;
      }
    });
    b.items.forEach((i) => (i.id = uid()));
  });
  flatten(copy.blocks).forEach((b) => {
    if (b.graph) {
      b.graph.positions = Object.fromEntries(
        Object.entries(b.graph.positions).map(([id, position]) => [
          ruleIds.get(id) || id,
          position,
        ]),
      );
      b.graph.edges = b.graph.edges.map((e) => ({
        id: uid(),
        source: ruleIds.get(e.source) || e.source,
        target: ruleIds.get(e.target) || e.target,
      }));
    }
  });
  workspace.apps.push(copy);
  createdAppId.value = copy.id;
  focusApp(copy);
}
function reorder(id: string) {
  const from = workspace.apps.findIndex((a) => a.id === dockDrag.value),
    to = workspace.apps.findIndex((a) => a.id === id);
  if (from < 0 || to < 0 || from === to) return;
  workspace.apps.splice(to, 0, workspace.apps.splice(from, 1)[0]!);
  dockDrag.value = "";
}
const dockDrag = ref("");
function moveDock(a: CanvasApp, direction: number) {
  const target =
    apps.value[apps.value.findIndex((other) => other.id === a.id) + direction];
  if (target) {
    dockDrag.value = a.id;
    reorder(target.id);
  }
}
function exportWorkspace(raw = false) {
  const data = raw
    ? localStorage.getItem(STORAGE) || "{}"
    : JSON.stringify(workspace, null, 2);
  const url = URL.createObjectURL(
    new Blob([data], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `orvane-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importWorkspace(e: Event) {
  const el = e.target as HTMLInputElement,
    file = el.files?.[0];
  if (!file) return;
  try {
    const value: unknown = JSON.parse(await file.text());
    if (!validateWorkspace(value))
      throw Error("This file is not a valid Orvane workspace.");
    if (workspace.apps.length) exportWorkspace();
    upgradeExampleApps(value);
    migrateGroups(value);
    Object.assign(workspace, value);
    loadError.value = false;
    status.value = "";
    persist();
    home();
  } catch (err) {
    status.value =
      err instanceof Error ? err.message : "This backup could not be read.";
  }
  el.value = "";
}
function resetAfterFailure() {
  exportWorkspace(true);
  loadError.value = false;
  status.value = "";
  persist();
}
function resolveValue(raw: string, app: CanvasApp, previous: string) {
  return raw
    ? raw.replace(/\{([^}]+)\}/g, (_, label: string) => {
        const b = flatten(app.blocks).find(
          (b) => b.label === label || b.id === label,
        );
        if (!b) throw Error(`Field “${label}” was not found.`);
        return b.kind === "counter" ? String(b.count) : b.value || b.label;
      })
    : previous;
}
async function executeFlow(
  app: CanvasApp,
  rules: Rule[],
  graph: ActionGraph | undefined,
  initial: string,
  depth = 0,
): Promise<string> {
  if (!graph) return executeRules(app, rules, initial, depth);
  let steps = 0;
  async function visit(
    id: string,
    value: string,
    path: Set<string>,
  ): Promise<string> {
    if (++steps > 500 || path.has(id))
      throw Error(
        "This graph contains a loop or exceeds 500 steps. Inspect its wires.",
      );
    const nextPath = new Set(path);
    nextPath.add(id);
    const rule = id === "trigger" ? undefined : rules.find((r) => r.id === id);
    if (id !== "trigger" && !rule)
      throw Error("A graph connection points to a missing node.");
    let result = rule ? await executeRules(app, [rule], value, depth) : value;
    const output = result;
    for (const edge of graph!.edges.filter((e) => e.source === id))
      result = await visit(edge.target, output, nextPath);
    return result;
  }
  return visit("trigger", initial, new Set());
}
async function executeRules(
  app: CanvasApp,
  rules: Rule[],
  initial: string,
  depth = 0,
): Promise<string> {
  if (depth > 12)
    throw Error("This connection contains a loop. Inspect the action chain.");
  let previous = initial;
  for (const rule of rules) {
    const targetApp = rule.appId
      ? workspace.apps.find(
          (a) => a.id === rule.appId && !a.archived && a.exposed,
        )
      : app;
    if (!targetApp)
      throw Error(
        "The connected app is archived, missing, or no longer exposes its interface.",
      );
    const b = flatten(targetApp.blocks).find((b) => b.id === rule.target);
    const value = resolveValue(rule.value, app, previous);
    if (rule.action === "custom") {
      const node = workspace.customNodes.find((n) => n.id === rule.nodeId);
      if (!node) throw Error("Choose an available reusable action.");
      previous = node.rules
        ? await executeFlow(app, node.rules, node.graph, value, depth + 1)
        : await runIsolated(node.code, value);
    } else {
      if (!b) throw Error("Choose a target component for this action.");
      if (rule.action === "add-item") {
        if (b.kind !== "list") throw Error("Add item needs a list target.");
        if (!value.trim())
          throw Error("Enter some text first, or set an action value.");
        b.items.push({ id: uid(), text: value, done: false });
      } else if (rule.action === "clear") b.value = "";
      else if (rule.action === "increment") {
        if (b.kind !== "counter" || !Number.isFinite(Number(value || 1)))
          throw Error("Increase counter needs a counter and a numeric amount.");
        b.count += Number(value || 1);
      } else if (rule.action === "toggle") {
        if (b.kind !== "checkbox")
          throw Error("Toggle needs a checkbox target.");
        b.checked = !b.checked;
      } else if (rule.action === "set-text") {
        if (b.kind === "text" || b.kind === "button") b.label = value;
        else b.value = value;
      } else if (rule.action === "emit")
        previous = await executeFlow(
          targetApp,
          b.rules,
          b.graph,
          value,
          depth + 1,
        );
      previous = rule.action === "emit" ? previous : value;
    }
    traces.value.unshift({
      id: uid(),
      from: app.name,
      to: targetApp.name,
      action: rule.action,
      at: new Date().toLocaleTimeString(),
    });
    traces.value = traces.value.slice(0, 30);
  }
  return previous;
}
const runtimeErrors = reactive<Record<string, string>>({});
async function run(app: CanvasApp, block: Block) {
  runtimeErrors[app.id] = "";
  try {
    const initial =
      block.kind === "input"
        ? block.value
        : flatten(app.blocks).find((b) => b.kind === "input")?.value || "";
    await executeFlow(app, block.rules, block.graph, initial);
  } catch (err) {
    runtimeErrors[app.id] =
      err instanceof Error ? err.message : "This action could not complete.";
    traces.value.unshift({
      id: uid(),
      from: app.name,
      to: app.name,
      action: block.label,
      at: new Date().toLocaleTimeString(),
      error: runtimeErrors[app.id],
    });
  }
}
function focusIn(e: FocusEvent, app: CanvasApp) {
  active.value = app.id;
  if (e.target instanceof HTMLElement && typing(e.target))
    lastFocus.set(app.id, e.target);
}
function shortcutChanged(key: keyof Workspace["shortcuts"]) {
  const value = workspace.shortcuts[key].toLowerCase().slice(-1);
  if (
    !/^[a-z0-9]$/.test(value) ||
    Object.entries(workspace.shortcuts).some(
      ([k, v]) => k !== key && v === value,
    )
  ) {
    status.value = "Choose a different letter or number for each shortcut.";
    const occupied = Object.entries(workspace.shortcuts)
      .filter(([k]) => k !== key)
      .map(([, v]) => v);
    workspace.shortcuts[key] = [
      emptyWorkspace().shortcuts[key],
      ..."abcdefghijklmnopqrstuvwxyz0123456789",
    ].find((k) => !occupied.includes(k))!;
  } else {
    workspace.shortcuts[key] = value;
    status.value = "";
  }
}
onMounted(() => {
  document.addEventListener("pointerdown", dismissOutside, true);
  window.addEventListener("blur", dismissOnBlur);
  try {
    if (!loadError.value && !localStorage.getItem(EXAMPLES)) addExamples();
  } catch {
    /* Storage errors have a separate recovery surface. */
  }
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("resize", resize);
  window.addEventListener("blur", pointerUp);
  window.addEventListener("pagehide", persist);
  window.addEventListener("wheel", wheel, { passive: false });
});
onBeforeUnmount(() => {
  stopPan();
  stopZoom();
  document.removeEventListener("pointerdown", dismissOutside, true);
  window.removeEventListener("blur", dismissOnBlur);
  persist();
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("keyup", keyup);
  window.removeEventListener("resize", resize);
  window.removeEventListener("blur", pointerUp);
  window.removeEventListener("pagehide", persist);
  window.removeEventListener("wheel", wheel);
  clearTimeout(saveTimer);
});
</script>
<template>
  <main
    class="workspace"
    :class="{ 'is-panning': space || dragging }"
    @pointerdown.capture="touchStart"
    @pointermove.capture="touchMove"
    @pointerup.capture="touchEnd"
    @pointercancel.capture="touchEnd"
    @pointerdown="pointerDown($event)"
    @pointermove="pointerMove"
    @pointerup="pointerUp"
    @pointercancel="pointerUp"
    @click="
      !dragging &&
      (($event.target as HTMLElement).classList.contains('canvas-background') ||
        $event.target === $event.currentTarget) &&
      (panel = null)
    "
  >
    <div class="canvas-background"></div>
    <header class="topbar" @pointerdown.stop>
      <div class="wordmark">
        <svg
          width="22"
          height="22"
          viewBox="0 0 22 22"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 15.5V6.5L11 3l7 3.5v9L11 19l-7-3.5Z"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <path
            d="m4 6.5 7 3.7 7-3.7M11 10.2V19"
            stroke="currentColor"
            stroke-width="1.3"
          /></svg
        ><span>orvane</span><span class="workspace-label">Personal canvas</span>
      </div>
      <div class="top-actions">
        <button
          class="subtle-button"
          aria-label="App groups"
          @click="panel === 'groups' ? (panel = null) : openGroups()"
        >
          <Icon name="layers" :size="14" /><span>Groups</span>
        </button>
        <button
          class="subtle-button"
          @click="panel = panel === 'help' ? null : 'help'"
        >
          <Icon name="help" :size="14" /><span>Canvas guide</span></button
        ><button
          class="icon-button workspace-options"
          aria-label="Workspace options"
          @click="panel = panel === 'workspace' ? null : 'workspace'"
        >
          <Icon name="settings" />
        </button>
      </div>
    </header>
    <div
      class="canvas-dots"
      :style="{
        backgroundPosition: `${camera.x}px ${camera.y}px`,
        backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
      }"
    ></div>
    <div
      class="canvas-plane"
      :class="{ 'camera-moving': movingCamera }"
      :style="{
        transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
      }"
    >
      <template v-for="group in spatialGroups" :key="group.id"
        ><div
          v-if="group.bounds"
          class="spatial-group"
          :data-group-id="group.id"
          :style="{
            left: group.bounds.x + 'px',
            top: group.bounds.y + 'px',
            width: group.bounds.width + 'px',
            height: group.bounds.height + 'px',
          }"
        >
          <button
            class="spatial-group-label"
            :aria-label="`Edit group ${group.name || 'Untitled group'}`"
            @pointerdown.stop
            @click="openGroups(group.id)"
          >
            <Icon name="layers" :size="12" /><span>{{
              group.name || "Untitled group"
            }}</span
            ><small>{{ group.members.length }}</small
            ><Icon name="edit" :size="11" />
          </button></div
      ></template>
      <div
        v-for="app in apps"
        :key="app.id"
        class="canvas-app"
        :data-app-id="app.id"
        :style="{
          left: app.x + 'px',
          top: app.y + 'px',
          width: app.width + 'px',
          height: app.height + 'px',
          zIndex: active === app.id ? 2 : 1,
        }"
        @pointerdown.stop="pointerDown($event, app)"
        @focusin="focusIn($event, app)"
      >
        <div
          v-if="locatedAppId === app.id"
          :key="locatorSequence"
          class="app-locator"
          aria-hidden="true"
          :style="{ '--locator-radius': app.radius + 'px' }"
        ></div>
        <AppSurface
          :app="app"
          :workspace="workspace"
          :enter-motion="createdAppId === app.id"
          @run="run"
          @archive="archive"
          @duplicate="duplicate"
          @geometry="
            geometryApp = $event;
            panel = 'geometry';
          "
          @error="runtimeErrors[app.id] = $event"
        />
        <div
          v-if="runtimeErrors[app.id]"
          class="app-error"
          role="alert"
          v-motion="{ kind: 'fade', state: runtimeErrors[app.id] }"
        >
          <span>{{ runtimeErrors[app.id] }}</span
          ><button
            class="icon-button"
            aria-label="Dismiss error"
            @click="runtimeErrors[app.id] = ''"
          >
            <Icon name="close" :size="13" />
          </button>
        </div>
        <div
          v-for="edge in ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']"
          :key="edge"
          class="resize-edge"
          :class="`edge-${edge}`"
          @pointerdown.stop="pointerDown($event, app, edge)"
        ></div>
      </div>
    </div>
    <div v-if="status" class="status-area" role="alert" @pointerdown.stop>
      <span>{{ status }}</span
      ><button
        v-if="loadError"
        class="subtle-button"
        @click="resetAfterFailure"
      >
        Export & start fresh</button
      ><button
        v-else
        class="icon-button"
        aria-label="Dismiss status"
        @click="status = ''"
      >
        <Icon name="close" :size="14" />
      </button>
    </div>
    <Transition name="search-reveal">
      <section
        v-if="panel === 'search'"
        class="search-panel floating-panel"
        :style="{ transformOrigin: searchOrigin }"
        aria-label="Find an app"
        @pointerdown.stop
      >
        <div class="search-input">
          <Icon name="search" :size="17" /><input
            ref="searchInput"
            v-model="query"
            placeholder="Find an app or group…"
            aria-label="Search apps"
            @keydown.down.prevent="moveSearch(1)"
            @keydown.up.prevent="moveSearch(-1)"
            @keydown.enter="commitSearch"
          /><button class="key-cap" @click="panel = null">esc</button>
        </div>
        <div ref="searchResults" class="search-results">
          <button
            v-for="(a, i) in filtered"
            :key="a.id"
            :class="{ selected: i === searchIndex }"
            :aria-current="i === searchIndex || undefined"
            @pointermove="searchIndex = i"
            @click="focusApp(a, true)"
          >
            <Icon :name="a.icon" /><span
              >{{ a.name || "Untitled"
              }}<small v-if="a.group">{{ a.group }}</small></span
            ><Icon name="enter" :size="14" />
          </button>
          <p v-if="!filtered.length">
            {{
              apps.length
                ? "No matching apps. Try a different name."
                : "Your apps will be here. Use + to create one."
            }}
          </p>
        </div>
        <div class="panel-footer">
          {{ apps.length }} {{ apps.length === 1 ? "app" : "apps" }} on your
          canvas
        </div>
      </section>
    </Transition>
    <section
      v-if="panel === 'help'"
      class="guide-panel floating-panel"
      v-motion="{ kind: 'popover' }"
      aria-label="Canvas guide"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h1>A little room to think.</h1>
        <button
          class="icon-button"
          aria-label="Close guide"
          @click="panel = null"
        >
          <Icon name="close" />
        </button>
      </div>
      <p>
        Create apps, give them a shape, and keep them where they make sense to
        you.
      </p>
      <div class="gesture-row">
        <Icon name="move" /><span
          >Pan the canvas<small
            >Drag empty space, or hold Space and drag</small
          ></span
        >
      </div>
      <div class="gesture-row">
        <Icon name="app" /><span
          >Move an app<small
            >Drag its header, or Alt / Option-drag its surface</small
          ></span
        >
      </div>
      <div class="gesture-row">
        <Icon name="resize" /><span
          >Resize or zoom<small
            >Drag an app edge · Ctrl / ⌘ + scroll to zoom</small
          ></span
        >
      </div>
      <div class="gesture-row">
        <Icon name="edit" /><span
          >Make it yours<small
            >Open Build app for layouts, rules and code</small
          ></span
        >
      </div>
      <div class="guide-shortcuts">
        <span
          ><kbd>{{ workspace.shortcuts.create.toUpperCase() }}</kbd> New
          app</span
        ><span
          ><kbd>{{ workspace.shortcuts.search.toUpperCase() }}</kbd> Find
          app</span
        ><span
          ><kbd>{{ workspace.shortcuts.home.toUpperCase() }}</kbd> Center
          canvas</span
        >
      </div>
      <p class="field-help">
        Everything stays on this browser. Export a backup to keep a copy
        elsewhere.
      </p>
      <button class="subtle-button" @click="home">
        <Icon name="box" :size="14" />Center canvas
      </button>
    </section>
    <section
      v-if="panel === 'workspace'"
      class="workspace-panel floating-panel"
      v-motion="{ kind: 'popover' }"
      aria-label="Workspace settings"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h1>Your workspace</h1>
        <button
          class="icon-button"
          aria-label="Close workspace settings"
          @click="panel = null"
        >
          <Icon name="close" />
        </button>
      </div>
      <p class="field-help">Local to this browser. Quietly saved as you go.</p>
      <div class="workspace-action-row">
        <button class="subtle-button" @click="exportWorkspace()">
          <Icon name="download" :size="14" />Export backup</button
        ><button class="subtle-button" @click="importInput?.click()">
          <Icon name="upload" :size="14" />Import backup
        </button>
      </div>
      <button class="subtle-button examples-action" @click="addExamples">
        <Icon name="app" :size="14" />Add example apps
      </button>
      <p class="field-help">
        Import replaces this workspace and downloads a backup of the current one
        first.
      </p>
      <div class="settings-section">
        <div class="section-line">
          <Icon name="keyboard" :size="14" />Keyboard shortcuts
        </div>
        <label
          v-for="(label, key) in {
            create: 'New app',
            search: 'Find app',
            home: 'Center canvas',
          }"
          :key="key"
          class="shortcut-row"
          ><span>{{ label }}</span
          ><input
            v-model="workspace.shortcuts[key]"
            maxlength="1"
            :aria-label="`${label} shortcut`"
            @change="shortcutChanged(key)"
        /></label>
      </div>
      <div class="settings-section">
        <div class="section-line">
          <Icon name="archive" :size="14" />Archived apps<span>{{
            archived.length
          }}</span>
        </div>
        <p v-if="!archived.length" class="field-help">
          Archived apps can be restored here.
        </p>
        <div v-for="a in archived" :key="a.id" class="restore-row">
          <span>{{ a.name }}</span
          ><button
            class="subtle-button"
            @click="
              a.archived = false;
              createdAppId = a.id;
              focusApp(a);
            "
          >
            <Icon name="undo" :size="13" />Restore
          </button>
        </div>
      </div>
      <details class="settings-section">
        <summary>
          Connection activity <span>{{ traces.length }}</span>
        </summary>
        <p v-if="!traces.length" class="field-help">
          Explicit actions between apps appear here.
        </p>
        <div v-for="t in traces" :key="t.id" class="trace">
          <span>{{ t.from }} → {{ t.to }}</span
          ><small>{{ t.action }} · {{ t.at }}</small
          ><span v-if="t.error" class="inline-error">{{ t.error }}</span>
        </div>
      </details>
    </section>
    <section
      v-if="panel === 'groups'"
      class="groups-panel floating-panel"
      v-motion="{ kind: 'popover' }"
      aria-label="App groups editor"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h1>App groups</h1>
        <button
          class="icon-button"
          aria-label="Close groups"
          @click="panel = null"
        >
          <Icon name="close" />
        </button>
      </div>
      <p class="field-help">
        A little structure for your canvas. Apps still move independently.
      </p>
      <div class="group-picker">
        <CustomSelect
          v-if="groups.length"
          v-model="selectedGroup"
          aria-label="Choose group"
          :options="
            groups.map((g) => ({
              value: g.id,
              label: g.name || 'Untitled group',
            }))
          "
        /><button class="subtle-button" @click="createGroup">
          <Icon name="plus" :size="13" />New group
        </button>
      </div>
      <template v-if="currentGroup"
        ><label class="property"
          >Group name<input
            ref="groupNameInput"
            :value="currentGroup.name"
            aria-label="Group name"
            maxlength="80"
            @input="renameGroup"
        /></label>
        <div class="section-line">
          <span>Apps in this group</span
          ><span>{{
            apps.filter((a) => a.groupId === selectedGroup).length
          }}</span>
        </div>
        <div class="group-members">
          <label v-for="app in apps" :key="app.id" class="group-member"
            ><input
              type="checkbox"
              :checked="app.groupId === selectedGroup"
              :aria-label="`Include ${app.name || 'Untitled'} in group`"
              @change="
                assignGroup(app, ($event.target as HTMLInputElement).checked)
              "
            /><Icon :name="app.icon" :size="13" /><span>{{
              app.name || "Untitled"
            }}</span
            ><small v-if="app.groupId && app.groupId !== selectedGroup">{{
              app.group
            }}</small></label
          >
          <p v-if="!apps.length" class="field-help">
            Create an app with + to add it here.
          </p>
        </div>
        <div class="group-footer">
          <button
            class="subtle-button"
            :disabled="!apps.some((a) => a.groupId === selectedGroup)"
            @click="centerGroup"
          >
            <Icon name="box" :size="13" />Go to group</button
          ><button
            class="subtle-button"
            :disabled="!apps.some((a) => a.groupId === selectedGroup)"
            @click="ungroup"
          >
            <Icon name="unlink" :size="13" />Ungroup apps
          </button>
        </div></template
      >
    </section>
    <section
      v-if="panel === 'geometry' && geometryApp"
      class="geometry-panel floating-panel"
      v-motion="{ kind: 'popover' }"
      aria-label="Position and size"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h1>Position & size</h1>
        <button
          class="icon-button"
          aria-label="Close position controls"
          @click="panel = null"
        >
          <Icon name="close" />
        </button>
      </div>
      <p class="field-help">{{ geometryApp.name }} · canvas coordinates</p>
      <div class="geometry-grid">
        <label
          v-for="(label, key) in {
            x: 'Horizontal',
            y: 'Vertical',
            width: 'Width',
            height: 'Height',
          }"
          :key="key"
          class="property"
          >{{ label
          }}<input
            type="number"
            v-model.number="geometryApp[key]"
            :min="key === 'width' ? 180 : key === 'height' ? 160 : undefined"
            @change="
              geometryApp.width = Math.max(
                180,
                Number(geometryApp.width) || 180,
              );
              geometryApp.height = Math.max(
                160,
                Number(geometryApp.height) || 160,
              );
              geometryApp.x = Number(geometryApp.x) || 0;
              geometryApp.y = Number(geometryApp.y) || 0;
            "
        /></label>
      </div>
      <button class="subtle-button" @click="focusApp(geometryApp)">
        <Icon name="box" :size="14" />Center this app
      </button>
    </section>
    <nav class="dock" aria-label="Canvas apps" @pointerdown.stop>
      <button
        class="dock-home icon-button"
        aria-label="Center canvas"
        title="Center canvas"
        @click="home"
      >
        <Icon name="box" :size="18" /></button
      ><span class="dock-divider"></span>
      <div class="dock-tabs">
        <button
          v-for="a in apps"
          :key="a.id"
          class="dock-tab"
          :class="{ active: active === a.id }"
          draggable="true"
          @keydown.alt.left.prevent="moveDock(a, -1)"
          @keydown.alt.right.prevent="moveDock(a, 1)"
          @dragstart="
            dockDrag = a.id;
            $event.dataTransfer?.setData('text/plain', a.id);
          "
          @dragover.prevent
          @drop.prevent="reorder(a.id)"
          @dragend="dockDrag = ''"
          @click="focusApp(a)"
          :title="a.group ? `${a.name} · ${a.group}` : a.name"
        >
          <Icon :name="a.icon" :size="15" /><span>{{
            a.name || "Untitled"
          }}</span></button
        ><span v-if="!apps.length" class="empty-dock-label">Your canvas</span>
      </div>
      <span class="dock-divider"></span
      ><button
        ref="searchButton"
        class="icon-button dock-action"
        :class="{ selected: panel === 'search' }"
        aria-label="Find an app"
        title="Find an app"
        @click="showSearch"
      >
        <Icon name="search" :size="17" /></button
      ><button
        class="icon-button create-app"
        aria-label="Create app"
        title="Create a blank app"
        @click="createApp"
      >
        <Icon name="plus" :size="19" />
      </button>
    </nav>
    <input
      ref="importInput"
      type="file"
      accept="application/json,.json"
      class="sr-only"
      aria-label="Import workspace file"
      @change="importWorkspace"
    />
  </main>
</template>
