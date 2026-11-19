<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowReactive } from "vue";
import Icon from "../Icon.vue";
import SplitTabs from "../SplitTabs.vue";
import FilePane from "./FilePane.vue";
import BatchRename from "./BatchRename.vue";
import { onOpenRequest, registerCommands } from "../../commands";
import { uid, type Block } from "../../model";
import {
  addTab,
  closeTab,
  groupOf,
  isSplit,
  reopenTab,
  restoreLayout,
  splitLayout,
  splitWith,
  type SplitLayout,
  type SplitSide,
} from "../../splitTabs";
import {
  api,
  baseName,
  crumbs,
  DRAG_MIME,
  label,
  rootOf,
  samePath,
  type ExplorerContext,
  type FileEntry,
  type MenuItem,
  type PaneState,
  type Roots,
} from "./explorer";

const props = defineProps<{ block: Block }>();

// ---- Saved state --------------------------------------------------------------
type Saved = {
  layout?: SplitLayout;
  panes?: Partial<PaneState>[];
  pins?: string[];
  hidden?: boolean;
  live?: boolean;
  sizes?: boolean;
  sidebar?: number;
  collapsed?: boolean;
};
function readSaved(): Saved {
  try {
    const value = JSON.parse(props.block.value || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
const saved = readSaved();
const panes = reactive(new Map<string, PaneState>());
function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : [];
}
function makePane(path: string, from?: Partial<PaneState>): PaneState {
  return {
    id: uid(),
    path,
    // History survives reloads; only the most recent steps are kept.
    back: strings(from?.back).slice(-30),
    forward: strings(from?.forward).slice(-30),
    view: from?.view === "grid" ? "grid" : "list",
    sort:
      from?.sort && ["name", "mtime", "type", "size"].includes(from.sort.key)
        ? { key: from.sort.key, dir: from.sort.dir === -1 ? -1 : 1 }
        : { key: "name", dir: 1 },
    preview: from?.preview === true,
  };
}
for (const pane of saved.panes ?? [])
  if (pane && typeof pane.id === "string" && typeof pane.path === "string" && pane.path)
    panes.set(pane.id, { ...makePane(pane.path, pane), id: pane.id });
const layout = reactive<SplitLayout>(restoreLayout(saved.layout, [...panes.keys()]) ?? splitLayout());
const pins = ref<string[]>(Array.isArray(saved.pins) ? saved.pins.filter((p) => typeof p === "string") : []);
const sidebarWidth = ref(Math.min(420, Math.max(150, Number(saved.sidebar) || 210)));
const collapsed = ref(saved.collapsed === true);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const value = JSON.stringify({
      layout,
      panes: layout.tabs.map((id) => {
        const p = panes.get(id)!;
        return { id, path: p.path, back: p.back.slice(-30), forward: p.forward.slice(-30), view: p.view, sort: p.sort, preview: p.preview };
      }),
      pins: pins.value,
      hidden: ctx.hidden,
      live: ctx.live,
      sizes: ctx.sizes,
      sidebar: Math.round(sidebarWidth.value),
      collapsed: collapsed.value,
    } satisfies Saved);
    if (value !== props.block.value) props.block.value = value;
  }, 250);
}

// ---- Roots and the folder tree -------------------------------------------------
const roots = ref<Roots | null>(null);
const rootError = ref("");
const children = shallowReactive(new Map<string, string[] | "loading" | "error">());
const expanded = reactive(new Set<string>());
async function loadRoots() {
  try {
    roots.value = await api<Roots>("roots");
    ctx.home = roots.value.home;
    ctx.token = roots.value.token;
    rootError.value = "";
    if (!layout.tabs.length) {
      const pane = makePane(roots.value.home);
      panes.set(pane.id, pane);
      addTab(layout, pane.id);
      persist();
    }
  } catch (e) {
    rootError.value = e instanceof Error ? e.message : String(e);
  }
}
function remember(path: string, entries: FileEntry[]) {
  children.set(
    path.toLowerCase(),
    entries.filter((e) => e.dir && (ctx.hidden || !e.hidden)).map((e) => e.path),
  );
}
async function toggleNode(path: string) {
  const key = path.toLowerCase();
  if (expanded.has(key)) return void expanded.delete(key);
  expanded.add(key);
  if (children.has(key) && children.get(key) !== "error") return;
  children.set(key, "loading");
  try {
    const data = await api<{ path: string; entries: FileEntry[] }>("list", { path });
    remember(path, data.entries);
  } catch {
    children.set(key, "error");
  }
}
type Node = { path: string; name: string; depth: number; state?: "loading" | "error" | "empty" | "more"; more?: number };
const TREE_LIMIT = 300;
const tree = computed(() => {
  const out: Node[] = [];
  const sorter = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const visit = (path: string, name: string, depth: number) => {
    out.push({ path, name, depth });
    const key = path.toLowerCase();
    if (!expanded.has(key)) return;
    const list = children.get(key);
    if (list === "loading" || list === "error") return void out.push({ path: path + "\0", name: "", depth: depth + 1, state: list });
    if (!list?.length) return void out.push({ path: path + "\0", name: "", depth: depth + 1, state: "empty" });
    const sortedList = [...list].sort((a, b) => sorter.compare(baseName(a), baseName(b)));
    for (const child of sortedList.slice(0, TREE_LIMIT)) visit(child, baseName(child), depth + 1);
    if (sortedList.length > TREE_LIMIT)
      out.push({ path: path + "\0more", name: "", depth: depth + 1, state: "more", more: sortedList.length - TREE_LIMIT });
  };
  for (const drive of roots.value?.drives ?? []) visit(drive.path, label(drive.path), 0);
  return out;
});
const activePath = computed(() => panes.get(layout.active)?.path ?? "");
// Expand the tree down to the active folder, like Explorer's "sync" option.
function expandTo(path: string) {
  const list = crumbs(path).slice(0, -1);
  for (const crumb of list) if (!expanded.has(crumb.path.toLowerCase())) void toggleNode(crumb.path);
}

// ---- Panes and tabs ------------------------------------------------------------
const paneRefs = new Map<string, InstanceType<typeof FilePane>>();
function setRef(id: string, el: unknown) {
  if (el) paneRefs.set(id, el as InstanceType<typeof FilePane>);
  else paneRefs.delete(id);
}
const closed: { pane: PaneState; slot: { id: string; group: SplitSide | null; index: number } }[] = [];
const closedCount = ref(0);
function newPane(path: string, group?: SplitSide | null, from?: PaneState) {
  const pane = makePane(path, from);
  panes.set(pane.id, pane);
  addTab(layout, pane.id, group ?? (isSplit(layout) ? groupOf(layout, layout.active) : null), layout.active || undefined);
  persist();
  return pane;
}
function addPane(group: SplitSide | null) {
  newPane(roots.value?.home ?? activePath.value, group);
}
function closePane(id: string) {
  const pane = panes.get(id);
  const slot = closeTab(layout, id);
  if (!slot || !pane) return;
  panes.delete(id);
  closed.push({ pane, slot });
  if (closed.length > 20) closed.shift();
  closedCount.value = closed.length;
  persist();
}
function reopenPane() {
  const last = closed.pop();
  closedCount.value = closed.length;
  if (!last) return;
  panes.set(last.pane.id, last.pane);
  reopenTab(layout, last.slot);
  persist();
}
function duplicatePane(id: string) {
  const pane = panes.get(id);
  if (pane) newPane(pane.path, groupOf(layout, id), pane);
}
function info(id: string) {
  const pane = panes.get(id);
  return pane
    ? { label: label(pane.path, roots.value?.home), icon: crumbs(pane.path).length === 1 ? "drive" : "folder", title: pane.path }
    : { label: "…" };
}
// History keys and mouse side buttons in the sidebar act on the active pane.
function sideKeys(event: KeyboardEvent) {
  const pane = paneRefs.get(layout.active);
  if (!pane) return;
  if (event.altKey && event.key === "ArrowLeft") pane.goBack();
  else if (event.altKey && event.key === "ArrowRight") pane.goForward();
  else if ((event.altKey && event.key === "ArrowUp") || event.key === "Backspace") pane.goUp();
  else return;
  event.preventDefault();
  event.stopPropagation();
}
function sideMouse(event: MouseEvent) {
  const pane = paneRefs.get(layout.active);
  if (event.button === 3) pane?.goBack();
  else if (event.button === 4) pane?.goForward();
}
function navigateActive(path: string) {
  const ref = paneRefs.get(layout.active);
  if (ref) {
    ref.navigate(path);
    // Keep keyboard history (Alt+Left, Backspace) working after a sidebar click.
    ref.focus();
  }
  else if (!layout.tabs.length) newPane(path);
}
function externalDrop(event: DragEvent, group: SplitSide | null) {
  const data = parseDrag(event);
  if (!data) return;
  const dirs = data.dirs.length ? data.dirs : [crumbs(data.paths[0]!).at(-2)?.path].filter((x): x is string => !!x);
  for (const dir of dirs.slice(0, 12)) newPane(dir, group);
}

// ---- Transfers and drops --------------------------------------------------------
function parseDrag(event: DragEvent): { paths: string[]; dirs: string[] } | null {
  try {
    const data = JSON.parse(event.dataTransfer?.getData(DRAG_MIME) || "null");
    return data && Array.isArray(data.paths) ? { paths: data.paths, dirs: Array.isArray(data.dirs) ? data.dirs : [] } : null;
  } catch {
    return null;
  }
}
async function transfer(paths: string[], destination: string, mode: "copy" | "move") {
  const sources = paths.filter((p) => !samePath(p, destination));
  if (!sources.length) return;
  const what = sources.length === 1 ? `“${baseName(sources[0]!)}”` : `${sources.length} items`;
  busy.value = `${mode === "copy" ? "Copying" : "Moving"} ${what}…`;
  try {
    const result = await api<{ paths: string[] }>(mode, { paths: sources, destination });
    if (result.paths.length)
      toast(`${mode === "copy" ? "Copied" : "Moved"} ${what} to ${label(destination, roots.value?.home)}.`);
    changed([destination, ...sources.map((p) => crumbs(p).at(-2)?.path ?? p), ...sources]);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
    changed([destination, ...sources.map((p) => crumbs(p).at(-2)?.path ?? p)]);
  } finally {
    busy.value = "";
  }
}
function dropPaths(event: DragEvent, destination: string) {
  const data = parseDrag(event);
  if (!data?.paths.length) return;
  // Like Explorer: same drive moves, another drive copies; Ctrl/Shift override.
  const sameDrive = samePath(rootOf(data.paths[0]!), rootOf(destination));
  const mode = event.ctrlKey ? "copy" : event.shiftKey ? "move" : sameDrive ? "move" : "copy";
  void transfer(data.paths, destination, mode);
}
const treeDrop = ref("");
function treeOver(event: DragEvent, path: string) {
  if (!event.dataTransfer?.types.includes(DRAG_MIME)) return;
  event.preventDefault();
  treeDrop.value = path;
}
function treeDropped(event: DragEvent, path: string) {
  treeDrop.value = "";
  event.preventDefault();
  dropPaths(event, path);
}

// ---- Context shared with panes ---------------------------------------------------
const ctx: ExplorerContext = reactive({
  home: "",
  token: "",
  hidden: saved.hidden === true,
  live: saved.live !== false,
  sizes: saved.sizes === true,
  clip: null,
  signal: { stamp: 0, dirs: [] as string[] },
  toggleLive() {
    ctx.live = !ctx.live;
    persist();
  },
  toggleSizes() {
    ctx.sizes = !ctx.sizes;
    persist();
  },
  batchRename(items: FileEntry[], done: () => void) {
    renaming.value = { items, done };
  },
  toggleHidden() {
    ctx.hidden = !ctx.hidden;
    children.clear();
    for (const key of expanded) void refreshNode(key);
    persist();
  },
  remember,
  changed,
  toast,
  confirm,
  menu: showMenu,
  openTab: (path: string) => void newPane(path),
  openSplit(path: string) {
    const pane = newPane(path);
    splitWith(layout, pane.id, "right");
    persist();
  },
  open: (path: string) => void api("open", { path }).catch((e) => toast(e.message, true)),
  reveal: (path: string) => void api("reveal", { path }).catch((e) => toast(e.message, true)),
  terminal: (path: string) => void api("terminal", { path }).catch((e) => toast(e.message, true)),
  isPinned: (path: string) => pins.value.some((p) => samePath(p, path)),
  togglePin(path: string) {
    pins.value = ctx.isPinned(path) ? pins.value.filter((p) => !samePath(p, path)) : [...pins.value, path];
    persist();
  },
  transfer,
  dropPaths,
  // The canvas (App.vue) owns app creation; it listens for this event.
  addToCanvas(path: string) {
    window.dispatchEvent(new CustomEvent("orvane:place-file", { detail: { path } }));
  },
});
async function refreshNode(key: string) {
  const node = tree.value.find((n) => n.path.toLowerCase() === key);
  if (!node) return;
  try {
    const data = await api<{ entries: FileEntry[] }>("list", { path: node.path });
    remember(node.path, data.entries);
  } catch {
    children.set(key, "error");
  }
}
function changed(dirs: string[]) {
  ctx.signal = { stamp: ctx.signal.stamp + 1, dirs };
  for (const dir of dirs) {
    const key = dir.toLowerCase();
    if (expanded.has(key)) void refreshNode(key);
    else children.delete(key);
  }
}

// ---- Batch rename ----------------------------------------------------------------
const renaming = ref<{ items: FileEntry[]; done: () => void } | null>(null);
async function applyRename(items: { path: string; name: string }[]) {
  const current = renaming.value;
  renaming.value = null;
  try {
    await api("rename-many", { items });
    toast(`Renamed ${items.length} item${items.length === 1 ? "" : "s"}.`);
    changed([...new Set(items.map((i) => crumbs(i.path).at(-2)?.path ?? i.path))]);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
  current?.done();
}

// ---- Toasts, confirm and menus -----------------------------------------------------
const toasts = ref<{ id: number; text: string; error: boolean }[]>([]);
const busy = ref("");
let toastId = 0;
function toast(text: string, error = false) {
  const id = ++toastId;
  toasts.value = [...toasts.value.slice(-3), { id, text, error }];
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), error ? 6000 : 3000);
}
const dialog = ref<{ message: string; action: string; resolve: (ok: boolean) => void } | null>(null);
const dialogButton = ref<HTMLButtonElement>();
function confirm(message: string, action: string) {
  dialog.value?.resolve(false);
  return new Promise<boolean>((resolve) => {
    dialog.value = { message, action, resolve };
    setTimeout(() => dialogButton.value?.focus());
  });
}
function answer(ok: boolean) {
  dialog.value?.resolve(ok);
  dialog.value = null;
}
const root = ref<HTMLElement>();
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);
// The app sits inside the scaled canvas: convert screen to local coordinates.
function local(event: MouseEvent) {
  const box = root.value!;
  const bounds = box.getBoundingClientRect(),
    scale = bounds.width / box.offsetWidth || 1;
  return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale, box };
}
function showMenu(event: MouseEvent, items: MenuItem[]) {
  if (!root.value) return;
  const { x, y, box } = local(event);
  const height = items.reduce((h, i) => h + (i === "sep" ? 9 : 29), 8);
  menu.value = {
    items,
    x: Math.max(4, Math.min(box.offsetWidth - 234, x)),
    y: Math.max(4, Math.min(box.offsetHeight - height - 4, y)),
  };
}
function runItem(item: MenuItem) {
  menu.value = null;
  if (item !== "sep" && !item.disabled) void item.run();
}
function placeMenu(event: MouseEvent, path: string) {
  showMenu(event, [
    { label: "Open", icon: "folder-open", run: () => navigateActive(path) },
    { label: "Open in new tab", icon: "plus", run: () => ctx.openTab(path) },
    { label: "Open in split view", icon: "columns", run: () => ctx.openSplit(path) },
    "sep",
    { label: ctx.isPinned(path) ? "Unpin from Quick access" : "Pin to Quick access", icon: "pin", run: () => ctx.togglePin(path) },
    { label: "Open in terminal", icon: "terminal", run: () => ctx.terminal(path) },
    { label: "Show in system explorer", icon: "external", run: () => ctx.open(path) },
  ]);
}
function outside(event: PointerEvent) {
  if (!(event.target as Element)?.closest?.(".fx-menu")) menu.value = null;
}
function escapeMenu(event: KeyboardEvent) {
  if (event.key !== "Escape" || !menu.value) return;
  event.preventDefault();
  event.stopPropagation();
  menu.value = null;
}

// ---- Sidebar resize ---------------------------------------------------------------
let stopResize: (() => void) | undefined;
function startResize(event: PointerEvent) {
  const width = sidebarWidth.value;
  const box = root.value!;
  const scale = box.getBoundingClientRect().width / box.offsetWidth || 1;
  const move = (e: PointerEvent) => {
    sidebarWidth.value = Math.min(420, Math.max(150, width + (e.clientX - event.clientX) / scale));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    stopResize = undefined;
    persist();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  stopResize = up;
}
function resizeKey(event: KeyboardEvent) {
  const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
  if (!step) return;
  event.preventDefault();
  sidebarWidth.value = Math.min(420, Math.max(150, sidebarWidth.value + step));
  persist();
}

// Coming back to the window picks up changes made by other programs.
function windowFocus() {
  const visible = isSplit(layout) ? [layout.leftActive, layout.rightActive] : [layout.active];
  const dirs = visible.map((id) => panes.get(id)?.path).filter((p): p is string => !!p);
  if (dirs.length) ctx.signal = { stamp: ctx.signal.stamp + 1, dirs };
}
// Ctrl+K palette: commands, and showing a file found by search.
const stopCommands = registerCommands(`files:${props.block.id}`, () => [
  { id: `files-tab:${props.block.id}`, title: "New File Explorer tab", icon: "plus", blockId: props.block.id, keywords: "folder", run: () => addPane(null) },
  ...(roots.value?.places ?? []).map((place) => ({
    id: `files-place:${props.block.id}:${place.path}`,
    title: `Open ${place.name}`,
    detail: "File Explorer",
    icon: "folder-open",
    blockId: props.block.id,
    keywords: "folder go",
    run: () => navigateActive(place.path),
  })),
  ...pins.value.map((pin) => ({
    id: `files-pin:${props.block.id}:${pin}`,
    title: `Open ${label(pin, roots.value?.home)}`,
    detail: `Pinned · ${pin}`,
    icon: "pin",
    blockId: props.block.id,
    keywords: "folder go",
    run: () => navigateActive(pin),
  })),
  { id: `files-hidden:${props.block.id}`, title: ctx.hidden ? "Hide hidden files" : "Show hidden files", icon: "eye", blockId: props.block.id, run: () => ctx.toggleHidden() },
  { id: `files-live:${props.block.id}`, title: ctx.live ? "Turn off live updates" : "Turn on live updates", icon: "refresh", blockId: props.block.id, keywords: "watch", run: () => ctx.toggleLive() },
  { id: `files-sizes:${props.block.id}`, title: ctx.sizes ? "Hide folder sizes" : "Calculate folder sizes", icon: "sort", blockId: props.block.id, run: () => ctx.toggleSizes() },
]);
const stopOpen = onOpenRequest((request) => {
  if (request.kind !== "explorer-path" || (request.blockId && request.blockId !== props.block.id)) return;
  const pane = paneRefs.get(layout.active);
  if (pane) pane.show(request.path, request.select);
  else newPane(request.path);
  return true;
});
onBeforeUnmount(() => (stopCommands(), stopOpen()));
onMounted(() => {
  void loadRoots();
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escapeMenu, true);
  window.addEventListener("focus", windowFocus);
});
onBeforeUnmount(() => {
  stopResize?.();
  clearTimeout(saveTimer);
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", escapeMenu, true);
  window.removeEventListener("focus", windowFocus);
  dialog.value?.resolve(false);
});
const placeIcon: Record<string, string> = {
  home: "home",
  desktop: "desktop",
  documents: "file",
  downloads: "download",
  pictures: "image",
  music: "music",
  videos: "video",
};
</script>
<template>
  <section ref="root" class="fx-root" aria-label="File Explorer">
    <aside
      v-if="!collapsed"
      class="fx-side"
      :style="{ width: sidebarWidth + 'px' }"
      aria-label="Locations"
      @keydown="sideKeys"
      @mouseup="sideMouse"
    >
      <div class="fx-side-head">
        <h2>Quick access</h2>
        <button aria-label="Hide sidebar" title="Hide sidebar" @click="(collapsed = true), persist()">
          <Icon name="sidebar" :size="13" />
        </button>
      </div>
      <button
        v-for="place in roots?.places ?? []"
        :key="place.path"
        class="fx-place"
        :class="{ active: samePath(place.path, activePath), drop: treeDrop === place.path }"
        :title="place.path"
        @click="navigateActive(place.path)"
        @contextmenu.prevent="placeMenu($event, place.path)"
        @dragover="treeOver($event, place.path)"
        @dragleave="treeDrop = ''"
        @drop="treeDropped($event, place.path)"
      >
        <Icon :name="placeIcon[place.icon ?? ''] ?? 'folder'" :size="14" class="fx-place-icon" /><span>{{ place.name }}</span>
      </button>
      <template v-if="pins.length">
        <div class="fx-side-head"><h2>Pinned</h2></div>
        <button
          v-for="pin in pins"
          :key="pin"
          class="fx-place"
          :class="{ active: samePath(pin, activePath), drop: treeDrop === pin }"
          :title="pin"
          @click="navigateActive(pin)"
          @contextmenu.prevent="placeMenu($event, pin)"
          @dragover="treeOver($event, pin)"
          @dragleave="treeDrop = ''"
          @drop="treeDropped($event, pin)"
        >
          <Icon name="pin" :size="13" class="fx-place-icon" /><span>{{ label(pin, roots?.home) }}</span>
        </button>
      </template>
      <div class="fx-side-head">
        <h2>This PC</h2>
        <button aria-label="Show current folder in tree" title="Show current folder in tree" @click="expandTo(activePath)">
          <Icon name="eye" :size="13" />
        </button>
      </div>
      <p v-if="rootError" class="fx-side-note">{{ rootError }}</p>
      <div class="fx-tree" role="tree">
        <template v-for="node in tree" :key="node.path">
          <p v-if="node.state" class="fx-side-note" :style="{ paddingLeft: 8 + node.depth * 14 + 'px' }">
            {{
              node.state === "loading"
                ? "Loading…"
                : node.state === "error"
                  ? "Cannot open"
                  : node.state === "more"
                    ? `${node.more} more…`
                    : "No folders"
            }}
          </p>
          <div
            v-else
            class="fx-node"
            :class="{ active: samePath(node.path, activePath), drop: treeDrop === node.path }"
            role="treeitem"
            :aria-expanded="expanded.has(node.path.toLowerCase())"
            :style="{ paddingLeft: 2 + node.depth * 14 + 'px' }"
            :title="node.path"
            @dragover="treeOver($event, node.path)"
            @dragleave="treeDrop = ''"
            @drop="treeDropped($event, node.path)"
            @contextmenu.prevent="placeMenu($event, node.path)"
          >
            <button
              class="fx-twisty"
              :class="{ open: expanded.has(node.path.toLowerCase()) }"
              :aria-label="expanded.has(node.path.toLowerCase()) ? 'Collapse' : 'Expand'"
              @click="toggleNode(node.path)"
            >
              <Icon name="right" :size="11" />
            </button>
            <button class="fx-node-name" @click="navigateActive(node.path)" @dblclick="toggleNode(node.path)">
              <Icon :name="node.depth ? 'folder' : 'drive'" :size="13" :class="node.depth ? 'fx-folder' : 'fx-place-icon'" /><span>{{
                node.name
              }}</span>
            </button>
          </div>
        </template>
      </div>
    </aside>
    <div
      v-if="!collapsed"
      class="fx-resize"
      role="separator"
      tabindex="0"
      aria-label="Resize sidebar"
      :aria-valuenow="Math.round(sidebarWidth)"
      @pointerdown.prevent="startResize"
      @keydown="resizeKey"
    />
    <div class="fx-content">
      <p v-if="rootError && !layout.tabs.length" class="fx-unavailable">
        <Icon name="alert" :size="16" />{{ rootError }}<br />The File Explorer needs Orvane's local server (pnpm dev or the desktop app).
      </p>
      <SplitTabs
        v-else-if="layout.tabs.length"
        :layout="layout"
        :info="info"
        label="File Explorer"
        :accept="DRAG_MIME"
        :can-reopen="closedCount > 0"
        lazy
        @add="addPane"
        @close="closePane"
        @reopen="reopenPane"
        @reload="paneRefs.get($event)?.reload()"
        @duplicate="duplicatePane"
        @external="externalDrop"
        @changed="persist"
      >
        <template #actions>
          <button
            v-if="collapsed"
            class="fx-tab-action"
            aria-label="Show sidebar"
            title="Show sidebar"
            @click="(collapsed = false), persist()"
          >
            <Icon name="sidebar" :size="13" />
          </button>
        </template>
        <template #pane="{ id, focused, visible }">
          <FilePane
            v-if="panes.get(id)"
            :ref="(el) => setRef(id, el)"
            :pane="panes.get(id)!"
            :ctx="ctx"
            :focused="focused"
            :visible="visible"
            @changed="persist"
          />
        </template>
      </SplitTabs>
    </div>
    <div v-if="menu" class="fx-menu" role="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <template v-for="(item, index) in menu.items" :key="index">
        <hr v-if="item === 'sep'" />
        <button v-else role="menuitem" :class="{ danger: item.danger }" :disabled="item.disabled" @click="runItem(item)">
          <Icon :name="item.icon" :size="13" /><span>{{ item.label }}</span><kbd v-if="item.hint">{{ item.hint }}</kbd>
        </button>
      </template>
    </div>
    <div v-if="dialog" class="fx-dialog-backdrop" @pointerdown.self="answer(false)">
      <div class="fx-dialog" role="alertdialog" aria-modal="true" @keydown.esc.stop="answer(false)" @keydown.stop>
        <p>{{ dialog.message }}</p>
        <p class="fx-dialog-note">You can restore it from the Recycle Bin.</p>
        <div class="fx-dialog-actions">
          <button @click="answer(false)">Cancel</button>
          <button ref="dialogButton" class="danger" @click="answer(true)">{{ dialog.action }}</button>
        </div>
      </div>
    </div>
    <BatchRename
      v-if="renaming"
      :items="renaming.items"
      @cancel="renaming = null"
      @apply="applyRename"
    />
    <div class="fx-toasts" aria-live="polite">
      <div v-if="busy" class="fx-toast"><span class="fx-spinner" />{{ busy }}</div>
      <div v-for="t in toasts" :key="t.id" class="fx-toast" :class="{ error: t.error }">{{ t.text }}</div>
    </div>
  </section>
</template>
<style>
.app-content:has(> .block-files:only-child) {
  padding: 0;
  overflow: hidden;
}
.app-content > .block-files {
  display: flex;
  flex: 1;
  min-height: 260px;
}
.block-files:not(:only-child) {
  height: 520px;
}
</style>
<style scoped>
.fx-root {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: #f7f9fa;
  color: #455968;
  font-size: 12px;
}
.fx-side {
  display: flex;
  flex-direction: column;
  flex: none;
  min-height: 0;
  padding: 10px 8px;
  overflow-y: auto;
  overflow-x: hidden;
}
.fx-side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 4px 4px 6px;
}
.fx-side-head:first-child {
  margin-top: 0;
}
.fx-side h2 {
  margin: 0;
  color: #718591;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.fx-side-head button,
.fx-tab-action {
  display: grid;
  place-items: center;
  padding: 3px;
  border-radius: 3px;
  background: none;
  color: #718591;
}
.fx-tab-action {
  flex: none;
  width: 25px;
  height: 25px;
  margin-bottom: 3px;
}
.fx-side-head button:hover,
.fx-tab-action:hover {
  background: #e2ebef;
}
.fx-place,
.fx-node {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 5px;
  background: none;
  color: #455968;
  text-align: left;
}
.fx-node {
  gap: 0;
  padding-top: 0;
  padding-bottom: 0;
}
.fx-place span,
.fx-node-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fx-place:hover,
.fx-node:hover {
  background: #e9f1f4;
}
.fx-place.active,
.fx-node.active {
  background: #dce9f0;
  color: #2f4856;
}
.fx-place.drop,
.fx-node.drop {
  background: #d3e6ef;
  box-shadow: inset 0 0 0 2px #6f9ab0;
}
.fx-place-icon {
  flex: none;
  color: #6f8998;
}
.fx-folder {
  flex: none;
  color: #d39b2a;
}
.fx-twisty {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 24px;
  padding: 0;
  background: none;
  color: #8798a3;
}
.fx-twisty :deep(svg) {
  transition: transform 0.12s;
}
.fx-twisty.open :deep(svg) {
  transform: rotate(90deg);
}
.fx-node-name {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  padding: 5px 4px 5px 2px;
  background: none;
  color: inherit;
  text-align: left;
}
.fx-node-name:hover {
  background: none;
}
.fx-side-note {
  margin: 2px 0;
  padding: 3px 8px;
  color: #8798a3;
  font-size: 11px;
}
.fx-resize {
  position: relative;
  flex: none;
  width: 1px;
  background: #dce5e9;
  cursor: col-resize;
}
.fx-resize::after {
  content: "";
  position: absolute;
  inset: 0 -4px;
}
.fx-resize:hover,
.fx-resize:focus-visible {
  background: #8ca7b5;
  outline: none;
}
.fx-content {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.fx-unavailable {
  margin: auto;
  max-width: 360px;
  color: #718591;
  line-height: 1.6;
  text-align: center;
}
.fx-menu {
  position: absolute;
  z-index: 70;
  width: 230px;
  padding: 4px;
  border: 1px solid #dce5e9;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 8px 22px #425c6b2e;
}
.fx-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 4px;
  background: none;
  color: #455968;
  font-size: 12px;
  text-align: left;
}
.fx-menu button span {
  flex: 1;
}
.fx-menu kbd {
  color: #8798a3;
  font: inherit;
  font-size: 11px;
}
.fx-menu button:hover:not(:disabled) {
  background: #e8f0f4;
}
.fx-menu button.danger {
  color: #a5503d;
}
.fx-menu button:disabled {
  opacity: 0.45;
}
.fx-menu hr {
  margin: 4px 2px;
  border: 0;
  border-top: 1px solid #e8eef1;
}
.fx-dialog-backdrop {
  position: absolute;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: #e9edf099;
}
.fx-dialog {
  width: min(340px, calc(100% - 32px));
  padding: 16px;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 12px 32px #425c6b33;
}
.fx-dialog p {
  margin: 0 0 6px;
  color: #2f4856;
  font-size: 13px;
  line-height: 1.5;
}
.fx-dialog .fx-dialog-note {
  color: #718591;
  font-size: 12px;
}
.fx-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.fx-dialog-actions button {
  padding: 6px 12px;
  border-radius: 5px;
  background: #e7edf0;
  color: #455968;
}
.fx-dialog-actions button.danger {
  background: #b5533f;
  color: #fff;
}
.fx-toasts {
  position: absolute;
  right: 12px;
  bottom: 30px;
  z-index: 75;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none;
}
.fx-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 360px;
  padding: 7px 12px;
  border-radius: 6px;
  background: #344f5e;
  color: #fff;
  font-size: 12px;
  box-shadow: 0 6px 16px #2f485633;
}
.fx-toast.error {
  background: #a5503d;
}
.fx-spinner {
  flex: none;
  width: 11px;
  height: 11px;
  border: 2px solid #ffffff55;
  border-top-color: #fff;
  border-radius: 50%;
  animation: fx-spin 0.8s linear infinite;
}
@keyframes fx-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
