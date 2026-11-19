<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  shallowReactive,
  watch,
  defineAsyncComponent,
} from "vue";
import { WorkspaceStorage, LEGACY_STORAGE } from "./storage";
import { trackWorkspace } from "./workspaceTracking";
import { connectMcpBridge, type BridgeRequest } from "./mcpBridge";
import { applyCommands, duplicateApp } from "./automation";
import { parseWorkspace, referenceIssues } from "./validation";
import { mergeWorkspace } from "./imports";
import { executeGraph } from "./flow";
import AppSurface from "./components/AppSurface.vue";
import AppTooltip from "./components/AppTooltip.vue";
import { exampleApps, upgradeExampleApps } from "./examples";
import { runIsolated } from "./sandbox";
import Icon from "./components/Icon.vue";
import CustomSelect from "./components/CustomSelect.vue";
import CustomNumber from "./components/CustomNumber.vue";
import { migrateGroups, groupBounds } from "./groups";
import { vMotion } from "./motion";
import { importDrop, importImageData, importImageFile, importPath, mayHoldImage, measure, type PlacedImage } from "./imageDrop";
import { isImage, peekKind } from "./components/files/explorer";
import { isBackup, makeBackup, restoreImages } from "./backup";
import { OPEN_EVENT, registerCommands, type OpenRequest } from "./commands";
import { ACTIVATE_EVENT, BROWSER_SHORTCUT, canvasScroll } from "./canvasScroll";
import { dayKey, dueAt, formatDay, readCalendar, type CalendarItem } from "./calendar";
import { captureLink, CAPTURE_TEXT_LIMIT, INBOX_LIMIT, type ClipboardCapture, type InboxCapture } from "./inbox";
import WorkspaceInbox from "./components/WorkspaceInbox.vue";
import { netSuiteCanvas, querySource, readRecordPreview, RECORD_PREVIEW_MIME, type RecordPreviewLink, type SuiteQLSelection } from "./netsuiteCanvas";
import { WORKBENCH_WIDGET, workbenchEditable, type WorkbenchKind } from "./workbenchWidgets";
import { DRAG_MIME } from "./components/files/explorer";
import CommandPalette from "./components/CommandPalette.vue";
import BoardLayer from "./components/BoardLayer.vue";
import BoardTools from "./components/BoardTools.vue";
import { BOARD_COLORS, ensureBoard, type Tool } from "./board";
import {
  emptyWorkspace,
  appMinimum,
  makeBlock,
  flatten,
  uid,
  type Block,
  type CanvasApp,
  type Rule,
  type Workspace,
  type Layout,
  type ActionGraph,
  type WorkspaceAction,
  type NoteLink,
} from "./model";
const STORAGE = LEGACY_STORAGE;
// Desktop window controls for the frameless top bar.
const desktopWindow = (
  window as unknown as {
    orvaneDesktop?: {
      frameless?: boolean;
      closeWindow?: () => void;
      isWindowMaximized?: () => Promise<boolean>;
      toggleWindowMaximized?: () => Promise<void>;
      onWindowMaximized?: (callback: (maximized: boolean) => void) => () => void;
      canRestoreByDrag?: boolean;
      dragWindow?: (phase: "start" | "move" | "end") => void;
      readInboxClipboard?: () => Promise<ClipboardCapture | null>;
      onInboxCapture?: (callback: () => void) => () => void;
      displays?: () => Promise<
        { id: number; label: string; chosen: boolean }[]
      >;
      setDisplay?: (id: number) => Promise<boolean>;
      notify?: (n: { title: string; body: string; appId: string }) => Promise<void>;
      onNotificationClick?: (callback: (appId: string) => void) => () => void;
    };
  }
).orvaneDesktop;
const frameless = !!desktopWindow?.frameless && !!desktopWindow.closeWindow;
const windowMaximized = ref(false);
const windowDragPointer = ref<number>();
const restoreDrag = computed(() =>
  desktopWindow?.canRestoreByDrag && (windowMaximized.value || windowDragPointer.value !== undefined));
let stopWindowMaximized: (() => void) | undefined;
function beginWindowDrag(event: PointerEvent) {
  if (!restoreDrag.value || event.button !== 0 || windowDragPointer.value !== undefined) return;
  windowDragPointer.value = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  desktopWindow?.dragWindow?.("start");
}
function moveWindowDrag(event: PointerEvent) {
  if (event.pointerId === windowDragPointer.value) desktopWindow?.dragWindow?.("move");
}
function endWindowDrag(event?: Event) {
  if (windowDragPointer.value === undefined || (event instanceof PointerEvent && event.pointerId !== windowDragPointer.value)) return;
  windowDragPointer.value = undefined;
  desktopWindow?.dragWindow?.("end");
}
// The monitor Orvane opens on, chosen in Workspace options.
const displays = ref<{ value: string; label: string }[]>([]),
  displayChoice = ref("");
async function loadDisplays() {
  const list = (await desktopWindow?.displays?.().catch(() => [])) || [];
  displays.value = list.map((item) => ({
    value: String(item.id),
    label: item.label,
  }));
  displayChoice.value = String(list.find((item) => item.chosen)?.id ?? "");
}
async function chooseDisplay() {
  if (displayChoice.value)
    await desktopWindow?.setDisplay?.(Number(displayChoice.value));
}
const ActionStudio = defineAsyncComponent(
  () => import("./components/ActionStudio.vue"),
);
const actionStudio = ref(false),
  studioActionId = ref(""),
  studioWheelEntry = ref(""),
  actionNotice = ref("");
watch(
  () => !actionStudio.value && actionNotice.value,
  (notice, _, onCleanup) => {
    if (!notice) return;
    const timeout = window.setTimeout(() => (actionNotice.value = ""), 3000);
    onCleanup(() => clearTimeout(timeout));
  },
);
const actionRunning = ref(false);
const studioOrigin = ref<{
  x: number;
  y: number;
  width: number;
  height: number;
}>();
const runningActionIds = new Set<string>();
const appViews: Record<
  string,
  { openView: (view: "settings" | "graph", target: string) => void }
> = {};
function openActionStudio(id = "", entryId = "", trigger?: HTMLElement) {
  const bounds = trigger?.getBoundingClientRect();
  studioOrigin.value = bounds
    ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    : undefined;
  wheelOpen.value = false;
  panel.value = null;
  studioActionId.value = id;
  studioWheelEntry.value = entryId;
  actionStudio.value = true;
}
function assignCreatedAction(id: string) {
  const entry = workspace.wheel?.find((e) => e.id === studioWheelEntry.value);
  const action = workspace.actions?.find((a) => a.id === id);
  if (entry && action) {
    entry.actionId = id;
    entry.name = action.name;
  }
}
const EXAMPLES = "orvane.examples.v1";
const status = ref(""),
  loadError = ref(false),
  ready = ref(false),
  canEdit = ref(false);
// Confirmations read as neutral notes; everything else needs attention.
const statusIsProblem = computed(
  () =>
    loadError.value ||
    !/ (moved to trash|archived)\. Restore it/.test(status.value),
);
const workspace = reactive<Workspace>(emptyWorkspace());
const minimumWatches = new Map<CanvasApp, () => void>();
watch(
  () => [...workspace.apps],
  (apps) => {
    for (const [app, stop] of minimumWatches) {
      if (!apps.includes(app)) {
        stop();
        minimumWatches.delete(app);
      }
    }
    for (const app of apps) {
      if (minimumWatches.has(app)) continue;
      minimumWatches.set(
        app,
        watch(
          () => [
            app.width,
            app.height,
            app.minWidth,
            app.minHeight,
            flatten(app.blocks)
              .map((block) => block.kind)
              .join(","),
          ],
          () => {
            const minimum = appMinimum(app);
            app.width = Math.max(app.width, minimum.width);
            app.height = Math.max(app.height, minimum.height);
          },
          { immediate: true },
        ),
      );
    }
  },
  { immediate: true, flush: "sync" },
);
watch(
  () => (workspace.actions || []).map((a) => ({ id: a.id, name: a.name })),
  (current, previous) => {
    if (!canEdit.value || applying) return;
    for (const entry of workspace.wheel || []) {
      if (entry.kind !== "action") continue;
      const before = previous.find((a) => a.id === entry.actionId);
      const after = current.find((a) => a.id === entry.actionId);
      if (before && after && entry.name === before.name)
        entry.name = after.name;
    }
  },
);
const workspaceRevision = ref(0),
  mcpBusy = ref(false);
const unsavedChanges = ref(false);
let mcpBridge: ReturnType<typeof connectMcpBridge> | undefined;
let applying = false;
const store = new WorkspaceStorage(async () => {
  if (store.conflicted) {
    canEdit.value = false;
    status.value =
      "Editing ownership changed. Unsaved work is still visible here; export it before reloading the shared workspace.";
    return;
  }
  if (!canEdit.value) await refresh();
});
function replaceWorkspace(value: Workspace) {
  applying = true;
  suiteQLSelections.clear();
  // Workspaces from before the focus shortcut get F, or a free key.
  if (value.shortcuts && !value.shortcuts.focus) {
    const used = Object.values(value.shortcuts);
    value.shortcuts.focus = [..."fabcdeghijlmopqrstuvwxyz0123456789"].find((k) => !used.includes(k));
  }
  Object.assign(workspace, value);
  for (const key of Object.keys(workspace))
    if (!(key in value))
      delete (workspace as unknown as Record<string, unknown>)[key];
  applying = false;
  workspaceRevision.value++;
  resetCanvasHistory();
}
async function refresh() {
  const value = await store.read();
  if (value) replaceWorkspace(parseWorkspace(value));
}
async function initialize() {
  try {
    await store.start(async () => {
      try {
        const value = await store.initialize();
        upgradeExampleApps(value);
        migrateGroups(value);
        replaceWorkspace(value);
        canEdit.value = true;
        status.value = "";
        if (!(await store.learned(EXAMPLES))) {
          if (!localStorage.getItem(EXAMPLES)) addExamples();
          await store.learn(EXAMPLES);
        }
        await persist();
        // Undo starts from the canvas as it opened (examples included).
        resetCanvasHistory();
        ready.value = true;
      } catch (error) {
        canEdit.value = false;
        loadError.value = true;
        ready.value = true;
        status.value =
          error instanceof Error
            ? error.message
            : "Your saved workspace could not be opened. Export the stored data to recover it.";
      }
    });
    if (!canEdit.value && !loadError.value) await refresh();
    ready.value = true;
    if (!canEdit.value && !loadError.value)
      status.value =
        "Read-only here. Changes from the editing browser appear automatically. Editing transfers when it closes.";
  } catch (error) {
    ready.value = true;
    loadError.value = true;
    status.value =
      error instanceof Error
        ? error.message
        : "The local SQLite backend is unavailable. Start Orvane with pnpm dev or pnpm preview, then reload.";
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) replaceWorkspace(parseWorkspace(JSON.parse(raw)));
    } catch {
      /* Preserve original bytes. */
    }
  }
}
const apps = computed(() =>
  workspace.apps.filter((a) => !a.archived && !a.deleted && !a.layoutHidden),
);
// Every live app, including ones the current layout leaves out.
const liveApps = computed(() =>
  workspace.apps.filter((a) => !a.archived && !a.deleted),
);
const suiteQLSelections = shallowReactive(new Map<string, SuiteQLSelection>());
const netSuiteSources = computed(() => {
  const sources = new Map<string, { app: CanvasApp; block: Block }>();
  for (const app of liveApps.value)
    for (const block of flatten(app.blocks))
      if (block.kind === "netsuite") sources.set(block.id, { app, block });
  return sources;
});
const recordPreviews = computed(() => {
  const previews = new Map<string, CanvasApp>();
  for (const app of liveApps.value)
    for (const block of flatten(app.blocks)) {
      if (block.kind !== "netsuite-record") continue;
      const link = readRecordPreview(block.value);
      if (link) previews.set(querySource(link.sourceBlockId, link.queryId), app);
    }
  return previews;
});
function querySourceExists(blockId: string, queryId: string) {
  const source = netSuiteSources.value.get(blockId);
  if (!source) return false;
  try {
    const files: unknown = JSON.parse(source.block.value).queries;
    return Array.isArray(files) && files.some((file) => file?.id === queryId);
  } catch {
    return false;
  }
}
provide(netSuiteCanvas, {
  editable: () => canEdit.value && !importBusy.value,
  sourceExists: querySourceExists,
  hasPreview: (source) => recordPreviews.value.has(source),
  selections: suiteQLSelections,
  addPreview: addRecordPreview,
});
provide(workbenchEditable, () => canEdit.value && !importBusy.value);
const active = ref(""),
  camera = reactive({ x: 0, y: 0, zoom: 1 }),
  movingCamera = ref(false);
// Apps and sticky notes share the canvas stacking order.
const stack = ref<string[]>([]);
function raiseCanvasItem(kind: "app" | "note", id: string) {
  const key = `${kind}:${id}`;
  if (stack.value.at(-1) === key) return;
  stack.value = [...stack.value.filter((other) => other !== key), key];
}
function activateApp(id: string) {
  active.value = id;
  raiseCanvasItem("app", id);
}
function stackLevel(kind: "app" | "note", id: string) {
  const index = stack.value.indexOf(`${kind}:${id}`);
  return index < 0 ? undefined : index + 2;
}
const noteStackLevel = (id: string) => stackLevel("note", id);
// ---- Focus mode: one app fills the window between the top bar and dock ----
// Only how the app is drawn changes: its saved position and size stay as
// they are, and the canvas view comes back exactly as it was.
const focused = ref<{
  id: string;
  camera: { x: number; y: number; zoom: number };
  rect: { x: number; y: number; width: number; height: number };
} | null>(null);
function focusArea() {
  const margin = viewport.width <= 600 ? 8 : 12;
  const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
  const dock = document.querySelector(".dock")?.getBoundingClientRect();
  const rail = document.querySelector(".board-rail")?.getBoundingClientRect();
  const top = Math.max(margin, (topbar?.bottom ?? 40) + margin);
  const bottom = Math.max(top + 200, (dock?.top ?? viewport.height - 70) - margin);
  // Leave the Board tools rail on the left uncovered.
  const left = rail && rail.width ? rail.right + margin : margin;
  return { x: left, y: top, width: Math.max(200, viewport.width - left - margin), height: bottom - top };
}
/** Point the camera so the focused app's corner sits at the focus area's. */
function placeFocus() {
  const f = focused.value;
  const app = f && workspace.apps.find((a) => a.id === f.id);
  if (!f || !app) return;
  f.rect = focusArea();
  camera.zoom = 1;
  camera.x = f.rect.x - app.x;
  camera.y = f.rect.y - app.y;
}
function enterFocus(app: CanvasApp) {
  if (focused.value?.id === app.id) return exitFocus();
  stopPan();
  stopZoom();
  const saved = focused.value?.camera ?? { x: camera.x, y: camera.y, zoom: camera.zoom };
  mountedApps.add(app.id);
  activateApp(app.id);
  canvasScroll.owner = app.id;
  panel.value = null;
  focused.value = { id: app.id, camera: saved, rect: focusArea() };
  placeFocus();
}
function exitFocus(restoreCamera = true) {
  const f = focused.value;
  if (!f) return;
  focused.value = null;
  if (!restoreCamera) return;
  stopPan();
  stopZoom();
  Object.assign(camera, f.camera);
}
/** Focus or unfocus the app in use (the shortcut). */
function toggleFocus() {
  if (focused.value) return exitFocus();
  const app = apps.value.find((a) => a.id === (canvasScroll.owner || active.value));
  if (app) enterFocus(app);
  else status.value = "Click an app first, then press the focus shortcut.";
}
const hint = ref("");
const hintText = computed(() =>
  hint.value === "move"
    ? "Alt-drag moves an app; edges resize it. Find the Canvas guide in search."
    : "Right-click an app in the dock for Rename, Duplicate and app management.",
);
async function offerHint(id: string) {
  try {
    if (!hint.value && !(await store.learned(id))) hint.value = id;
  } catch {
    /* Optional hints. */
  }
}
function dismissHint() {
  const id = hint.value;
  hint.value = "";
  void store.learn(id).catch(() => {});
}
const createdAppId = ref("");

const panel = ref<
    "search" | "workspace" | "help" | "geometry" | "groups" | "layouts" | null
  >(null),
  query = ref(""),
  searchInput = ref<HTMLInputElement>(),
  importInput = ref<HTMLInputElement>(),
  geometryApp = ref<CanvasApp>();
// Monitors can be plugged in or removed, so read them each time.
watch(panel, (open) => {
  if (open === "workspace") void loadDisplays();
});
const searchButton = ref<HTMLButtonElement>();
const searchOrigin = ref("50% calc(100% + 35px)");
const viewport = reactive({
  width: window.innerWidth,
  height: window.innerHeight,
});
const filtered = computed(() =>
  apps.value.filter((a) =>
    `${a.name || "Untitled"} ${a.group}`
      .toLowerCase()
      .includes(query.value.toLowerCase()),
  ),
);
// Notify embedded Browser pages when the camera moves or settles.
let cameraSettle: ReturnType<typeof setTimeout> | undefined,
  cameraFrame = 0;
function announceCamera(moving: boolean) {
  window.dispatchEvent(
    new CustomEvent("orvane-camera", {
      detail: { zoom: camera.zoom, x: camera.x, y: camera.y, moving },
    }),
  );
}
watch(
  () => [camera.x, camera.y, camera.zoom],
  () => {
    clearTimeout(cameraSettle);
    cameraSettle = setTimeout(() => {
      announceCamera(false);
    }, 150);
    cameraFrame ||= requestAnimationFrame(() => {
      cameraFrame = 0;
      announceCamera(true);
    });
  },
);
onBeforeUnmount(() => {
  clearTimeout(cameraSettle);
  cancelAnimationFrame(cameraFrame);
});
const searchIndex = ref(0),
  searchResults = ref<HTMLElement>();
watch(query, () => (searchIndex.value = 0));
watch(
  filtered,
  () =>
    (searchIndex.value = Math.min(
      searchIndex.value,
      Math.max(0, filtered.value.length - 1),
    )),
);
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
const layoutNameInput = ref<HTMLInputElement>();
function openLayouts() {
  panel.value = "layouts";
  void nextTick(() => layoutNameInput.value?.focus());
}
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
// Saves wait for a pause in editing; hiding, blurring or closing the window flushes.
const SAVE_DELAY = 1000;
let saveTimer: ReturnType<typeof setTimeout>;
function flushSave() {
  resumeWorkspaceTracking();
  if (!unsavedChanges.value) return;
  clearTimeout(saveTimer);
  void persist();
}
async function persist() {
  if (!canEdit.value || loadError.value || applying) return;
  const revision = workspaceRevision.value;
  try {
    await store.write(workspace);
    if (revision === workspaceRevision.value) unsavedChanges.value = false;
    if (
      status.value.startsWith("Saving") ||
      status.value.startsWith("Read-only")
    )
      status.value = "";
  } catch {
    if (store.conflicted) return;
    status.value =
      "Saving is unavailable. Your changes are still here; export a backup from Workspace or retry saving.";
  }
}
// ---- Canvas undo (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) ----
// Covers where apps are and whether they exist (move, resize, create,
// duplicate, archive, delete, layout visibility) and the Board (sticky
// notes, arrows, drawings). Never content inside apps: each app keeps its
// own undo. The canvas state is recorded once changes settle, so a drag or
// a stroke is one step.
type CanvasAppState = Pick<CanvasApp, "id" | "x" | "y" | "width" | "height" | "archived" | "deleted" | "layoutHidden">;
const UNDO_LIMIT = 100;
let canvasUndo: string[] = [];
let canvasRedo: string[] = [];
let canvasCurrent = "";
let canvasRecordTimer: ReturnType<typeof setTimeout> | undefined;
// Apps an undo took off the canvas, kept so redo can bring them back whole.
const undoneApps = new Map<string, CanvasApp>();
function canvasState() {
  return JSON.stringify({
    apps: workspace.apps.map(
      (a): CanvasAppState => ({
        id: a.id,
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
        archived: a.archived,
        deleted: a.deleted,
        layoutHidden: a.layoutHidden,
      }),
    ),
    board: workspace.board ?? null,
  });
}
function recordCanvas() {
  clearTimeout(canvasRecordTimer);
  canvasRecordTimer = undefined;
  const state = canvasState();
  if (state === canvasCurrent) return;
  if (canvasCurrent) canvasUndo.push(canvasCurrent);
  if (canvasUndo.length > UNDO_LIMIT) canvasUndo.shift();
  canvasRedo = [];
  canvasCurrent = state;
}
function scheduleCanvasRecord() {
  clearTimeout(canvasRecordTimer);
  canvasRecordTimer = setTimeout(recordCanvas, 400);
}
/** A loaded or replaced workspace starts a fresh history. */
function resetCanvasHistory() {
  clearTimeout(canvasRecordTimer);
  canvasRecordTimer = undefined;
  canvasUndo = [];
  canvasRedo = [];
  undoneApps.clear();
  canvasCurrent = canvasState();
}
function applyCanvasState(state: string) {
  const { apps: saved, board } = JSON.parse(state) as {
    apps: CanvasAppState[];
    board: Workspace["board"] | null;
  };
  const byId = new Map(workspace.apps.map((a) => [a.id, a]));
  for (const app of workspace.apps)
    if (!saved.some((s) => s.id === app.id)) undoneApps.set(app.id, app);
  const next: CanvasApp[] = [];
  for (const s of saved) {
    const app = byId.get(s.id) ?? undoneApps.get(s.id);
    if (!app) continue;
    undoneApps.delete(s.id);
    app.x = s.x;
    app.y = s.y;
    app.width = s.width;
    app.height = s.height;
    app.archived = s.archived;
    if (s.deleted === undefined) delete app.deleted;
    else app.deleted = s.deleted;
    if (s.layoutHidden === undefined) delete app.layoutHidden;
    else app.layoutHidden = s.layoutHidden;
    next.push(app);
  }
  workspace.apps.splice(0, workspace.apps.length, ...next);
  if (board) workspace.board = board;
  else delete workspace.board;
  boardSelected.value = "";
  boardEditNote.value = "";
  canvasCurrent = canvasState();
}
function undoCanvas(redo = false) {
  if (!canEdit.value || importBusy.value) return;
  if (canvasRecordTimer) recordCanvas();
  const from = redo ? canvasRedo : canvasUndo,
    to = redo ? canvasUndo : canvasRedo;
  const state = from.pop();
  if (!state) {
    status.value = redo ? "Nothing to redo on the canvas." : "Nothing to undo on the canvas.";
    return;
  }
  to.push(canvasCurrent);
  applyCanvasState(state);
  // An "archived / moved to trash" notice no longer describes the canvas.
  if (/ (moved to trash|archived)\. Restore it/.test(status.value)) status.value = "";
}
onBeforeUnmount(() => clearTimeout(canvasRecordTimer));
const workspaceWatch = trackWorkspace(workspace, () => {
  if (!canEdit.value || applying) return;
  scheduleCanvasRecord();
  unsavedChanges.value = true;
  workspaceRevision.value++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persist(), SAVE_DELAY);
});
onBeforeUnmount(() => {
  workspaceWatch.stop();
  for (const stop of minimumWatches.values()) stop();
});
// Geometry changes arrive many times per second during a drag. Vue's deep
// watcher otherwise traverses the entire workspace for every coordinate.
let trackingPaused = false;
function pauseWorkspaceTracking() {
  if (trackingPaused) return;
  trackingPaused = true;
  workspaceWatch.pause();
}
function resumeWorkspaceTracking() {
  if (!trackingPaused) return;
  trackingPaused = false;
  workspaceWatch.resume();
}
const typing = (e: EventTarget | null) =>
  e instanceof HTMLElement &&
  !!e.closest("input,textarea,select,[contenteditable=true]");
function createApp() {
  if (!canEdit.value || importBusy.value) return;
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
  void offerHint("move");
  createdAppId.value = a.id;
  activateApp(a.id);
  panel.value = null;
}
let panFrame = 0;
const toolApps = {
  claude: { name: "Claude sessions", icon: "text" },
  git: { name: "Git viewer", icon: "git" },
  projects: { name: "Projects Hub", icon: "folder" },
  notes: { name: "Notes", icon: "text" },
  browser: { name: "Browser", icon: "globe" },
  netsuite: { name: "NetSuite", icon: "globe" },
  certificates: { name: "Certificate manager", icon: "key" },
  files: { name: "File Explorer", icon: "folder-open" },
  calendar: { name: "Calendar", icon: "calendar", width: 780, height: 520 },
  terminal: { name: "Terminal", icon: "terminal", width: 940, height: 560 },
};
function createGitViewer(kind: keyof typeof toolApps = "git", value?: string) {
  if (!canEdit.value || importBusy.value) return;
  const appId = uid();
  const { name, icon, width = 1160, height = 740 } = toolApps[kind] as {
    name: string;
    icon: string;
    width?: number;
    height?: number;
  };
  const result = applyCommands(workspace, [
    {
      operation: "app_create",
      args: {
        id: appId,
        properties: {
          name,
          icon,
          width,
          height,
          x: (viewport.width / 2 - camera.x) / camera.zoom - width / 2,
          y: (viewport.height / 2 - camera.y) / camera.zoom - height / 2,
          padding: 0,
          gap: 0,
        },
      },
    },
    {
      operation: "component_create",
      args: {
        appId,
        kind,
        properties: {
          label: name,
          sizing: "fill",
          ...(value === undefined ? {} : { value }),
        },
      },
    },
  ]);
  const app = result.workspace.apps.find((a) => a.id === appId)!;
  workspace.apps.push(app);
  createdAppId.value = app.id;
  panel.value = null;
  void focusApp(app);
}
// ---- Command palette (Ctrl+K) ----
const palette = ref<string | null>(null);
// Ctrl+K (search and commands) and Ctrl+Shift+P (commands only) are caught
// in the capture phase, before apps that keep keys to themselves. Notes
// keeps Ctrl+K for its own search while you type in it.
function paletteKeys(e: KeyboardEvent) {
  if (!ready.value || inboxOpen.value || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  const commands = key === "p" && e.shiftKey;
  if (!commands && !(key === "k" && !e.shiftKey)) return;
  if (!commands && e.target instanceof Element && e.target.closest(".block-notes")) return;
  e.preventDefault();
  e.stopPropagation();
  openPalette(commands ? ">" : "");
}
function openPalette(initial: string) {
  palette.value = palette.value === null ? initial : null;
}
// Web pages in the Browser app forward the same shortcuts.
function paletteEvent(event: Event) {
  openPalette(String((event as CustomEvent<string>).detail ?? ""));
}
function focusBlock(blockId: string) {
  const app = workspace.apps.find((a) => !a.archived && !a.deleted && flatten(a.blocks).some((b) => b.id === blockId));
  if (app) void focusApp(app);
}
// A sticky note's link opens in the File Explorer (files and folders) or
// the Browser (pages), like the same results in Ctrl+K.
async function openNoteLink(link: NoteLink, external = false, sourceBlockId?: string) {
  const kind = link.kind === "page" ? "browser" : "files";
  const source = kind === "browser" && sourceBlockId
    ? liveApps.value.find((a) => flatten(a.blocks).some((b) => b.kind === kind && b.id === sourceBlockId))
    : undefined;
  const app = source ?? liveApps.value.find((a) => flatten(a.blocks).some((b) => b.kind === kind));
  const block = app && flatten(app.blocks).find((b) => b.kind === kind && (!source || b.id === sourceBlockId));
  if ((!app || !block) && external && link.kind === "page") {
    window.open(link.target, "_blank", "noopener");
    return;
  }
  if (!app || !block) {
    status.value = `Add a ${kind === "browser" ? "Browser" : "File Explorer"} app to open this link.`;
    return;
  }
  if (app.layoutHidden && canEdit.value) app.layoutHidden = false;
  await focusApp(app);
  const folder = link.target.replace(/[\\/][^\\/]*$/, "");
  const request: OpenRequest =
    link.kind === "page"
      ? { kind: "browser-url", blockId: block.id, url: link.target, reuse: !!sourceBlockId }
      : link.kind === "folder"
        ? { kind: "explorer-path", blockId: block.id, path: link.target }
        : { kind: "explorer-path", blockId: block.id, path: folder, select: link.target };
  // The app may still be loading: ask again briefly until it answers.
  for (let i = 0; i < 20; i++) {
    const event = new CustomEvent<OpenRequest>(OPEN_EVENT, { detail: request });
    window.dispatchEvent(event);
    if ((event as CustomEvent & { handled?: boolean }).handled) return;
    await new Promise((done) => setTimeout(done, 100));
  }
}
// Ctrl+click on a link or path in the Terminal app.
function openLinkEvent(event: Event) {
  const detail = (event as CustomEvent<{ link?: NoteLink; external?: boolean; sourceBlockId?: string }>).detail;
  const link = detail?.link;
  if (!link || !["file", "folder", "page"].includes(link.kind) || typeof link.target !== "string") return;
  if (link.kind === "page" && !/^https?:\/\//i.test(link.target)) return;
  void openNoteLink(link, !!detail.external, detail.sourceBlockId);
}
function focusAppById(appId: string) {
  const app = workspace.apps.find((a) => a.id === appId);
  if (!app) return;
  // Asking for an app that the layout hides brings it back.
  if (app.layoutHidden && canEdit.value) app.layoutHidden = false;
  void focusApp(app);
}

// ---- Board: sticky notes, arrows and drawings on the canvas ----
const boardTool = ref<Tool>("select");
const boardColor = ref(BOARD_COLORS[0]!);
const boardSelected = ref("");
const boardEditNote = ref("");
const EMPTY_BOARD = { notes: [], arrows: [], strokes: [] };
const boardView = computed(() => workspace.board ?? EMPTY_BOARD);
// The board is created the first time a drawing tool is picked.
watch(boardTool, (tool) => {
  if (tool !== "select" && canEdit.value) ensureBoard(workspace);
  if (tool !== "select") boardSelected.value = "";
});
function selectBoardItem(id: string) {
  boardSelected.value = id;
  if (boardView.value.notes.some((note) => note.id === id)) raiseCanvasItem("note", id);
}
function boardCreated(id: string, kind: "note" | "arrow" | "stroke") {
  selectBoardItem(id);
  if (kind === "note") boardEditNote.value = id;
}
function eraseBoardItem(id: string) {
  const board = workspace.board;
  if (!board || !canEdit.value) return;
  board.strokes = board.strokes.filter((s) => s.id !== id);
  board.notes = board.notes.filter((n) => n.id !== id);
  board.arrows = board.arrows.filter((a) => a.id !== id && a.from.noteId !== id && a.to.noteId !== id);
  if (boardSelected.value === id) boardSelected.value = "";
}
function addStickyNote(text = "", link?: NoteLink, point?: { x: number; y: number }) {
  if (!canEdit.value) return;
  const board = ensureBoard(workspace);
  const note = {
    id: uid(),
    x: Math.round(((point?.x ?? viewport.width / 2) - camera.x) / camera.zoom - (point ? 0 : 100)),
    y: Math.round(((point?.y ?? viewport.height / 2) - camera.y) / camera.zoom - (point ? 0 : 80)),
    width: 200,
    height: 160,
    text,
    color: "#fff4b8",
    ...(link ? { link } : {}),
  };
  board.notes.push(note);
  if (text) selectBoardItem(note.id);
  else boardCreated(note.id, "note");
}
function stickyAtPointer() {
  if (!canEdit.value || importBusy.value) return;
  exitFocus();
  boardTool.value = "select";
  const pointer = lastPointer ?? { x: viewport.width / 2, y: viewport.height / 2 };
  addStickyNote("", undefined, {
    x: Math.max(0, Math.min(pointer.x, viewport.width - 200 * camera.zoom)),
    y: Math.max(0, Math.min(pointer.y, viewport.height - 160 * camera.zoom)),
  });
}

const inboxOpen = ref(false);
const inboxBusy = ref(false);
const inboxMessage = ref("");
const inboxDraft = ref("");
const canChangeInbox = computed(() => ready.value && canEdit.value && !importBusy.value);
function openInbox() {
  if (!inboxOpen.value) inboxMessage.value = "";
  panel.value = null;
  palette.value = null;
  inboxOpen.value = true;
}
async function saveCapture(read: () => Promise<ClipboardCapture | null>) {
  if (inboxBusy.value) return false;
  if (!canChangeInbox.value) {
    inboxMessage.value = "Open the inbox in the editing window to capture.";
    return false;
  }
  if ((workspace.inbox?.length ?? 0) >= INBOX_LIMIT) {
    inboxMessage.value = "The inbox is full. Move or discard a capture first.";
    return false;
  }
  const apps = workspace.apps;
  inboxBusy.value = true;
  try {
    const data = await read();
    if (!data?.value) {
      inboxMessage.value = "Copy text, a link or an image first.";
      return false;
    }
    if (data.kind === "text" && data.value.length > CAPTURE_TEXT_LIMIT) {
      inboxMessage.value = "Captures can contain up to 20,000 characters.";
      return false;
    }
    if (workspace.apps !== apps || !canChangeInbox.value) {
      inboxMessage.value = "The workspace changed. Capture again.";
      return false;
    }
    workspace.inbox = [{ ...data, id: uid(), capturedAt: Date.now() }, ...(workspace.inbox ?? [])];
    inboxMessage.value = "Saved to inbox.";
    return true;
  } catch (error) {
    inboxMessage.value = error instanceof Error ? error.message : "The capture could not be saved.";
    return false;
  } finally {
    inboxBusy.value = false;
  }
}
async function saveInboxDraft() {
  const value = inboxDraft.value.trim();
  if (await saveCapture(async () => ({ kind: "text", value }))) inboxDraft.value = "";
}
function saveInboxImage(file: File) {
  return saveCapture(async () => ({
    kind: "image",
    value: (await importImageFile(file, "Clipboard image")).value,
  }));
}
function readInboxClipboard() {
  void saveCapture(async () => {
    const input = await desktopWindow?.readInboxClipboard?.();
    return input?.kind === "image"
      ? { kind: "image", value: (await importImageData(input.value, "Clipboard image")).value }
      : input ?? null;
  });
}
const pendingInboxShortcut = ref(false);
const stopInboxCapture = desktopWindow?.onInboxCapture?.(() => {
  openInbox();
  pendingInboxShortcut.value = true;
});
watch([ready, pendingInboxShortcut], ([loaded, pending]) => {
  if (!loaded || !pending) return;
  pendingInboxShortcut.value = false;
  readInboxClipboard();
});
onBeforeUnmount(() => stopInboxCapture?.());

type CaptureDestination = "note" | "calendar" | "image" | "discard";
async function moveCapture(capture: InboxCapture, destination: CaptureDestination) {
  if (inboxBusy.value || !canChangeInbox.value || !workspace.inbox?.includes(capture)) return;
  inboxBusy.value = true;
  try {
    if (destination === "note" && capture.kind === "text") {
      if ((workspace.board?.notes.length ?? 0) >= 500) throw Error("The board is full.");
      exitFocus();
      boardTool.value = "select";
      const url = captureLink(capture.value);
      addStickyNote(capture.value, url ? { kind: "page", target: capture.value, label: url.hostname } : undefined);
    } else if (destination === "calendar" && capture.kind === "text") {
      const calendar = liveApps.value.flatMap((a) => flatten(a.blocks)).find((b) => b.kind === "calendar");
      const data = readCalendar(calendar?.value ?? "");
      data.items.push({
        id: uid(),
        title: capture.value.split(/\r?\n/, 1)[0]!.slice(0, 200),
        date: dayKey(new Date()),
      });
      if (calendar) calendar.value = JSON.stringify(data);
      else {
        if (workspace.apps.length >= 300) throw Error("The workspace has reached its app limit.");
        createGitViewer("calendar", JSON.stringify(data));
      }
    } else if (destination === "image" && capture.kind === "image") {
      const size = await imageWidgetSize(capture.value);
      if (!canChangeInbox.value || !workspace.inbox?.includes(capture)) return;
      if (workspace.apps.length >= 300) throw Error("The workspace has reached its app limit.");
      exitFocus();
      placeWidget("image", capture.value, "Clipboard image", size, {
        x: (viewport.width / 2 - camera.x) / camera.zoom,
        y: (viewport.height / 2 - camera.y) / camera.zoom,
      });
    } else if (destination !== "discard") return;
    workspace.inbox = workspace.inbox?.filter((item) => item.id !== capture.id);
    inboxMessage.value = {
      note: "Moved to a sticky note.",
      calendar: "Added to Calendar for today.",
      image: "Placed on the canvas.",
      discard: "Capture discarded.",
    }[destination];
  } catch (error) {
    inboxMessage.value = error instanceof Error ? error.message : "The capture could not be moved.";
  } finally {
    inboxBusy.value = false;
  }
}

// ---- Layouts: named arrangements of the canvas ----
const layouts = computed(() => workspace.layouts ?? []);
const layoutName = ref("");
function captureLayout(id: string, name: string): Layout {
  return {
    id,
    name: name.slice(0, 80) || "Layout",
    apps: Object.fromEntries(
      liveApps.value.map((a) => [a.id, { x: a.x, y: a.y, width: a.width, height: a.height, shown: !a.layoutHidden }]),
    ),
    camera: focused.value
      ? { ...focused.value.camera }
      : { x: camera.x, y: camera.y, zoom: camera.zoom },
  };
}
function saveLayout(name = layoutName.value.trim()) {
  if (!canEdit.value) return;
  const layout = captureLayout(uid(), name || `Layout ${layouts.value.length + 1}`);
  workspace.layouts = [...layouts.value, layout].slice(-50);
  workspace.activeLayout = layout.id;
  layoutName.value = "";
}
function updateLayout(id: string) {
  const index = layouts.value.findIndex((l) => l.id === id);
  if (index < 0 || !canEdit.value) return;
  const next = [...layouts.value];
  next[index] = captureLayout(id, next[index]!.name);
  workspace.layouts = next;
  workspace.activeLayout = id;
}
function renameLayout(id: string, name: string) {
  const layout = layouts.value.find((l) => l.id === id);
  if (layout && canEdit.value) layout.name = name.slice(0, 80);
}
function deleteLayout(id: string) {
  if (!canEdit.value) return;
  workspace.layouts = layouts.value.filter((l) => l.id !== id);
  if (workspace.activeLayout === id) workspace.activeLayout = undefined;
}
// Apps created after the layout was saved stay where they are, shown.
function applyLayout(id: string) {
  const layout = layouts.value.find((l) => l.id === id);
  if (!layout || !canEdit.value) return;
  for (const app of liveApps.value) {
    const place = layout.apps[app.id];
    if (!place) {
      app.layoutHidden = false;
      continue;
    }
    app.x = place.x;
    app.y = place.y;
    app.width = Math.max(place.width, appMinimum(app).width);
    app.height = Math.max(place.height, appMinimum(app).height);
    app.layoutHidden = !place.shown;
  }
  workspace.activeLayout = id;
  panTo(layout.camera.x, layout.camera.y, undefined, layout.camera.zoom);
}
function showAllApps() {
  if (!canEdit.value) return;
  for (const app of liveApps.value) app.layoutHidden = false;
}
// ---- Calendar reminders ----
// Checked every 15 seconds in the editing window (one per workspace, so a
// reminder never shows twice). In the desktop app they are system
// notifications that also fire while Orvane sits in the tray; in a browser,
// the browser's notifications. A reminder missed while Orvane was closed is
// shown once if it was due in the last day, and otherwise skipped quietly.
const MISSED_REMINDER_MS = 24 * 60 * 60 * 1000;
function notifyReminder(item: CalendarItem, appId: string) {
  const body = `${item.time} · ${formatDay(item.date)}`;
  if (desktopWindow?.notify) {
    void desktopWindow.notify({ title: item.title, body, appId }).catch(() => undefined);
    return;
  }
  if ("Notification" in window && Notification.permission === "granted") {
    const shown = new Notification(item.title, { body, tag: item.id });
    shown.onclick = () => {
      window.focus();
      focusAppById(appId);
    };
    return;
  }
  status.value = `Reminder: ${item.title} (${body})`;
}
function checkReminders() {
  if (!ready.value || !canEdit.value || importBusy.value) return;
  const now = Date.now();
  for (const app of liveApps.value)
    for (const block of flatten(app.blocks)) {
      if (block.kind !== "calendar") continue;
      const data = readCalendar(block.value);
      let changed = false;
      for (const item of data.items) {
        if (!item.remind || item.done || item.notified) continue;
        const at = dueAt(item);
        if (at === null || at > now) continue;
        item.notified = true;
        changed = true;
        if (now - at < MISSED_REMINDER_MS) notifyReminder(item, app.id);
      }
      if (changed) block.value = JSON.stringify(data);
    }
}
const reminderTimer = setInterval(checkReminders, 15_000);
watch(ready, (isReady) => isReady && checkReminders());
const stopNotificationClicks = desktopWindow?.onNotificationClick?.((appId) => focusAppById(appId));
onBeforeUnmount(() => {
  clearInterval(reminderTimer);
  stopNotificationClicks?.();
});
const stopCanvasCommands = registerCommands("canvas", () => {
  const writable = canEdit.value && !importBusy.value;
  const tools: [keyof typeof toolApps, string][] = [
    ["files", "folder-open"],
    ["notes", "text"],
    ["browser", "globe"],
    ["git", "git"],
    ["projects", "folder"],
    ["netsuite", "globe"],
    ["calendar", "calendar"],
    ["terminal", "terminal"],
  ];
  return [
    { id: "workspace-inbox", title: "Open workspace inbox", icon: "archive", detail: "Workspace", keywords: "capture clipboard screenshot", run: openInbox },
    ...(writable ? [
      { id: "folder-compare", title: "Compare two folders", icon: "columns", detail: "Canvas", run: () => placeWorkbench("folder-compare", {}) },
      { id: "test-results", title: "Pin Playwright results", icon: "terminal", detail: "Canvas", run: () => placeWorkbench("test-results", {}) },
    ] : []),
    ...(writable
      ? [
          { id: "app-new", title: "New app", icon: "plus", hint: workspace.shortcuts.create.toUpperCase(), detail: "Canvas", run: () => createApp() },
          ...tools.map(([kind, icon]) => ({
            id: `app-new-${kind}`,
            title: `New ${toolApps[kind].name}`,
            icon,
            detail: "Canvas",
            keywords: "create add open",
            run: () => createGitViewer(kind),
          })),
        ]
      : []),
    ...layouts.value.map((l) => ({
      id: `layout:${l.id}`,
      title: `Switch to layout: ${l.name}`,
      icon: "layers",
      detail: workspace.activeLayout === l.id ? "Current layout" : "Layouts",
      keywords: "workspace snapshot arrangement",
      run: () => applyLayout(l.id),
    })),
    ...(writable
      ? [
          { id: "layout-save", title: "Save current layout…", icon: "layers", detail: "Layouts", keywords: "workspace snapshot arrangement", run: () => openLayouts() },
          { id: "layout-show-all", title: "Show all apps", icon: "eye", detail: "Layouts", keywords: "unhide", run: () => showAllApps() },
        ]
      : []),
    ...(writable
      ? [
          { id: "board-note", title: "Add sticky note", icon: "text", detail: "Board", hint: "Ctrl Shift N", keywords: "whiteboard postit", run: stickyAtPointer },
          { id: "board-arrow", title: "Draw an arrow between apps", icon: "forward", detail: "Board", keywords: "connect connector link whiteboard", run: () => (boardTool.value = "arrow") },
          { id: "board-pen", title: "Draw on the canvas", icon: "edit", detail: "Board", keywords: "pen freehand sketch whiteboard", run: () => (boardTool.value = "pen") },
          { id: "board-eraser", title: "Erase board items", icon: "trash", detail: "Board", keywords: "whiteboard delete", run: () => (boardTool.value = "eraser") },
          ...(workspace.board?.strokes.length
            ? [{ id: "board-clear", title: "Clear all drawings", icon: "trash", detail: "Board", keywords: "whiteboard pen erase", run: () => (workspace.board!.strokes = []) }]
            : []),
        ]
      : []),
    { id: "canvas-home", title: "Center the canvas", icon: "home", hint: workspace.shortcuts.home.toUpperCase(), detail: "Canvas", run: () => home() },
    { id: "backup-export", title: "Export backup", icon: "download", detail: "Workspace", keywords: "save download json images", run: () => exportWorkspace() },
    ...(writable
      ? [{ id: "backup-import", title: "Import backup…", icon: "upload", detail: "Workspace", keywords: "restore load", run: () => importInput.value?.click() }]
      : []),
  ];
});
onBeforeUnmount(stopCanvasCommands);

// ---- Image widgets: drops on empty canvas and "Place on canvas" ----
const dropNotice = ref("");
let dropNoticeTimer: ReturnType<typeof setTimeout> | undefined;
function notifyDrop(text: string) {
  clearTimeout(dropNoticeTimer);
  dropNotice.value = text;
  dropNoticeTimer = setTimeout(() => (dropNotice.value = ""), 4500);
}
function onCanvas(target: EventTarget | null) {
  return (
    target instanceof Element &&
    (target.classList.contains("canvas-background") || target.classList.contains("workspace"))
  );
}
function canvasDragOver(event: DragEvent) {
  if (!canEdit.value || importBusy.value || !onCanvas(event.target)) return;
  if (!event.dataTransfer?.types.includes(RECORD_PREVIEW_MIME) && !mayHoldImage(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}
function canvasDrop(event: DragEvent) {
  if (!canEdit.value || importBusy.value || !onCanvas(event.target) || !event.dataTransfer) return;
  event.preventDefault();
  const at = { x: (event.clientX - camera.x) / camera.zoom, y: (event.clientY - camera.y) / camera.zoom };
  if (event.dataTransfer.types.includes(RECORD_PREVIEW_MIME)) {
    const link = readRecordPreview(event.dataTransfer.getData(RECORD_PREVIEW_MIME));
    if (link) addRecordPreview(link, at);
    return;
  }
  const folders = folderDrop(event.dataTransfer);
  if (folders.length) {
    placeWorkbench("folder-compare", { left: folders[0], right: folders[1] || "" }, undefined, at);
    return;
  }
  const { jobs, files, skipped } = importDrop(event.dataTransfer);
  if (!jobs.length && !files.length)
    return notifyDrop(
      skipped ? "Folders cannot be placed on the canvas." : "Drop images or files from the File Explorer here.",
    );
  if (skipped) notifyDrop(`${skipped} folder${skipped === 1 ? " was" : "s were"} skipped.`);
  void placeImages(jobs, at, 0);
  placeFiles(files, at, jobs.length * 28);
}
// Creates a one-component app centred on `at`.
function placeWidget(
  kind: "image" | "file" | "netsuite-record" | WorkbenchKind,
  value: string,
  name: string,
  size: { width: number; height: number },
  at: { x: number; y: number },
) {
  const appId = uid();
  const result = applyCommands(workspace, [
    {
      operation: "app_create",
      args: {
        id: appId,
        properties: {
          name,
          icon: ({ "netsuite-record": "globe", "browser-clip": "image", "folder-compare": "columns", "test-results": "terminal" } as Record<string, string>)[kind] ?? kind,
          width: size.width,
          height: size.height,
          x: at.x - size.width / 2,
          y: at.y - size.height / 2,
          padding: 0,
          gap: 0,
        },
      },
    },
    { operation: "component_create", args: { appId, kind, properties: { label: name, value, sizing: "fill" } } },
  ]);
  const app = result.workspace.apps.find((a) => a.id === appId)!;
  workspace.apps.push(app);
  createdAppId.value = appId;
  return app;
}
function placeWorkbench(kind: WorkbenchKind, value: object, title?: string, at?: { x: number; y: number }) {
  if (!canEdit.value || importBusy.value) return;
  if (workspace.apps.length >= 300) return notifyDrop("The workspace has reached its app limit.");
  const settings = {
    "browser-clip": { width: 620, height: 430, name: "Browser clip" },
    "folder-compare": { width: 900, height: 600, name: "Folder comparison" },
    "test-results": { width: 760, height: 560, name: "Playwright test results" },
  }[kind];
  exitFocus();
  const app = placeWidget(kind, JSON.stringify(value), title?.slice(0, 150) || settings.name, settings, at ?? {
    x: (viewport.width / 2 - camera.x) / camera.zoom,
    y: (viewport.height / 2 - camera.y) / camera.zoom,
  });
  if (!at) void focusApp(app);
}
function workbenchEvent(event: Event) {
  const detail = (event as CustomEvent<{ kind: WorkbenchKind; value: object; title?: string }>).detail;
  if (!detail || !["browser-clip", "folder-compare", "test-results"].includes(detail.kind) || !detail.value) return;
  placeWorkbench(detail.kind, detail.value, detail.title);
}
function folderDrop(data: DataTransfer): string[] {
  try {
    const { paths, dirs } = JSON.parse(data.getData(DRAG_MIME));
    if (Array.isArray(paths) && paths.length > 0 && paths.length <= 2 && Array.isArray(dirs) &&
      paths.every((p) => typeof p === "string" && dirs.includes(p))) return paths;
  } catch {
    // External drops use the standard image and file handling.
  }
  return [];
}
function addRecordPreview(link: RecordPreviewLink, at?: { x: number; y: number }) {
  if (!canEdit.value || importBusy.value || !querySourceExists(link.sourceBlockId, link.queryId)) return;
  const source = netSuiteSources.value.get(link.sourceBlockId)!.app;
  const existing = recordPreviews.value.get(querySource(link.sourceBlockId, link.queryId));
  if (!existing && workspace.apps.length >= 300) return notifyDrop("The workspace has reached its app limit.");
  const size = { width: 380, height: Math.min(580, source.height) };
  let left = source.x + source.width + 24;
  if (!at && !existing) {
    for (const app of [...apps.value].sort((a, b) => a.x - b.x)) {
      if (app.y < source.y + size.height && app.y + app.height > source.y &&
        app.x < left + size.width && app.x + app.width > left)
        left = app.x + app.width + 24;
    }
  }
  const preview = existing ?? placeWidget("netsuite-record", JSON.stringify(link), "NetSuite record preview", size, at ?? {
    x: left + size.width / 2,
    y: source.y + size.height / 2,
  });
  if (preview.layoutHidden) preview.layoutHidden = false;
  exitFocus();
  if (!at || existing) void focusApp(source, false, preview);
}
async function imageWidgetSize(value: string) {
  // Fit the picture into 480 px on its longer side, keeping its shape.
  const size = await measure(value);
  const scale = Math.min(1, 480 / Math.max(size.width, size.height));
  return {
    width: Math.max(180, Math.round(size.width * scale)),
    height: Math.max(160, Math.round(size.height * scale) + 36),
  };
}
async function placeImages(jobs: Promise<PlacedImage>[], at: { x: number; y: number }, offset: number) {
  for (const job of jobs) {
    let placed: PlacedImage;
    try {
      placed = await job;
    } catch (error) {
      notifyDrop(error instanceof Error ? error.message : "The image could not be placed.");
      continue;
    }
    if (!placed.value || !canEdit.value) continue;
    placeWidget(
      "image",
      placed.value,
      placed.name || "Image",
      await imageWidgetSize(placed.value),
      { x: at.x + offset, y: at.y + offset },
    );
    offset += 28;
  }
}
// File widgets link to the file on disk; size follows what it shows.
const FILE_SIZES: Record<string, { width: number; height: number }> = {
  video: { width: 640, height: 400 },
  pdf: { width: 540, height: 700 },
  sheet: { width: 680, height: 440 },
  audio: { width: 380, height: 220 },
  text: { width: 600, height: 460 },
};
function placeFiles(paths: string[], at: { x: number; y: number }, offset: number) {
  for (const path of paths.slice(0, 20)) {
    const name = path.split(/[\\/]/).pop() ?? path;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const kind = peekKind({ name, path, dir: false, size: 0, mtime: 0, ext, hidden: false, link: false });
    placeWidget("file", path, name, FILE_SIZES[kind] ?? FILE_SIZES.text!, { x: at.x + offset, y: at.y + offset });
    offset += 28;
  }
}
// Ctrl+V with nothing text-like focused: an image on the clipboard (a
// screenshot, a copied picture or an image address) becomes a widget at the
// pointer, or in the middle of the view.
let lastPointer: { x: number; y: number } | null = null;
function trackPointer(event: PointerEvent) {
  lastPointer = { x: event.clientX, y: event.clientY };
}
function pasteImage(event: ClipboardEvent) {
  const target = event.target as Element | null;
  if (!canEdit.value || importBusy.value || !event.clipboardData) return;
  if (target?.closest?.("input, textarea, [contenteditable], .code-editor, .app-surface, .node-workspace")) return;
  const { jobs } = importDrop(event.clipboardData);
  if (!jobs.length) return;
  event.preventDefault();
  const point = lastPointer ?? { x: viewport.width / 2, y: viewport.height / 2 };
  void placeImages(jobs, { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom }, 0);
}
function placeFileEvent(event: Event) {
  const path = (event as CustomEvent<{ path?: string }>).detail?.path;
  if (!path || !canEdit.value || importBusy.value) return;
  const at = { x: (viewport.width / 2 - camera.x) / camera.zoom, y: (viewport.height / 2 - camera.y) / camera.zoom };
  if (isImage(path)) void placeImages([importPath(path)], at, 0);
  else placeFiles([path], at, 0);
}

let navigationSequence = 0;
function stopPan() {
  navigationSequence++;
  cancelAnimationFrame(panFrame);
  panFrame = 0;
  movingCamera.value = false;
}
function panTo(x: number, y: number, done?: () => void, zoom = camera.zoom) {
  // Navigating leaves focus mode; the camera is about to move anyway.
  exitFocus(false);
  stopPan();
  stopZoom();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    camera.x = x;
    camera.y = y;
    camera.zoom = zoom;
    done?.();
    return;
  }
  const fromX = camera.x,
    fromY = camera.y,
    fromZoom = camera.zoom;
  // The motion is timed from the request, so its first frame already moves;
  // a late first frame counts as at most one frame of progress.
  const requested = performance.now();
  let start: number | undefined;
  movingCamera.value = true;
  const tick = (time: number) => {
    start ??= Math.min(time, Math.max(requested, time - 1000 / 60));
    const progress = Math.max(0, Math.min(1, (time - start) / 280)),
      eased = 1 - (1 - progress) ** 4;
    camera.x = fromX + (x - fromX) * eased;
    camera.y = fromY + (y - fromY) * eased;
    camera.zoom = fromZoom + (zoom - fromZoom) * eased;
    if (progress < 1) panFrame = requestAnimationFrame(tick);
    else {
      panFrame = 0;
      movingCamera.value = false;
      done?.();
    }
  };
  panFrame = requestAnimationFrame(tick);
}
const idle = (work: () => void, timeout = 600) =>
  "requestIdleCallback" in window
    ? requestIdleCallback(work, { timeout })
    : setTimeout(work, 60);
const cancelIdle = (handle: number) => {
  if ("cancelIdleCallback" in window) cancelIdleCallback(handle);
  clearTimeout(handle);
};
/** The app closest to the middle of the view among those that qualify. */
function nearestApp(qualifies: (app: CanvasApp) => boolean) {
  const centerX = (viewport.width / 2 - camera.x) / camera.zoom,
    centerY = (viewport.height / 2 - camera.y) / camera.zoom;
  let nearest: CanvasApp | undefined,
    best = Infinity;
  for (const app of apps.value) {
    if (!qualifies(app)) continue;
    const distance = Math.hypot(
      app.x + app.width / 2 - centerX,
      app.y + app.height / 2 - centerY,
    );
    if (distance < best) {
      best = distance;
      nearest = app;
    }
  }
  return nearest;
}
// Startup mounts the apps in view at once and the others in idle slices,
// nearest first, so a large workspace can be used before all of it exists.
// Anything opened, created or navigated to later mounts immediately.
const mountedApps = reactive(new Set<string>());
// The window resizing re-fits the focused app; it leaving the canvas
// (archived, deleted, hidden by a layout) ends focus.
watch(() => [viewport.width, viewport.height], () => focused.value && placeFocus());
watch(
  () => focused.value && apps.value.some((a) => a.id === focused.value!.id),
  (present) => {
    if (focused.value && !present) exitFocus();
  },
);
let mountHandle = 0;
function inView(app: CanvasApp) {
  const left = app.x * camera.zoom + camera.x,
    top = app.y * camera.zoom + camera.y;
  return (
    left < viewport.width &&
    top < viewport.height &&
    left + app.width * camera.zoom > 0 &&
    top + app.height * camera.zoom > 0
  );
}
function mountPending() {
  if (mountHandle) return;
  mountHandle = idle(() => {
    mountHandle = 0;
    // Motion owns the frame budget; resume once the canvas is still.
    if (gesture || pinch || panFrame || zoomFrame) return mountPending();
    const next = nearestApp((app) => !mountedApps.has(app.id));
    if (!next) return warmApps();
    mountedApps.add(next.id);
    mountPending();
  }, 80);
}
watch(
  apps,
  (current) => {
    for (const app of current)
      if (ready.value || inView(app)) mountedApps.add(app.id);
    if (current.some((app) => !mountedApps.has(app.id))) mountPending();
  },
  { immediate: true, flush: "sync" },
);
// Off-screen apps skip rendering (content-visibility in style.css). Each is
// laid out once while the canvas is idle, nearest first, so panning or
// switching to it later paints existing layout instead of stalling on it.
const warmedApps = new Set<string>();
let warmHandle = 0,
  warmFrame = 0;
function warmApps() {
  if (warmHandle || warmFrame || !ready.value) return;
  warmHandle = idle(() => {
    warmHandle = 0;
    // Motion owns the frame budget; resume once the canvas is still.
    if (gesture || pinch || panFrame || zoomFrame) return warmApps();
    const next = nearestApp(
      (app) => mountedApps.has(app.id) && !warmedApps.has(app.id),
    );
    if (!next) return;
    warmedApps.add(next.id);
    const surface = document.querySelector<HTMLElement>(
      `.canvas-app[data-app-id="${CSS.escape(next.id)}"] > .app-surface`,
    );
    if (!surface) return warmApps();
    surface.classList.add("is-warming");
    // One rendered frame computes its style and layout; the browser keeps
    // both when the app is skipped again.
    warmFrame = requestAnimationFrame(() => {
      warmFrame = requestAnimationFrame(() => {
        warmFrame = 0;
        surface.classList.remove("is-warming");
        warmApps();
      });
    });
  });
}
watch([ready, () => apps.value.length], warmApps, { flush: "post" });
onBeforeUnmount(() => {
  cancelIdle(mountHandle);
  cancelIdle(warmHandle);
  cancelAnimationFrame(warmFrame);
});
const locatedAppId = ref("");
const locatorSequence = ref(0);
let locatorTimer: ReturnType<typeof setTimeout> | undefined;
function clearLocator() {
  clearTimeout(locatorTimer);
  locatedAppId.value = "";
}
onBeforeUnmount(clearLocator);
async function focusApp(a: CanvasApp, locate = false, alongside?: CanvasApp) {
  stopPan();
  stopZoom();
  const sequence = navigationSequence;
  clearLocator();
  mountedApps.add(a.id);
  activateApp(a.id);
  panel.value = null;
  movingCamera.value = true;
  if (canEdit.value && !hint.value) await offerHint("dock");
  await nextTick();
  if (sequence !== navigationSequence) return;
  const current = apps.value.find((app) => app.id === a.id);
  if (!current) {
    stopPan();
    return;
  }
  a = current;
  const margin = viewport.width <= 600 ? 16 : 24;
  const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
  const dock = document.querySelector(".dock")?.getBoundingClientRect();
  const top = Math.max(margin, (topbar?.bottom ?? 40) + 20);
  const bottom = Math.max(top + 1, (dock?.top ?? viewport.height - 70) - 20);
  const width = Math.max(1, viewport.width - 2 * margin);
  const height = bottom - top;
  const bounds = alongside ? groupBounds([a, alongside])! : a;
  const zoom = Math.min(2.5, width / bounds.width, height / bounds.height);
  panTo(
    viewport.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    (top + bottom) / 2 - (bounds.y + bounds.height / 2) * zoom,
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
    zoom,
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
  if (!canEdit.value || importBusy.value) return;
  const x = (Math.max(24, (viewport.width - 720) / 2) - camera.x) / camera.zoom;
  const y = (80 - camera.y) / camera.zoom;
  workspace.apps.push(...exampleApps(x, y));
  migrateGroups(workspace);
  panel.value = null;
  persist();
  try {
    localStorage.setItem(EXAMPLES, "installed");
    void store.learn(EXAMPLES).catch(() => {});
  } catch {
    /* Saving failure is reported by persist. */
  }
}
function dismissOutside(event: PointerEvent) {
  const target = event.target as HTMLElement;
  if (!target.closest(".dock-overflow, .dock-overflow-trigger")) dockOverflowOpen.value = false;
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
  space.value = false;
  if (gesture || dragging.value) pointerUp();
  wheelOpen.value = false;
  wheelKeyHeld = false;
}
function visibilityChanged() {
  if (document.hidden) {
    space.value = false;
    pointerUp();
    void persist();
  }
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
  type: "pan" | "move" | "resize" | "group";
  pointerId: number;
  members?: { app: CanvasApp; x: number; y: number }[];
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
// Grab/grabbing feedback is one overlay above the canvas. It is updated
// synchronously so it can take pointer capture in the same event, and so the
// rest of the document is never restyled for a pan.
const panShield = ref<HTMLElement>();
watch(
  [space, dragging],
  ([armed, active]) => {
    panShield.value?.classList.toggle("armed", armed || active);
    panShield.value?.classList.toggle("dragging", active);
  },
  { flush: "sync" },
);
// Hold Space and move the pointer: the canvas follows in any direction,
// over empty space, apps and web pages alike (the pan shield covers them
// while Space is held). Space is taken before apps see it, except while
// typing; a quick tap without moving is passed on to the app (Peek etc.).
let hoverLast: { x: number; y: number } | null = null;
let spaceMoved = false;
let spaceTarget: EventTarget | null = null;
let replayingSpace = false;
const editable = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),.cm-editor,.code-editor,.xterm");
function armSpace(target: EventTarget | null) {
  if (space.value) return;
  space.value = true;
  spaceMoved = false;
  spaceTarget = target;
  hoverLast = null;
}
function releaseSpace() {
  if (!space.value) return;
  space.value = false;
  hoverLast = null;
  const target = spaceTarget;
  spaceTarget = null;
  // A tap, not a pan: let the app have its Space after all.
  if (!spaceMoved && target instanceof Element && target.closest(".canvas-app")) {
    replayingSpace = true;
    try {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }));
    } finally {
      replayingSpace = false;
    }
  }
}
function spaceDown(e: KeyboardEvent) {
  if (inboxOpen.value) return;
  if (replayingSpace || e.code !== "Space" || e.ctrlKey || e.metaKey || e.altKey || !ready.value) return;
  if (editable(e.target) || wheelOpen.value) return;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) armSpace(e.target);
}
function spaceUp(e: KeyboardEvent) {
  if (e.code !== "Space" || !space.value) return;
  e.preventDefault();
  e.stopPropagation();
  releaseSpace();
}
function hoverPan(e: PointerEvent) {
  if (!space.value || e.buttons || gesture || focused.value) {
    hoverLast = null;
    return;
  }
  if (hoverLast) {
    const dx = e.clientX - hoverLast.x,
      dy = e.clientY - hoverLast.y;
    if (dx || dy) {
      spaceMoved = true;
      stopPan();
      camera.x += dx;
      camera.y += dy;
    }
  }
  hoverLast = { x: e.clientX, y: e.clientY };
}
// Space held inside a web page or code app arrives as this event.
function spaceEvent(event: Event) {
  const down = (event as CustomEvent<boolean>).detail;
  if (down) armSpace(null);
  else if (space.value) {
    spaceMoved = true; // the page already had its key; never replay it
    releaseSpace();
  }
}
const touches = new Map<number, { x: number; y: number }>();
let pinch: {
  distance: number;
  zoom: number;
  worldX: number;
  worldY: number;
} | null = null;
function touchStart(e: PointerEvent) {
  if (
    focused.value ||
    e.pointerType !== "touch" ||
    (e.target as HTMLElement).closest(
      ".dock,.floating-panel,.topbar,.node-workspace,.code-workspace",
    )
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
    Math.min(0.2, pinch.zoom),
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
let gestureCapture: HTMLElement | undefined;
function pointerDown(e: PointerEvent, app?: CanvasApp, edge = "") {
  if (
    !app &&
    e.target instanceof Element &&
    e.target.classList.contains("canvas-background") &&
    document.activeElement instanceof HTMLElement
  )
    document.activeElement.blur();
  // Pressing in an app makes it the app in use (outlined); pressing empty
  // canvas clears that. Pan gestures (middle button, Space) change neither.
  if (e.button === 0 && !space.value) {
    if (app) canvasScroll.owner = app.id;
    else if (
      e.target instanceof Element &&
      (e.target.classList.contains("canvas-background") || e.target.classList.contains("workspace"))
    )
      canvasScroll.owner = "";
  }
  if (gesture) return;
  // A focused app is not moved, resized or panned away.
  if (focused.value) return;
  if (app && (!canEdit.value || importBusy.value)) return;
  if (pinch) return;
  if (e.button !== 0 && e.button !== 1) return;
  // Explicit pan gestures take precedence over edge resizing and Alt-move.
  const panning = e.button === 1 || space.value;
  if (panning) edge = "";
  // Panning only moves the view; it never brings an app to the front.
  if (app && !panning) activateApp(app.id);
  const target = e.target as HTMLElement;
  const headerDrag =
    !!app &&
    !!target.closest(".app-topline") &&
    !target.closest(
      "button,input,textarea,select,a,[contenteditable],.floating-panel",
    );
  const moveApp =
    !!app && !panning && e.button === 0 && (e.altKey || headerDrag);
  if ((moveApp || edge) && hint.value === "move") dismissHint();
  if (!edge && app && !moveApp && !space.value && e.button !== 1) {
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
  const cameraPan = !edge && !moveApp;
  dragging.value = true;
  gestureCapture = cameraPan
    ? (panShield.value ?? (e.currentTarget as HTMLElement))
    : (e.currentTarget as HTMLElement);
  gestureCapture.setPointerCapture(e.pointerId);
  if (!cameraPan) gestureCapture.classList.add("gesture-cursor-target");
  gesture = {
    pointerId: e.pointerId,
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
let groupMoved = false;
function groupPointerDown(event: PointerEvent, groupId: string) {
  if (event.button === 1 || space.value) {
    pointerDown(event);
    return;
  }
  if (
    event.button !== 0 ||
    !canEdit.value ||
    importBusy.value ||
    gesture ||
    pinch
  )
    return;
  const members = apps.value
    .filter((app) => app.groupId === groupId)
    .map((app) => ({ app, x: app.x, y: app.y }));
  if (!members.length) return;
  event.preventDefault();
  stopZoom();
  stopPan();
  groupMoved = false;
  // Preserve the label's native click target when opening group settings.
  gestureCapture = event.currentTarget as HTMLElement;
  gestureCapture.setPointerCapture(event.pointerId);
  gesture = {
    type: "group",
    pointerId: event.pointerId,
    px: event.clientX,
    py: event.clientY,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    edge: "",
    members,
  };
}
function groupClick(event: MouseEvent, id: string) {
  if (groupMoved && event.detail !== 0) {
    event.preventDefault();
    groupMoved = false;
    return;
  }
  groupMoved = false;
  openGroups(id);
}
// Pans relayed from embedded pages (desktop Browser webviews), whose own
// pointer events never reach this document. Deltas are screen pixels.
function embeddedPan(event: Event) {
  const { dx, dy } = (event as CustomEvent<{ dx: number; dy: number }>).detail;
  if (gesture || pinch || focused.value || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  stopZoom();
  stopPan();
  camera.x += dx;
  camera.y += dy;
}
function pointerMove(e: PointerEvent) {
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  const g = gesture,
    dx = (e.clientX - g.px) / (g.type === "pan" ? 1 : camera.zoom),
    dy = (e.clientY - g.py) / (g.type === "pan" ? 1 : camera.zoom);
  if (g.type === "group") {
    if (!groupMoved && Math.hypot(e.clientX - g.px, e.clientY - g.py) < 4)
      return;
    groupMoved = true;
    gestureCapture?.classList.add("gesture-cursor-target");
    dragging.value = true;
    pauseWorkspaceTracking();
    g.members?.forEach(({ app, x, y }) => {
      app.x = x + dx;
      app.y = y + dy;
    });
  } else if (g.type === "pan") {
    camera.x = g.x + dx;
    camera.y = g.y + dy;
  } else if (g.app && g.type === "move") {
    pauseWorkspaceTracking();
    g.app.x = g.x + dx;
    g.app.y = g.y + dy;
  } else if (g.app) {
    pauseWorkspaceTracking();
    const minimum = appMinimum(g.app);
    if (g.edge.includes("e"))
      g.app.width = Math.max(minimum.width, g.width + dx);
    if (g.edge.includes("s"))
      g.app.height = Math.max(minimum.height, g.height + dy);
    if (g.edge.includes("w")) {
      g.app.width = Math.max(minimum.width, g.width - dx);
      g.app.x = g.x + g.width - g.app.width;
    }
    if (g.edge.includes("n")) {
      g.app.height = Math.max(minimum.height, g.height - dy);
      g.app.y = g.y + g.height - g.app.height;
    }
  }
}
function pointerUp(event?: Event) {
  if (
    event instanceof PointerEvent &&
    gesture &&
    event.pointerId !== gesture.pointerId
  )
    return;
  const pointerId = gesture?.pointerId;
  const captured = gestureCapture;
  gestureCapture = undefined;
  captured?.classList.remove("gesture-cursor-target");
  gesture = null;
  dragging.value = false;
  if (pointerId !== undefined && captured?.hasPointerCapture(pointerId))
    captured.releasePointerCapture(pointerId);
  resumeWorkspaceTracking();
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
// Plain scroll belongs to whatever is under the pointer (apps scroll their
// content). Only while Space is held does two-finger scroll pan the canvas;
// the pan shield then covers apps and web pages, so the scroll lands here.
let wheelPanTimer: ReturnType<typeof setTimeout> | undefined;
// Windows locks touchpad scroll to one axis when a gesture starts along it.
// The desktop app also streams the two fingers' own movement (electron/
// touchpad.cs); while that arrives, panning follows the fingers in every
// direction and the axis-locked scroll is only used to learn how many
// pixels (and which sign) one touchpad width means for this user's scroll
// settings, so the pan feels like their normal scrolling.
const TOUCHPAD_SCALE_KEY = "orvane.touchpadScale";
// Panning from the fingers at full scroll speed felt too sensitive.
const TOUCHPAD_PAN_SPEED = 0.5;
let touchpadScale = (() => {
  try {
    const saved = Number(localStorage.getItem(TOUCHPAD_SCALE_KEY));
    return Number.isFinite(saved) && Math.abs(saved) > 50 ? saved : 1500;
  } catch {
    return 1500;
  }
})();
let stopTouchpad: (() => void) | undefined;
let fingersAt = 0;
let fingerSum = { x: 0, y: 0 };
function touchpadInput(input: { fx?: number; fy?: number; end?: boolean }) {
  if (input.end || !space.value || !ready.value || gesture || pinch) {
    fingerSum = { x: 0, y: 0 };
    return;
  }
  const fx = Number(input.fx),
    fy = Number(input.fy);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return;
  fingersAt = performance.now();
  fingerSum.x += fx;
  fingerSum.y += fy;
  applyPan(fx * touchpadScale * TOUCHPAD_PAN_SPEED, fy * touchpadScale * TOUCHPAD_PAN_SPEED);
}
function learnScale(dx: number, dy: number) {
  // Compare the locked scroll with the finger movement since the last one.
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const scroll = vertical ? dy : dx,
    fingers = vertical ? fingerSum.y : fingerSum.x;
  fingerSum = { x: 0, y: 0 };
  if (Math.abs(scroll) < 2 || Math.abs(fingers) < 0.003) return;
  const sample = scroll / fingers;
  if (!Number.isFinite(sample) || Math.abs(sample) < 100 || Math.abs(sample) > 20000) return;
  // A sign flip means the scroll direction setting differs: adopt it at once.
  touchpadScale =
    Math.sign(sample) !== Math.sign(touchpadScale) ? sample : touchpadScale * 0.85 + sample * 0.15;
  try {
    localStorage.setItem(TOUCHPAD_SCALE_KEY, String(Math.round(touchpadScale)));
  } catch {
    // Per-viewer convenience only.
  }
}
function wheelPan(e: WheelEvent) {
  if (!space.value || !ready.value || gesture || pinch) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.height : 1;
  let dx = e.deltaX * unit,
    dy = e.deltaY * unit;
  if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  // The fingers are driving the pan: use this scroll only to calibrate.
  if (performance.now() - fingersAt < 150) return learnScale(dx, dy);
  applyPan(dx, dy);
}
function applyPan(dx: number, dy: number) {
  if (focused.value) return;
  spaceMoved = true; // a pan, not a tap: don't replay Space to the app
  stopPan();
  camera.x -= dx;
  camera.y -= dy;
  // Same light rendering as other camera motion while the scroll lasts.
  movingCamera.value = true;
  clearTimeout(wheelPanTimer);
  wheelPanTimer = setTimeout(() => (movingCamera.value = false), 140);
}
// A press in a code app or Browser page makes it the app in use.
// Browser shortcuts (Ctrl+W, Ctrl+T, Ctrl+Tab, Ctrl+L…) when a Browser app
// is the one in use but the key went to the canvas (its frame was clicked,
// not its page or toolbar): the Browser runs them on its current tab. Keys
// inside the Browser itself are handled there first and never arrive here.
function browserTabKeys(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey || e.altKey) || typing(e.target)) return false;
  const app = apps.value.find((a) => a.id === active.value);
  const browser = app && flatten(app.blocks).find((block) => block.kind === "browser");
  if (!browser) return false;
  const inside = e.target instanceof Element ? e.target.closest(".canvas-app") : null;
  if (inside && (inside as HTMLElement).dataset.appId !== app.id) return false;
  const detail = { blockId: browser.id, key: e, handled: false };
  window.dispatchEvent(new CustomEvent(BROWSER_SHORTCUT, { detail }));
  if (detail.handled) e.preventDefault();
  return detail.handled;
}
function activatedApp(event: Event) {
  const appId = (event as CustomEvent<{ appId: string }>).detail?.appId;
  if (!appId || !apps.value.some((a) => a.id === appId)) return;
  canvasScroll.owner = appId;
  activateApp(appId);
}
onBeforeUnmount(() => clearTimeout(wheelPanTimer));
function wheel(e: WheelEvent) {
  if (!(e.ctrlKey || e.metaKey)) return wheelPan(e);
  if (focused.value) {
    // No canvas zoom while an app is focused.
    e.preventDefault();
    return;
  }
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
      Math.min(0.2, camera.zoom),
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
const wheelOpen = ref(false),
  wheelEditing = ref(false),
  wheelParent = ref("");
const wheelCenter = ref<HTMLButtonElement>(),
  wheelEditor = ref<HTMLElement>();
const wheelCenterSelected = computed(
  () =>
    Math.hypot(
      pointerPosition.x - viewport.width / 2,
      pointerPosition.y - viewport.height / 2,
    ) <
    Math.min(360, viewport.width * 0.86, viewport.height * 0.78) * 0.24,
);
async function openWheelConfig(origin?: HTMLElement, reset = false) {
  const source = origin?.getBoundingClientRect();
  wheelOpen.value = false;
  panel.value = null;
  if (reset) wheelParent.value = "";
  wheelEditing.value = true;
  await nextTick();
  const editor = wheelEditor.value;
  if (!editor) return;
  editor
    .querySelector<HTMLButtonElement>('[aria-label="Close wheel editor"]')
    ?.focus({ preventScroll: true });
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const bounds = editor.getBoundingClientRect();
    const x = source
      ? source.x + source.width / 2 - bounds.x - bounds.width / 2
      : 0;
    const y = source
      ? source.y + source.height / 2 - bounds.y - bounds.height / 2
      : 0;
    const scale = source
      ? Math.max(0.15, Math.min(0.7, source.width / bounds.width))
      : 0.3;
    editor.animate(
      [
        {
          opacity: 0.15,
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
        },
        { opacity: 1, transform: "none" },
      ],
      { duration: 240, easing: "cubic-bezier(.16,1,.3,1)" },
    );
  }
}
function closeWheelConfig() {
  wheelEditing.value = false;
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
}
function wheelConfigKeys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeWheelConfig();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [
    ...(wheelEditor.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
    ) || []),
  ];
  const first = controls[0],
    last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
let wheelKeyHeld = false;
function captureWheelKey(e: KeyboardEvent) {
  // The wheel owns this entire key hold, including browser auto-repeat after
  // clicking a group or cancelling with Escape.
  if (e.code === "KeyQ" && wheelKeyHeld) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}
const pointerPosition = reactive({
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
});
const wheelEntries = computed(() =>
  (workspace.wheel || []).filter((entry) => entry.parent === wheelParent.value),
);
const wheelSlotCount = computed(() => Math.max(6, wheelEntries.value.length));
function wheelPoint(angle: number, radius: number) {
  return [50 + radius * Math.sin(angle), 50 - radius * Math.cos(angle)];
}
function wheelSegment(index: number) {
  const step = (2 * Math.PI) / wheelSlotCount.value;
  const start = index * step - step / 2 + 0.008;
  const end = index * step + step / 2 - 0.008;
  const points: number[][] = [];
  for (let i = 0; i <= 24; i++)
    points.push(wheelPoint(start + ((end - start) * i) / 24, 49));
  for (let i = 24; i >= 0; i--)
    points.push(wheelPoint(start + ((end - start) * i) / 24, 24));
  return `polygon(${points.map((p) => `${p[0]}% ${p[1]}%`).join(",")})`;
}
function wheelArc(index: number) {
  const step = (2 * Math.PI) / wheelSlotCount.value;
  const a = wheelPoint(index * step - step / 2 + 0.025, 49.5);
  const b = wheelPoint(index * step + step / 2 - 0.025, 49.5);
  return `M ${a[0]} ${a[1]} A 49.5 49.5 0 0 1 ${b[0]} ${b[1]}`;
}
const wheelSelected = computed(() => {
  const dx = pointerPosition.x - viewport.width / 2,
    dy = pointerPosition.y - viewport.height / 2;
  const diameter = Math.min(360, viewport.width * 0.86, viewport.height * 0.78);
  if (Math.hypot(dx, dy) < diameter * 0.24 || !wheelEntries.value.length)
    return undefined;
  const angle =
    (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
  return wheelEntries.value[
    Math.round((angle / (2 * Math.PI)) * wheelSlotCount.value) %
      wheelSlotCount.value
  ];
});
function trackWheelPointer(e: PointerEvent) {
  pointerPosition.x = e.clientX;
  pointerPosition.y = e.clientY;
}
function wheelBack() {
  wheelParent.value =
    (workspace.wheel || []).find((entry) => entry.id === wheelParent.value)
      ?.parent || "";
}
function wheelAdd(kind: "group" | "app" | "action") {
  workspace.wheel ||= [];
  if (wheelEntries.value.length >= 8) {
    status.value = "A ring can hold up to eight entries. Add a group for more.";
    return;
  }
  workspace.wheel.push({
    id: uid(),
    parent: wheelParent.value,
    name: kind === "group" ? "New group" : "Action",
    kind,
    appId: apps.value[0]?.id || "",
    bindings: {},
  });
}
function wheelRemove(id: string) {
  const removed = new Set([id]);
  for (let i = 0; i < (workspace.wheel || []).length; i++)
    for (const entry of workspace.wheel || [])
      if (removed.has(entry.parent)) removed.add(entry.id);
  workspace.wheel = (workspace.wheel || []).filter(
    (entry) => !removed.has(entry.id),
  );
}
function keydown(e: KeyboardEvent) {
  if (!ready.value || e.defaultPrevented) return;
  if (browserTabKeys(e)) return;
  if (e.code === "KeyN" && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !e.repeat && !typing(e.target)) {
    e.preventDefault();
    stickyAtPointer();
    return;
  }
  // Delete removes the selected sticky note, arrow or drawing.
  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    boardSelected.value &&
    !boardEditNote.value &&
    !(e.target instanceof Element && e.target.closest("input, textarea, [contenteditable], .app-surface"))
  ) {
    e.preventDefault();
    eraseBoardItem(boardSelected.value);
    return;
  }
  if (
    e.code === "KeyQ" &&
    !e.repeat &&
    !e.ctrlKey &&
    e.altKey &&
    !e.metaKey &&
    !e.shiftKey &&
    !panel.value &&
    !wheelEditing.value &&
    !actionStudio.value &&
    (e.target === document.body ||
      e.target === document.documentElement ||
      (e.target instanceof Element &&
        (e.target.classList.contains("canvas-background") ||
          // Notes passes Alt+Q on so the wheel opens while writing too.
          !!e.target.closest(".notes-workspace"))))
  ) {
    e.preventDefault();
    wheelKeyHeld = true;
    wheelParent.value = "";
    wheelOpen.value = true;
    return;
  }
  if (wheelOpen.value && e.key === "Escape") {
    wheelOpen.value = false;
    e.preventDefault();
    return;
  }
  if (
    e.target instanceof Element &&
    e.target.closest(".node-workspace,.code-editor,.select-popover:not(.dock-overflow)")
  )
    return;
  if (e.key === "Escape") {
    if (dockContext.value) {
      dockContext.value = undefined;
      e.preventDefault();
      return;
    }
    if (dockOverflowOpen.value) {
      closeDockOverflow(true);
      e.preventDefault();
      return;
    }
    if (panel.value || managedApp.value || pendingImport.value || inboxOpen.value || actionStudio.value) {
      actionStudio.value = false;
      inboxOpen.value = false;
      pendingImport.value = undefined;
      managedApp.value = undefined;
      panel.value = null;
      e.preventDefault();
      return;
    }
    if (focused.value && !typing(e.target)) {
      exitFocus();
      e.preventDefault();
      return;
    }
    canvasScroll.owner = "";
    (document.activeElement as HTMLElement)?.blur();
    return;
  }
  if (typing(e.target)) return;
  if (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    (e.code === "KeyZ" || e.code === "KeyY") &&
    !(e.target instanceof Element && e.target.closest(".app-surface,.floating-panel,.cp-backdrop"))
  ) {
    e.preventDefault();
    undoCanvas(e.code === "KeyY" || e.shiftKey);
    return;
  }
  if (
    e.code === "Space" &&
    !(e.target instanceof Element && e.target.closest("button,[role=button]"))
  ) {
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
  } else if (key === (workspace.shortcuts.focus || "f")) {
    e.preventDefault();
    toggleFocus();
  }
}
const keyup = (e: KeyboardEvent) => {
  const releaseWheel = wheelKeyHeld && (e.code === "KeyQ" || e.key === "Alt");
  if (e.code === "KeyQ") wheelKeyHeld = false;
  if (e.code === "Space") space.value = false;
  if (releaseWheel && wheelOpen.value) {
    e.preventDefault();
    const entry = wheelSelected.value;
    if (wheelCenterSelected.value) {
      void openWheelConfig(wheelCenter.value);
      return;
    }
    wheelOpen.value = false;
    if (entry?.kind === "app") {
      const app = apps.value.find((a) => a.id === entry.appId);
      if (app) void focusApp(app, true);
      else
        status.value =
          "This wheel action's app is unavailable. Edit the wheel to choose another app.";
    }
    if (entry?.kind === "action")
      void runWheelAction(entry.actionId || "", entry.bindings || {});
  }
};
const resize = () => {
  viewport.width = window.innerWidth;
  viewport.height = window.innerHeight;
};
const managedApp = ref<CanvasApp>();
const dockContext = ref<CanvasApp>();
const dockTabs = ref<HTMLElement>();
const dockMeasure = ref<HTMLElement>();
const dockOverflow = ref<HTMLElement>();
const dockOverflowButton = ref<HTMLButtonElement>();
const dockOverflowOpen = ref(false);
const dockVisibleCount = ref(Infinity);
let dockResize: ResizeObserver | undefined;
function measureDock() {
  const strip = dockMeasure.value;
  const available = dockTabs.value?.clientWidth;
  if (!strip || available === undefined) return;
  const sizes = Array.from(strip.querySelectorAll<HTMLElement>(".dock-measure-tab"), (tab) => tab.getBoundingClientRect().width);
  if (strip.scrollWidth <= available + 1) {
    dockVisibleCount.value = sizes.length;
    closeDockOverflow(dockOverflowOpen.value);
    return;
  }
  const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
  const capacity = available - (dockOverflowButton.value?.offsetWidth || 31) - gap;
  let width = 0;
  let visible = 0;
  for (const size of sizes) {
    width += size + (visible ? gap : 0);
    if (width > capacity) break;
    visible++;
  }
  dockVisibleCount.value = visible;
}
function closeDockOverflow(restoreFocus: boolean) {
  dockOverflowOpen.value = false;
  if (restoreFocus) dockOverflowButton.value?.focus({ preventScroll: true });
}
function toggleDockOverflow() {
  if (dockOverflowOpen.value) return closeDockOverflow(true);
  dockOverflowOpen.value = true;
  nextTick(() => dockOverflow.value?.querySelector<HTMLButtonElement>("button")?.focus());
}
function chooseDockApp(app: CanvasApp, overflow: boolean) {
  if (overflow) closeDockOverflow(true);
  void focusApp(app);
}
const managementName = ref<HTMLInputElement>();
const managementDependencies = computed(() => {
  const id = managedApp.value?.id;
  const uses = (rules: Rule[], seen = new Set<string>()): boolean =>
    rules.some((r) => {
      if (r.appId === id || (r.flow && uses(r.flow.rules, seen))) return true;
      if (r.nodeId && !seen.has(r.nodeId)) {
        seen.add(r.nodeId);
        return uses(
          workspace.customNodes.find((n) => n.id === r.nodeId)?.rules || [],
          seen,
        );
      }
      return false;
    });
  return workspace.apps.filter(
    (a) =>
      a.id !== id && !a.deleted && flatten(a.blocks).some((b) => uses(b.rules)),
  );
});
function manage(a: CanvasApp) {
  managedApp.value = a;
  dockContext.value = undefined;
  panel.value = null;
  nextTick(() => managementName.value?.focus());
}
function archive(a: CanvasApp) {
  manage(a);
}
function retireApp(deleted: boolean) {
  if (!canEdit.value || importBusy.value || !managedApp.value) return;
  managedApp.value.archived = true;
  managedApp.value.deleted = deleted;
  if (active.value === managedApp.value.id) active.value = "";
  status.value = `${managedApp.value.name || "App"} ${deleted ? "moved to trash" : "archived"}. Restore it from Workspace; its data and connections are kept.`;
  managedApp.value = undefined;
}
function duplicate(a: CanvasApp) {
  if (!canEdit.value || importBusy.value) return;
  const copy = duplicateApp(workspace, a);
  dockContext.value = undefined;
  createdAppId.value = copy.id;
  focusApp(copy);
}
function reorder(id: string) {
  if (!canEdit.value || importBusy.value) return;
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
async function exportWorkspace(raw = false) {
  let data = JSON.stringify(workspace, null, 2);
  if (!raw) {
    // A full backup carries the pictures of image widgets too.
    try {
      const { backup, count, missing } = await makeBackup(JSON.parse(data));
      data = JSON.stringify(backup);
      status.value = count || missing
        ? `Backup includes ${count} image${count === 1 ? "" : "s"}${missing ? `; ${missing} could not be read and were left out` : ""}.`
        : status.value;
    } catch {
      // Fall back to the workspace alone.
    }
  }
  if (raw) {
    try {
      const stored = await store.read();
      data = stored
        ? JSON.stringify(stored, null, 2)
        : localStorage.getItem(STORAGE) || data;
    } catch {
      try {
        data = localStorage.getItem(STORAGE) || data;
      } catch {
        /* Export in-memory data. */
      }
    }
  }
  const url = URL.createObjectURL(
    new Blob([data], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `orvane-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const renderGeneration = ref(0);
const pendingImport = ref<Workspace>();
const importIssues = computed(() =>
  pendingImport.value ? referenceIssues(pendingImport.value) : [],
);
const importBusy = ref(false);
async function recoverBrowserWorkspace() {
  if (!canEdit.value) return;
  try {
    const data = await store.browserWorkspace();
    if (!data) {
      status.value = "This browser has no earlier workspace to recover.";
      return;
    }
    upgradeExampleApps(data);
    migrateGroups(data);
    pendingImport.value = data;
    panel.value = "workspace";
    status.value = "";
    await nextTick();
    document
      .querySelector<HTMLButtonElement>(".import-preview button")
      ?.focus();
  } catch (error) {
    status.value =
      error instanceof Error
        ? error.message
        : "The earlier browser workspace could not be read. Its data has been preserved.";
  }
}
async function importWorkspace(e: Event) {
  const el = e.target as HTMLInputElement,
    file = el.files?.[0];
  if (!file || !canEdit.value) return;
  try {
    if (file.size > 400_000_000)
      throw Error("This backup is too large (maximum 400 MB).");
    let raw: unknown = JSON.parse(await file.text());
    let restoredNote = "";
    if (isBackup(raw)) {
      // Pictures go back into the image store first; they are content-
      // addressed, so restoring them twice or merging is harmless.
      const { restored, rejected } = await restoreImages(raw.images);
      restoredNote = rejected
        ? `${restored} images restored; ${rejected} were damaged and skipped.`
        : restored
          ? `${restored} image${restored === 1 ? "" : "s"} restored.`
          : "";
      raw = raw.workspace;
    } else if ((raw as { version?: number })?.version === 1 && file.size > 25_000_000)
      throw Error("This backup is too large (maximum 25 MB without images).");
    const value = parseWorkspace(raw);
    upgradeExampleApps(value);
    migrateGroups(value);
    pendingImport.value = value;
    nextTick(() =>
      document
        .querySelector<HTMLButtonElement>(".import-preview button")
        ?.focus(),
    );
    panel.value = "workspace";
    status.value = restoredNote;
  } catch (error) {
    status.value =
      error instanceof Error ? error.message : "This backup could not be read.";
  }
  el.value = "";
}
function resetTransient() {
  renderGeneration.value++;
  warmedApps.clear();
  geometryApp.value = undefined;
  active.value = "";
  managedApp.value = undefined;
  dockContext.value = undefined;
  lastFocus.clear();
  traces.value = [];
  Object.keys(runtimeErrors).forEach((key) => delete runtimeErrors[key]);
  clearLocator();
  panel.value = null;
}
async function commitImport(mode: "merge" | "replace") {
  if (!pendingImport.value || !canEdit.value || importBusy.value) return;
  importBusy.value = true;
  clearTimeout(saveTimer);
  try {
    if (activeExecutions.value)
      throw Error("Wait for the current action to finish before importing.");
    const value =
      mode === "merge"
        ? mergeWorkspace(workspace, pendingImport.value)
        : pendingImport.value;
    const issues = referenceIssues(value);
    if (issues.length)
      throw Error(
        `Import stopped: ${issues.join(" ")} Repair the backup references before importing.`,
      );
    await store.write(value, `Before ${mode} import`);
    replaceWorkspace(value);
    unsavedChanges.value = false;
    resetTransient();
    pendingImport.value = undefined;
    status.value = "";
  } catch (error) {
    status.value =
      error instanceof Error &&
      /^(Import stopped:|Wait for)/.test(error.message)
        ? error.message
        : "Import could not be saved. Your existing workspace was kept. Check the local backend and available disk space, then try again.";
  } finally {
    importBusy.value = false;
  }
}
async function restoreSnapshot() {
  if (!canEdit.value || importBusy.value) return;
  try {
    if (activeExecutions.value) {
      status.value = "Wait for the current action to finish before restoring.";
      return;
    }
    importBusy.value = true;
    clearTimeout(saveTimer);
    const previous = await store.latestSnapshot();
    if (!previous) {
      status.value = "No local recovery snapshot is available yet.";
      return;
    }
    const value = parseWorkspace(previous.data);
    await store.write(value, "Before recovery");
    replaceWorkspace(value);
    unsavedChanges.value = false;
    resetTransient();
    status.value = "";
  } catch {
    status.value =
      "Recovery could not complete. Your current workspace was kept; export a backup before trying again.";
  } finally {
    importBusy.value = false;
  }
}
async function resetAfterFailure() {
  await exportWorkspace(true);
  if (!store.writer) return;
  loadError.value = false;
  canEdit.value = true;
  replaceWorkspace(emptyWorkspace());
  await persist();
}
function resolveValue(raw: string, app: CanvasApp, previous: string) {
  return raw
    ? raw.replace(/\{([^}]+)\}/g, (_, label: string) => {
        const b = flatten(app.blocks).find(
          (b) => b.label === label || b.id === label,
        );
        if (!b) throw Error(`Field “${label}” was not found.`);
        return b.kind === "counter"
          ? String(b.count)
          : b.kind === "checkbox"
            ? String(b.checked)
            : b.kind === "text" || b.kind === "button"
              ? b.label
              : b.value;
      })
    : previous;
}
async function executeFlow(
  app: CanvasApp,
  rules: Rule[],
  graph: ActionGraph | undefined,
  initial: string,
  depth = 0,
  callPath: string[] = [],
): Promise<string> {
  if (!graph) return executeRules(app, rules, initial, depth, callPath);
  return executeGraph(
    rules,
    graph,
    initial,
    (rule, value) => executeRules(app, [rule], value, depth, callPath),
    app.id === "__workspace__",
  );
}
async function executeWorkspaceAction(
  id: string,
  bindings: Record<string, string>,
  depth = 0,
  callPath: string[] = [],
  initial = "",
) {
  const saved = workspace.actions?.find((a) => a.id === id);
  if (!saved) throw Error("Choose an available workspace action.");
  const action = JSON.parse(JSON.stringify(saved)) as WorkspaceAction;
  if (callPath.includes(id) || depth > 12)
    throw Error(`Action “${action.name}” contains a recursive call.`);
  if (runningActionIds.has(id))
    throw Error(`“${action.name}” is already running. Wait for it to finish.`);
  if (!action.rules.length)
    throw Error(
      `“${action.name}” has no steps. Open its graph to add an action.`,
    );
  if (action.graph && !action.graph.edges.some((e) => e.source === "trigger"))
    throw Error(
      `“${action.name}” has no connected steps. Connect its trigger to an action node.`,
    );
  for (const input of action.inputs)
    if (!(input in bindings))
      throw Error(
        `“${action.name}” requires input “${input}”. Configure it on the trigger.`,
      );
  const source: CanvasApp = {
    id: "__workspace__",
    name: action.name,
    icon: action.icon,
    x: 0,
    y: 0,
    width: 400,
    height: 400,
    blocks: action.inputs.map((name) => ({
      ...makeBlock("input"),
      id: name,
      label: name,
      value: bindings[name]!,
    })),
    archived: false,
    exposed: false,
    group: "",
    accent: "#6f8998",
    padding: 20,
    gap: 12,
    radius: 6,
  };
  runningActionIds.add(id);
  try {
    return await executeFlow(
      source,
      action.rules,
      action.graph,
      initial,
      depth + 1,
      [...callPath, id],
    );
  } finally {
    runningActionIds.delete(id);
  }
}
async function runWheelAction(id: string, bindings: Record<string, string>) {
  if (!canEdit.value || importBusy.value || actionRunning.value) return;
  actionRunning.value = true;
  activeExecutions.value++;
  actionNotice.value = "";
  try {
    await executeWorkspaceAction(id, bindings);
    if (!actionNotice.value) actionNotice.value = "Action completed.";
  } catch (error) {
    actionNotice.value =
      error instanceof Error ? error.message : "Action failed.";
    traces.value.unshift({
      id: uid(),
      from:
        workspace.actions?.find((a) => a.id === id)?.name || "Workspace action",
      to: "Workspace",
      action: "Run action",
      at: new Date().toLocaleTimeString(),
      error: actionNotice.value,
    });
    traces.value = traces.value.slice(0, 30);
  } finally {
    actionRunning.value = false;
    activeExecutions.value--;
  }
}
async function executeRules(
  app: CanvasApp,
  rules: Rule[],
  initial: string,
  depth = 0,
  callPath: string[] = [],
): Promise<string> {
  if (depth > 12)
    throw Error("This connection contains a loop. Inspect the action chain.");
  let previous = initial;
  for (const rule of rules) {
    if (!canEdit.value)
      throw Error(
        "Editing ownership changed. Run this action in the editing tab.",
      );
    if (rule.action === "workspace-action") {
      const bindings = Object.fromEntries(
        Object.entries(rule.bindings || {}).map(([key, raw]) => [
          key,
          raw ? resolveValue(raw, app, previous) : "",
        ]),
      );
      previous = await executeWorkspaceAction(
        rule.nodeId || "",
        bindings,
        depth + 1,
        callPath,
        previous,
      );
      continue;
    }
    if (rule.action === "navigate" || rule.action === "open-view") {
      const destination = apps.value.find((a) => a.id === rule.appId);
      if (!destination)
        throw Error(
          "The destination app is missing or archived. Choose an available app in this node.",
        );
      if (
        rule.action === "open-view" &&
        rule.view === "graph" &&
        !flatten(destination.blocks).some((b) => b.id === rule.target)
      )
        throw Error(
          "The component graph is missing. Choose a component in this node.",
        );
      await nextTick();
      await focusApp(destination, true);
      if (rule.action === "open-view") {
        const surface = appViews[destination.id];
        if (!surface) throw Error("The destination app view is unavailable.");
        await surface.openView(rule.view || "settings", rule.target);
      }
      continue;
    }
    if (rule.action === "message") {
      actionNotice.value = resolveValue(rule.value, app, previous);
      continue;
    }
    if (rule.flow) {
      previous = await executeFlow(
        app,
        rule.flow.rules,
        rule.flow.graph,
        previous,
        depth + 1,
        callPath,
      );
      continue;
    }
    const targetApp = rule.appId
      ? workspace.apps.find(
          (a) => a.id === rule.appId && !a.archived && !a.deleted && a.exposed,
        )
      : app;
    if (!targetApp)
      throw Error(
        "The connected app is archived, missing, or no longer exposes its interface.",
      );
    const b = flatten(targetApp.blocks).find((b) => b.id === rule.target);
    const value = resolveValue(rule.value, app, previous);
    if (rule.action === "read-field") {
      if (!rule.appId || !b)
        throw Error("Choose an exposed app and an existing field to read.");
      previous =
        b.kind === "counter"
          ? String(b.count)
          : b.kind === "checkbox"
            ? String(b.checked)
            : b.kind === "list"
              ? JSON.stringify(b.items)
              : b.kind === "text" || b.kind === "button"
                ? b.label
                : b.value;
      continue;
    }
    if (rule.action === "custom") {
      const node = workspace.customNodes.find((n) => n.id === rule.nodeId);
      if (!node) throw Error("Choose an available reusable action.");
      if (callPath.includes(node.id))
        throw Error(
          `Reusable action "${node.name}" calls itself. Remove the recursive connection.`,
        );
      previous = node.rules
        ? await executeFlow(app, node.rules, node.graph, value, depth + 1, [
            ...callPath,
            node.id,
          ])
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
        const next = b.count + Number(value || 1);
        if (!Number.isFinite(next))
          throw Error(
            "This counter result is too large. Use a smaller amount.",
          );
        b.count = next;
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
const activeExecutions = ref(0);
async function executeMcp(request: BridgeRequest, revision: string) {
  if (!canEdit.value || !store.writer || loadError.value)
    throw Error("This tab cannot edit the workspace.");
  if (importBusy.value || activeExecutions.value || gesture)
    throw Error(
      "The workspace is busy with a gesture, action, import or recovery. Finish it before editing through MCP.",
    );
  if (request.recovery === "preview") {
    const snapshot = await store.latestSnapshot();
    return {
      revision,
      snapshot: snapshot
        ? { reason: snapshot.reason, at: snapshot.at, workspace: snapshot.data }
        : null,
    };
  }
  const before = JSON.parse(JSON.stringify(workspace)) as Workspace;
  const placement = {
    width: Math.max(220, Math.min(600, (viewport.width - 40) / camera.zoom)),
    height: Math.max(200, Math.min(440, (viewport.height - 170) / camera.zoom)),
    x: (viewport.width / 2 - camera.x) / camera.zoom - 300,
    y: (viewport.height / 2 - camera.y - 22) / camera.zoom - 220,
  };
  placement.x += (600 - placement.width) / 2;
  placement.y += (440 - placement.height) / 2;
  const output = request.commands
    ? applyCommands(before, request.commands, placement)
    : undefined;
  const focusCommand = request.commands
    ?.filter((command) => command.operation === "app_focus")
    .at(-1);
  const focusRequested = async () => {
    if (!focusCommand) return;
    const id = (focusCommand.args as { appId: string }).appId;
    const app = apps.value.find((a) => a.id === id);
    if (app) await focusApp(app, true);
  };
  if (output && !output.changed) {
    await focusRequested();
    return { revision, results: output.results, changed: false };
  }
  mcpBusy.value = true;
  importBusy.value = true;
  clearTimeout(saveTimer);
  let committed = false;
  try {
    let next = output?.workspace;
    if (request.recovery === "restore") {
      const snapshot = await store.latestSnapshot();
      if (!snapshot) throw Error("No local recovery snapshot is available.");
      next = parseWorkspace(snapshot.data);
    }
    if (!next) throw Error("No mutation was supplied.");
    await store.write(
      next,
      request.recovery ? "Before MCP recovery" : "Before MCP edit",
      before,
    );
    committed = true;
    const previousApps = new Map(workspace.apps.map((app) => [app.id, app]));
    const reuseBlocks = (incoming: Block[], previous: Block[]): Block[] =>
      incoming.map((block) => {
        const existing = previous.find((item) => item.id === block.id);
        if (!existing) return block;
        block.children = reuseBlocks(block.children, existing.children);
        return JSON.stringify(block) === JSON.stringify(existing)
          ? existing
          : block;
      });
    next.apps = next.apps.map((app) => {
      const existing = previousApps.get(app.id);
      if (!existing) return app;
      app.blocks = reuseBlocks(app.blocks, existing.blocks);
      return JSON.stringify(app) === JSON.stringify(existing) ? existing : app;
    });
    next.customNodes = next.customNodes.map((node) => {
      const existing = workspace.customNodes.find(
        (item) => item.id === node.id,
      );
      return existing && JSON.stringify(existing) === JSON.stringify(node)
        ? existing
        : node;
    });
    replaceWorkspace(next);
    unsavedChanges.value = false;
    if (
      request.recovery ||
      request.commands?.some((c) => c.operation === "workspace_import")
    )
      resetTransient();
    else {
      const created = request.commands
        ?.flatMap((command, index) =>
          command.operation === "app_create" ||
          command.operation === "app_duplicate"
            ? [output!.results[index] as CanvasApp]
            : [],
        )
        .at(-1);
      if (created) {
        activateApp(created.id);
        createdAppId.value = created.id;
      }
      if (geometryApp.value)
        geometryApp.value = workspace.apps.find(
          (a) => a.id === geometryApp.value?.id,
        );
      if (managedApp.value)
        managedApp.value = workspace.apps.find(
          (a) => a.id === managedApp.value?.id,
        );
      if (dockContext.value)
        dockContext.value = workspace.apps.find(
          (app) => app.id === dockContext.value?.id,
        );
      if (!apps.value.some((a) => a.id === active.value)) active.value = "";
      if (!workspace.groups?.some((g) => g.id === selectedGroup.value))
        selectedGroup.value = "";
    }
    await focusRequested();
    return { results: output?.results || [{ restored: true }], changed: true };
  } catch (error) {
    if (committed) {
      status.value =
        "The MCP edit was saved, but the view could not refresh. Reload this tab before editing again.";
      loadError.value = true;
      canEdit.value = false;
      throw Error(status.value);
    }
    if (error instanceof Error && error.message.startsWith("No local recovery"))
      throw error;
    throw Error(
      "The MCP edit could not be saved. The workspace was kept unchanged. Check the local backend and retry after reading the workspace.",
    );
  } finally {
    mcpBusy.value = false;
    importBusy.value = false;
    if (!committed) saveTimer = setTimeout(() => void persist(), SAVE_DELAY);
  }
}
const runtimeErrors = reactive<Record<string, string>>({});
async function run(app: CanvasApp, block: Block) {
  if (!canEdit.value || importBusy.value || app.deleted) return;
  activeExecutions.value++;
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
  } finally {
    activeExecutions.value--;
  }
}
function focusIn(e: FocusEvent, app: CanvasApp) {
  activateApp(app.id);
  canvasScroll.owner = app.id;
  if (e.target instanceof HTMLElement && typing(e.target))
    lastFocus.set(app.id, e.target);
}
function shortcutChanged(key: keyof Workspace["shortcuts"]) {
  const value = (workspace.shortcuts[key] ?? "").toLowerCase().slice(-1);
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
      emptyWorkspace().shortcuts[key]!,
      ..."abcdefghijklmnopqrstuvwxyz0123456789",
    ].find((k) => !occupied.includes(k))!;
  } else {
    workspace.shortcuts[key] = value;
    status.value = "";
  }
}
function beforeUnload(event: BeforeUnloadEvent) {
  resumeWorkspaceTracking();
  if (!unsavedChanges.value) return;
  event.preventDefault();
  event.returnValue = "";
}
function restorePage(event: PageTransitionEvent) {
  if (event.persisted) location.reload();
}
function hidePage() {
  // Capture the latest in-memory state before synchronously queuing the final
  // beacon. Deferring lease release to a microtask can lose it on navigation.
  resumeWorkspaceTracking();
  void persist();
  void store.close();
}
onMounted(() => {
  dockResize = new ResizeObserver(measureDock);
  if (dockTabs.value) dockResize.observe(dockTabs.value);
  if (dockMeasure.value) dockResize.observe(dockMeasure.value);
  const setMaximized = (maximized: boolean) => { windowMaximized.value = maximized; };
  stopWindowMaximized = desktopWindow?.onWindowMaximized?.(setMaximized);
  void desktopWindow?.isWindowMaximized?.().then(setMaximized).catch(() => undefined);
  window.addEventListener("blur", endWindowDrag);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("blur", flushSave);
  window.addEventListener("pageshow", restorePage);
  window.addEventListener("online", persist);
  document.addEventListener("pointerdown", dismissOutside, true);
  window.addEventListener("blur", dismissOnBlur);
  void initialize();
  mcpBridge = connectMcpBridge({
    writable: () =>
      ready.value && canEdit.value && store.writer && !loadError.value,
    revision: () => workspaceRevision.value,
    execute: executeMcp,
  });
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("keydown", keydown);
  window.addEventListener("keydown", captureWheelKey, true);
  window.addEventListener("keyup", keyup);
  window.addEventListener("pointermove", trackWheelPointer);
  window.addEventListener("resize", resize);
  window.addEventListener("blur", pointerUp);
  window.addEventListener("pagehide", hidePage);
  window.addEventListener("wheel", wheel, { passive: false });
  window.addEventListener("orvane-canvas-pan", embeddedPan);
  window.addEventListener("orvane:place-file", placeFileEvent);
  window.addEventListener(WORKBENCH_WIDGET, workbenchEvent);
  window.addEventListener("keydown", paletteKeys, true);
  window.addEventListener("keydown", spaceDown, true);
  window.addEventListener("keyup", spaceUp, true);
  window.addEventListener("pointermove", hoverPan, { passive: true });
  window.addEventListener("orvane:space", spaceEvent);
  stopTouchpad = (window as unknown as {
    orvaneDesktop?: { onTouchpad?: (cb: (input: { fx?: number; fy?: number; end?: boolean }) => void) => () => void };
  }).orvaneDesktop?.onTouchpad?.(touchpadInput);
  window.addEventListener(ACTIVATE_EVENT, activatedApp);
  window.addEventListener("orvane:open-link", openLinkEvent);
  window.addEventListener("orvane:palette", paletteEvent);
  window.addEventListener("paste", pasteImage);
  window.addEventListener("pointermove", trackPointer, { passive: true });
});
onBeforeUnmount(() => {
  dockResize?.disconnect();
  stopWindowMaximized?.();
  window.removeEventListener("blur", endWindowDrag);
  endWindowDrag();
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("blur", flushSave);
  window.removeEventListener("pageshow", restorePage);
  window.removeEventListener("online", persist);
  mcpBridge?.close();
  window.removeEventListener("orvane-canvas-pan", embeddedPan);
  window.removeEventListener("orvane:place-file", placeFileEvent);
  window.removeEventListener(WORKBENCH_WIDGET, workbenchEvent);
  window.removeEventListener("keydown", paletteKeys, true);
  window.removeEventListener("keydown", spaceDown, true);
  window.removeEventListener("keyup", spaceUp, true);
  window.removeEventListener("pointermove", hoverPan);
  window.removeEventListener("orvane:space", spaceEvent);
  stopTouchpad?.();
  window.removeEventListener(ACTIVATE_EVENT, activatedApp);
  window.removeEventListener("orvane:open-link", openLinkEvent);
  window.removeEventListener("orvane:palette", paletteEvent);
  window.removeEventListener("paste", pasteImage);
  window.removeEventListener("pointermove", trackPointer);
  clearTimeout(dropNoticeTimer);
  stopPan();
  stopZoom();
  document.removeEventListener("pointerdown", dismissOutside, true);
  window.removeEventListener("blur", dismissOnBlur);
  void persist().finally(() => store.close());
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("keydown", captureWheelKey, true);
  window.removeEventListener("keyup", keyup);
  window.removeEventListener("pointermove", trackWheelPointer);
  window.removeEventListener("resize", resize);
  window.removeEventListener("blur", pointerUp);
  window.removeEventListener("pagehide", hidePage);
  window.removeEventListener("wheel", wheel);
  clearTimeout(saveTimer);
  document.removeEventListener("visibilitychange", visibilityChanged);
});
</script>
<template>
  <main
    class="workspace"
    :inert="mcpBusy || !ready"
    :data-ready="ready"
    :data-saved="!unsavedChanges"
    :data-editable="canEdit && ready"
    :class="{ frameless }"
    @pointerdown.capture="touchStart"
    @pointermove.capture="touchMove"
    @pointerup.capture="touchEnd"
    @pointercancel.capture="touchEnd"
    @pointerdown="pointerDown($event)"
    @pointermove="pointerMove"
    @pointerup="pointerUp"
    @pointercancel="pointerUp"
    @lostpointercapture="pointerUp"
    @dragover="canvasDragOver"
    @drop="canvasDrop"
    @click="
      !dragging &&
      (($event.target as HTMLElement).classList.contains('canvas-background') ||
        $event.target === $event.currentTarget) &&
      ((panel = null), (boardSelected = ''))
    "
  >
    <div class="canvas-background"></div>
    <div v-if="dropNotice" class="drop-notice" role="status">{{ dropNotice }}</div>
    <BoardTools
      v-if="ready && canEdit"
      v-model:tool="boardTool"
      v-model:color="boardColor"
      :board="boardView"
      :apps="apps"
      :all-apps="workspace.apps"
      :camera="camera"
      @created="boardCreated"
    />
    <AppTooltip />
    <CommandPalette
      v-if="palette !== null"
      :apps="workspace.apps"
      :initial="palette"
      @close="palette = null"
      @focus-app="focusAppById"
      @focus-block="focusBlock"
    />
    <ActionStudio
      v-if="actionStudio"
      :workspace="workspace"
      :initial-id="studioActionId"
      :create-on-open="!!studioWheelEntry && !studioActionId"
      :writable="canEdit && !importBusy"
      :notice="actionNotice"
      :running="actionRunning"
      :opening-from="studioOrigin"
      @close="actionStudio = false"
      @created="assignCreatedAction"
      @run="runWheelAction"
    />
    <div
      v-if="actionNotice && !actionStudio"
      class="action-notice floating-panel"
      role="status"
      @pointerdown.stop
    >
      <span>{{ actionNotice }}</span
      ><button
        class="icon-button"
        aria-label="Dismiss action result"
        @click="actionNotice = ''"
      >
        <Icon name="close" :size="13" />
      </button>
    </div>
    <div
      v-if="wheelOpen"
      class="radial-overlay"
      @contextmenu.prevent.stop="wheelBack"
      @pointerdown.stop
      @click.self="
        wheelSelected?.kind === 'group' && (wheelParent = wheelSelected.id)
      "
    >
      <div class="radial-wheel" aria-label="Action wheel">
        <button
          ref="wheelCenter"
          class="radial-center"
          :class="{ selected: wheelCenterSelected }"
          aria-label="Edit wheel config"
          @click.stop="openWheelConfig(wheelCenter)"
        >
          <Icon name="settings" :size="18" /><strong>Edit config</strong>
          <small>{{
            wheelCenterSelected
              ? "Release Alt+Q to edit"
              : wheelSelected?.name || "Point to select"
          }}</small>
          <small v-if="wheelParent">Right-click to go back</small>
        </button>
        <button
          v-for="(_, index) in wheelSlotCount"
          :key="index"
          class="radial-entry"
          :disabled="!wheelEntries[index]"
          :aria-label="wheelEntries[index]?.name || 'Empty slot'"
          :class="{
            selected:
              wheelSelected && wheelSelected.id === wheelEntries[index]?.id,
          }"
          :style="{ clipPath: wheelSegment(index) }"
          @click.stop="
            wheelEntries[index]?.kind === 'group' &&
            (wheelParent = wheelEntries[index]!.id)
          "
        >
          <span
            v-if="wheelEntries[index]"
            class="radial-entry-content"
            :style="{
              left: `${50 + 36 * Math.sin((index * 2 * Math.PI) / wheelSlotCount)}%`,
              top: `${50 - 36 * Math.cos((index * 2 * Math.PI) / wheelSlotCount)}%`,
            }"
            ><Icon
              :name="
                wheelEntries[index]?.kind === 'group'
                  ? 'layers'
                  : wheelEntries[index]?.kind === 'action'
                    ? workspace.actions?.find(
                        (a) => a.id === wheelEntries[index]?.actionId,
                      )?.icon || 'workflow'
                    : apps.find((a) => a.id === wheelEntries[index]?.appId)
                        ?.icon || 'app'
              "
              :size="22"
            /><span>{{ wheelEntries[index]?.name }}</span></span
          >
        </button>
        <svg class="radial-outline" viewBox="0 0 100 100" aria-hidden="true">
          <path
            v-if="wheelSelected"
            :d="
              wheelArc(
                wheelEntries.findIndex((e) => e.id === wheelSelected?.id),
              )
            "
          />
        </svg>
      </div>
    </div>
    <div
      v-if="wheelEditing"
      class="wheel-config-backdrop"
      @pointerdown.stop
      @click.self="closeWheelConfig"
      @keydown="wheelConfigKeys"
    >
      <section
        ref="wheelEditor"
        class="wheel-editor floating-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Edit action wheel"
        @pointerdown.stop
      >
        <div class="panel-heading">
          <h1>Action wheel</h1>
          <button
            class="icon-button"
            aria-label="Close wheel editor"
            @click="closeWheelConfig"
          >
            <Icon name="close" />
          </button>
        </div>
        <p class="field-help">
          Hold Alt+Q on the canvas. Point to an action and release. Click groups;
          right-click to go back.
        </p>
        <button v-if="wheelParent" class="subtle-button" @click="wheelBack">
          Back to parent
        </button>
        <div
          v-for="entry in wheelEntries"
          :key="entry.id"
          class="wheel-editor-entry"
        >
          <input
            v-model="entry.name"
            :disabled="!canEdit"
            aria-label="Wheel entry name"
          />
          <CustomSelect
            v-if="entry.kind === 'app'"
            v-model="entry.appId"
            :disabled="!canEdit"
            aria-label="Destination app"
            search-label="Search apps"
            :options="apps.map((app) => ({ value: app.id, label: app.name }))"
            placeholder="Choose an app"
          />
          <template v-else-if="entry.kind === 'action'">
            <CustomSelect
              v-model="entry.actionId"
              aria-label="Assigned action"
              :options="
                (workspace.actions || []).map((a) => ({
                  value: a.id,
                  label: a.name,
                }))
              "
              placeholder="Choose action"
              @change="
                entry.name =
                  workspace.actions?.find((a) => a.id === entry.actionId)
                    ?.name || 'Action'
              "
            />
            <button
              class="subtle-button"
              @click="
                openActionStudio(
                  entry.actionId,
                  entry.id,
                  $event.currentTarget as HTMLElement,
                )
              "
            >
              {{ entry.actionId ? "Edit graph" : "Create action" }}
            </button>
            <label
              v-for="input in workspace.actions?.find(
                (a) => a.id === entry.actionId,
              )?.inputs || []"
              :key="input"
              class="property"
              ><span>{{ input }}</span
              ><input
                :value="entry.bindings?.[input] || ''"
                :aria-label="`Wheel input ${input}`"
                @input="
                  (entry.bindings ||= {})[input] = (
                    $event.target as HTMLInputElement
                  ).value
                "
            /></label>
          </template>
          <button v-else class="subtle-button" @click="wheelParent = entry.id">
            Open group
          </button>
          <button
            class="subtle-button"
            :disabled="!canEdit"
            @click="wheelRemove(entry.id)"
          >
            Remove
          </button>
        </div>
        <p v-if="!wheelEntries.length" class="field-help">
          This ring is empty. Add an action or a group.
        </p>
        <div class="workspace-action-row">
          <button
            class="subtle-button"
            :disabled="!canEdit"
            @click="wheelAdd('action')"
          >
            <Icon name="plus" :size="13" />Add action</button
          ><button
            class="subtle-button"
            :disabled="!canEdit"
            @click="wheelAdd('group')"
          >
            Add group</button
          ><button
            class="subtle-button"
            @click="
              openActionStudio('', '', $event.currentTarget as HTMLElement)
            "
          >
            Action library
          </button>
        </div>
      </section>
    </div>
    <div class="topbar-frost" aria-hidden="true"></div>
    <header class="topbar" @pointerdown.stop>
      <div class="wordmark" :class="{ 'restore-drag': restoreDrag }"
        @pointerdown="beginWindowDrag" @pointermove="moveWindowDrag" @pointerup="endWindowDrag($event)"
        @pointercancel="endWindowDrag($event)" @lostpointercapture="endWindowDrag($event)"
        @dblclick="restoreDrag && desktopWindow?.toggleWindowMaximized?.()">
        <img src="/favicon.png" width="18" height="18" alt="" />
        <span>orvane</span><span class="workspace-label">Personal canvas</span>
      </div>
      <div
        v-if="hint && canEdit"
        class="context-hint"
        role="status"
        @pointerdown.stop
      >
        <span>{{ hintText }}</span
        ><button class="subtle-button" @click="dismissHint">Got it</button>
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
          aria-label="Layouts"
          @click="panel === 'layouts' ? (panel = null) : openLayouts()"
        >
          <Icon name="app" :size="14" /><span>{{
            layouts.find((l) => l.id === workspace.activeLayout)?.name || "Layouts"
          }}</span>
        </button>
        <span v-if="ready && !canEdit" class="field-help">Read-only tab</span>
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
          <Icon name="settings" /></button
        ><button
          v-if="desktopWindow?.toggleWindowMaximized"
          type="button"
          class="icon-button window-size"
          :aria-label="windowMaximized ? 'Restore Orvane window' : 'Maximize Orvane window'"
          :title="windowMaximized ? 'Restore window' : 'Maximize window'"
          @click="desktopWindow.toggleWindowMaximized()"
        >
          <Icon :name="windowMaximized ? 'shrink' : 'expand'" />
        </button
        ><button
          v-if="frameless"
          class="icon-button window-close"
          aria-label="Close Orvane"
          title="Close"
          @click="desktopWindow?.closeWindow?.()"
        >
          <Icon name="close" />
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
    <!-- Toggling inert restyles the whole subtree, so the plane does not
         repeat it while the workspace above is already inert for an MCP edit. -->
    <div
      class="canvas-plane"
      v-show="ready"
      :inert="!canEdit || (importBusy && !mcpBusy)"
      :class="{ 'camera-moving': movingCamera }"
      :style="{
        transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
      }"
    >
      <BoardLayer
        v-if="workspace.board"
        :board="workspace.board"
        :apps="apps"
        :all-apps="workspace.apps"
        :zoom="camera.zoom"
        :tool="boardTool"
        :editable="canEdit && !importBusy"
        :selected="boardSelected"
        :edit-note="boardEditNote"
        :stack-level="noteStackLevel"
        @select="selectBoardItem"
        @erase="eraseBoardItem"
        @edit-note="boardEditNote = $event"
        @open-link="openNoteLink"
        @saved-note="status = 'Sticky note saved to Notes.'"
      />
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
            @pointerdown.stop="groupPointerDown($event, group.id)"
            @click="groupClick($event, group.id)"
          >
            <Icon name="layers" :size="12" /><span>{{
              group.name || "Untitled group"
            }}</span
            ><small>{{ group.members.length }}</small
            ><Icon name="edit" :size="11" />
          </button>
          <div
            v-for="edge in ['n', 'e', 's', 'w']"
            :key="edge"
            class="group-drag-edge"
            :class="`group-edge-${edge}`"
            @pointerdown.stop="groupPointerDown($event, group.id)"
          ></div></div
      ></template>
      <!-- Focus mode: covers the rest of the canvas behind the focused app. -->
      <div
        v-if="focused"
        class="focus-backdrop"
        :style="{
          left: -camera.x + 'px',
          top: -camera.y + 'px',
          width: viewport.width + 'px',
          height: viewport.height + 'px',
          zIndex: stack.length + 3,
        }"
        @pointerdown.stop
      ></div>
      <div
        v-for="app in apps"
        :key="`${renderGeneration}:${app.id}`"
        class="canvas-app"
        :class="{
          'scroll-owner': canvasScroll.owner === app.id,
          'focused-app': focused?.id === app.id,
        }"
        :data-app-id="app.id"
        :style="{
          left: app.x + 'px',
          top: app.y + 'px',
          width: (focused?.id === app.id ? focused.rect.width : app.width) + 'px',
          height: (focused?.id === app.id ? focused.rect.height : app.height) + 'px',
          zIndex: focused?.id === app.id ? stack.length + 4 : (stackLevel('app', app.id) ?? 1),
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
        <section
          v-if="!mountedApps.has(app.id)"
          class="app-surface app-pending"
          aria-busy="true"
          :aria-label="app.name"
          :style="{ '--app-radius': app.radius + 'px' }"
        >
          <div v-if="app.showName !== false" class="app-topline">
            <span class="app-name app-title">{{
              app.name || "Untitled app"
            }}</span>
          </div>
        </section>
        <AppSurface
          v-else
          :ref="
            (el) => {
              if (el)
                appViews[app.id] = el as unknown as {
                  openView: (
                    view: 'settings' | 'graph',
                    target: string,
                  ) => void;
                };
              else delete appViews[app.id];
            }
          "
          :app="app"
          :workspace="workspace"
          :enter-motion="createdAppId === app.id"
          :focused="focused?.id === app.id"
          @focus="enterFocus"
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
    <div ref="panShield" class="pan-shield" aria-hidden="true"></div>
    <div
      v-if="status"
      class="status-area"
      :class="{ 'status-warning': statusIsProblem }"
      :role="statusIsProblem ? 'alert' : 'status'"
      @pointerdown.stop
    >
      <Icon
        class="status-icon"
        :name="statusIsProblem ? 'alert' : 'info'"
        :size="15"
      />
      <span class="status-text">{{ status }}</span
      ><button
        v-if="status.startsWith('Saving')"
        class="subtle-button"
        @click="persist"
      >
        Retry saving</button
      ><button
        v-if="loadError || !canEdit || status.startsWith('Saving')"
        class="subtle-button"
        @click="exportWorkspace()"
      >
        Export current data</button
      ><button
        v-if="loadError"
        class="subtle-button"
        @click="exportWorkspace(true)"
      >
        Export stored data</button
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
        <button
          v-if="!query || /help|guide|gesture/i.test(query)"
          class="subtle-button"
          @click="panel = 'help'"
        >
          Canvas guide: gestures and building
        </button>
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
        <Icon name="layers" /><span
          >Move a group<small
            >Drag its label or border to move its apps together</small
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
        Saved to SQLite on this computer. Browsers connected to this Orvane
        server share the same workspace.
      </p>
      <button class="subtle-button" @click="home">
        <Icon name="box" :size="14" />Center canvas
      </button>
    </section>
    <section
      v-if="panel === 'workspace' && !pendingImport"
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
      <p class="field-help">
        Saved on this computer. Shared across browsers connected to this server.
      </p>
      <button class="subtle-button" @click="openInbox">
        <Icon name="archive" :size="14" />Workspace inbox
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer()"
      >
        <Icon name="git" :size="14" />Create Git viewer
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer('projects')"
      >
        <Icon name="folder" :size="14" />Create Projects Hub
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer('notes')"
      >
        <Icon name="text" :size="14" />Create Notes
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer('browser')"
      >
        <Icon name="globe" :size="14" />Create Browser
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer('netsuite')"
      >
        <Icon name="globe" :size="14" />Create NetSuite app
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer('certificates')"
      >
        <Icon name="key" :size="14" />Create Certificate manager
      </button>
      <button class="subtle-button" :disabled="!canEdit || importBusy" @click="createGitViewer('claude')">
        <Icon name="text" :size="14" />Create Claude sessions
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer('files')"
      >
        <Icon name="folder-open" :size="14" />Create File Explorer
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer('calendar')"
      >
        <Icon name="calendar" :size="14" />Create Calendar
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="createGitViewer('terminal')"
      >
        <Icon name="terminal" :size="14" />Create Terminal
      </button>
      <button
        class="subtle-button"
        :disabled="!canEdit || importBusy"
        @click="recoverBrowserWorkspace"
      >
        Recover earlier browser workspace
      </button>
      <button
        class="subtle-button"
        @click="openWheelConfig($event.currentTarget as HTMLElement, true)"
      >
        Edit action wheel
      </button>
      <button
        class="subtle-button"
        @click="openActionStudio('', '', $event.currentTarget as HTMLElement)"
      >
        <Icon name="workflow" :size="14" />Action library
      </button>
      <button
        class="subtle-button"
        @click="restoreSnapshot"
        :disabled="!canEdit || importBusy"
      >
        Restore previous workspace
      </button>
      <div class="workspace-action-row">
        <button class="subtle-button" @click="exportWorkspace()">
          <Icon name="download" :size="14" />Export backup</button
        ><button
          class="subtle-button"
          @click="importInput?.click()"
          :disabled="!canEdit || importBusy"
        >
          <Icon name="upload" :size="14" />Import backup
        </button>
      </div>
      <button
        class="subtle-button examples-action"
        :disabled="!canEdit || importBusy"
        @click="addExamples"
      >
        <Icon name="app" :size="14" />Add example apps
      </button>
      <p class="field-help">
        Import previews Merge or Replace. A local recovery snapshot keeps your
        current workspace safe.
      </p>
      <div v-if="displays.length" class="settings-section">
        <div class="section-line">
          <Icon name="box" :size="14" />Window
        </div>
        <label class="property"
          >Open on monitor<CustomSelect
            v-model="displayChoice"
            aria-label="Monitor for the Orvane window"
            :options="displays"
            placeholder="Primary monitor"
            @change="chooseDisplay"
        /></label>
        <p class="field-help">
          Orvane moves there now and opens there next time.
        </p>
      </div>
      <div class="settings-section">
        <div class="section-line">
          <Icon name="keyboard" :size="14" />Keyboard shortcuts
        </div>
        <label
          v-for="(label, key) in {
            create: 'New app',
            search: 'Find app',
            home: 'Center canvas',
            focus: 'Focus app full-window',
          }"
          :key="key"
          class="shortcut-row"
          ><span>{{ label }}</span
          ><input
            v-model="workspace.shortcuts[key]"
            :disabled="!canEdit || importBusy"
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
            :disabled="!canEdit || importBusy"
            @click="
              a.archived = false;
              a.deleted = false;
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
      v-if="panel === 'layouts'"
      class="groups-panel layouts-panel floating-panel"
      :inert="!canEdit"
      v-motion="{ kind: 'popover' }"
      aria-label="Layouts"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h1>Layouts</h1>
        <button class="icon-button" aria-label="Close layouts" @click="panel = null">
          <Icon name="close" />
        </button>
      </div>
      <p class="field-help">
        A layout remembers where each app sits, which apps are shown and the
        view. Switching never changes what is inside an app.
      </p>
      <div v-if="layouts.length" class="layout-list">
        <div
          v-for="l in layouts"
          :key="l.id"
          class="layout-row"
          :class="{ current: l.id === workspace.activeLayout }"
        >
          <button class="layout-switch" :title="`Switch to ${l.name}`" @click="applyLayout(l.id)">
            <Icon :name="l.id === workspace.activeLayout ? 'check' : 'app'" :size="13" />
          </button>
          <input
            :value="l.name"
            :aria-label="`Layout name: ${l.name}`"
            maxlength="80"
            @change="renameLayout(l.id, ($event.target as HTMLInputElement).value)"
            @keydown.enter="applyLayout(l.id)"
          />
          <button class="icon-button" title="Save the current arrangement into this layout" :aria-label="`Update ${l.name}`" @click="updateLayout(l.id)">
            <Icon name="download" :size="13" /></button
          ><button class="icon-button" :aria-label="`Delete ${l.name}`" title="Delete layout" @click="deleteLayout(l.id)">
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </div>
      <form class="group-picker" @submit.prevent="saveLayout()">
        <input
          ref="layoutNameInput"
          v-model="layoutName"
          class="layout-name"
          placeholder="Coding, Research, NetSuite…"
          aria-label="New layout name"
          maxlength="80"
        /><button class="subtle-button" type="submit">
          <Icon name="plus" :size="13" />Save current
        </button>
      </form>
      <div class="section-line">
        <span>Shown in this view</span><span>{{ apps.length }} / {{ liveApps.length }}</span>
      </div>
      <div class="group-members">
        <label v-for="app in liveApps" :key="app.id" class="group-member"
          ><input
            type="checkbox"
            :checked="!app.layoutHidden"
            :aria-label="`Show ${app.name || 'Untitled'}`"
            @change="app.layoutHidden = !($event.target as HTMLInputElement).checked"
          /><Icon :name="app.icon" :size="13" /><span>{{ app.name || "Untitled" }}</span></label
        >
      </div>
    </section>
    <section
      v-if="panel === 'groups'"
      class="groups-panel floating-panel"
      :inert="!canEdit"
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
        Drag a group label or border to move its apps together. Individual apps
        still move independently.
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
          }}<CustomNumber
            v-model="geometryApp[key]"
            :aria-label="label"
            :min="
              key === 'width'
                ? appMinimum(geometryApp).width
                : key === 'height'
                  ? appMinimum(geometryApp).height
                  : undefined
            "
        /></label>
      </div>
      <button class="subtle-button" @click="focusApp(geometryApp)">
        <Icon name="box" :size="14" />Center this app
      </button>
    </section>

    <WorkspaceInbox
      v-if="inboxOpen"
      v-model:draft="inboxDraft"
      :captures="workspace.inbox ?? []"
      :busy="inboxBusy"
      :editable="canChangeInbox"
      :desktop="!!desktopWindow?.readInboxClipboard"
      :message="inboxMessage"
      @close="inboxOpen = false"
      @save="saveInboxDraft"
      @paste-image="saveInboxImage"
      @clipboard="readInboxClipboard"
      @move="moveCapture"
    />
    <section
      v-if="pendingImport"
      class="import-preview floating-panel"
      aria-label="Backup import preview"
      role="dialog"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h2>Import backup</h2>
        <button
          class="icon-button"
          aria-label="Cancel import"
          @click="pendingImport = undefined"
        >
          <Icon name="close" />
        </button>
      </div>
      <p>
        {{ pendingImport.apps.length }} apps /
        {{ pendingImport.customNodes.length }} reusable actions
      </p>
      <p class="field-help">
        Merge adds independent copies and keeps existing positions and dock
        order. Replace swaps the workspace. Both keep a local recovery snapshot.
      </p>
      <p v-for="issue in importIssues" :key="issue" class="inline-error">
        {{ issue }}
      </p>
      <div class="workspace-action-row">
        <button
          class="subtle-button"
          :disabled="importBusy || !!importIssues.length"
          @click="commitImport('merge')"
        >
          Merge</button
        ><button
          class="subtle-button"
          :disabled="importBusy || !!importIssues.length"
          @click="commitImport('replace')"
        >
          Replace
        </button>
      </div>
    </section>
    <section
      v-if="dockContext && canEdit"
      class="dock-context floating-panel"
      aria-label="App quick actions"
      @pointerdown.stop
    >
      <button
        class="subtle-button"
        @click="
          manage(dockContext);
          nextTick(() => managementName?.focus());
        "
      >
        Rename
      </button>
      <button class="subtle-button" @click="duplicate(dockContext)">
        Duplicate
      </button>
      <button class="subtle-button" @click="manage(dockContext)">
        Manage app
      </button>
      <button class="subtle-button" @click="dockContext = undefined">
        Close
      </button>
    </section>
    <section
      v-if="managedApp && canEdit"
      class="management-panel floating-panel"
      aria-label="Manage app"
      role="dialog"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h2>Manage app</h2>
        <button
          class="icon-button"
          aria-label="Close app management"
          @click="managedApp = undefined"
        >
          <Icon name="close" />
        </button>
      </div>
      <label class="property"
        >App name<input
          ref="managementName"
          v-model="managedApp.name"
          aria-label="Managed app name"
      /></label>
      <p class="field-help">
        {{
          managementDependencies.length
            ? "Connected apps: " +
              managementDependencies.map((a) => a.name || "Untitled").join(", ")
            : "No incoming app connections"
        }}. Connections pause while this app is archived or in trash. Restoring
        it restores the same IDs and data.
      </p>
      <div class="workspace-action-row">
        <button class="subtle-button" @click="retireApp(false)">
          Archive app</button
        ><button class="subtle-button" @click="retireApp(true)">
          Move to trash
        </button>
      </div>
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
      <div ref="dockTabs" class="dock-tabs">
        <div ref="dockMeasure" class="dock-measure" aria-hidden="true">
          <span v-for="a in apps" :key="a.id" class="dock-measure-tab">
            <Icon :name="a.icon" :size="15" /><span>{{ a.name || "Untitled" }}</span>
          </span>
          <span v-if="!apps.length" class="empty-dock-label">Your canvas</span>
        </div>
        <div class="dock-primary">
        <template v-for="(a, index) in apps" :key="a.id">
        <Teleport :to="dockOverflow || 'body'" :disabled="index < dockVisibleCount || !dockOverflow">
        <button
          class="dock-tab"
          :style="{ order: index }"
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
          @contextmenu.prevent="canEdit && (dockContext = a)"
          @keydown.shift.f10.prevent="canEdit && (dockContext = a)"
          @click="chooseDockApp(a, index >= dockVisibleCount)"
          :title="a.group ? `${a.name} · ${a.group}` : a.name"
        >
          <Icon :name="a.icon" :size="15" /><span>{{
            a.name || "Untitled"
          }}</span></button>
        </Teleport>
        </template>
        <span v-if="!apps.length" class="empty-dock-label">Your canvas</span>
        </div>
        <button
          v-show="dockVisibleCount < apps.length"
          ref="dockOverflowButton"
          type="button"
          class="icon-button dock-action dock-overflow-trigger"
          aria-label="More apps"
          title="More apps"
          :aria-expanded="dockOverflowOpen"
          aria-controls="dock-overflow"
          @click="toggleDockOverflow"
        ><Icon name="more" :size="17" /></button>
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
        :disabled="!canEdit || importBusy"
        title="Create a blank app"
        @click="createApp"
      >
        <Icon name="plus" :size="19" />
      </button>
      <div v-show="dockOverflowOpen" id="dock-overflow" ref="dockOverflow" class="dock-overflow select-popover" role="group" aria-label="More canvas apps"></div>
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
