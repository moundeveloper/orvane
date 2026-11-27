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
  toRaw,
  watch,
  defineAsyncComponent,
  h,
} from "vue";
import { WorkspaceStorage, LEGACY_STORAGE } from "./storage";
import { useWorkspaceAppearance } from "./useWorkspaceAppearance";
import { TERMINAL_DARK, useTerminalTint } from "./terminalTint";
import { THEME_PRESETS, type ThemeBackgroundType, type WorkspaceTheme } from "./workspaceTheme";
import AppearanceSettings from "./components/AppearanceSettings.vue";
import ThemeCanvasBackground from "./components/ThemeCanvasBackground.vue";
import { trackWorkspace } from "./workspaceTracking";
import { connectMcpBridge, type BridgeRequest } from "./mcpBridge";
import { applyCommands, duplicateApp, type RunRequest } from "./automation";
import { runBrowserAgent, runHostBrowser, setBrowserAgentContext } from "./browserAgent";
import { parseWorkspace, referenceIssues } from "./validation";
import { mergeWorkspace } from "./imports";
import { executeGraph } from "./flow";
import AppSurface from "./components/AppSurface.vue";
import DockActionMenu, { type DockAction } from "./components/DockActionMenu.vue";
import AppTooltip from "./components/AppTooltip.vue";
import { exampleApps, upgradeExampleApps } from "./examples";
import { runIsolated } from "./sandbox";
import Icon from "./components/Icon.vue";
import MemoryPanel from "./components/MemoryPanel.vue";
import SiteMemoryView from "./components/SiteMemoryView.vue";
import SessionChat from "./components/SessionChat.vue";
import SessionList from "./components/SessionList.vue";
import CustomSelect from "./components/CustomSelect.vue";
import CustomNumber from "./components/CustomNumber.vue";
import { migrateGroups, groupBounds } from "./groups";
import { vMotion } from "./motion";
import { closeWheel, openWheel, wheelLevelHooks, type WheelExit } from "./wheelMotion";
import { importDrop, importImageData, importImageFile, importPath, mayHoldImage, measure, type PlacedImage } from "./imageDrop";
import { isImage, peekKind } from "./components/files/explorer";
import { isBackup, makeBackup, restoreBackgrounds, restoreImages } from "./backup";
import { OPEN_EVENT, registerCommands, type OpenRequest } from "./commands";
import { MOCK_READY_OPEN, type MockReadyOpen } from "./mockReady";
import { ACTIVATE_EVENT, BROWSER_SHORTCUT, canvasScroll } from "./canvasScroll";
import { dayKey, dueAt, formatDay, readCalendar, type CalendarItem } from "./calendar";
import { captureLink, CAPTURE_TEXT_LIMIT, INBOX_LIMIT, type ClipboardCapture, type InboxCapture } from "./inbox";
import WorkspaceInbox, { type CaptureDestination } from "./components/WorkspaceInbox.vue";
import { sendToNotes } from "./agentMessageNotes";
import { addRun, type AutomationRun, type RunSource } from "./automationRuns";
import { netSuiteCanvas, querySource, readRecordPreview, RECORD_PREVIEW_MIME, type RecordPreviewLink, type SuiteQLSelection } from "./netsuiteCanvas";
import { WORKBENCH_WIDGET, workbenchEditable, type WorkbenchKind } from "./workbenchWidgets";
import { DRAG_MIME } from "./components/files/explorer";
import CommandPalette from "./components/CommandPalette.vue";
import AgentLauncher from "./components/AgentLauncher.vue";
import { AGENT_REVEAL, agentOpenRequests, agentRunIndicators, PIN_AGENT_DRAFT, type AgentDraft, type AgentReveal } from "./agentNavigation";
import { CLAUDE_LOGIN_EVENT, type ClaudeLoginDetail } from "./claudeAccounts";
import { readTerminal, panes as terminalPanes } from "./terminalLayout";
import { agentRequest } from "./exposition";
import { agentNames, type AgentRun } from "./agentSessions";
import {
  configureHarness,
  harness,
  openRunFromAlert,
  sendSelection,
  startActivity,
  stopActivity,
} from "./agentHarness";
import BoardLayer from "./components/BoardLayer.vue";
import BoardTools from "./components/BoardTools.vue";
import CanvasRewind from "./components/CanvasRewind.vue";
import { captureRewind, restoreRewind, type RewindEntry } from "./canvasRewind";
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
import { latestOccurrence, triggerDue, type Trigger } from "./triggers";
const STORAGE = LEGACY_STORAGE;
// Desktop window controls for the frameless top bar.
const desktopWindow = (
  window as unknown as {
    orvaneDesktop?: {
      frameless?: boolean;
      closeWindow?: () => void;
      restartDesktop?: (action: "schedule" | "status" | "cancel") => Promise<unknown>;
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
      isFullScreen?: () => Promise<boolean>;
      setFullScreen?: (on: boolean) => Promise<boolean>;
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
// Maximized (the taskbar stays) or full screen; F11 toggles it too.
const windowModes = [
  { value: "maximized", label: "Maximized" },
  { value: "fullscreen", label: "Full screen · F11" },
];
const windowMode = ref("maximized");
async function loadWindowMode() {
  windowMode.value = (await desktopWindow?.isFullScreen?.().catch(() => false)) ? "fullscreen" : "maximized";
}
async function chooseWindowMode() {
  await desktopWindow?.setFullScreen?.(windowMode.value === "fullscreen");
}
// Restart Orvane from its own UI (Workspace settings → Window, or Ctrl+K),
// the same restart agents schedule with desktop_restart: it waits for running
// agent turns and the workspace save, then relaunches. Pressed again while it
// waits, it cancels.
const canRestart = !!desktopWindow?.restartDesktop;
const restartWaiting = ref<"" | "agent-turns" | "workspace-save" | "starting">("");
let restartPoll: ReturnType<typeof setInterval> | undefined;
function restartSeen(result: unknown) {
  const state = (result ?? {}) as { state?: string; waitingFor?: string };
  restartWaiting.value =
    state.state === "pending" ? (state.waitingFor === "agent-turns" || state.waitingFor === "workspace-save" ? state.waitingFor : "starting") : "";
  if (!restartWaiting.value) {
    clearInterval(restartPoll);
    restartPoll = undefined;
  }
}
async function restartOrvane() {
  if (!desktopWindow?.restartDesktop) return;
  try {
    if (restartWaiting.value) return restartSeen(await desktopWindow.restartDesktop("cancel"));
    flushSave();
    restartSeen(await desktopWindow.restartDesktop("schedule"));
    if (restartWaiting.value && !restartPoll)
      restartPoll = setInterval(() => void desktopWindow.restartDesktop!("status").then(restartSeen, () => restartSeen(null)), 1000);
  } catch (error) {
    restartSeen(null);
    status.value = error instanceof Error ? error.message : String(error);
  }
}
const restartLabel = computed(() =>
  restartWaiting.value === "agent-turns"
    ? "Waiting for agents · Cancel"
    : restartWaiting.value === "workspace-save"
      ? "Saving the workspace · Cancel"
      : restartWaiting.value
        ? "Restarting… · Cancel"
        : "Restart Orvane",
);
// The library pulls in the graph editor, which can take seconds to load the
// first time (much longer under the dev server): say so at once, and load it
// ahead when the window is idle after startup.
const loadActionStudio = () => import("./components/ActionStudio.vue");
const CustomToolsPanel = defineAsyncComponent(() => import("./components/CustomToolsPanel.vue"));
const customToolsOpen = ref(false);
function openCustomTools() {
  panel.value = null;
  customToolsOpen.value = true;
}
const ActionStudio = defineAsyncComponent({
  loader: loadActionStudio,
  delay: 0,
  loadingComponent: {
    render: () =>
      h("section", { class: "action-studio-loading floating-panel", role: "status" }, "Opening Action library…"),
  },
});
const actionStudio = ref(false),
  studioActionId = ref(""),
  studioView = ref<"actions" | "timeline">("actions"),
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
function openActionStudio(id = "", entryId = "", trigger?: HTMLElement, view: "actions" | "timeline" = "actions") {
  studioView.value = view;
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
  loadError = ref(""),
  ready = ref(false),
  canEdit = ref(false);
const statusText = computed(() => loadError.value || status.value);
// Confirmations read as neutral notes; everything else needs attention.
const statusIsProblem = computed(
  () =>
    loadError.value ||
    !/ (moved to trash|archived)\. Restore it|^(App|Canvas arrangement) restored\.$|^Backup includes \d+ images?\.$/.test(status.value),
);
// Same conditions as the status action buttons in the template.
const statusHasActions = computed(
  () => loadError.value || !canEdit.value || status.value.startsWith("Saving"),
);
// Advisory statuses with no actions go away on their own.
let statusTimer: ReturnType<typeof setTimeout> | undefined;
watch([status, statusHasActions], ([text, actions]) => {
  clearTimeout(statusTimer);
  if (!text || actions) return;
  statusTimer = setTimeout(
    () => {
      if (status.value === text) status.value = "";
    },
    statusIsProblem.value ? 6000 : 4000,
  );
});
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
// Editing came back after the lease lapsed and nobody else saved: keep the
// workspace on screen and save it.
store.onResume(async () => {
  if (loadError.value) return;
  canEdit.value = true;
  if (status.value.startsWith("Editing ownership changed")) status.value = "";
  await persist();
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
async function openWorkspaceForEditing() {
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
    loadError.value = "";
    await persist();
    // Undo starts from the canvas as it opened (examples included).
    resetCanvasHistory();
  } catch (error) {
    canEdit.value = false;
    loadError.value = error instanceof Error
      ? error.message
      : "Your saved workspace could not be opened. Export the stored data to recover it.";
  } finally {
    ready.value = true;
  }
}
async function initialize(retry = false) {
  try {
    let opened = false;
    await store.start(async () => {
      opened = true;
      await openWorkspaceForEditing();
    });
    if (retry && !opened && store.writer) await openWorkspaceForEditing();
    if (!canEdit.value && !loadError.value) await refresh();
    ready.value = true;
    if (!canEdit.value && !loadError.value)
      status.value =
        "Read-only here. Changes from the editing browser appear automatically. Editing transfers when it closes.";
  } catch (error) {
    ready.value = true;
    canEdit.value = false;
    loadError.value =
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
const retryingWorkspace = ref(false);
async function retryOpeningWorkspace() {
  if (retryingWorkspace.value || unsavedChanges.value) return;
  retryingWorkspace.value = true;
  try {
    await initialize(true);
  } finally {
    retryingWorkspace.value = false;
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
  // The viewport already ends left of the pinned side chat.
  return { x: left, y: top, width: Math.max(200, viewport.width - left - margin), height: bottom - top };
}
/** Point the camera so the focused app's corner sits at the focus area's. */
function placeFocus() {
  const f = focused.value;
  const app = f && workspace.apps.find((a) => a.id === f.id);
  if (!f || !app) return;
  f.rect = focusArea();
  // The app's own interface is shown at actual size; only web pages keep the
  // size they were read at on the canvas (focusPageZoom).
  camera.zoom = 1;
  camera.x = f.rect.x - app.x;
  camera.y = f.rect.y - app.y;
}
/** Canvas zoom the focused app was read at: its Browser pages keep it, so
 * focusing gives a page more room without making its content bigger. */
const focusPageZoom = computed(() =>
  focused.value ? Math.min(2, Math.max(0.5, focused.value.camera.zoom || 1)) : 1,
);
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
    "search" | "workspace" | "appearance" | "help" | "geometry" | "groups" | "layouts" | "memory" | "site-memory" | null
  >(null),
  query = ref(""),
  searchInput = ref<HTMLInputElement>(),
  importInput = ref<HTMLInputElement>(),
  geometryApp = ref<CanvasApp>();
const appearanceButton = ref<HTMLButtonElement>();
const optionsButton = ref<HTMLButtonElement>();
const {
  theme: appearance, dirty: appearanceDirty, changeCount: appearanceChanges, reduced: appearanceReduced, previewReduced,
  systemReduced, saving: appearanceSaving, error: appearanceError, paletteStyle,
  discard: discardAppearance, close: releaseAppearance, update: updateAppearance,
  importMedia: importAppearanceMedia, importPaletteImage: importAppearancePaletteImage, apply: applyAppearance,
} = useWorkspaceAppearance(
  () => workspace.appearance,
  (id, file) => store.uploadThemeMedia(id, file),
  saveAppearance,
);
const terminalDark = useTerminalTint(appearance);
provide(TERMINAL_DARK, terminalDark);
async function saveAppearance(theme: WorkspaceTheme) {
  store.assertWriter();
  const previous = workspace.appearance;
  workspace.appearance = theme;
  try {
    await store.write(workspace);
  } catch (error) {
    if (toRaw(workspace.appearance) === theme) {
      if (previous) workspace.appearance = previous;
      else delete workspace.appearance;
    }
    throw error;
  }
}
function openAppearance() {
  if (!canEdit.value || importBusy.value || appearanceSaving.value) return;
  discardAppearance();
  panel.value = "appearance";
}
function leaveAppearance(back = false) {
  panel.value = back ? "workspace" : null;
  void nextTick(() => (back ? appearanceButton.value : optionsButton.value)?.focus());
}
function dismissAppearanceFromGuest() {
  if (panel.value === "appearance") panel.value = null;
}
watch(panel, (open, previous) => {
  if (previous === "appearance" && open !== "appearance") releaseAppearance();
});
const appearanceSummary = computed(() => {
  const { preset, backgroundType } = appearance.value;
  const name = THEME_PRESETS.find((item) => item.id === preset)?.name ?? (preset === "image" ? "Image" : "Custom");
  return `${name} · ${backgroundType.charAt(0).toUpperCase()}${backgroundType.slice(1)}`;
});
// The palette also lives on <html> so shell popovers teleported to <body>
// (dropdowns, tooltips) follow it. The default palette sets nothing.
const ROOT_THEME_VARS = {
  "--theme-canvas": "--theme-canvas", "--theme-surface": "--surface", "--theme-text": "--theme-text",
  "--theme-accent": "--accent", "--theme-run": "--theme-run",
} as const;
watch(paletteStyle, (style: Partial<Record<string, string>>) => {
  const root = document.documentElement;
  root.classList.toggle("orvane-themed", !!style["--theme-canvas"]);
  for (const [name, source] of Object.entries(ROOT_THEME_VARS)) {
    const value = style[source];
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
}, { immediate: true });
onBeforeUnmount(() => {
  document.documentElement.classList.remove("orvane-themed");
  for (const name of Object.keys(ROOT_THEME_VARS)) document.documentElement.style.removeProperty(name);
});
// Monitors can be plugged in or removed, so read them each time.
watch(panel, (open) => {
  if (open === "workspace") void (loadDisplays(), loadWindowMode());
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
// Orvane memory: entries an AI saved that wait for the owner's review.
const memoryPending = ref(0);
async function pullMemoryCount() {
  if (document.visibilityState !== "visible") return;
  try {
    const response = await fetch("/__orvane/workspace-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "count" }),
    });
    if (response.ok) memoryPending.value = (await response.json()).unreviewed ?? 0;
  } catch {
    /* the count is a hint; the panel shows errors */
  }
}
// Site memory (Browser): routes, notes, flows and test plans waiting for the owner.
const siteMemoryPending = ref(0);
async function pullSiteMemoryCount() {
  if (document.visibilityState !== "visible") return;
  try {
    const response = await fetch("/__orvane/site-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pending" }),
    });
    if (response.ok) siteMemoryPending.value = (await response.json()).count ?? 0;
  } catch {
    /* the count is a hint; the panel shows errors */
  }
}
const memoryCountTimer = setInterval(() => {
  void pullMemoryCount();
  void pullSiteMemoryCount();
}, 20_000);
onBeforeUnmount(() => clearInterval(memoryCountTimer));
void pullMemoryCount();
void pullSiteMemoryCount();
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
// A failed save is retried quietly a few times; the warning appears only
// when saving keeps failing.
const SAVE_RETRIES = [500, 1000, 2000];
let saveFailures = 0;
async function persist() {
  if (!canEdit.value || loadError.value || applying) return;
  const revision = workspaceRevision.value;
  try {
    await store.write(workspace);
    saveFailures = 0;
    if (revision === workspaceRevision.value) unsavedChanges.value = false;
    if (
      status.value.startsWith("Saving") ||
      status.value.startsWith("Read-only")
    )
      status.value = "";
  } catch {
    if (store.conflicted) return;
    const retry = SAVE_RETRIES[saveFailures++];
    if (retry !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void persist(), retry);
      return;
    }
    saveFailures = 0;
    status.value =
      "Saving is unavailable. Your changes are still here; export a backup from Workspace or retry saving.";
  }
}
const rewind = ref<InstanceType<typeof CanvasRewind>>();
const rewindOpen = ref(false);
const rewindPreview = ref(false);
const rewindLoading = ref(false);
const rewindBusy = ref(false);
const rewindError = ref("");
const rewindEntries = ref<RewindEntry[]>([]);
const rewindApps = computed(() => captureRewind(workspace).apps);
let rewindRequest = 0;
async function openRewind() {
  if (rewindOpen.value || importBusy.value || gesture || loadError.value) return;
  const request = ++rewindRequest;
  if (focused.value) exitFocus();
  panel.value = null;
  rewindEntries.value = [];
  rewindError.value = "";
  rewindOpen.value = true;
  rewindLoading.value = true;
  try {
    if (unsavedChanges.value && canEdit.value) {
      clearTimeout(saveTimer);
      await persist();
    }
    const entries = await store.canvasRewind();
    if (request === rewindRequest) rewindEntries.value = entries;
  } catch (cause) {
    if (request === rewindRequest)
      rewindError.value = cause instanceof Error ? cause.message : "Canvas history could not be loaded.";
  } finally {
    if (request === rewindRequest) rewindLoading.value = false;
  }
}
function closeRewind() {
  if (rewindBusy.value) return;
  rewindRequest++;
  rewindOpen.value = false;
  rewindPreview.value = false;
}
async function restoreRewindEntry(entry: RewindEntry, appId?: string) {
  if (!canEdit.value || importBusy.value || gesture || !rewindOpen.value) return;
  if (activeExecutions.value) {
    rewindError.value = "Wait for the current action to finish before restoring.";
    return;
  }
  if (appId && !workspace.apps.some((app) => app.id === appId)) return;
  rewindBusy.value = true;
  importBusy.value = true;
  rewindError.value = "";
  clearTimeout(saveTimer);
  try {
    const before = JSON.parse(JSON.stringify(workspace)) as Workspace;
    const next = JSON.parse(JSON.stringify(before)) as Workspace;
    restoreRewind(next, entry.state, appId);
    await store.write(next, "Before canvas rewind", before);
    if (canvasRecordTimer) recordCanvas();
    restoreRewind(workspace, entry.state, appId);
    recordCanvas();
    clearTimeout(saveTimer);
    unsavedChanges.value = false;
    if (active.value && !apps.value.some((app) => app.id === active.value)) active.value = "";
    status.value = appId ? "App restored." : "Canvas arrangement restored.";
    rewindBusy.value = false;
    closeRewind();
  } catch (cause) {
    rewindError.value = cause instanceof Error ? cause.message : "The arrangement could not be restored.";
    if (unsavedChanges.value && canEdit.value) void persist();
  } finally {
    rewindBusy.value = false;
    importBusy.value = false;
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
  claude: { name: "Agent sessions", icon: "agent-sessions" },
  git: { name: "Git viewer", icon: "git" },
  projects: { name: "Projects Hub", icon: "folder" },
  notes: { name: "Notes", icon: "text" },
  uimaker: { name: "UI Maker", icon: "edit", width: 1280, height: 800 },
  browser: { name: "Browser", icon: "globe" },
  netsuite: { name: "NetSuite", icon: "globe" },
  certificates: { name: "Certificate manager", icon: "key" },
  files: { name: "File Explorer", icon: "folder-open" },
  calendar: { name: "Calendar", icon: "calendar", width: 780, height: 520 },
  "flow-tests": { name: "Test runs", icon: "video", width: 1040, height: 620 },
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
  return app;
}
// ---- Claude account sign-in: a Terminal whose only pane runs `claude auth
// login` for one account. The server prepared the command from the ticket;
// the page only names the ticket. ----
const claudeLoginApps = new Map<string, string>();
function claudeLoginEvent(event: Event) {
  const detail = (event as CustomEvent<ClaudeLoginDetail>).detail;
  if (!detail || typeof detail.ticket !== "string" || !/^[\w-]{10,64}$/.test(detail.ticket)) return;
  const known = claudeLoginApps.get(detail.ticket);
  if (known && workspace.apps.some((a) => a.id === known && !a.archived)) return focusAppById(known);
  const restored = workspace.apps.find((app) => !app.archived && flatten(app.blocks).some((block) =>
    block.kind === "terminal" && readTerminal(block.value).tabs.some((tab) =>
      terminalPanes(tab.root).some((pane) => pane.profile === `claude-login:${detail.ticket}`))));
  if (restored) {
    claudeLoginApps.set(detail.ticket, restored.id);
    return focusAppById(restored.id);
  }
  if (detail.show) {
    status.value = "The sign-in Terminal was closed. Cancel the sign-in in Settings and start it again.";
    return;
  }
  if (!canEdit.value) {
    status.value = "This window can't add apps right now. Sign in from the window that edits the workspace.";
    return;
  }
  const pane = `login-${uid()}`.slice(0, 60);
  const tab = `tab-${uid()}`.slice(0, 60);
  const state = {
    tabs: [{ id: tab, name: `Claude sign-in · ${String(detail.name).slice(0, 40)}`, root: { type: "pane", id: pane, profile: `claude-login:${detail.ticket}` }, focus: pane }],
    active: tab,
  };
  const app = createGitViewer("terminal", JSON.stringify(state));
  if (app) {
    app.name = `Claude sign-in · ${String(detail.name).slice(0, 40)}`;
    claudeLoginApps.set(detail.ticket, app.id);
  }
}
// ---- Command palette (Ctrl+K) ----
const palette = ref<string | null>(null);
const agentLauncher = ref(false);
// ---- Side chat: one agent session pinned to the right of the window ----
const SIDE_KEY = "orvane.side-chat.v1";
const sideSaved = (() => {
  try {
    return JSON.parse(localStorage.getItem(SIDE_KEY) ?? "{}") as {
      key?: string; draft?: AgentDraft; open?: boolean; collapsed?: boolean; width?: number;
    };
  } catch {
    return {};
  }
})();
/** The session pinned last (kept when unpinned, for Ctrl+Shift+J). */
const sideSession = ref(sideSaved.key ?? "");
const sideDraft = ref(sideSaved.draft);
const latestSideDraft = ref(sideSaved.draft);
const hasSideSession = computed(() => Boolean(sideSession.value || sideDraft.value));
const sideOpen = ref(!!(sideSaved.open && hasSideSession.value));
/** Pinned but folded into the small bubble at the right edge. */
const sideCollapsed = ref(!!sideSaved.collapsed);
const sideSwitching = ref(false);
const sideChat = ref<{ focus(): void }>();
/** The pinned panel's width: dragged on its left edge, kept between these
 * limits (the widest leaves at least half the window to the canvas). */
const SIDE_MIN = 320;
const sideMax = () => Math.max(SIDE_MIN, Math.min(720, Math.round(window.innerWidth / 2)));
const sideWidth = ref(Math.min(sideMax(), Math.max(SIDE_MIN, Number(sideSaved.width) || 384)));
/** Width the pinned panel takes from the canvas (panel plus its margin). */
const sideReserve = () =>
  sideOpen.value && hasSideSession.value && !sideCollapsed.value && window.innerWidth >= 800 ? sideWidth.value + 12 : 0;
/** The canvas viewport is the window minus the pinned panel, so Home and focus fit what is left. */
const sideReserved = ref(0);
function measureViewport() {
  sideReserved.value = sideReserve();
  viewport.width = window.innerWidth - sideReserved.value;
  viewport.height = window.innerHeight;
}
measureViewport();
function saveSideChat() {
  try {
    localStorage.setItem(
      SIDE_KEY,
      JSON.stringify({ key: sideSession.value, draft: latestSideDraft.value, open: sideOpen.value, collapsed: sideCollapsed.value, width: sideWidth.value }),
    );
  } catch {
    /* only a convenience */
  }
}
function updateSideDraft(value: AgentDraft) {
  if (!sideDraft.value) return;
  latestSideDraft.value = value;
  saveSideChat();
}
watch([sideSession, sideDraft, sideOpen, sideCollapsed, sideWidth], () => {
  measureViewport();
  saveSideChat();
  if (focused.value) void nextTick(placeFocus);
});
const sideTitle = ref("");
const sideProvider = ref("claude");
const sideLabel = computed(() => sideDraft.value ? "New session" : sideTitle.value || "Session");
watch(
  sideSession,
  async (key) => {
    sideTitle.value = "";
    if (!key) return;
    sideProvider.value = key.startsWith("codex:") ? "codex" : "claude";
    try {
      const { sessions } = await agentRequest<{ sessions: { key: string; title: string; provider?: string }[] }>("sessions");
      const session = sessions.find((s) => s.key === key);
      if (sideSession.value !== key) return;
      sideTitle.value = session?.title || "Untitled session";
      if (session?.provider) sideProvider.value = session.provider;
    } catch {
      /* the chat shows its own errors */
    }
  },
  { immediate: true },
);
/** The switcher closes on a click outside it (in the panel or anywhere else). */
function closeSideSwitch(event: Event) {
  const target = event.target as Element | null;
  if (sideSwitching.value && !target?.closest(".side-chat-list,.side-chat-switch")) sideSwitching.value = false;
}
function outsideSideSwitch(event: PointerEvent) {
  if (!(event.target as Element | null)?.closest(".side-chat")) sideSwitching.value = false;
}
watch(sideSwitching, (open) => {
  // The switcher opens on its search field.
  if (open) void nextTick(() => document.querySelector<HTMLInputElement>(".side-chat-list .session-search input")?.focus({ preventScroll: true }));
  if (open) document.addEventListener("pointerdown", outsideSideSwitch, true);
  else document.removeEventListener("pointerdown", outsideSideSwitch, true);
});
window.addEventListener("orvane:guest-pointer-down", () => (sideSwitching.value = false));
// Resizing the pinned panel: drag its left edge, or ←/→ on the focused edge
// (Shift for bigger steps), Home/End for the narrowest/widest.
const sideResizing = ref(false);
function setSideWidth(width: number) {
  sideWidth.value = Math.round(Math.min(sideMax(), Math.max(SIDE_MIN, width)));
}
function sideResizeDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  sideResizing.value = true;
  const startX = event.clientX;
  const startWidth = sideWidth.value;
  const move = (e: PointerEvent) => {
    if (e.pointerId === event.pointerId) setSideWidth(startWidth + startX - e.clientX);
  };
  const finish = () => {
    sideResizing.value = false;
    handle.removeEventListener("pointermove", move);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("lostpointercapture", finish, { once: true });
}
function sideResizeKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 64 : 16;
  const next =
    event.key === "ArrowLeft" ? sideWidth.value + step
    : event.key === "ArrowRight" ? sideWidth.value - step
    : event.key === "Home" ? SIDE_MIN
    : event.key === "End" ? sideMax()
    : null;
  if (next === null) return;
  event.preventDefault();
  setSideWidth(next);
}
// A smaller window narrows a panel that no longer fits its limit.
window.addEventListener("resize", () => {
  if (sideWidth.value > sideMax()) setSideWidth(sideWidth.value);
});
/** What the pinned session's run is doing, and which run. */
const sideRunState = computed((): { state: "waiting" | "working" | "idle"; runId?: string } => {
  if (sideDraft.value) {
    const runId = latestSideDraft.value?.runId;
    const run = runId ? agentRunIndicators.get(runId) : undefined;
    return !run || !["running", "stopping"].includes(run.status)
      ? { state: "idle" }
      : { state: run.awaitingApproval ? "waiting" : "working", runId: run.id };
  }
  let path = "";
  const sideProvider = sideSession.value.startsWith("codex:") ? "codex" : "claude";
  const sideProfile = /^claude@([^:]+):/.exec(sideSession.value)?.[1] ?? "default";
  try {
    const key = sideSession.value.replace(/^(?:codex:|claude@[^:]+:)/, "");
    path = atob(key.replace(/-/g, "+").replace(/_/g, "/")).toLowerCase();
  } catch {
    return { state: "idle" };
  }
  const run = harness.runs.find(
    (r) => r.provider === sideProvider && (sideProvider !== "claude" || (r.profileId ?? "default") === sideProfile) &&
      r.sessionId && ["running", "stopping"].includes(r.status) &&
      (r.key ? r.key === sideSession.value : path.includes(r.sessionId.toLowerCase())),
  );
  return !run ? { state: "idle" } : { state: run.awaitingApproval ? "waiting" : "working", runId: run.id };
});
// Done (the Lively bubble's happy state): a run that completed while the
// chat was folded into its bubble. A failed or stopped run is not "done".
// Opening the chat, a new run or another pinned session clears it.
const sideDoneRun = ref("");
let sideLastRun = "";
watch(sideRunState, (now) => {
  if (now.runId) {
    sideLastRun = now.runId;
    sideDoneRun.value = "";
    return;
  }
  if (!sideLastRun) return;
  const id = sideLastRun;
  sideLastRun = "";
  const finished = harness.runs.find((r) => r.id === id) ?? agentRunIndicators.get(id);
  if (sideCollapsed.value && finished?.status === "completed") sideDoneRun.value = id;
});
watch([sideCollapsed, sideSession], ([collapsed], [, before]) => {
  if (!collapsed || sideSession.value !== before) sideDoneRun.value = "";
});
/** What the pinned session is doing, for the collapsed bubble. */
const sideState = computed((): "waiting" | "working" | "done" | "idle" =>
  sideRunState.value.state === "idle" && sideDoneRun.value ? "done" : sideRunState.value.state,
);
function collapseSideChat(collapse: boolean) {
  sideCollapsed.value = collapse;
  if (collapse) sideSwitching.value = false;
}
/** Continue with another model: while the pinned panel shows a source (or a
 * continued session) opened from another one, this goes back to where you
 * were: a draft, which keeps what you typed, or a session. */
const sideBack = ref<{ label: string; draft?: AgentDraft; key?: string } | null>(null);
function sideRevealEvent(event: Event) {
  const detail = (event as CustomEvent<AgentReveal>).detail;
  if (detail.blockId !== "session-chat:side") return;
  if (detail.paneId === "side" || (sideBack.value && detail.key && detail.key === sideBack.value.key)) return goSideBack();
  if (!detail.key || detail.key === sideSession.value) return;
  const back = sideDraft.value
    ? { label: `Draft · New ${agentNames[latestSideDraft.value?.provider ?? sideDraft.value.provider]} session`,
        draft: latestSideDraft.value ?? sideDraft.value }
    : sideSession.value ? { label: sideTitle.value || "Session", key: sideSession.value } : null;
  pinSession(detail.key);
  sideBack.value = back;
}
function goSideBack() {
  const back = sideBack.value;
  sideBack.value = null;
  if (back?.draft) pinDraft(back.draft);
  else if (back?.key) pinSession(back.key);
}
function pinSession(key: string) {
  sideBack.value = null;
  sideDraft.value = latestSideDraft.value = undefined;
  sideSession.value = key;
  sideOpen.value = true;
  sideCollapsed.value = false;
  agentLauncher.value = false;
  sideSwitching.value = false;
}
function pinDraft(value: AgentDraft) {
  sideBack.value = null;
  sideSession.value = "";
  sideDraft.value = latestSideDraft.value = value;
  sideOpen.value = true;
  sideCollapsed.value = false;
  sideSwitching.value = false;
  agentLauncher.value = false;
  void nextTick(() => sideChat.value?.focus());
}
function pinDraftEvent(event: Event) {
  pinDraft((event as CustomEvent<AgentDraft>).detail);
}
function promoteSideDraft(key: string) {
  if (sideDraft.value) pinSession(key);
}
function unpinSideChat() {
  if (sideDraft.value) sideDraft.value = latestSideDraft.value;
  sideOpen.value = false;
}
const agentLauncherPanel = ref<{ pinChosen(): boolean }>();
function toggleSideChat() {
  // The launcher can pin the draft or the session it shows.
  if (agentLauncher.value && agentLauncherPanel.value?.pinChosen()) return;
  // Pinned: Ctrl+Shift+J folds the panel into its bubble and back.
  if (sideOpen.value) collapseSideChat(!sideCollapsed.value);
  else if (hasSideSession.value) {
    sideOpen.value = true;
    sideCollapsed.value = false;
  }
  else {
    // Nothing pinned yet: pick a session in the launcher.
    agentLauncher.value = true;
    status.value = "Pin a new task or pick a session in the launcher.";
  }
}
const agentStarting = ref(false);
const agentDockButton = ref<HTMLElement>();
const agentPopovers = ref<HTMLElement>();
const agentDockStatus = computed(() => {
  const runs = [...agentRunIndicators.values()];
  if (runs.some((run) => run.awaitingApproval)) return "Needs approval";
  if (runs.some((run) => run.status === "running" || run.status === "stopping")) return "Running";
  const latest = runs.at(-1)?.status;
  return latest === "failed" ? "Failed" : latest === "completed" ? "Done" : undefined;
});
function openAgentLauncher() {
  if (!canEdit.value || importBusy.value || agentStarting.value) return;
  palette.value = null;
  agentLauncher.value = true;
}
function toggleAgentLauncher() {
  if (agentStarting.value) return;
  if (agentLauncher.value) agentLauncher.value = false;
  else openAgentLauncher();
}
function dockIcon(app: CanvasApp) {
  return app.icon === "text" && flatten(app.blocks).some(block => block.kind === "claude")
    ? "agent-sessions"
    : app.icon;
}
// The Agent sessions app, opened (or created) without changing what it shows.
function openAgentSessionsApp() {
  const existing = workspace.apps.find((app) =>
    !app.archived && !app.deleted && flatten(app.blocks).some((block) => block.kind === "claude"),
  );
  if (existing) {
    if (existing.layoutHidden && canEdit.value) existing.layoutHidden = false;
    void focusApp(existing);
  } else if (canEdit.value) createGitViewer("claude");
}
async function sendAgentSelection(from?: Element | null) {
  const problem = await sendSelection(from);
  if (problem) status.value = problem;
}
function openAgentActivity() {
  harness.activityOpen = true;
  openAgentSessionsApp();
}
configureHarness({
  appName: (appId) => workspace.apps.find((app) => app.id === appId)?.name ?? "",
  apps: () =>
    [...workspace.apps]
      .reverse()
      .filter((app) => !app.archived && !app.deleted && !app.layoutHidden)
      .map((app) => ({ id: app.id, name: app.name, icon: dockIcon(app) })),
  focusApp: (appId) => focusAppById(appId),
  openSessions: openAgentSessionsApp,
  openRun: (runId) => {
    void agentRequest<AgentRun | null>("inspect-run", { id: runId })
      .then((run) => run && openAgentSession({ run }))
      .catch(() => undefined);
  },
});
function sendSelectionEvent(event: Event) {
  void sendAgentSelection((event as CustomEvent<Element | null>).detail);
}
function openAgentSession(request: Parameters<typeof agentOpenRequests.set>[1]) {
  const existing = workspace.apps.find((app) =>
    !app.archived && !app.deleted && flatten(app.blocks).some((block) => block.kind === "claude"),
  );
  const app = existing ?? createGitViewer("claude");
  if (!app) return;
  if (app.layoutHidden && canEdit.value) app.layoutHidden = false;
  const block = flatten(app.blocks).find((entry) => entry.kind === "claude");
  if (block) agentOpenRequests.set(block.id, request);
  if (existing) void focusApp(app);
}
// Ctrl+K (search and commands) and Ctrl+Shift+P (commands only) are caught
// in the capture phase, before apps that keep keys to themselves. Notes
// search lives on Alt+K, so Ctrl+K opens the palette inside Notes too.
function paletteKeys(e: KeyboardEvent) {
  if (!ready.value || inboxOpen.value || !(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  // Agent sessions: Ctrl+Shift+L sends the selection, Ctrl+Alt+U opens activity.
  if (e.altKey && !e.shiftKey && key === "u") {
    e.preventDefault();
    e.stopPropagation();
    openAgentActivity();
    return;
  }
  if (e.altKey) return;
  if (key === "l" && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    void sendAgentSelection();
    return;
  }
  if (key === "k" && e.shiftKey && canEdit.value && !importBusy.value) {
    e.preventDefault();
    e.stopPropagation();
    toggleAgentLauncher();
    return;
  }
  // Ctrl+Shift+J: pin or unpin the side chat (the last session pinned).
  if (key === "j" && e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    toggleSideChat();
    return;
  }
  // Ctrl+Shift+A: type in the pinned side chat.
  if (key === "a" && e.shiftKey && sideOpen.value && hasSideSession.value) {
    e.preventDefault();
    e.stopPropagation();
    if (sideCollapsed.value) collapseSideChat(false);
    void nextTick(() => sideChat.value?.focus());
    return;
  }
  const commands = key === "p" && e.shiftKey;
  if (!commands && !(key === "k" && !e.shiftKey)) return;
  e.preventDefault();
  e.stopPropagation();
  openPalette(commands ? ">" : "");
}
function openPalette(initial: string) {
  if (agentStarting.value) return;
  agentLauncher.value = false;
  palette.value = palette.value === null ? initial : null;
}
// Web pages in the Browser app forward the same shortcuts.
function paletteEvent(event: Event) {
  const detail = String((event as CustomEvent<string>).detail ?? "");
  if (detail === "agent") openAgentLauncher();
  else openPalette(detail);
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
/** A "mock ready" card in Agent sessions: open UI Maker on it, the same way
 * the uimaker_open tool does (focus the app, then show the round or version). */
function mockReadyOpenEvent(event: Event) {
  const detail = (event as CustomEvent<MockReadyOpen>).detail;
  detail.opened = runForMcp({
    kind: "uimaker-open",
    component: detail.component,
    mode: detail.mode,
    ...(detail.version ? { version: detail.version } : {}),
    ...(detail.lab ? { lab: detail.lab } : {}),
  });
}
function openLinkEvent(event: Event) {
  const detail = (event as CustomEvent<{ link?: NoteLink; external?: boolean; sourceBlockId?: string }>).detail;
  const link = detail?.link;
  if (!link || !["file", "folder", "page"].includes(link.kind) || typeof link.target !== "string") return;
  if (link.kind === "page" && !/^https?:\/\//i.test(link.target)) return;
  void openNoteLink(link, !!detail.external, detail.sourceBlockId);
}
// "Open in Git" from an agent run: show that repository in the Git viewer.
async function openGitEvent(event: Event) {
  const path = (event as CustomEvent<{ path?: string }>).detail?.path;
  if (typeof path !== "string" || !path) return;
  const app = liveApps.value.find((a) => flatten(a.blocks).some((b) => b.kind === "git"));
  const block = app && flatten(app.blocks).find((b) => b.kind === "git");
  if (!app || !block) {
    status.value = "Add a Git app to open this repository.";
    return;
  }
  try {
    const { gitRequest } = await import("./git");
    const workspace = await gitRequest<{ id: string }>("git_workspace_add", { path });
    block.gitWorkspaceId = workspace.id;
  } catch (error) {
    status.value = error instanceof Error ? error.message : "The repository could not be opened.";
    return;
  }
  if (app.layoutHidden && canEdit.value) app.layoutHidden = false;
  await focusApp(app);
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
    } else if (destination === "notes" && capture.kind === "text") {
      const title = capture.value.trim().split(/\r?\n/, 1)[0]!.slice(0, 120) || "Inbox capture";
      await sendToNotes(title, capture.value);
      if (!workspace.inbox?.includes(capture)) return;
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
      notes: "Sent to Notes.",
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
// ---- Scheduled triggers (src/triggers.ts) ----
// Checked with reminders, by the editing window only, so each runs once.
const runningTriggers = new Set<string>();
async function runTrigger(trigger: Trigger, at = Date.now()) {
  if (runningTriggers.has(trigger.id)) throw Error(`${trigger.name} is already running.`);
  runningTriggers.add(trigger.id);
  trigger.lastRun = at;
  activeExecutions.value++;
  const workflow = workspace.actions?.find((a) => a.id === trigger.workflowId);
  try {
    if (!workflow) throw Error(`Workflow ${trigger.workflowId} no longer exists.`);
    const result = await executeWorkspaceAction(workflow.id, trigger.inputs, 0, [], "", {
      source: "trigger",
      triggerId: trigger.id,
    });
    delete trigger.lastError;
    return { trigger: trigger.name, workflow: workflow.name, result };
  } catch (error) {
    trigger.lastError = error instanceof Error ? error.message : String(error);
    traces.value.unshift({
      id: uid(),
      from: `Trigger: ${trigger.name}`,
      to: workflow?.name || trigger.workflowId,
      action: "Scheduled run",
      at: new Date().toLocaleTimeString(),
      error: trigger.lastError,
    });
    traces.value = traces.value.slice(0, 30);
    throw error;
  } finally {
    runningTriggers.delete(trigger.id);
    activeExecutions.value--;
  }
}
/** Action library → Triggers → Run now. */
function runTriggerById(id: string) {
  const trigger = workspace.triggers?.find((t) => t.id === id);
  if (!trigger) return Promise.reject(Error("That trigger no longer exists."));
  if (!canEdit.value || importBusy.value) return Promise.reject(Error("The workspace is not editable right now."));
  return runTrigger(trigger);
}
function checkTriggers() {
  if (!ready.value || !canEdit.value || importBusy.value) return;
  const now = Date.now();
  for (const trigger of workspace.triggers || []) {
    if (runningTriggers.has(trigger.id)) continue;
    const { due, stale } = triggerDue(trigger, now);
    if (!due) continue;
    const at = trigger.schedule.kind === "interval" ? latestOccurrence(trigger, now)! : now;
    // Missed for more than a day while Orvane was closed: skip quietly.
    if (stale) trigger.lastRun = at;
    else void runTrigger(trigger, at).catch(() => undefined);
  }
}
const reminderTimer = setInterval(() => {
  checkReminders();
  checkTriggers();
}, 15_000);
watch(ready, (isReady) => {
  if (!isReady) return;
  checkReminders();
  checkTriggers();
});
const stopNotificationClicks = desktopWindow?.onNotificationClick?.(
  (appId) => openRunFromAlert(appId) || focusAppById(appId),
);
onBeforeUnmount(() => {
  clearInterval(reminderTimer);
  stopNotificationClicks?.();
});
const stopCanvasCommands = registerCommands("canvas", () => {
  const writable = canEdit.value && !importBusy.value;
  const tools: [keyof typeof toolApps, string][] = [
    ["files", "folder-open"],
    ["notes", "text"],
    ["uimaker", "edit"],
    ["browser", "globe"],
    ["git", "git"],
    ["projects", "folder"],
    ["netsuite", "globe"],
    ["calendar", "calendar"],
    ["flow-tests", "video"],
    ["terminal", "terminal"],
  ];
  return [
    { id: "custom-tools", title: "Custom tools", icon: "code", detail: "Workspace", keywords: "mcp agent tools chain code", run: openCustomTools },
    { id: "canvas-rewind", title: "Canvas rewind", icon: "clock", detail: "Canvas", keywords: "history restore arrangement", run: openRewind },
    { id: "workspace-inbox", title: "Open workspace inbox", icon: "archive", detail: "Workspace", keywords: "capture clipboard screenshot", run: openInbox },
    { id: "automation-timeline", title: "Automation timeline", icon: "clock", detail: "Action library", keywords: "workflow trigger runs history schedule failed", run: () => openActionStudio("", "", undefined, "timeline") },
    ...(writable ? [
      { id: "workspace-appearance", title: "Appearance settings", icon: "settings", detail: "Workspace", keywords: "theme palette wallpaper background", run: openAppearance },
      { id: "agent-launcher", title: "Open AI launcher", icon: "ai", hint: "Ctrl+Shift+K", keywords: "new task agent Codex Claude prompt", run: openAgentLauncher },
      { id: "agent-send-selection", title: "Add selection to agent session", icon: "agent-sessions", hint: "Ctrl+Shift+L", keywords: "quote selected text terminal page Claude Codex context", run: () => void sendAgentSelection() },
      { id: "agent-activity", title: "Agent activity", icon: "agent-sessions", hint: "Ctrl+Alt+U", keywords: "waiting approval running done sessions alerts", run: openAgentActivity },
      { id: "agent-keep-awake", title: harness.settings.keepAwake ? "Stop keeping the PC awake for agents" : "Keep the PC awake while agents run", icon: "agent-sessions", keywords: "sleep power awake agent turn", run: () => { harness.settings.keepAwake = !harness.settings.keepAwake; } },
      { id: "agent-alerts", title: harness.settings.alerts ? "Turn off agent alerts" : "Turn on agent alerts", icon: "agent-sessions", keywords: "notifications approval finished Claude Codex", run: () => { harness.settings.alerts = !harness.settings.alerts; } },
      { id: "folder-compare", title: "Compare two folders", icon: "columns", detail: "Canvas", run: () => placeWorkbench("folder-compare", {}) },
      { id: "test-results", title: "Pin Playwright results", icon: "terminal", detail: "Canvas", run: () => placeWorkbench("test-results", {}) },
    ] : []),
    ...(canRestart
      ? [{ id: "desktop-restart", title: restartWaiting.value ? "Cancel the Orvane restart" : "Restart Orvane", icon: "refresh", detail: "Window", keywords: "restart reload relaunch reboot desktop app", run: restartOrvane }]
      : []),
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
          { id: "memory", title: "Memory", icon: "library", detail: "Orvane", keywords: "remember preferences procedures ai notes", run: () => (panel.value = "memory") },
          { id: "site-memory", title: "Site memory", icon: "globe", detail: "Browser", keywords: "routes notes flows test plans approve websites", run: () => (panel.value = "site-memory") },
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
// Load the Action library ahead once the workspace is idle after startup.
let studioWarmed = false;
watch(ready, (isReady) => {
  if (!isReady || studioWarmed) return;
  studioWarmed = true;
  idle(() => void loadActionStudio().catch(() => undefined), 3000);
}, { immediate: true });
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
  if (rewindPreview.value && e.button === 0 && boardTool.value !== "select") return;
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
// Slot chosen with the arrow keys; null while the pointer chooses.
const wheelKeyIndex = ref<number | null>(null);
const wheelCenter = ref<HTMLButtonElement>(),
  wheelEditor = ref<HTMLElement>();
/** The pointer from the wheel's centre, and the wheel's diameter. The wheel
 * is drawn at the window's centre: the canvas viewport ends left of a pinned
 * side chat, so its centre is not the wheel's. */
function wheelGeometry() {
  const dx = pointerPosition.x - window.innerWidth / 2,
    dy = pointerPosition.y - window.innerHeight / 2;
  const diameter = Math.min(360, window.innerWidth * 0.86, window.innerHeight * 0.78);
  return { dx, dy, distance: Math.hypot(dx, dy), diameter };
}
const wheelCenterSelected = computed(() => {
  const { distance, diameter } = wheelGeometry();
  return wheelKeyIndex.value === null && distance < diameter * 0.24;
});
async function openWheelConfig(origin?: HTMLElement, reset = false) {
  const source = origin?.getBoundingClientRect();
  if (wheelOpen.value) wheelExit = "center";
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
  // Arrow keys belong to the open wheel (before Browser's Alt+Left/Right
  // history keys or an editor's Alt+arrows see them).
  if (wheelOpen.value && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    wheelArrow(e.key);
  }
}
// Left/Right step through the slots, Up enters the selected group, Down
// returns one level with the group just left selected. Releasing the
// shortcut runs the selected slot, as with the pointer.
function wheelArrow(key: string) {
  const entries = wheelEntries.value;
  const selected = wheelSelected.value;
  const current = selected ? entries.findIndex((e) => e.id === selected.id) : -1;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (!entries.length) return;
    const step = key === "ArrowRight" ? 1 : -1;
    wheelKeyIndex.value =
      current < 0
        ? step > 0 ? 0 : entries.length - 1
        : (current + step + entries.length) % entries.length;
  } else if (key === "ArrowUp") {
    if (selected?.kind !== "group") return;
    wheelParent.value = selected.id;
    wheelKeyIndex.value = wheelEntries.value.length ? 0 : null;
  } else if (wheelParent.value) {
    const from = wheelParent.value;
    wheelBack();
    wheelKeyIndex.value = Math.max(0, wheelEntries.value.findIndex((e) => e.id === from));
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
const wheelSelected = computed(() => {
  if (wheelKeyIndex.value !== null)
    return wheelEntries.value[wheelKeyIndex.value];
  const { dx, dy, distance, diameter } = wheelGeometry();
  if (distance < diameter * 0.24 || !wheelEntries.value.length)
    return undefined;
  const angle =
    (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
  return wheelEntries.value[
    Math.round((angle / (2 * Math.PI)) * wheelSlotCount.value) %
      wheelSlotCount.value
  ];
});
// Faint dividers between the slots, from just outside the center to the edge.
const wheelDividers = computed(() => {
  const step = (2 * Math.PI) / wheelSlotCount.value;
  return Array.from({ length: wheelSlotCount.value }, (_, i) => {
    const a = wheelPoint((i + 0.5) * step, 27),
      b = wheelPoint((i + 0.5) * step, 50);
    return `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`;
  }).join(" ");
});
// The glow fills the top slot right to the ring's edge and is rotated to the
// selected one, so moving the selection glides it the short way round.
const wheelGlowShape = computed(() => {
  const half = Math.PI / wheelSlotCount.value - Math.PI / 180;
  const points: number[][] = [];
  for (let i = 0; i <= 24; i++) points.push(wheelPoint(-half + (2 * half * i) / 24, 50));
  for (let i = 24; i >= 0; i--) points.push(wheelPoint(-half + (2 * half * i) / 24, 27));
  return `polygon(${points.map((p) => `${p[0]}% ${p[1]}%`).join(",")})`;
});
const wheelSelectedIndex = computed(() =>
  wheelSelected.value
    ? wheelEntries.value.findIndex((e) => e.id === wheelSelected.value?.id)
    : -1,
);
const wheelGlowDeg = ref(0),
  wheelGlowJump = ref(true);
watch(
  [wheelSelectedIndex, wheelParent],
  ([index, parent], [previous, previousParent]) => {
    if (index < 0) return;
    const target = (index * 360) / wheelSlotCount.value;
    if (previous < 0 || parent !== previousParent || !wheelOpen.value) {
      // Appearing (or on a new level): show it in place, don't glide in.
      wheelGlowJump.value = true;
      wheelGlowDeg.value = target;
      void nextTick(() => {
        void document.body.offsetWidth;
        wheelGlowJump.value = false;
      });
      return;
    }
    const last = wheelGlowDeg.value;
    wheelGlowDeg.value = last + ((((target - last) % 360) + 540) % 360) - 180;
  },
);
// 1 when the wheel goes into a group, -1 when it goes back out.
let wheelLevelDirection = 1;
watch(
  wheelParent,
  (parent, previous) => {
    wheelLevelDirection =
      parent && workspace.wheel?.find((e) => e.id === parent)?.parent === previous
        ? 1
        : -1;
  },
  { flush: "sync" },
);
const wheelLevelMotion = wheelLevelHooks(() => wheelLevelDirection, {
  duration: 240,
  scale: true,
});
const wheelCenterMotion = wheelLevelHooks(() => wheelLevelDirection, {
  duration: 200,
  scale: false,
});
const wheelRing = ref<HTMLElement>(),
  wheelOverlay = ref<HTMLElement>();
// How the wheel last closed ("cancel" unless an item or Edit config was chosen).
let wheelExit: WheelExit = "cancel";
let finishWheelClose: (() => void) | undefined;
function wheelLeave(el: Element, done: () => void) {
  const exit = wheelExit;
  wheelExit = "cancel";
  finishWheelClose = done;
  closeWheel(el, exit, () => {
    if (finishWheelClose === done) finishWheelClose = undefined;
    done();
  });
}
watch(wheelOpen, async (open) => {
  if (!open) return;
  // Reopening while the last wheel still fades out: drop that one at once.
  finishWheelClose?.();
  finishWheelClose = undefined;
  await nextTick();
  openWheel(wheelOverlay.value, wheelRing.value);
});
// The handoff between a slot and the center follows the pointer: in a band
// around the center's edge the slot glow fades out and the center ring fades
// in, in step with the distance (1 = all slot, 0 = all center). With the
// arrow keys it is all-or-nothing and fades over 220 ms.
const wheelBlend = computed(() => {
  if (wheelKeyIndex.value !== null) return 1;
  const { distance, diameter } = wheelGeometry();
  const dead = diameter * 0.24,
    band = diameter * 0.1;
  return Math.min(1, Math.max(0, (distance - (dead - band)) / (2 * band)));
});
const wheelActive = computed(
  () => wheelSelectedIndex.value >= 0 || wheelCenterSelected.value,
);
// The center text crossfades when the selection moves between the center
// and the ring, as well as when the level changes.
const wheelCenterKey = computed(
  () => `${wheelParent.value}|${wheelCenterSelected.value ? "center" : "ring"}`,
);
function wheelEntryIcon(entry: (typeof wheelEntries.value)[number]) {
  if (entry.kind === "group") return "layers";
  if (entry.kind === "action")
    return workspace.actions?.find((a) => a.id === entry.actionId)?.icon || "workflow";
  return apps.value.find((a) => a.id === entry.appId)?.icon || "app";
}
function wheelEntryKind(entry: (typeof wheelEntries.value)[number]) {
  if (entry.kind === "group") {
    const count = (workspace.wheel || []).filter((e) => e.parent === entry.id).length;
    return `Group · ${count} ${count === 1 ? "item" : "items"}`;
  }
  return entry.kind === "action" ? "Action · release to run" : "App · release to open";
}
const wheelCrumb = computed(() =>
  wheelParent.value
    ? (workspace.wheel || []).find((e) => e.id === wheelParent.value)?.name || ""
    : "",
);
function trackWheelPointer(e: PointerEvent) {
  // Moving the pointer hands the selection back from the arrow keys.
  if (
    wheelKeyIndex.value !== null &&
    Math.hypot(e.clientX - pointerPosition.x, e.clientY - pointerPosition.y) > 3
  )
    wheelKeyIndex.value = null;
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
const appearanceTypeShortcuts: Partial<Record<string, ThemeBackgroundType>> = {
  "1": "plain", "2": "image", "3": "video", "4": "code",
};
function keydown(e: KeyboardEvent) {
  if (!ready.value || e.defaultPrevented) return;
  if (panel.value === "appearance") {
    const type = appearanceTypeShortcuts[e.key];
    if (e.key === "Escape") {
      e.preventDefault();
      if (appearanceDirty.value) discardAppearance();
      else leaveAppearance();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      void applyAppearance();
      return;
    }
    if (type && e.altKey && !e.ctrlKey && !e.metaKey && !typing(e.target)) {
      e.preventDefault();
      updateAppearance({ ...appearance.value, backgroundType: type });
      return;
    }
  }
  if (rewindOpen.value && !typing(e.target)) {
    rewind.value?.key(e);
    if (e.defaultPrevented) return;
  }
  if (browserTabKeys(e)) return;
  // Ctrl+Left/Right goes to the previous/next app in dock order (wrapping).
  // In focus mode it swaps the focused app; on the canvas it moves the view
  // to that app, as a dock click does. Text fields keep Ctrl+arrows for
  // moving by word.
  if (
    (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    !typing(e.target) &&
    apps.value.length > (focused.value ? 1 : 0)
  ) {
    const list = apps.value;
    const forward = e.key === "ArrowRight";
    const at = list.findIndex((a) => a.id === (focused.value?.id ?? active.value));
    const next =
      at < 0
        ? list[forward ? 0 : list.length - 1]
        : list[(at + (forward ? 1 : -1) + list.length) % list.length];
    if (next) {
      e.preventDefault();
      if (focused.value) enterFocus(next);
      else void focusApp(next);
    }
    return;
  }
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
    wheelKeyIndex.value = null;
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
    if (panel.value || managedApp.value || pendingImport.value || inboxOpen.value || actionStudio.value || customToolsOpen.value) {
      actionStudio.value = false;
      customToolsOpen.value = false;
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
    if (entry && entry.kind !== "group") wheelExit = "slot";
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
  measureViewport();
};
const managedApp = ref<CanvasApp>();
const dockContext = ref<CanvasApp>();
// The quick actions open right above the dock tab they belong to.
const dockContextAt = ref<{ left: string; right: string; bottom: string }>();
function openDockContext(app: CanvasApp, event: Event) {
  if (!canEdit.value) return;
  const target = event.currentTarget as HTMLElement;
  const tab = target.getBoundingClientRect();
  const bar = target.closest(".dock")?.getBoundingClientRect();
  const width = 250;
  dockContextAt.value = {
    left: `${Math.min(Math.max(8, tab.left + tab.width / 2 - width / 2), innerWidth - width - 8)}px`,
    right: "auto",
    bottom: `${innerHeight - (bar ?? tab).top + 8}px`,
  };
  dockContext.value = app;
}
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
function dockAction(app: CanvasApp, action: DockAction) {
  if (!canEdit.value || importBusy.value) return;
  dockContext.value = undefined;
  if (action.kind === "rename" || action.kind === "manage") {
    manage(app);
    if (action.kind === "rename") nextTick(() => managementName.value?.select());
  } else if (action.kind === "duplicate") duplicate(app);
  else if (action.kind === "group") {
    app.groupId = action.groupId;
    const group = workspace.groups?.find((item) => item.id === action.groupId);
    status.value = group ? `${app.name || "App"} moved to ${group.name}.` : `${app.name || "App"} removed from its group.`;
  } else {
    managedApp.value = app;
    retireApp(action.kind === "trash");
  }
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
      const { backup, count, missing, missingBackgrounds } = await makeBackup(JSON.parse(data));
      data = JSON.stringify(backup);
      status.value = count || missing
        ? `Backup includes ${count} image${count === 1 ? "" : "s"}${missing ? `; ${missing} could not be read and were left out` : ""}.`
        : status.value;
      if (missingBackgrounds) status.value = `Backup could not include ${missingBackgrounds} background file(s).`;
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
      const rejectedBackgrounds = await restoreBackgrounds(parseWorkspace(raw.workspace), raw.backgrounds,
        (id, file) => store.uploadThemeMedia(id, file));
      restoredNote = rejected
        ? `${restored} images restored; ${rejected} were damaged and skipped.`
        : restored
          ? `${restored} image${restored === 1 ? "" : "s"} restored.`
          : "";
      if (rejectedBackgrounds) restoredNote += ` ${rejectedBackgrounds} background file(s) could not be restored.`;
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
  loadError.value = "";
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
// Workflows running now, shown live on the automation timeline; finished
// top-level runs go into workspace.runs (src/automationRuns.ts).
const liveRuns = ref<Omit<AutomationRun, "end" | "error">[]>([]);
async function trackRun<T>(workflowId: string, run: { source: RunSource; triggerId?: string }, work: () => Promise<T>) {
  const entry = {
    id: uid(),
    workflowId,
    source: run.source,
    ...(run.triggerId ? { triggerId: run.triggerId } : {}),
    start: Date.now(),
  };
  liveRuns.value = [...liveRuns.value, entry];
  let error: string | undefined;
  try {
    return await work();
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
    throw failure;
  } finally {
    liveRuns.value = liveRuns.value.filter((r) => r.id !== entry.id);
    if (canEdit.value)
      workspace.runs = addRun(workspace.runs, { ...entry, end: Date.now(), ...(error ? { error: error.slice(0, 2000) } : {}) });
  }
}
/** Runs an Action-library workflow; a top-level run is recorded for the timeline. */
function executeWorkspaceAction(
  id: string,
  bindings: Record<string, string>,
  depth = 0,
  callPath: string[] = [],
  initial = "",
  run: { source: RunSource; triggerId?: string } = { source: "button" },
): Promise<string> {
  if (callPath.length) return runWorkspaceAction(id, bindings, depth, callPath, initial);
  return trackRun(id, run, () => runWorkspaceAction(id, bindings, depth, callPath, initial));
}
async function runWorkspaceAction(
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
    await executeWorkspaceAction(id, bindings, 0, [], "", { source: "manual" });
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
  // Browser control acts in pages, not on the workspace: never "busy".
  if (request.run?.kind === "browser") return { revision, ...(await browserForMcp(request.run)) };
  if (request.run?.kind === "agent-delegation" || request.run?.kind === "host-browser")
    return { revision, ...(await runForMcp(request.run)) };
  if (importBusy.value || activeExecutions.value || gesture)
    throw Error(
      "The workspace is busy with a gesture, action, import or recovery. Finish it before editing through MCP.",
    );
  if (request.run) return { revision, ...(await runForMcp(request.run)) };
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
      loadError.value =
        "The MCP edit was saved, but the view could not refresh. Reload this tab before editing again.";
      canEdit.value = false;
      throw Error(loadError.value);
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
/** MCP browser_* tools: AI control of Browser tabs (src/browserAgent.ts). */
function browserForMcp(request: Extract<RunRequest, { kind: "browser" }>) {
  return runBrowserAgent(request, browserAgentContext);
}
const browserAgentContext: Parameters<typeof runBrowserAgent>[1] = {
    browserBlocks(appId) {
      const first = focused.value?.id;
      return liveApps.value
        .filter((app) => !appId || app.id === appId)
        .sort((a, b) => Number(b.id === first) - Number(a.id === first))
        .flatMap((app) =>
          flatten(app.blocks)
            .filter((block) => block.kind === "browser")
            .map((block) => ({ blockId: block.id, appId: app.id, app: app.name })),
        );
    },
    mount: (appId) => mountedApps.add(appId),
};
// The Test runs app drives Browser tabs itself through the same operations.
setBrowserAgentContext(browserAgentContext);
/** MCP: run a workflow, or press/submit/toggle a component, exactly as a
 * person would in this window. Errors are returned, never retried. */
async function runForMcp(request: RunRequest) {
  if (request.kind === "browser") return browserForMcp(request);
  if (request.kind === "desktop-restart") {
    if (!desktopWindow?.restartDesktop) throw Error("Open the updated Orvane desktop app to schedule a restart.");
    if (request.action === "schedule") flushSave();
    return { restart: await desktopWindow.restartDesktop(request.action) };
  }
  if (request.kind === "agent-delegation")
    return { delegation: await agentRequest("delegation", request.request) };
  if (request.kind === "host-browser")
    return { browser: await runHostBrowser(request.request, browserAgentContext) };
  if (request.kind === "uimaker-open") {
    const targets = liveApps.value.flatMap((app) =>
      flatten(app.blocks).filter((block) => block.kind === "uimaker").map((block) => ({ app, block })),
    );
    const target = request.appId
      ? targets.find(({ app }) => app.id === request.appId)
      : targets.find(({ app }) => app.id === active.value) ?? targets[0];
    if (!target) throw Error("No matching UI Maker app is on the canvas.");
    if (request.review?.action !== "status") {
      if (target.app.layoutHidden) target.app.layoutHidden = false;
      await focusApp(target.app);
    }
    const detail: Extract<OpenRequest, { kind: "uimaker" }> = {
      kind: "uimaker", blockId: target.block.id, component: request.component,
      mode: request.mode, version: request.version, reference: request.reference, review: request.review,
      lab: request.lab,
    };
    for (let attempt = 0; attempt < 40; attempt++) {
      window.dispatchEvent(new CustomEvent<OpenRequest>(OPEN_EVENT, { detail }));
      if (detail.opened) return { appId: target.app.id, ...(await detail.opened) };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("UI Maker did not finish opening.");
  }
  if (request.kind === "runs")
    return {
      runs: traces.value.map(({ id: _id, ...t }) => t),
      appErrors: Object.entries(runtimeErrors).map(([appId, error]) => ({
        appId,
        app: workspace.apps.find((a) => a.id === appId)?.name || appId,
        error,
      })),
    };
  if (request.kind === "layout-apply") {
    const layout = layouts.value.find((l) => l.id === request.layoutId);
    if (!layout) throw Error(`Layout ${request.layoutId} does not exist. Call layout_list.`);
    applyLayout(layout.id);
    return { applied: layout.id, name: layout.name };
  }
  if (request.kind === "layout-save") return saveLayoutForMcp(request);
  if (request.kind === "trigger-run") {
    const trigger = workspace.triggers?.find((t) => t.id === request.triggerId);
    if (!trigger) throw Error(`Trigger ${request.triggerId} does not exist. Call trigger_list.`);
    actionNotice.value = "";
    const ran = await runTrigger(trigger);
    return { ...ran, message: actionNotice.value };
  }
  actionNotice.value = "";
  activeExecutions.value++;
  const label =
    request.kind === "workflow"
      ? workspace.actions?.find((a) => a.id === request.workflowId)?.name || request.workflowId
      : request.componentId;
  try {
    if (request.kind === "workflow") {
      const workflow = workspace.actions?.find((a) => a.id === request.workflowId);
      if (!workflow) throw Error(`Workflow ${request.workflowId} does not exist. Call workflow_list.`);
      const result = await executeWorkspaceAction(workflow.id, request.inputs, 0, [], "", { source: "ai" });
      return { workflow: workflow.name, result, message: actionNotice.value };
    }
    const app = apps.value.find((a) => a.id === request.appId);
    if (!app) throw Error(`App ${request.appId} is not on the canvas (missing, archived or trashed).`);
    const block = flatten(app.blocks).find((b) => b.id === request.componentId);
    if (!block) throw Error(`Component ${request.componentId} is not in ${app.name}.`);
    if (!["button", "input", "checkbox"].includes(block.kind))
      throw Error("Only buttons, text fields and checkboxes can be triggered.");
    if (request.value !== undefined) {
      if (block.kind !== "input") throw Error("value can only be typed into a text field.");
      block.value = request.value;
    }
    if (block.kind === "checkbox") block.checked = !block.checked;
    if (!block.rules.length)
      return { component: block.label, result: "", message: "", note: "This component has no actions yet." };
    const initial =
      block.kind === "input"
        ? block.value
        : flatten(app.blocks).find((b) => b.kind === "input")?.value || "";
    const result = await executeFlow(app, block.rules, block.graph, initial);
    return { component: block.label, result, message: actionNotice.value };
  } catch (error) {
    // Failed agent runs show in Connection activity like a person's would.
    traces.value.unshift({
      id: uid(),
      from: "MCP agent",
      to: label,
      action: request.kind === "workflow" ? "Run workflow" : "Trigger",
      at: new Date().toLocaleTimeString(),
      error: error instanceof Error ? error.message : String(error),
    });
    traces.value = traces.value.slice(0, 30);
    throw error;
  } finally {
    activeExecutions.value--;
  }
}
/** MCP: arrange apps (optional), then save the arrangement as a named layout. */
function saveLayoutForMcp(request: Extract<RunRequest, { kind: "layout-save" }>) {
  const places = Object.entries(request.apps || {}).map(([appId, place]) => {
    const app = liveApps.value.find((a) => a.id === appId);
    if (!app) throw Error(`App ${appId} is not on the canvas (missing, archived or trashed).`);
    return { app, place };
  });
  for (const { app, place } of places) {
    app.x = place.x;
    app.y = place.y;
    app.width = Math.max(place.width, appMinimum(app).width);
    app.height = Math.max(place.height, appMinimum(app).height);
    app.layoutHidden = !place.shown;
  }
  const layout = captureLayout(request.id || uid(), request.name);
  const shown = liveApps.value.filter((a) => !a.layoutHidden);
  if (places.length && shown.length) {
    // Frame what the agent arranged, the way Center does.
    const bounds = groupBounds(shown)!;
    layout.camera = {
      x: viewport.width / 2 - (bounds.x + bounds.width / 2) * camera.zoom,
      y: (viewport.height - 80) / 2 - (bounds.y + bounds.height / 2) * camera.zoom,
      zoom: camera.zoom,
    };
    panTo(layout.camera.x, layout.camera.y, undefined, layout.camera.zoom);
  }
  const exists = layouts.value.some((l) => l.id === layout.id);
  workspace.layouts = exists
    ? layouts.value.map((l) => (l.id === layout.id ? layout : l))
    : [...layouts.value, layout].slice(-50);
  workspace.activeLayout = layout.id;
  return { saved: layout.id, name: layout.name, apps: Object.keys(layout.apps).length };
}
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
  window.addEventListener("orvane:guest-pointer-down", dismissAppearanceFromGuest);
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
  window.addEventListener(MOCK_READY_OPEN, mockReadyOpenEvent);
  window.addEventListener("orvane:open-git", openGitEvent);
  window.addEventListener(CLAUDE_LOGIN_EVENT, claudeLoginEvent);
  window.addEventListener("orvane:palette", paletteEvent);
  window.addEventListener("orvane:send-selection", sendSelectionEvent);
  window.addEventListener(PIN_AGENT_DRAFT, pinDraftEvent);
  window.addEventListener(AGENT_REVEAL, sideRevealEvent);
  startActivity();
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
  window.removeEventListener(MOCK_READY_OPEN, mockReadyOpenEvent);
  window.removeEventListener("orvane:open-git", openGitEvent);
  window.removeEventListener(CLAUDE_LOGIN_EVENT, claudeLoginEvent);
  window.removeEventListener("orvane:palette", paletteEvent);
  window.removeEventListener("orvane:send-selection", sendSelectionEvent);
  window.removeEventListener(PIN_AGENT_DRAFT, pinDraftEvent);
  window.removeEventListener(AGENT_REVEAL, sideRevealEvent);
  stopActivity();
  window.removeEventListener("paste", pasteImage);
  window.removeEventListener("pointermove", trackPointer);
  clearTimeout(dropNoticeTimer);
  stopPan();
  stopZoom();
  document.removeEventListener("pointerdown", dismissOutside, true);
  window.removeEventListener("orvane:guest-pointer-down", dismissAppearanceFromGuest);
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
    :style="{ '--side-reserve': `${sideReserved}px`, ...paletteStyle }"
    :inert="mcpBusy || !ready"
    :data-ready="ready"
    :data-saved="!unsavedChanges"
    :data-editable="canEdit && ready"
    :class="{
      frameless,
      'workspace-themed': !!paletteStyle['--theme-canvas'],
      'workspace-wallpaper': appearance.backgroundType !== 'plain',
      'wallpaper-dark': terminalDark,
    }"
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
    <div class="canvas-background">
      <ThemeCanvasBackground v-if="appearance.backgroundType !== 'plain'" :theme="appearance" :reduced="appearanceReduced" />
    </div>
    <div v-if="panel === 'appearance' && appearanceDirty" class="appearance-preview-chip" :class="{ 'below-header': hint && canEdit }" aria-hidden="true">
      <span />Previewing theme · not applied
    </div>
    <div v-if="panel === 'appearance' && appearanceReduced && (appearance.backgroundType === 'video' || appearance.backgroundType === 'code')" class="appearance-motion-chip">
      <Icon name="pause" :size="12" />Still frame · reduced motion
    </div>
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
      @agent-session="openAgentSession({ key: $event })"
    />
    <Transition name="agent-launcher">
      <AgentLauncher
        v-if="agentLauncher"
        ref="agentLauncherPanel"
        :apps="workspace.apps"
        :anchor="agentDockButton"
        :popovers="agentPopovers"
        @close="agentLauncher = false"
        @starting="agentStarting = $event"
        @started="openAgentSession({ run: $event }); agentLauncher = false"
        @pin="pinSession"
        @pin-draft="pinDraft"
        @open="openAgentSession({ key: $event }); agentLauncher = false"
      />
    </Transition>
    <Transition name="side-chat">
    <aside v-if="sideOpen && hasSideSession" v-show="!sideCollapsed" class="side-chat workspace-frost" :style="{ '--side-width': `${sideWidth}px` }" aria-label="Pinned AI session" @pointerdown.stop="closeSideSwitch($event)" @keydown.esc="sideSwitching && ($event.stopPropagation(), (sideSwitching = false))">
      <div
        class="side-chat-resize"
        :class="{ dragging: sideResizing }"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side chat"
        :aria-valuenow="sideWidth"
        :aria-valuemin="SIDE_MIN"
        :aria-valuemax="sideMax()"
        tabindex="0"
        @pointerdown="sideResizeDown"
        @keydown="sideResizeKey"
      ></div>
      <header class="side-chat-head">
        <button
          type="button"
          class="side-chat-switch"
          aria-label="Switch session"
          :aria-expanded="sideSwitching"
          @click="sideSwitching = !sideSwitching"
        >
          <span class="side-chat-provider" :class="sideDraft?.provider || sideProvider">{{ (sideDraft?.provider || sideProvider) === "codex" ? "X" : "C" }}</span><b>{{ sideLabel }}</b>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
        </button>
        <span class="side-chat-space"></span>
        <button type="button" class="side-chat-button" aria-label="Collapse side chat" data-tip="Collapse · Ctrl+Shift+J"
          @click="collapseSideChat(true)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg></button>
        <button type="button" class="side-chat-button active" aria-label="Unpin side chat" data-tip="Unpin"
          @click="unpinSideChat"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 2.5 13.5 6l-2.5 1-2.5 3 .5 2.5L4 7.5 6.5 8l3-2.5z" /><path d="M5.5 10.5 2.5 13.5" /></svg></button>
        <button v-if="sideSession" type="button" class="side-chat-button" aria-label="Open in Agent sessions" data-tip="Open in Agent sessions"
          @click="openAgentSession({ key: sideSession })"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" /></svg></button>
      </header>
      <Transition name="side-chat-list">
        <div v-if="sideSwitching" class="side-chat-list select-popover">
          <SessionList :current="sideSession" @pick="pinSession($event.key)" />
        </div>
      </Transition>
      <div v-if="sideBack" class="side-chat-back" role="status">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.4" /><circle cx="4.5" cy="12.5" r="1.4" /><circle cx="11.5" cy="5.5" r="1.4" /><path d="M4.5 5v6M11.5 7c0 2.6-2.4 3.8-7 4.8" /></svg>
        <span>{{ sideBack.label }}</span>
        <button type="button" class="side-chat-back-go" @click="goSideBack">{{ sideBack.draft ? "Back to draft" : "Back" }}</button>
        <button type="button" class="side-chat-back-close" aria-label="Dismiss" @click="sideBack = null">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
        </button>
      </div>
      <SessionChat ref="sideChat" :session-key="sideSession" :initial-draft="sideDraft" place="side"
        @session-key="promoteSideDraft" @draft-state="updateSideDraft" />
      <footer class="side-chat-keys">
        <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>A</kbd> type here<span class="side-chat-space"></span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>J</kbd> collapse
      </footer>
    </aside>
    </Transition>
    <!-- The collapsed side chat: a small face at the right edge. It blinks
         while idle, reads left and right while the session works, and shows
         an amber dot when it waits for you. -->
    <Transition name="side-bubble">
      <button
        v-if="sideOpen && hasSideSession && sideCollapsed"
        type="button"
        class="side-bubble workspace-frost"
        :class="`is-${sideState}`"
        :aria-label="`Open pinned chat: ${sideLabel}${sideState === 'working' ? ', working' : sideState === 'waiting' ? ', waiting for you' : sideState === 'done' ? ', finished' : ''}`"
        :data-tip="`${sideLabel} · Ctrl+Shift+J`"
        @pointerdown.stop
        @click="collapseSideChat(false)"
      >
        <span class="side-bubble-face" aria-hidden="true"
          ><i></i><i></i
          ><template v-if="sideState === 'done'"><b class="side-bubble-arc"></b><b class="side-bubble-arc"></b></template
        ></span>
        <span v-if="sideState === 'waiting'" class="side-bubble-dot" aria-hidden="true"></span>
        <span v-else-if="sideState === 'done'" class="side-bubble-tick" aria-hidden="true"
          ><svg width="9" height="9" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10" /></svg
        ></span>
      </button>
    </Transition>
    <div ref="agentPopovers" class="agent-launcher-popovers" />
    <CustomToolsPanel v-if="customToolsOpen" @close="customToolsOpen = false" />
    <ActionStudio
      v-if="actionStudio"
      :workspace="workspace"
      :live-runs="liveRuns"
      :initial-view="studioView"
      :initial-id="studioActionId"
      :create-on-open="!!studioWheelEntry && !studioActionId"
      :writable="canEdit && !importBusy"
      :notice="actionNotice"
      :running="actionRunning"
      :opening-from="studioOrigin"
      :run-trigger="runTriggerById"
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
    <!-- Closing plays a short exit (see closeWheel); opening is animated in openWheel. -->
    <Transition :css="false" @leave="wheelLeave">
    <div
      v-if="wheelOpen"
      ref="wheelOverlay"
      class="radial-overlay"
      @contextmenu.prevent.stop="wheelBack"
      @pointerdown.stop
      @click.self="
        wheelSelected?.kind === 'group' && (wheelParent = wheelSelected.id)
      "
    >
      <div
        ref="wheelRing"
        class="radial-wheel"
        :class="{ keyed: wheelKeyIndex !== null }"
        aria-label="Action wheel"
      >
        <!-- One layer per level: entering a group or going back crossfades
             the layers in place while the ring and the center disc stay. -->
        <Transition
          :css="false"
          @enter="wheelLevelMotion.enter"
          @leave="wheelLevelMotion.leave"
        >
          <div :key="wheelParent" class="radial-layer">
            <svg class="radial-dividers" viewBox="0 0 100 100" aria-hidden="true">
              <path :d="wheelDividers" />
            </svg>
            <div
              class="radial-glow"
              :class="{ jump: wheelGlowJump }"
              :style="{
                clipPath: wheelGlowShape,
                transform: `rotate(${wheelGlowDeg}deg)`,
                opacity: wheelActive ? wheelBlend : 0,
              }"
              aria-hidden="true"
            ></div>
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
                :class="wheelEntries[index] ? 'radial-entry-content' : 'radial-dot'"
                :style="{
                  left: `${50 + 37 * Math.sin((index * 2 * Math.PI) / wheelSlotCount)}%`,
                  top: `${50 - 37 * Math.cos((index * 2 * Math.PI) / wheelSlotCount)}%`,
                }"
                ><template v-if="wheelEntries[index]"
                  ><span class="radial-icon"
                    ><Icon :name="wheelEntryIcon(wheelEntries[index]!)" :size="19"
                  /></span><span>{{ wheelEntries[index]?.name }}</span></template
                ></span
              >
            </button>
          </div>
        </Transition>
        <button
          ref="wheelCenter"
          class="radial-center"
          :class="{ selected: wheelCenterSelected }"
          :style="{ '--ring': wheelActive ? 1 - wheelBlend : 0 }"
          aria-label="Edit wheel config"
          @click.stop="openWheelConfig(wheelCenter)"
        >
          <Transition
            :css="false"
            @enter="wheelCenterMotion.enter"
            @leave="wheelCenterMotion.leave"
          >
            <span :key="wheelCenterKey" class="radial-center-text">
              <small v-if="wheelCrumb" class="radial-crumb">‹ {{ wheelCrumb }}</small>
              <template v-if="wheelCenterSelected">
                <span class="radial-center-icon"><Icon name="settings" :size="20" /></span>
                <strong>Edit config</strong><small>Release Alt+Q to edit</small>
              </template>
              <template v-else-if="wheelSelected">
                <span class="radial-center-icon"
                  ><Icon :name="wheelEntryIcon(wheelSelected)" :size="20"
                /></span>
                <strong>{{ wheelSelected.name }}</strong
                ><small>{{ wheelEntryKind(wheelSelected) }}</small>
              </template>
              <span v-else class="radial-idle"
                ><Icon name="settings" :size="16" />Point to select</span
              >
            </span>
          </Transition>
        </button>
      </div>
    </div>
    </Transition>
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
    <header class="topbar" @pointerdown.stop>
      <!-- Frameless desktop window: an invisible strip where the wordmark used
           to be still moves the window (and restores it from maximized). -->
      <div v-if="frameless" class="window-drag-region" :class="{ 'restore-drag': restoreDrag }" aria-hidden="true"
        @pointerdown="beginWindowDrag" @pointermove="moveWindowDrag" @pointerup="endWindowDrag($event)"
        @pointercancel="endWindowDrag($event)" @lostpointercapture="endWindowDrag($event)"
        @dblclick="restoreDrag && desktopWindow?.toggleWindowMaximized?.()"></div>
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
        <button
          class="subtle-button"
          aria-label="Memory"
          @click="panel = panel === 'memory' ? null : 'memory'"
        >
          <Icon name="library" :size="14" /><span>Memory</span
          ><span v-if="memoryPending" class="memory-pending" :aria-label="`${memoryPending} to review`">{{ memoryPending }}</span>
        </button>
        <button
          class="subtle-button"
          aria-label="Site memory"
          @click="panel = panel === 'site-memory' ? null : 'site-memory'"
        >
          <Icon name="globe" :size="14" /><span>Site memory</span
          ><span v-if="siteMemoryPending" class="memory-pending" :aria-label="`${siteMemoryPending} to approve`">{{ siteMemoryPending }}</span>
        </button>
        <span v-if="ready && !canEdit" class="field-help">Read-only tab</span>
        <button
          class="subtle-button"
          @click="panel = panel === 'help' ? null : 'help'"
        >
          <Icon name="help" :size="14" /><span>Canvas guide</span></button
        ><button
          class="icon-button workspace-options"
          ref="optionsButton"
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
      v-if="appearance.dots"
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
      v-show="ready && !rewindPreview"
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
          '--focus-page-zoom': focused?.id === app.id ? focusPageZoom : undefined,
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
    <CanvasRewind
      v-if="rewindOpen"
      ref="rewind"
      v-model="rewindPreview"
      :entries="rewindEntries"
      :apps="rewindApps"
      :camera="camera"
      :can-restore="canEdit && !importBusy"
      :busy="rewindBusy"
      :loading="rewindLoading"
      :error="rewindError"
      @close="closeRewind"
      @restore="restoreRewindEntry"
    />
    <div ref="panShield" class="pan-shield" aria-hidden="true"></div>
    <div
      v-if="statusText"
      class="status-area"
      :class="{ 'status-warning': statusIsProblem, 'status-recovery': loadError }"
      :role="statusIsProblem ? 'alert' : 'status'"
      @pointerdown.stop
    >
      <Icon
        class="status-icon"
        :name="statusIsProblem ? 'alert' : 'info'"
        :size="15"
      />
      <span class="status-text">{{ statusText }}</span>
      <div class="status-actions"><button
        v-if="status.startsWith('Saving')"
        class="subtle-button"
        @click="persist"
      >
        Retry saving</button
      ><button
        v-if="loadError && !unsavedChanges"
        class="subtle-button"
        :disabled="retryingWorkspace"
        @click="retryOpeningWorkspace"
      >
        {{ retryingWorkspace ? "Opening workspace…" : "Retry opening workspace" }}</button
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
      </button></div>
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
    <AppearanceSettings
      v-if="panel === 'appearance' && !pendingImport"
      :theme="appearance"
      :dirty="appearanceDirty"
      :change-count="appearanceChanges"
      :reduced="previewReduced"
      :system-reduced="systemReduced"
      :saving="appearanceSaving"
      :error="appearanceError"
      @pointerdown.stop
      @update:theme="updateAppearance"
      @update:reduced="previewReduced = $event"
      @import-media="importAppearanceMedia"
      @import-palette-image="importAppearancePaletteImage"
      @apply="applyAppearance"
      @discard="discardAppearance"
      @back="leaveAppearance(true)"
      @close="leaveAppearance()"
    />
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
        @click="createGitViewer('uimaker')"
      >
        <Icon name="edit" :size="14" />Create UI Maker
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
        <Icon name="agent-sessions" :size="14" />Create Agent sessions
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
        @click="createGitViewer('flow-tests')"
      >
        <Icon name="video" :size="14" />Create Test runs
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
      <button class="subtle-button" @click="openCustomTools">
        <Icon name="code" :size="14" />Custom tools
      </button>
      <button
        class="subtle-button"
        @click="restoreSnapshot"
        :disabled="!canEdit || importBusy"
      >
        Restore previous workspace
      </button>
      <button class="subtle-button" @click="openRewind"><Icon name="clock" :size="14" />Canvas rewind</button>
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
      <div class="settings-section">
        <div class="section-line">
          <Icon name="settings" :size="14" />Appearance
        </div>
        <button ref="appearanceButton" class="subtle-button appearance-entry" :disabled="!canEdit || importBusy" @click="openAppearance">
          Palette and background<span>{{ appearanceSummary }}</span><Icon name="right" :size="13" />
        </button>
      </div>
      <div v-if="displays.length" class="settings-section">
        <div class="section-line">
          <Icon name="box" :size="14" />Window
        </div>
        <label class="property"
          >Open on monitor<CustomSelect
            v-model="displayChoice"
            aria-label="Monitor for the Orvane window"
            :options="displays"
            placeholder="Monitor in use"
            @change="chooseDisplay"
        /></label>
        <label class="property"
          >Window<CustomSelect
            v-model="windowMode"
            aria-label="Orvane window size"
            :options="windowModes"
            @change="chooseWindowMode"
        /></label>
        <p class="field-help">
          Orvane moves there now and opens there next time. If that monitor is
          not connected, it opens on the one in use.
        </p>
        <button
          v-if="canRestart"
          type="button"
          class="subtle-button restart-orvane"
          :aria-pressed="!!restartWaiting"
          title="Restart Orvane (also in Ctrl+K). Waits for running agent turns and saves first."
          @click="restartOrvane"
        >
          <Icon name="refresh" :size="14" />{{ restartLabel }}
        </button>
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
      v-if="panel === 'memory'"
      class="groups-panel floating-panel"
      v-motion="{ kind: 'popover' }"
      aria-label="Memory"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h1>Memory</h1>
        <button class="icon-button" aria-label="Close memory" @click="panel = null">
          <Icon name="close" />
        </button>
      </div>
      <MemoryPanel @count="memoryPending = $event" />
    </section>
    <section
      v-if="panel === 'site-memory'"
      class="groups-panel floating-panel site-memory-panel"
      v-motion="{ kind: 'popover' }"
      aria-label="Site memory"
      @pointerdown.stop
    >
      <div class="panel-heading">
        <h1>Site memory</h1>
        <button class="icon-button" aria-label="Close site memory" @click="panel = null">
          <Icon name="close" />
        </button>
      </div>
      <SiteMemoryView @count="siteMemoryPending = $event" />
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
    <DockActionMenu
      v-if="dockContext && canEdit"
      :key="dockContext.id"
      :style="dockContextAt"
      :app="dockContext"
      :groups="workspace.groups || []"
      @action="dockAction(dockContext, $event)"
      @close="dockContext = undefined"
    />
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
        <img class="dock-logo" src="/favicon.png" width="18" height="18" alt="" />
      </button>
      <button
        ref="agentDockButton"
        type="button"
        class="dock-ai dock-action icon-button"
        :class="{ selected: agentLauncher }"
        :disabled="!canEdit || importBusy || agentStarting"
        :aria-expanded="agentLauncher"
        :aria-controls="agentLauncher ? 'agent-launcher' : undefined"
        aria-label="AI launcher"
        title="AI launcher (Ctrl+Shift+K)"
        @click="toggleAgentLauncher"
      ><Icon name="ai" :size="17" /></button>
      <span class="dock-divider"></span>
      <div ref="dockTabs" class="dock-tabs">
        <div ref="dockMeasure" class="dock-measure" aria-hidden="true">
          <span v-for="a in apps" :key="a.id" class="dock-measure-tab">
            <Icon :name="dockIcon(a)" :size="15" /><span>{{ a.name || "Untitled" }}</span>
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
          @contextmenu.prevent="openDockContext(a, $event)"
          @keydown.shift.f10.prevent="openDockContext(a, $event)"
          @click="chooseDockApp(a, index >= dockVisibleCount)"
          :title="a.group ? `${a.name} · ${a.group}` : a.name"
          :aria-description="flatten(a.blocks).some((block) => block.kind === 'claude') ? agentDockStatus : undefined"
        >
          <Icon :name="dockIcon(a)" :size="15" /><i v-if="agentDockStatus && flatten(a.blocks).some((block) => block.kind === 'claude')"
            class="agent-dock-dot" :data-status="agentDockStatus" :title="agentDockStatus" aria-hidden="true" /><span>{{
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
        :class="{ selected: palette !== null }"
        aria-label="Search and commands"
        title="Search and commands (Ctrl+K)"
        @click="palette === null ? openPalette('') : (palette = null)"
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
