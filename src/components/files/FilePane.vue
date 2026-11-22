<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import Icon from "../Icon.vue";
import FilePeek from "./FilePeek.vue";
import {
  api,
  baseName,
  crumbs,
  DRAG_MIME,
  formatDate,
  formatSize,
  iconOf,
  isImage,
  label,
  folderCardCache,
  cardThumb,
  thumbKey,
  rawUrl,
  rememberFolderCard,
  samePath,
  sortEntries,
  toneOf,
  typeName,
  watchFolder,
  type ExplorerContext,
  type FolderCard,
  type FileEntry,
  type MenuItem,
  type PaneState,
  type SortKey,
} from "./explorer";

const props = defineProps<{ pane: PaneState; ctx: ExplorerContext; focused: boolean; visible: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const p = props.pane;

// ---- Listing -------------------------------------------------------------
const entries = shallowRef<FileEntry[]>([]);
const parent = ref<string | null>(null);
const loading = ref(false);
const error = ref("");
const truncated = ref(false);
const filter = ref("");
let loadSeq = 0;
async function load(quiet = false) {
  const seq = ++loadSeq,
    path = p.path;
  if (!quiet) loading.value = true;
  // A refresh the user asked for reads the folder cards again too.
  if (!quiet) for (const path of folderCardCache.keys()) forced.add(path);
  try {
    const data = await api<{ path: string; parent: string | null; entries: FileEntry[]; truncated: boolean }>("list", { path });
    if (seq !== loadSeq) return;
    entries.value = data.entries;
    parent.value = data.parent;
    truncated.value = data.truncated;
    error.value = "";
    if (data.path !== p.path) p.path = data.path;
    // Keep the selection for items that still exist.
    const alive = new Set(data.entries.map((e) => e.path));
    selected.value = new Set([...selected.value].filter((x) => alive.has(x)));
    props.ctx.remember(data.path, data.entries);
    void loadGit(data.path);
    if (props.ctx.sizes) void loadSizes();
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = e instanceof Error ? e.message : String(e);
    entries.value = [];
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}
function navigate(path: string, record = true) {
  if (!path) return;
  cancelSearch();
  if (record && !samePath(path, p.path)) {
    p.back.push(p.path);
    if (p.back.length > 60) p.back.shift();
    p.forward = [];
  }
  const from = p.path;
  p.path = path;
  filter.value = "";
  selected.value = new Set();
  cursor.value = "";
  // Going up selects the folder we came out of, like Explorer.
  pendingSelect = from;
  scrollTo(0);
  emit("changed");
  void load().then(() => {
    const hit = shown.value.find((e) => samePath(e.path, pendingSelect));
    if (hit) select(hit, false), reveal(hit.path);
    pendingSelect = "";
  });
}
let pendingSelect = "";
function goBack() {
  const to = p.back.pop();
  if (!to) return;
  p.forward.push(p.path);
  navigate(to, false);
}
function goForward() {
  const to = p.forward.pop();
  if (!to) return;
  p.back.push(p.path);
  navigate(to, false);
}
function goUp() {
  if (parent.value) navigate(parent.value);
}
watch(
  () => props.ctx.signal.stamp,
  () => {
    if (props.ctx.signal.dirs.some((d) => samePath(d, p.path))) void load(true);
  },
);
onMounted(() => void load());

// ---- Live: reload when something changes in this folder on disk ----
let unwatch: (() => void) | undefined;
let liveTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => [p.path, props.ctx.live, props.visible] as const,
  ([path, live, visible]) => {
    unwatch?.();
    unwatch = undefined;
    // Hidden tabs do not watch; they reload when shown.
    if (!live || visible === false) return;
    unwatch = watchFolder(path, () => {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => void load(true), 120);
    });
  },
  { immediate: true },
);
watch(
  () => props.visible,
  (visible, was) => {
    if (visible && was === false) void load(true);
  },
);
onBeforeUnmount(() => {
  unwatch?.();
  clearTimeout(liveTimer);
});

// ---- Git status badges (only inside a repository) ----
const gitBadges = shallowRef<Record<string, string>>({});
let gitSeq = 0;
async function loadGit(path: string) {
  const seq = ++gitSeq;
  try {
    const data = await api<{ repo: boolean; entries: Record<string, string> }>("git-status", { path });
    if (seq === gitSeq && samePath(path, p.path)) gitBadges.value = data.entries;
  } catch {
    if (seq === gitSeq) gitBadges.value = {};
  }
}
const GIT_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
  C: "Conflict",
};

// ---- Folder sizes (on request; computed in the background) ----
const sizes = shallowRef<Record<string, { bytes: number; complete: boolean } | "pending">>({});
let sizeSeq = 0;
async function loadSizes() {
  const seq = ++sizeSeq;
  const dirs = entries.value.filter((e) => e.dir).map((e) => e.path).slice(0, 200);
  if (!dirs.length) return;
  sizes.value = Object.fromEntries(dirs.map((d) => [d, sizes.value[d] && sizes.value[d] !== "pending" ? sizes.value[d] : "pending"]));
  // Small batches so the first sizes appear quickly.
  for (let i = 0; i < dirs.length; i += 8) {
    try {
      const data = await api<Record<string, { bytes: number; complete: boolean }>>("folder-size", { paths: dirs.slice(i, i + 8) });
      if (seq !== sizeSeq) return;
      sizes.value = { ...sizes.value, ...data };
    } catch {
      return;
    }
  }
}
watch(
  () => props.ctx.sizes,
  (on) => (on ? void loadSizes() : ((sizeSeq++), (sizes.value = {}))),
);
function sizeOf(entry: FileEntry) {
  if (!entry.dir) return formatSize(entry.size);
  const size = sizes.value[entry.path];
  if (!size) return "";
  if (size === "pending") return "…";
  return (size.complete ? "" : "≥ ") + formatSize(size.bytes);
}
// With sizes on, sorting by size uses folder totals too.
function sizeValue(entry: FileEntry) {
  const size = sizes.value[entry.path];
  return entry.dir && size && size !== "pending" ? size.bytes : entry.size;
}

// ---- Zip ----
async function compress(items = selection.value) {
  if (!items.length) return;
  props.ctx.toast(`Compressing ${items.length === 1 ? `“${items[0]!.name}”` : `${items.length} items`}…`);
  try {
    const result = await api<{ path: string; count: number }>("zip", { paths: items.map((e) => e.path) });
    await load(true);
    props.ctx.changed([p.path]);
    const hit = shown.value.find((e) => samePath(e.path, result.path));
    if (hit) (select(hit, false), reveal(hit.path));
    props.ctx.toast(`Created ${baseName(result.path)} (${result.count} file${result.count === 1 ? "" : "s"}).`);
  } catch (e) {
    props.ctx.toast(e instanceof Error ? e.message : String(e), true);
  }
}
async function extract(entry: FileEntry) {
  try {
    const result = await api<{ path: string; count: number }>("unzip", { path: entry.path });
    await load(true);
    props.ctx.changed([p.path]);
    const hit = shown.value.find((e) => samePath(e.path, result.path));
    if (hit) (select(hit, false), reveal(hit.path));
    props.ctx.toast(`Extracted ${result.count} file${result.count === 1 ? "" : "s"} to ${baseName(result.path)}.`);
  } catch (e) {
    props.ctx.toast(e instanceof Error ? e.message : String(e), true);
  }
}
function batchRename(items = selection.value) {
  if (!items.length) return;
  props.ctx.batchRename(items, () => focusPane());
}
// Mouse side buttons (3 = back, 4 = forward) act on the pane under the pointer.
function mouseHistory(event: MouseEvent) {
  if (event.button === 3) (event.preventDefault(), goBack());
  else if (event.button === 4) (event.preventDefault(), goForward());
}
defineExpose({
  reload: () => load(),
  navigate,
  goBack,
  goForward,
  goUp,
  focus: () => focusPane(),
  // Opens a folder and selects one item in it (used by Ctrl+K results).
  show(path: string, item?: string) {
    if (samePath(path, p.path)) {
      void load(true).then(() => {
        const hit = item && shown.value.find((e) => samePath(e.path, item));
        if (hit) (select(hit, false), reveal(hit.path));
      });
    } else {
      navigate(path);
      if (item) pendingSelect = item;
    }
    focusPane();
  },
});

// ---- Search ---------------------------------------------------------------
const query = ref("");
const results = shallowRef<FileEntry[] | null>(null);
const searching = ref(false);
const searchNote = ref("");
let searchSeq = 0;
async function runSearch() {
  const q = query.value.trim();
  if (!q) return cancelSearch();
  const seq = ++searchSeq;
  searching.value = true;
  searchNote.value = "";
  try {
    const data = await api<{ entries: FileEntry[]; complete: boolean; visited: number }>("search", {
      path: p.path,
      query: q,
      hidden: props.ctx.hidden,
    });
    if (seq !== searchSeq) return;
    results.value = data.entries;
    selected.value = new Set();
    scrollTo(0);
    searchNote.value = `${data.entries.length} result${data.entries.length === 1 ? "" : "s"} in ${data.visited.toLocaleString()} folders${data.complete ? "" : " · search stopped early"}`;
  } catch (e) {
    if (seq === searchSeq) props.ctx.toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    if (seq === searchSeq) searching.value = false;
  }
}
function cancelSearch() {
  searchSeq++;
  searching.value = false;
  results.value = null;
  searchNote.value = "";
  query.value = "";
}

// ---- What is shown ----------------------------------------------------------
const shown = computed(() => {
  let list = results.value ?? entries.value;
  if (!props.ctx.hidden) list = list.filter((e) => !e.hidden);
  const f = filter.value.trim().toLowerCase();
  if (f) list = list.filter((e) => e.name.toLowerCase().includes(f));
  if (p.sort.key === "size" && props.ctx.sizes) {
    const order = sortEntries(
      list.map((e) => (e.dir ? { ...e, size: sizeValue(e) } : e)),
      p.sort,
    ).map((e) => e.path);
    const byPath = new Map(list.map((e) => [e.path, e]));
    return order.map((path) => byPath.get(path)!);
  }
  return sortEntries(list, p.sort);
});
function sortBy(key: SortKey) {
  p.sort = { key, dir: p.sort.key === key ? (-p.sort.dir as 1 | -1) : key === "mtime" || key === "size" ? -1 : 1 };
  emit("changed");
}

// ---- Selection --------------------------------------------------------------
const selected = ref(new Set<string>());
const anchor = ref("");
const cursor = ref("");
const selection = computed(() => shown.value.filter((e) => selected.value.has(e.path)));
function select(entry: FileEntry, additive: boolean) {
  const next = additive ? new Set(selected.value) : new Set<string>();
  if (additive && next.has(entry.path)) next.delete(entry.path);
  else next.add(entry.path);
  selected.value = next;
  anchor.value = entry.path;
  cursor.value = entry.path;
}
function selectRange(entry: FileEntry, additive: boolean) {
  const list = shown.value;
  const a = list.findIndex((e) => e.path === anchor.value),
    b = list.findIndex((e) => e.path === entry.path);
  if (a < 0) return select(entry, additive);
  const next = additive ? new Set(selected.value) : new Set<string>();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(list[i]!.path);
  selected.value = next;
  cursor.value = entry.path;
}
function itemClick(event: MouseEvent, entry: FileEntry) {
  focusPane();
  if (event.shiftKey) selectRange(entry, event.ctrlKey || event.metaKey);
  else select(entry, event.ctrlKey || event.metaKey);
}
function backgroundClick(event: MouseEvent) {
  if (event.target === event.currentTarget || (event.target as Element).classList.contains("fx-spacer-row")) {
    selected.value = new Set();
    focusPane();
  }
}
function selectAll() {
  selected.value = new Set(shown.value.map((e) => e.path));
}

// ---- Opening ----------------------------------------------------------------
async function open(entry: FileEntry) {
  if (entry.dir) return navigate(entry.path);
  try {
    await api("open", { path: entry.path });
  } catch (e) {
    props.ctx.toast(e instanceof Error ? e.message : String(e), true);
  }
}
function openSelection() {
  const items = selection.value;
  if (items.length === 1) return open(items[0]!);
  for (const item of items) item.dir ? props.ctx.openTab(item.path) : void open(item);
}

// ---- File operations --------------------------------------------------------
const renaming = ref("");
const renameDraft = ref("");
const renameInput = ref<HTMLInputElement[]>();
function startRename(entry?: FileEntry) {
  const target = entry ?? selection.value[0];
  if (!target) return;
  renaming.value = target.path;
  renameDraft.value = target.name;
  reveal(target.path);
  void nextTick(() => {
    const input = renameInput.value?.[0];
    if (!input) return;
    input.focus();
    const dot = target.dir ? -1 : target.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : target.name.length);
  });
}
async function commitRename() {
  const path = renaming.value,
    name = renameDraft.value.trim();
  renaming.value = "";
  focusPane();
  if (!path || !name || name === baseName(path)) return;
  try {
    const result = await api<{ path: string }>("rename", { path, name });
    await load(true);
    const hit = shown.value.find((e) => samePath(e.path, result.path));
    if (hit) select(hit, false);
    props.ctx.changed([p.path]);
  } catch (e) {
    props.ctx.toast(e instanceof Error ? e.message : String(e), true);
  }
}
async function create(kind: "mkdir" | "new-file") {
  if (results.value) cancelSearch();
  try {
    const result = await api<{ path: string }>(kind, { path: p.path, name: kind === "mkdir" ? "New folder" : "New text file.txt" });
    await load(true);
    props.ctx.changed([p.path]);
    const hit = shown.value.find((e) => samePath(e.path, result.path));
    if (hit) {
      select(hit, false);
      startRename(hit);
    }
  } catch (e) {
    props.ctx.toast(e instanceof Error ? e.message : String(e), true);
  }
}
async function remove(items = selection.value) {
  if (!items.length) return;
  const what = items.length === 1 ? `“${items[0]!.name}”` : `${items.length} items`;
  if (!(await props.ctx.confirm(`Move ${what} to the Recycle Bin?`, "Delete"))) return focusPane();
  focusPane();
  try {
    await api("trash", { paths: items.map((e) => e.path) });
    props.ctx.toast(`Moved ${what} to the Recycle Bin.`);
    props.ctx.changed([p.path, ...items.map((e) => e.path)]);
    if (results.value) results.value = results.value.filter((r) => !items.includes(r));
  } catch (e) {
    props.ctx.toast(e instanceof Error ? e.message : String(e), true);
    void load(true);
  }
}
function copy(mode: "copy" | "cut", items = selection.value) {
  if (!items.length) return;
  props.ctx.clip = { mode, paths: items.map((e) => e.path) };
  props.ctx.toast(`${mode === "cut" ? "Cut" : "Copied"} ${items.length} item${items.length === 1 ? "" : "s"}.`);
}
function paste(into = p.path) {
  const clip = props.ctx.clip;
  if (!clip) return;
  void props.ctx.transfer(clip.paths, into, clip.mode === "cut" ? "move" : "copy");
  if (clip.mode === "cut") props.ctx.clip = null;
}
function copyPath(items = selection.value) {
  const text = items.length ? items.map((e) => e.path).join("\n") : p.path;
  void navigator.clipboard?.writeText(text).then(
    () => props.ctx.toast("Path copied."),
    () => props.ctx.toast("Could not copy to the clipboard.", true),
  );
}
const isCut = (path: string) => props.ctx.clip?.mode === "cut" && props.ctx.clip.paths.includes(path);

// ---- Context menus ----------------------------------------------------------
function itemMenu(event: MouseEvent, entry: FileEntry) {
  if (!selected.value.has(entry.path)) select(entry, false);
  const items = selection.value,
    one = items.length === 1 ? items[0]! : null;
  const menu: MenuItem[] = [
    { label: "Open", icon: one?.dir ? "folder-open" : "external", run: openSelection },
  ];
  if (one && !one.dir) menu.push({ label: "Peek", icon: "eye", hint: "Space", run: () => peek(one) });
  const placeable = items.filter((e) => !e.dir);
  if (placeable.length)
    menu.push({
      label: placeable.length === 1 ? "Place on canvas" : `Place ${placeable.length} files on canvas`,
      icon: placeable.every((e) => isImage(e.path)) ? "image" : "app",
      run: () => placeable.slice(0, 20).forEach((e) => props.ctx.addToCanvas(e.path)),
    });
  if (one?.dir)
    menu.push(
      { label: "Open in new tab", icon: "plus", run: () => props.ctx.openTab(one.path) },
      { label: "Open in split view", icon: "columns", run: () => props.ctx.openSplit(one.path) },
      { label: "Open in terminal", icon: "terminal", run: () => props.ctx.terminal(one.path) },
      {
        label: props.ctx.isPinned(one.path) ? "Unpin from Quick access" : "Pin to Quick access",
        icon: "pin",
        run: () => props.ctx.togglePin(one.path),
      },
    );
  if (results.value && one)
    menu.push({ label: "Open file location", icon: "folder", run: () => locate(one) });
  menu.push(
    { label: "Show in system explorer", icon: "external", run: () => props.ctx.reveal(items[0]!.path) },
    "sep",
    { label: "Cut", icon: "cut", hint: "Ctrl+X", run: () => copy("cut", items) },
    { label: "Copy", icon: "copy", hint: "Ctrl+C", run: () => copy("copy", items) },
  );
  if (one?.dir && props.ctx.clip) menu.push({ label: "Paste into folder", icon: "paste", run: () => paste(one.path) });
  menu.push({ label: "Copy path", icon: "link", run: () => copyPath(items) }, "sep");
  if (one && !one.dir && one.ext === "zip") menu.push({ label: "Extract here", icon: "archive2", run: () => extract(one) });
  menu.push(
    { label: items.length === 1 ? "Compress to ZIP" : `Compress ${items.length} items to ZIP`, icon: "archive2", run: () => compress(items) },
    "sep",
    one
      ? { label: "Rename", icon: "edit", hint: "F2", run: () => startRename(one) }
      : { label: `Rename ${items.length} items…`, icon: "edit", hint: "F2", run: () => batchRename(items) },
    { label: "Delete", icon: "trash", hint: "Del", danger: true, run: () => remove(items) },
  );
  props.ctx.menu(event, menu);
}
function backgroundMenu(event: MouseEvent) {
  if ((event.target as Element).closest(".fx-item")) return;
  selected.value = new Set();
  props.ctx.menu(event, [
    { label: "New folder", icon: "folder", hint: "Ctrl+Shift+N", disabled: !!results.value, run: () => create("mkdir") },
    { label: "New text file", icon: "file", disabled: !!results.value, run: () => create("new-file") },
    "sep",
    { label: "Paste", icon: "paste", hint: "Ctrl+V", disabled: !props.ctx.clip, run: () => paste() },
    { label: "Refresh", icon: "refresh", hint: "F5", run: () => load() },
    "sep",
    { label: "Copy folder path", icon: "link", run: () => copyPath([]) },
    { label: "Open in terminal", icon: "terminal", run: () => props.ctx.terminal(p.path) },
    { label: "Show in system explorer", icon: "external", run: () => props.ctx.open(p.path) },
  ]);
}
function locate(entry: FileEntry) {
  const folder = crumbs(entry.path).at(-2)?.path;
  if (!folder) return;
  navigate(folder);
  pendingSelect = entry.path;
}

// ---- Drag and drop ----------------------------------------------------------
const dropTarget = ref("");
function dragStart(event: DragEvent, entry: FileEntry) {
  if (!selected.value.has(entry.path)) select(entry, false);
  const paths = selection.value.map((e) => e.path);
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ paths, dirs: selection.value.filter((e) => e.dir).map((e) => e.path) }));
  event.dataTransfer.setData("text/plain", paths.join("\n"));
}
function accepts(event: DragEvent) {
  return !!event.dataTransfer?.types.includes(DRAG_MIME);
}
function dragOver(event: DragEvent, target: string) {
  if (!accepts(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dropTarget.value = target;
  if (event.dataTransfer) event.dataTransfer.dropEffect = event.ctrlKey ? "copy" : "move";
}
function drop(event: DragEvent, target: string) {
  dropTarget.value = "";
  if (!accepts(event)) return;
  event.preventDefault();
  event.stopPropagation();
  props.ctx.dropPaths(event, target);
}

// ---- Peek -------------------------------------------------------------------
const peekPath = ref("");
const peekFiles = computed(() => shown.value.filter((e) => !e.dir));
const peekIndex = computed(() => peekFiles.value.findIndex((e) => e.path === peekPath.value));
const peekEntry = computed(() => peekFiles.value[peekIndex.value] ?? null);
function peek(entry?: FileEntry) {
  const target = entry ?? shown.value.find((e) => e.path === cursor.value) ?? selection.value[0];
  if (!target || target.dir) return;
  select(target, false);
  peekPath.value = target.path;
}
function stepPeek(delta: number) {
  const list = peekFiles.value;
  if (!list.length) return;
  const next = list[(peekIndex.value + delta + list.length) % list.length]!;
  peekPath.value = next.path;
  select(next, false);
  reveal(next.path);
}
function closePeek() {
  peekPath.value = "";
  focusPane();
}
watch(peekEntry, (entry) => {
  if (!entry && peekPath.value) peekPath.value = "";
});

// ---- Keyboard ---------------------------------------------------------------
const root = ref<HTMLElement>();
const filterInput = ref<HTMLInputElement>();
function focusPane() {
  root.value?.focus({ preventScroll: true });
}
function move(delta: number, extend: boolean) {
  const list = shown.value;
  if (!list.length) return;
  const at = list.findIndex((e) => e.path === cursor.value);
  const next = list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + delta))]!;
  if (extend) selectRange(next, false);
  else select(next, false);
  reveal(next.path);
}
function keydown(event: KeyboardEvent) {
  const typing = (event.target as Element).closest("input,textarea,[contenteditable]");
  const ctrl = event.ctrlKey || event.metaKey,
    key = event.key;
  // The canvas has single-key shortcuts; nothing here should reach them.
  event.stopPropagation();
  if (key === "Escape" && typing) return;
  if (ctrl && key.toLowerCase() === "l") {
    event.preventDefault();
    return editAddress();
  }
  if (ctrl && key.toLowerCase() === "f") {
    event.preventDefault();
    return filterInput.value?.focus();
  }
  if (key === "F5") {
    event.preventDefault();
    return void load();
  }
  if (typing) return;
  const at = shown.value.findIndex((e) => e.path === cursor.value);
  const inCards = p.view === "cards" && at >= 0 && at < folderCount.value;
  const cols = inCards ? cardColumns.value : columns.value;
  // From the last row of cards, Down goes to the first file; from the first
  // file, Up goes back to the last card.
  const down = inCards && at + cols >= folderCount.value ? Math.max(1, folderCount.value - at) : cols;
  const up = p.view === "cards" && at === folderCount.value && at > 0 ? 1 : cols;
  const handled = () => event.preventDefault();
  if (event.altKey && key === "ArrowLeft") (handled(), goBack());
  else if (event.altKey && key === "ArrowRight") (handled(), goForward());
  else if ((event.altKey && key === "ArrowUp") || key === "Backspace") (handled(), goUp());
  else if (key === "ArrowDown") (handled(), move(down, event.shiftKey));
  else if (key === "ArrowUp") (handled(), move(-up, event.shiftKey));
  else if (key === "ArrowRight" && cols > 1) (handled(), move(1, event.shiftKey));
  else if (key === "ArrowLeft" && cols > 1) (handled(), move(-1, event.shiftKey));
  else if (key === "Home") (handled(), move(-Infinity, event.shiftKey));
  else if (key === "End") (handled(), move(Infinity, event.shiftKey));
  else if (key === "PageDown") (handled(), move((inCards ? cols : columns.value) * pageRows(), event.shiftKey));
  else if (key === "PageUp") (handled(), move(-(inCards ? cols : columns.value) * pageRows(), event.shiftKey));
  else if (key === "Enter") (handled(), openSelection());
  else if (key === " " && !ctrl) (handled(), peek());
  else if (key === "F2") (handled(), selection.value.length > 1 ? batchRename() : startRename());
  else if (key === "Delete") (handled(), void remove());
  else if (key === "Escape") selected.value = new Set();
  else if (ctrl && key.toLowerCase() === "a") (handled(), selectAll());
  else if (ctrl && key.toLowerCase() === "c" && event.shiftKey) (handled(), copyPath());
  else if (ctrl && key.toLowerCase() === "c") (handled(), copy("copy"));
  else if (ctrl && key.toLowerCase() === "x") (handled(), copy("cut"));
  else if (ctrl && key.toLowerCase() === "v") (handled(), paste());
  else if (ctrl && event.shiftKey && key.toLowerCase() === "n") (handled(), void create("mkdir"));
  else if (!ctrl && !event.altKey && key.length === 1 && key !== " ") typeAhead(key);
}
// Typing a few letters jumps to the next matching name.
let typed = "",
  typedTimer: ReturnType<typeof setTimeout> | undefined;
function typeAhead(key: string) {
  clearTimeout(typedTimer);
  typed += key.toLowerCase();
  typedTimer = setTimeout(() => (typed = ""), 700);
  const list = shown.value,
    at = list.findIndex((e) => e.path === cursor.value);
  const order = [...list.slice(typed.length === 1 ? at + 1 : Math.max(0, at)), ...list.slice(0, Math.max(0, at))];
  const hit = order.find((e) => e.name.toLowerCase().startsWith(typed));
  if (hit) (select(hit, false), reveal(hit.path));
}

// ---- Address bar ------------------------------------------------------------
const editingAddress = ref(false);
const addressDraft = ref("");
const addressInput = ref<HTMLInputElement>();
function editAddress() {
  addressDraft.value = p.path;
  editingAddress.value = true;
  void nextTick(() => addressInput.value?.select());
}
function commitAddress() {
  const path = addressDraft.value.trim().replace(/^"(.*)"$/, "$1");
  editingAddress.value = false;
  if (path && !samePath(path, p.path)) navigate(path);
  focusPane();
}
const segments = computed(() => crumbs(p.path));

// ---- Windowed body ----------------------------------------------------------
const body = ref<HTMLElement>();
const scrollTop = ref(0);
const viewHeight = ref(400);
const viewWidth = ref(600);
const ROW = 28,
  TILE_H = 96,
  TILE_W = 104,
  CARD_H = 212,
  CARD_W = 184,
  LABEL_H = 30;
const columns = computed(() => (p.view === "grid" ? Math.max(1, Math.floor((viewWidth.value - 16) / TILE_W)) : 1));
const rowHeight = computed(() => (p.view === "grid" ? TILE_H : ROW));
// Cards view: folders as cards on top, then the files as plain rows.
const cardColumns = computed(() => Math.max(1, Math.floor((viewWidth.value - 24) / CARD_W)));
const folderCount = computed(() => (p.view === "cards" ? shown.value.filter((e) => e.dir).length : 0));
const cardRows = computed(() => Math.ceil(folderCount.value / cardColumns.value));
const filesTop = computed(
  () => cardRows.value * CARD_H + (folderCount.value && shown.value.length > folderCount.value ? LABEL_H : 0),
);
const totalHeight = computed(() =>
  p.view === "cards"
    ? filesTop.value + (shown.value.length - folderCount.value) * ROW
    : Math.ceil(shown.value.length / columns.value) * rowHeight.value,
);
type Row = { key: string; top: number; height: number; items: FileEntry[]; cards?: boolean; label?: string };
const rows = computed(() => {
  const out: Row[] = [];
  const list = shown.value,
    top = scrollTop.value,
    bottom = top + viewHeight.value;
  if (p.view !== "cards") {
    const h = rowHeight.value,
      cols = columns.value,
      count = Math.ceil(list.length / cols);
    const start = Math.max(0, Math.floor(top / h) - 6),
      end = Math.min(count, Math.ceil(bottom / h) + 6);
    for (let r = start; r < end; r++) out.push({ key: "r" + r, top: r * h, height: h, items: list.slice(r * cols, r * cols + cols) });
    return out;
  }
  const cols = cardColumns.value,
    folders = folderCount.value;
  const start = Math.max(0, Math.floor(top / CARD_H) - 1),
    end = Math.min(cardRows.value, Math.ceil(bottom / CARD_H) + 1);
  for (let r = start; r < end; r++)
    out.push({ key: "c" + r, top: r * CARD_H, height: CARD_H, items: list.slice(r * cols, Math.min(folders, r * cols + cols)), cards: true });
  const base = filesTop.value,
    files = list.length - folders;
  if (base > cardRows.value * CARD_H && base > top - LABEL_H && cardRows.value * CARD_H < bottom)
    out.push({ key: "label", top: cardRows.value * CARD_H, height: LABEL_H, items: [], label: "Files" });
  const first = Math.max(0, Math.floor((top - base) / ROW) - 6),
    last = Math.min(files, Math.ceil((bottom - base) / ROW) + 6);
  for (let r = first; r < last; r++) out.push({ key: "f" + r, top: base + r * ROW, height: ROW, items: [list[folders + r]!] });
  return out;
});
// Where an item sits, for scrolling it into view.
function placeOf(index: number) {
  if (p.view !== "cards") {
    const h = rowHeight.value;
    return { top: Math.floor(index / columns.value) * h, height: h };
  }
  if (index < folderCount.value) return { top: Math.floor(index / cardColumns.value) * CARD_H, height: CARD_H };
  return { top: filesTop.value + (index - folderCount.value) * ROW, height: ROW };
}
function pageRows() {
  return Math.max(1, Math.floor(viewHeight.value / (p.view === "cards" ? ROW : rowHeight.value)) - 1);
}
function scrollTo(top: number) {
  scrollTop.value = top;
  if (body.value) body.value.scrollTop = top;
}
function reveal(path: string) {
  const index = shown.value.findIndex((e) => e.path === path);
  if (index < 0 || !body.value) return;
  const { top, height: h } = placeOf(index);
  if (top < body.value.scrollTop) scrollTo(top);
  else if (top + h > body.value.scrollTop + viewHeight.value) scrollTo(top + h - viewHeight.value);
}
let observer: ResizeObserver | undefined;
let frame = 0;
function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    scrollTop.value = body.value?.scrollTop ?? 0;
  });
}
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    viewHeight.value = entry.contentRect.height;
    viewWidth.value = entry.contentRect.width;
  });
  if (body.value) observer.observe(body.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
  clearTimeout(typedTimer);
  clearTimeout(cardsTimer);
});
watch(
  () => p.view,
  () => void nextTick(() => cursor.value && reveal(cursor.value)),
);

// ---- Folder cards -----------------------------------------------------------
const cards = shallowRef(new Map<string, FolderCard>());
// Cards already read (in any pane) show at once. A card is read again only
// when its folder's modified time changed, or on a refresh the user asked
// for (F5, opening a folder); quiet reloads (focus, live updates) reuse it.
// Reads go in small batches so the first cards fill in quickly.
const forced = new Set<string>();
const reading = new Set<string>();
const thumbs = shallowRef(new Map<string, string>());
function showThumbs(card: FolderCard) {
  for (const sheet of card.sheets) {
    if (!sheet.image) continue;
    const key = thumbKey(sheet.path, sheet.mtime);
    if (thumbs.value.has(key)) continue;
    void cardThumb(sheet.path, sheet.mtime, props.ctx.token).then(
      (url) => {
        if (thumbs.value.get(key) === url) return;
        const next = new Map(thumbs.value);
        next.set(key, url);
        thumbs.value = next;
      },
      () => undefined,
    );
  }
}
const thumbOf = (sheet: { path: string; mtime?: number }) => thumbs.value.get(thumbKey(sheet.path, sheet.mtime));
let cardsTimer = 0;
const visibleCards = () =>
  p.view === "cards" && props.visible ? rows.value.flatMap((row) => (row.cards ? row.items.map((e) => e.path) : [])) : [];
function syncCards() {
  clearTimeout(cardsTimer);
  const paths = visibleCards();
  const stampOf = new Map(shown.value.map((e) => [e.path, e.mtime]));
  let next: Map<string, FolderCard> | undefined;
  for (const path of paths) {
    const cached = folderCardCache.get(path);
    if (cached && cards.value.get(path) !== cached) (next ??= new Map(cards.value)).set(path, cached);
  }
  if (next) cards.value = next;
  for (const path of paths) {
    const card = cards.value.get(path);
    if (card) showThumbs(card);
  }
  const missing = paths.filter((path) => {
    if (reading.has(path)) return false;
    const card = cards.value.get(path);
    return !card || forced.has(path) || card.stamp !== stampOf.get(path);
  });
  if (!missing.length) return;
  // Nothing to show yet: read now. Only refreshing: wait for scrolling to settle.
  const blank = missing.some((path) => !cards.value.has(path));
  cardsTimer = window.setTimeout(() => void readCards(missing), blank ? 0 : 150);
}
async function readCards(paths: string[]) {
  for (let at = 0; at < paths.length; at += 6) {
    const batch = paths.slice(at, at + 6);
    for (const path of batch) reading.add(path);
    try {
      const data = await api<Record<string, FolderCard>>("folder-cards", { paths: batch });
      const next = new Map(cards.value);
      const stampOf = new Map(shown.value.map((e) => [e.path, e.mtime]));
      for (const [path, read] of Object.entries(data)) {
        const card = { ...read, stamp: stampOf.get(path) };
        rememberFolderCard(path, card);
        forced.delete(path);
        next.set(path, card);
        showThumbs(card);
      }
      cards.value = next;
    } catch {
    } finally {
      for (const path of batch) reading.delete(path);
    }
  }
}
watch(visibleCards, syncCards);
// A reload keeps the cards on screen; changed folders are read again.
watch(entries, () => void nextTick(syncCards));
const ago = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function edited(ms: number) {
  if (!ms) return "";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "edited just now";
  if (minutes < 60) return "edited " + ago.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return "edited " + ago.format(-hours, "hour");
  const days = Math.round(hours / 24);
  return "edited " + (days < 30 ? ago.format(-days, "day") : formatDate(ms));
}
function cardMeta(entry: FileEntry) {
  const card = cards.value.get(entry.path);
  if (!card) return "";
  if (!card.count) return "No files yet";
  const names = card.sheets.slice(0, 2).map((sheet) => sheet.name);
  return card.count.toLocaleString() + (card.count === 1 ? " item" : " items") + (names.length ? " · " + names.join(", ") : "");
}
// Oldest of the three at the back, newest in front.
function sheetsOf(entry: FileEntry) {
  const sheets = cards.value.get(entry.path)?.sheets ?? [];
  return sheets.map((sheet, index) => ({ ...sheet, slot: "s" + (index + 1) })).reverse();
}

// ---- Preview ----------------------------------------------------------------
type Preview = {
  path: string;
  name: string;
  size: number;
  mtime: number;
  ctime: number;
  kind: "folder" | "image" | "text" | "binary";
  count?: number;
  url?: string;
  text?: string;
  truncated?: boolean;
};
const preview = shallowRef<Preview | null>(null);
const previewError = ref("");
const draft = ref("");
const saving = ref(false);
const dirty = computed(() => preview.value?.kind === "text" && !preview.value.truncated && draft.value !== preview.value.text);
let previewSeq = 0,
  previewTimer: ReturnType<typeof setTimeout> | undefined;
const previewTarget = computed(() => (p.preview && selection.value.length === 1 ? selection.value[0]! : null));
watch(
  () => [previewTarget.value?.path, previewTarget.value?.mtime, p.preview] as const,
  ([path]) => {
    clearTimeout(previewTimer);
    if (!path) {
      preview.value = null;
      previewError.value = "";
      return;
    }
    if (dirty.value && preview.value?.path === path) return;
    const seq = ++previewSeq;
    // Arrowing through a folder should not read every file on the way.
    previewTimer = setTimeout(async () => {
      try {
        const data = await api<Preview>("preview", { path });
        if (seq !== previewSeq) return;
        preview.value = data;
        draft.value = data.text ?? "";
        previewError.value = "";
      } catch (e) {
        if (seq !== previewSeq) return;
        preview.value = null;
        previewError.value = e instanceof Error ? e.message : String(e);
      }
    }, 120);
  },
  { immediate: true },
);
async function save() {
  const current = preview.value;
  if (!current || !dirty.value || saving.value) return;
  saving.value = true;
  try {
    const result = await api<{ mtime: number }>("write", { path: current.path, text: draft.value, mtime: current.mtime });
    preview.value = { ...current, text: draft.value, mtime: result.mtime, size: new Blob([draft.value]).size };
    props.ctx.toast(`Saved ${current.name}.`);
    void load(true);
  } catch (e) {
    props.ctx.toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    saving.value = false;
  }
}
function previewKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  }
}
function togglePreview() {
  p.preview = !p.preview;
  emit("changed");
}
function setView(view: PaneState["view"]) {
  p.view = view;
  emit("changed");
}

// ---- Status -----------------------------------------------------------------
const status = computed(() => {
  const count = shown.value.length;
  const parts = [`${count.toLocaleString()} item${count === 1 ? "" : "s"}`];
  const sel = selection.value;
  if (sel.length) {
    const size = sel.reduce((sum, e) => sum + (e.dir ? 0 : e.size), 0);
    parts.push(`${sel.length} selected${size ? ` · ${formatSize(size)}` : ""}`);
  }
  if (truncated.value && !results.value) parts.push("showing the first 50,000");
  return parts.join("   ");
});
const sorted = (key: SortKey) => p.sort.key === key;
// Search results show their folder relative to where the search started.
const relative = (entry: FileEntry) => {
  const folder = crumbs(entry.path).at(-2)?.path ?? "";
  const base = p.path.replace(/[\\/]+$/, "");
  return folder.toLowerCase().startsWith(base.toLowerCase())
    ? folder.slice(base.length).replace(/^[\\/]+/, "") || "."
    : folder;
};
</script>
<template>
  <div
    ref="root"
    class="fx-pane"
    tabindex="-1"
    :data-path="pane.path"
    @keydown="keydown"
    @mousedown="($event.button === 3 || $event.button === 4) && $event.preventDefault()"
    @mouseup="mouseHistory"
  >
    <div class="fx-toolbar">
      <button aria-label="Back" title="Back (Alt+Left)" :disabled="!pane.back.length" @click="goBack">
        <Icon name="back" :size="14" /></button
      ><button aria-label="Forward" title="Forward (Alt+Right)" :disabled="!pane.forward.length" @click="goForward">
        <Icon name="forward" :size="14" /></button
      ><button aria-label="Up one level" title="Up (Alt+Up)" :disabled="!parent" @click="goUp">
        <Icon name="up" :size="14" /></button
      ><button aria-label="Refresh" title="Refresh (F5)" :disabled="loading" @click="load()">
        <Icon name="refresh" :size="14" :class="{ spin: loading }" />
      </button>
      <div
        class="fx-address"
        :class="{ editing: editingAddress, drop: dropTarget === '@address' }"
        @click.self="editAddress"
      >
        <input
          v-if="editingAddress"
          ref="addressInput"
          v-model="addressDraft"
          aria-label="Folder path"
          spellcheck="false"
          @keydown.enter.prevent="commitAddress"
          @keydown.esc.prevent="(editingAddress = false), focusPane()"
          @blur="editingAddress = false"
        />
        <template v-else>
          <template v-for="(part, index) in segments" :key="part.path"
            ><Icon v-if="index" name="right" :size="10" class="fx-sep" /><button
              :class="{ current: index === segments.length - 1 }"
              :title="part.path"
              @click="navigate(part.path)"
              @dragover="dragOver($event, part.path)"
              @dragleave="dropTarget = ''"
              @drop="drop($event, part.path)"
            >
              <Icon v-if="!index" name="drive" :size="12" />{{ index ? part.name : label(part.path) }}
            </button></template
          >
          <span class="fx-address-fill" title="Edit path (Ctrl+L)" @click="editAddress" />
        </template>
      </div>
      <div class="fx-search" :class="{ active: !!results }">
        <Icon name="search" :size="13" />
        <input
          v-model="query"
          :placeholder="`Search ${label(pane.path, ctx.home)}`"
          aria-label="Search this folder and subfolders"
          spellcheck="false"
          @keydown.enter.prevent="runSearch"
          @keydown.esc.prevent="cancelSearch(), focusPane()"
        /><span v-if="searching" class="fx-spinner" /><button
          v-else-if="query || results"
          aria-label="Clear search"
          @click="cancelSearch"
        >
          <Icon name="close" :size="12" />
        </button>
      </div>
    </div>
    <div class="fx-commands">
      <button title="New folder (Ctrl+Shift+N)" :disabled="!!results" @click="create('mkdir')">
        <Icon name="folder" :size="14" /><span>New folder</span></button
      ><button title="New text file" :disabled="!!results" @click="create('new-file')">
        <Icon name="file" :size="14" /><span>New file</span>
      </button>
      <i class="fx-divider" />
      <button aria-label="Cut" title="Cut (Ctrl+X)" :disabled="!selection.length" @click="copy('cut')">
        <Icon name="cut" :size="14" /></button
      ><button aria-label="Copy" title="Copy (Ctrl+C)" :disabled="!selection.length" @click="copy('copy')">
        <Icon name="copy" :size="14" /></button
      ><button aria-label="Paste" title="Paste (Ctrl+V)" :disabled="!ctx.clip || !!results" @click="paste()">
        <Icon name="paste" :size="14" /></button
      ><button
        aria-label="Peek"
        title="Peek (Space)"
        :disabled="selection.length !== 1 || selection[0]!.dir"
        @click="peek()"
      >
        <Icon name="eye" :size="14" /></button
      ><button
        aria-label="Rename"
        title="Rename (F2); several items open batch rename"
        :disabled="!selection.length"
        @click="selection.length > 1 ? batchRename() : startRename()"
      >
        <Icon name="edit" :size="14" /></button
      ><button aria-label="Delete" title="Delete (Del)" :disabled="!selection.length" @click="remove()">
        <Icon name="trash" :size="14" />
      </button>
      <div class="fx-grow" />
      <input
        ref="filterInput"
        v-model="filter"
        class="fx-filter"
        placeholder="Filter…"
        aria-label="Filter this folder"
        spellcheck="false"
        @keydown.esc.prevent="(filter = ''), focusPane()"
        @keydown.down.prevent="focusPane(), move(0, false)"
      />
      <button
        aria-label="Live updates"
        :title="ctx.live ? 'Live: refreshes when files change on disk' : 'Live updates are off'"
        :aria-pressed="ctx.live"
        @click="ctx.toggleLive()"
      >
        <Icon name="refresh" :size="14" :class="{ 'fx-off': !ctx.live }" /></button
      ><button
        aria-label="Folder sizes"
        :title="ctx.sizes ? 'Hide folder sizes' : 'Calculate folder sizes'"
        :aria-pressed="ctx.sizes"
        @click="ctx.toggleSizes()"
      >
        <Icon name="sort" :size="14" /></button
      ><button
        :aria-label="ctx.hidden ? 'Hide hidden items' : 'Show hidden items'"
        :title="ctx.hidden ? 'Hide hidden items' : 'Show hidden items'"
        :aria-pressed="ctx.hidden"
        @click="ctx.toggleHidden()"
      >
        <Icon :name="ctx.hidden ? 'eye' : 'eye-off'" :size="14" />
      </button>
      <div class="fx-seg">
        <button aria-label="Details view" title="Details" :aria-pressed="pane.view === 'list'" @click="setView('list')">
          <Icon name="list" :size="13" /></button
        ><button aria-label="Icons view" title="Icons" :aria-pressed="pane.view === 'grid'" @click="setView('grid')">
          <Icon name="app" :size="13" /></button
        ><button aria-label="Folder cards view" title="Folder cards" :aria-pressed="pane.view === 'cards'" @click="setView('cards')">
          <Icon name="layers" :size="13" />
        </button>
      </div>
      <button aria-label="Preview pane" title="Preview pane" :aria-pressed="pane.preview" @click="togglePreview">
        <Icon name="panel-right" :size="14" />
      </button>
    </div>
    <div class="fx-main">
      <FilePeek
        v-if="peekEntry"
        :entry="peekEntry"
        :position="peekIndex"
        :total="peekFiles.length"
        :ctx="ctx"
        @close="closePeek"
        @step="stepPeek"
      />
      <div class="fx-listing">
        <div v-if="results" class="fx-note">
          <Icon name="search" :size="12" />{{ searchNote || "Searching…" }}
          <button @click="cancelSearch">Back to folder</button>
        </div>
        <!-- Header row: opaque and outside the scroll viewport (DESIGN.md). -->
        <div v-if="pane.view === 'list'" class="fx-head fx-cols" :class="{ search: !!results }">
          <button @click="sortBy('name')">Name<Icon v-if="sorted('name')" name="down" :size="11" :class="{ asc: pane.sort.dir === 1 }" /></button>
          <span v-if="results">Folder</span>
          <button @click="sortBy('mtime')">Date modified<Icon v-if="sorted('mtime')" name="down" :size="11" :class="{ asc: pane.sort.dir === 1 }" /></button>
          <button @click="sortBy('type')">Type<Icon v-if="sorted('type')" name="down" :size="11" :class="{ asc: pane.sort.dir === 1 }" /></button>
          <button class="num" @click="sortBy('size')">Size<Icon v-if="sorted('size')" name="down" :size="11" :class="{ asc: pane.sort.dir === 1 }" /></button>
        </div>
        <div
          ref="body"
          class="fx-body"
          :class="[pane.view, { drop: dropTarget === '@here' }]"
          role="listbox"
          aria-multiselectable="true"
          :aria-label="`Contents of ${label(pane.path, ctx.home)}`"
          @scroll="onScroll"
          @click="backgroundClick"
          @contextmenu.prevent="backgroundMenu"
          @dragover="!results && dragOver($event, '@here')"
          @dragleave.self="dropTarget = ''"
          @drop="drop($event, pane.path)"
        >
          <p v-if="error" class="fx-empty error"><Icon name="alert" :size="14" />{{ error }}</p>
          <p v-else-if="!loading && !shown.length" class="fx-empty">
            {{ results ? "No matches." : filter ? "Nothing matches the filter." : "This folder is empty." }}
          </p>
          <div class="fx-spacer-row" :style="{ height: totalHeight + 'px' }">
            <div
              v-for="row in rows"
              :key="row.key"
              class="fx-row"
              :class="{ 'fx-card-row': row.cards, 'fx-section': row.label }"
              :style="{ transform: `translateY(${row.top}px)`, height: row.height + 'px' }"
            >
              <template v-if="row.label">{{ row.label }}</template>
              <div
                v-for="entry in row.items"
                :key="entry.path"
                class="fx-item"
                :class="[
                  row.cards ? 'fx-card' : pane.view === 'grid' ? 'fx-tile' : 'fx-cols',
                  {
                    search: !!results,
                    selected: selected.has(entry.path),
                    cursor: focused && cursor === entry.path,
                    hidden: entry.hidden,
                    cut: isCut(entry.path),
                    drop: dropTarget === entry.path,
                  },
                ]"
                role="option"
                :aria-selected="selected.has(entry.path)"
                :title="entry.path"
                draggable="true"
                @click.stop="itemClick($event, entry)"
                @dblclick.stop="open(entry)"
                @contextmenu.prevent.stop="itemMenu($event, entry)"
                @dragstart="dragStart($event, entry)"
                @dragend="dropTarget = ''"
                @dragover="entry.dir && !selected.has(entry.path) && dragOver($event, entry.path)"
                @dragleave="dropTarget === entry.path && (dropTarget = '')"
                @drop="entry.dir && drop($event, entry.path)"
              >
                <div v-if="row.cards" class="fx-stack" aria-hidden="true">
                  <i class="fx-back" />
                  <span v-for="sheet in sheetsOf(entry)" :key="sheet.path" class="fx-sheet" :class="sheet.slot">
                    <template v-if="sheet.image"><img v-if="thumbOf(sheet)" :src="thumbOf(sheet)" alt="" /></template>
                    <template v-else>{{ sheet.text || sheet.name }}</template>
                  </span>
                  <span v-if="cards.get(entry.path) && !sheetsOf(entry).length" class="fx-sheet s1 fx-sheet-empty">{{
                    cards.get(entry.path)?.count ? "Folders only" : "Empty"
                  }}</span>
                  <span class="fx-front">
                    <span>{{ edited(cards.get(entry.path)?.newest || entry.mtime) }}</span>
                    <b v-if="cards.get(entry.path)?.badge">{{ cards.get(entry.path)?.badge }}</b>
                  </span>
                </div>
                <span class="fx-name">
                  <Icon :name="iconOf(entry)" :size="pane.view === 'grid' ? 34 : 15" :class="toneOf(entry)" />
                  <input
                    v-if="renaming === entry.path"
                    ref="renameInput"
                    v-model="renameDraft"
                    class="fx-rename"
                    aria-label="New name"
                    spellcheck="false"
                    @click.stop
                    @dblclick.stop
                    @keydown.enter.prevent="commitRename"
                    @keydown.esc.prevent="(renaming = ''), focusPane()"
                    @blur="commitRename"
                  />
                  <span v-else>{{ entry.name }}</span>
                  <b
                    v-if="gitBadges[entry.name] && !results"
                    class="fx-git"
                    :class="`git-${gitBadges[entry.name]}`"
                    :title="`Git: ${GIT_LABEL[gitBadges[entry.name]!]}${entry.dir ? ' (inside)' : ''}`"
                    >{{ gitBadges[entry.name] }}</b
                  >
                  <Icon v-if="entry.link" name="link" :size="10" class="fx-link" />
                </span>
                <small v-if="row.cards" class="fx-card-meta">{{ cardMeta(entry) }}</small>
                <template v-if="pane.view === 'list' || (pane.view === 'cards' && !row.cards)">
                  <span v-if="results" class="fx-dim">{{ relative(entry) }}</span>
                  <span class="fx-dim">{{ formatDate(entry.mtime) }}</span>
                  <span class="fx-dim">{{ typeName(entry) }}</span>
                  <span class="fx-dim num">{{ sizeOf(entry) }}</span>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
      <aside v-if="pane.preview" class="fx-preview" @keydown="previewKey">
        <template v-if="preview && previewTarget">
          <div class="fx-preview-head">
            <Icon :name="iconOf(previewTarget)" :size="16" :class="toneOf(previewTarget)" />
            <strong :title="preview.path">{{ preview.name }}</strong>
            <button v-if="dirty" class="fx-save" :disabled="saving" title="Save (Ctrl+S)" @click="save">
              <Icon name="save" :size="13" />Save
            </button>
          </div>
          <img v-if="preview.kind === 'image'" class="fx-image" :src="preview.url" :alt="preview.name" />
          <textarea
            v-else-if="preview.kind === 'text'"
            v-model="draft"
            class="fx-text"
            spellcheck="false"
            :readonly="preview.truncated"
            aria-label="File contents"
          />
          <p v-else-if="preview.kind === 'binary'" class="fx-empty">No preview for this file type.</p>
          <p v-if="preview.truncated" class="fx-hint">Only the first 2 MB is shown; editing is off.</p>
          <dl class="fx-info">
            <dt>Type</dt>
            <dd>{{ typeName(previewTarget) }}</dd>
            <template v-if="preview.kind === 'folder'"
              ><dt>Contains</dt>
              <dd>{{ preview.count }} items</dd></template
            ><template v-else
              ><dt>Size</dt>
              <dd>{{ formatSize(preview.size) }} ({{ preview.size.toLocaleString() }} bytes)</dd></template
            >
            <dt>Modified</dt>
            <dd>{{ formatDate(preview.mtime) }}</dd>
            <dt>Created</dt>
            <dd>{{ formatDate(preview.ctime) }}</dd>
            <dt>Location</dt>
            <dd :title="preview.path">{{ crumbs(preview.path).at(-2)?.path }}</dd>
          </dl>
        </template>
        <p v-else-if="previewError" class="fx-empty error">{{ previewError }}</p>
        <p v-else class="fx-empty">
          {{ selection.length > 1 ? `${selection.length} items selected` : "Select a file to preview it." }}
        </p>
      </aside>
    </div>
    <div class="fx-status">
      <span>{{ status }}</span>
      <span v-if="ctx.clip" class="fx-dim"
        >{{ ctx.clip.paths.length }} on clipboard ({{ ctx.clip.mode === "cut" ? "move" : "copy" }})</span
      >
    </div>
  </div>
</template>
<style scoped>
.fx-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: #fff;
  outline: none;
  container-type: inline-size;
}
.fx-toolbar,
.fx-commands {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px 8px;
  border-bottom: 1px solid #e2eaee;
  min-width: 0;
}
.fx-commands {
  padding: 3px 8px;
  background: #fbfcfd;
}
.fx-toolbar > button,
.fx-commands > button,
.fx-seg button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 5px 6px;
  border-radius: 4px;
  background: none;
  color: #547589;
  font-size: 12px;
}
.fx-toolbar > button:hover:not(:disabled),
.fx-commands > button:hover:not(:disabled),
.fx-seg button:hover,
.fx-commands button[aria-pressed="true"],
.fx-seg button[aria-pressed="true"] {
  background: #e3edf2;
}
.fx-seg button[aria-pressed="true"] {
  background: #fff;
  box-shadow: 0 1px 2px #425c6b26;
}
button:disabled {
  opacity: 0.4;
}
.fx-address {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 80px;
  height: 28px;
  margin: 0 4px;
  padding: 0 4px;
  border-radius: 5px;
  background: #edf3f6;
  overflow: hidden;
  white-space: nowrap;
  cursor: text;
}
.fx-address.editing {
  background: #e6eff3;
  box-shadow: inset 0 -1px #7895a5;
}
.fx-address input {
  flex: 1;
  min-width: 0;
  border: 0;
  padding: 0 4px;
  background: transparent;
  color: #2f4856;
  font: inherit;
  font-size: 12px;
  outline: none;
}
.fx-address button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 1 auto;
  min-width: 22px;
  max-width: 180px;
  padding: 3px 5px;
  border-radius: 4px;
  background: none;
  color: #547589;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fx-address button:hover {
  background: #dce8ee;
}
.fx-address button.current {
  flex-shrink: 0;
  color: #2f4856;
  font-weight: 600;
}
.fx-address-fill {
  flex: 1;
  align-self: stretch;
  min-width: 12px;
}
.fx-sep {
  flex: none;
  color: #a5b4bd;
}
.fx-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 220px;
  min-width: 110px;
  height: 28px;
  padding: 0 8px;
  border-radius: 5px;
  background: #edf3f6;
  color: #718591;
}
.fx-search.active {
  box-shadow: inset 0 -1px #7895a5;
}
.fx-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: #2f4856;
  font: inherit;
  font-size: 12px;
  outline: none;
}
.fx-search button {
  display: grid;
  place-items: center;
  padding: 2px;
  border-radius: 3px;
  background: none;
  color: inherit;
}
.fx-divider {
  width: 1px;
  height: 16px;
  margin: 0 5px;
  background: #dce5e9;
}
.fx-grow {
  flex: 1;
}
.fx-filter {
  width: 130px;
  min-width: 60px;
  margin-right: 4px;
  padding: 5px 8px;
  border: 0;
  border-radius: 5px;
  background: #edf3f6;
  color: inherit;
  font-size: 12px;
}
.fx-seg {
  display: flex;
  margin: 0 3px;
  padding: 2px;
  border-radius: 5px;
  background: #edf3f6;
}
.fx-seg button {
  padding: 3px 6px;
}
@container (max-width: 560px) {
  .fx-commands > button span,
  .fx-filter {
    display: none;
  }
  .fx-search {
    flex-basis: 140px;
  }
}
.fx-main {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.fx-listing {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.fx-note {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border-bottom: 1px solid #e2eaee;
  background: #f5f8f9;
  color: #607583;
  font-size: 12px;
}
.fx-note button {
  margin-left: auto;
  padding: 3px 8px;
  border-radius: 4px;
  background: #e3edf2;
  color: #455968;
  font-size: 12px;
}
.fx-cols {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 132px 110px 76px;
  align-items: center;
  column-gap: 10px;
}
.fx-cols.search {
  grid-template-columns: minmax(140px, 1fr) minmax(80px, 0.7fr) 132px 110px 76px;
}
@container (max-width: 620px) {
  .fx-cols,
  .fx-cols.search {
    grid-template-columns: minmax(120px, 1fr) 76px;
  }
  .fx-cols > :nth-child(n + 2):not(:last-child) {
    display: none;
  }
}
.fx-head {
  flex: none;
  height: 29px;
  padding: 0 calc(12px + 5px) 0 12px;
  border-bottom: 1px solid #e2eaee;
  background: #f7f9fa;
}
.fx-head > button,
.fx-head > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 0;
  background: none;
  color: #718591;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}
.fx-head > button:hover {
  color: #455968;
}
.fx-head .asc {
  transform: rotate(180deg);
}
.num {
  justify-content: flex-end;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.fx-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  overflow-anchor: none;
}
.fx-body.drop {
  box-shadow: inset 0 0 0 2px #6f9ab0;
}
.fx-spacer-row {
  position: relative;
}
.fx-row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
}
.fx-body.grid .fx-row {
  padding: 0 8px;
  gap: 0;
}
.fx-body.grid .fx-spacer-row {
  margin-top: 6px;
}
.fx-item {
  min-width: 0;
  color: #4b6170;
  font-size: 12px;
  cursor: default;
  user-select: none;
}
.fx-item.fx-cols {
  flex: 1;
  height: 100%;
  padding: 0 12px;
}
.fx-item:hover {
  background: #f1f6f8;
}
.fx-item.selected {
  background: #dce9f0;
}
.fx-item.cursor {
  box-shadow: inset 0 0 0 1px #8ca7b5;
}
.fx-item.drop {
  background: #d3e6ef;
  box-shadow: inset 0 0 0 2px #6f9ab0;
}
.fx-item.hidden .fx-name,
.fx-item.cut .fx-name {
  opacity: 0.55;
}
.fx-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: #344f5e;
}
.fx-name > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fx-link {
  flex: none;
  color: #8798a3;
}
.fx-dim {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8798a3;
}
.fx-body.cards .fx-card-row {
  gap: 0;
  padding: 0 12px;
}
.fx-body.cards .fx-spacer-row {
  margin-top: 10px;
}
.fx-section {
  align-items: flex-end;
  padding: 0 14px 6px;
  color: #8ea1ac;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.fx-card {
  width: 184px;
  height: 202px;
  padding: 6px 8px;
  border-radius: 9px;
}
.fx-item.fx-card:hover,
.fx-item.fx-card.selected {
  background: transparent;
}
.fx-item.fx-card.cursor {
  box-shadow: none;
}
.fx-stack {
  position: relative;
  height: 140px;
  margin: 8px 0;
}
.fx-back {
  position: absolute;
  inset: 0;
  border-radius: 9px;
  background: #dfe7ec;
}
.fx-back::before {
  content: "";
  position: absolute;
  left: 0;
  top: -7px;
  width: 44%;
  height: 14px;
  border-radius: 7px 7px 0 0;
  background: #dfe7ec;
}
.fx-sheet {
  position: absolute;
  left: 12px;
  right: 12px;
  top: 20px;
  height: 80px;
  overflow: hidden;
  padding: 8px;
  border: 1px solid #e1e8ec;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 1px 2px #263f5510;
  color: #93a4ae;
  font: 9.5px/1.45 "Cascadia Code", Consolas, monospace;
  white-space: pre;
  transition: transform 160ms ease-out;
}
.fx-sheet img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.fx-sheet.s3 {
  top: 6px;
  left: 8px;
  right: 30px;
  transform: rotate(-4deg);
}
.fx-sheet.s2 {
  top: 10px;
  left: 30px;
  right: 8px;
  transform: rotate(3.5deg);
}
.fx-sheet-empty {
  display: grid;
  place-items: center;
  color: #b3c2ca;
  font-family: inherit;
}
.fx-card:hover .fx-sheet.s3 {
  transform: rotate(-6deg) translateY(-6px);
}
.fx-card:hover .fx-sheet.s2 {
  transform: rotate(5deg) translateY(-4px);
}
.fx-front {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  height: 56px;
  padding: 9px 11px;
  border: 1px solid #dbe4ea;
  border-radius: 9px;
  background: linear-gradient(#eef3f6f2, #e6edf1f7);
  backdrop-filter: blur(3px);
  color: #8296a2;
  font-size: 11px;
}
.fx-front b {
  padding: 0 5px;
  border: 1px solid #dce5ea;
  border-radius: 4px;
  background: #f7f9fa;
  color: #5d7381;
  font: 500 10.5px "Cascadia Code", Consolas, monospace;
}
.fx-card.selected .fx-front {
  border-color: #9fb6c3;
  box-shadow: 0 0 0 3px #6f89981a;
}
.fx-card.cursor .fx-front {
  border-color: #8ca7b5;
}
.fx-card.drop .fx-back,
.fx-card.drop .fx-back::before {
  background: #d3e6ef;
}
.fx-card .fx-name {
  gap: 6px;
  font-size: 12.5px;
  font-weight: 550;
  color: #273f50;
}
.fx-card .fx-name > svg {
  display: none;
}
.fx-card-meta {
  display: block;
  overflow: hidden;
  color: #8296a2;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .fx-sheet {
    transition: none;
  }
  .fx-card:hover .fx-sheet.s3 {
    transform: rotate(-4deg);
  }
  .fx-card:hover .fx-sheet.s2 {
    transform: rotate(3.5deg);
  }
}
.fx-tile {
  width: 104px;
  height: 92px;
  padding: 8px 6px 4px;
  border-radius: 6px;
}
.fx-tile .fx-name {
  flex-direction: column;
  gap: 6px;
  text-align: center;
}
.fx-tile .fx-name > span {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  width: 100%;
  white-space: normal;
  word-break: break-word;
  line-height: 1.3;
}
.fx-rename {
  flex: 1;
  min-width: 0;
  width: 100%;
  padding: 2px 5px;
  border: 1px solid #6f9ab0;
  border-radius: 3px;
  background: #fff;
  color: inherit;
  font: inherit;
  outline: none;
}
.fx-empty {
  position: absolute;
  inset: 24px 0 auto;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 0 16px;
  color: #8798a3;
  font-size: 12px;
  text-align: center;
  pointer-events: none;
}
.fx-preview .fx-empty {
  position: static;
  padding: 24px 8px;
}
.fx-empty.error {
  color: #a5603d;
}
.fx-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 300px;
  flex: none;
  min-height: 0;
  padding: 10px 12px;
  border-left: 1px solid #e2eaee;
  background: #fbfcfd;
  overflow: auto;
}
@container (max-width: 640px) {
  .fx-preview {
    width: 46%;
  }
}
.fx-preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.fx-preview-head strong {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #2f4856;
  font-size: 13px;
}
.fx-save {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 4px;
  background: #4f7b93;
  color: #fff;
  font-size: 12px;
}
.fx-image {
  max-width: 100%;
  max-height: 340px;
  object-fit: contain;
  align-self: center;
  border-radius: 4px;
  background: repeating-conic-gradient(#eef2f4 0 25%, #fff 0 50%) 0 0 / 14px 14px;
}
.fx-text {
  flex: 1;
  min-height: 160px;
  resize: none;
  padding: 8px;
  border: 0;
  border-radius: 5px;
  background: #f1f5f7;
  color: #2f4856;
  font: 12px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
  white-space: pre;
  tab-size: 2;
  outline: none;
}
.fx-text:focus {
  box-shadow: inset 0 -1px #7895a5;
}
.fx-hint {
  margin: 0;
  color: #718591;
  font-size: 11px;
}
.fx-info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  margin: 0;
  font-size: 11px;
}
.fx-info dt {
  color: #8798a3;
}
.fx-info dd {
  margin: 0;
  color: #455968;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fx-status {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  padding: 4px 12px;
  border-top: 1px solid #e2eaee;
  background: #f7f9fa;
  color: #718591;
  font-size: 11px;
  white-space: pre;
}
.tone-folder {
  flex: none;
  color: #d39b2a;
}
.tone-image {
  flex: none;
  color: #8a5cc0;
}
.tone-code {
  flex: none;
  color: #4f7b93;
}
.tone-archive {
  flex: none;
  color: #b0763a;
}
.tone-file {
  flex: none;
  color: #8798a3;
}
.spin {
  animation: fx-spin 0.8s linear infinite;
}
.fx-spinner {
  flex: none;
  width: 11px;
  height: 11px;
  border: 2px solid #c7d6dd;
  border-top-color: #557a8e;
  border-radius: 50%;
  animation: fx-spin 0.8s linear infinite;
}
@keyframes fx-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin,
  .fx-spinner {
    animation-duration: 2.4s;
  }
}
</style>
<style scoped>
.fx-git {
  flex: none;
  min-width: 15px;
  padding: 0 3px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
}
.git-M { background: #f4ead2; color: #9a6b12; }
.git-A { background: #dcefe2; color: #2f7a4c; }
.git-U { background: #dcefe2; color: #2f7a4c; }
.git-D { background: #f6dfda; color: #a5503d; }
.git-R { background: #e3e7f6; color: #4f5fa5; }
.git-C { background: #f6dfda; color: #a5503d; }
.fx-off {
  opacity: 0.45;
}
</style>
