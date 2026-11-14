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
  samePath,
  sortEntries,
  toneOf,
  typeName,
  type ExplorerContext,
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
  menu.push(
    { label: "Copy path", icon: "link", run: () => copyPath(items) },
    "sep",
    { label: "Rename", icon: "edit", hint: "F2", disabled: !one, run: () => startRename(one!) },
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
  const cols = columns.value;
  const handled = () => event.preventDefault();
  if (event.altKey && key === "ArrowLeft") (handled(), goBack());
  else if (event.altKey && key === "ArrowRight") (handled(), goForward());
  else if ((event.altKey && key === "ArrowUp") || key === "Backspace") (handled(), goUp());
  else if (key === "ArrowDown") (handled(), move(cols, event.shiftKey));
  else if (key === "ArrowUp") (handled(), move(-cols, event.shiftKey));
  else if (key === "ArrowRight" && cols > 1) (handled(), move(1, event.shiftKey));
  else if (key === "ArrowLeft" && cols > 1) (handled(), move(-1, event.shiftKey));
  else if (key === "Home") (handled(), move(-Infinity, event.shiftKey));
  else if (key === "End") (handled(), move(Infinity, event.shiftKey));
  else if (key === "PageDown") (handled(), move(cols * pageRows(), event.shiftKey));
  else if (key === "PageUp") (handled(), move(-cols * pageRows(), event.shiftKey));
  else if (key === "Enter") (handled(), openSelection());
  else if (key === " " && !ctrl) (handled(), peek());
  else if (key === "F2") (handled(), startRename());
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
  TILE_W = 104;
const columns = computed(() => (p.view === "grid" ? Math.max(1, Math.floor((viewWidth.value - 16) / TILE_W)) : 1));
const rowHeight = computed(() => (p.view === "grid" ? TILE_H : ROW));
const rowCount = computed(() => Math.ceil(shown.value.length / columns.value));
const range = computed(() => {
  const h = rowHeight.value;
  const start = Math.max(0, Math.floor(scrollTop.value / h) - 6);
  const end = Math.min(rowCount.value, Math.ceil((scrollTop.value + viewHeight.value) / h) + 6);
  return { start, end };
});
const rows = computed(() => {
  const out: { index: number; items: FileEntry[] }[] = [];
  const cols = columns.value,
    list = shown.value;
  for (let r = range.value.start; r < range.value.end; r++) out.push({ index: r, items: list.slice(r * cols, r * cols + cols) });
  return out;
});
function pageRows() {
  return Math.max(1, Math.floor(viewHeight.value / rowHeight.value) - 1);
}
function scrollTo(top: number) {
  scrollTop.value = top;
  if (body.value) body.value.scrollTop = top;
}
function reveal(path: string) {
  const index = shown.value.findIndex((e) => e.path === path);
  if (index < 0 || !body.value) return;
  const h = rowHeight.value,
    top = Math.floor(index / columns.value) * h;
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
});
watch(
  () => p.view,
  () => void nextTick(() => cursor.value && reveal(cursor.value)),
);

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
function setView(view: "list" | "grid") {
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
      ><button aria-label="Rename" title="Rename (F2)" :disabled="selection.length !== 1" @click="startRename()">
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
          <Icon name="app" :size="13" />
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
          <div class="fx-spacer-row" :style="{ height: rowCount * rowHeight + 'px' }">
            <div
              v-for="row in rows"
              :key="row.index"
              class="fx-row"
              :style="{ transform: `translateY(${row.index * rowHeight}px)`, height: rowHeight + 'px' }"
            >
              <div
                v-for="entry in row.items"
                :key="entry.path"
                class="fx-item"
                :class="[
                  pane.view === 'list' ? 'fx-cols' : 'fx-tile',
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
                  <Icon v-if="entry.link" name="link" :size="10" class="fx-link" />
                </span>
                <template v-if="pane.view === 'list'">
                  <span v-if="results" class="fx-dim">{{ relative(entry) }}</span>
                  <span class="fx-dim">{{ formatDate(entry.mtime) }}</span>
                  <span class="fx-dim">{{ typeName(entry) }}</span>
                  <span class="fx-dim num">{{ entry.dir ? "" : formatSize(entry.size) }}</span>
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
