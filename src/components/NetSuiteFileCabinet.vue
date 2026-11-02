<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import FileFolderTree from "./FileFolderTree.vue";
import NetSuiteFileEditor from "./NetSuiteFileEditor.vue";
import SplitTabs from "./SplitTabs.vue";
import WindowedTableBody from "./WindowedTableBody.vue";
import {
  addTab,
  closeTab,
  groupOf,
  reopenTab,
  restoreLayout,
  splitLayout,
  type SplitLayout,
  type SplitSide,
} from "../splitTabs";
import {
  TRASH_DAYS,
  addTrash,
  drafts,
  findDraft,
  importLegacy,
  removeDraft,
  removeTrash,
  storageError,
  trash,
  updateDraft as storeDraft,
  type TrashEntry,
} from "../netsuiteFiles";
import type { Block } from "../model";
import { uid } from "../model";
type Row = Record<string, any>;
type Crumb = { id: number; name: string };
type Kind = "file" | "folder";
type Item = Row & { type: Kind; key: string };
type Bookmark = {
  environment: string;
  id: number;
  name: string;
  path: Crumb[];
  kind?: Kind;
  missing?: boolean;
};
type Pane = {
  id: string;
  path: Crumb[];
  folders: Row[];
  files: Row[];
  preview: Row | null;
  loading: boolean;
  busy: string;
  error: string;
  requestSeq: number;
  selected: string[];
  anchor: string;
  detail: Item | null;
  editing: boolean;
  filter: string;
  search: string;
  results: { folders: Row[]; files: Row[] } | null;
  searching: boolean;
  searchSeq: number;
  dragOver: boolean;
  pdfUrl: string;
  restoredFile?: Row;
  initialized?: boolean;
};
type MenuAction = {
  label: string;
  icon: string;
  run: () => unknown;
  danger?: boolean;
};
const props = defineProps<{
  block: Block;
  environment: string;
  request: (op: string, args?: Row) => Promise<Row>;
  openRecord?: (kind: string, id: unknown) => unknown;
  initialFile?: { id: number; name: string };
  storageKey?: string;
}>();
const emit = defineEmits<{ "opened-initial": [] }>();
// Matches Magic NetSuite's FileCabinetPane file type groups.
const TEXT_TYPES = new Set([
  "JAVASCRIPT",
  "TYPESCRIPT",
  "PLAINTEXT",
  "CSV",
  "XMLDOC",
  "HTMLDOC",
  "JSON",
  "STYLESHEET",
  "FREEMARKER",
  "SVGIMAGE",
  "CONFIG",
]);
const IMAGE_TYPES: Record<string, string> = {
  JPGIMAGE: "image/jpeg",
  PNGIMAGE: "image/png",
  GIFIMAGE: "image/gif",
  BMPIMAGE: "image/bmp",
  TIFFIMAGE: "image/tiff",
  ICON: "image/x-icon",
};
const TRASH_LIMIT = 1000000;
function readState(): Row {
  try {
    return JSON.parse(props.block.value) || {};
  } catch {
    return {};
  }
}
function writeState(patch: Row) {
  props.block.value = JSON.stringify({ ...readState(), ...patch });
}
function stored(): Bookmark[] {
  const state = readState();
  return Array.isArray(state.fileBookmarks)
    ? state.fileBookmarks.filter(
        (b: Bookmark) =>
          b &&
          typeof b.environment === "string" &&
          Number.isSafeInteger(b.id) &&
          Array.isArray(b.path),
      )
    : [];
}
const bookmarks = ref<Bookmark[]>(stored());
watch(bookmarks, () => writeState({ fileBookmarks: bookmarks.value }), {
  deep: true,
});
const pane = (): Pane => ({
  id: uid(),
  path: [],
  folders: [],
  files: [],
  preview: null,
  loading: false,
  busy: "",
  error: "",
  requestSeq: 0,
  selected: [],
  anchor: "",
  detail: null,
  editing: false,
  filter: "",
  search: "",
  results: null,
  searching: false,
  searchSeq: 0,
  dragOver: false,
  pdfUrl: "",
});
const closedPanes = ref<
  { pane: Pane; closed: { id: string; group: SplitSide | null; index: number } }[]
>([]);
let restoringPanes = false;
const treeFilter = ref(""),
  treeChildren = ref<Record<number, Row[]>>({}),
  treeExpanded = ref<number[]>([]),
  treeLoading = ref<number[]>([]);
const roots = ref<Row[]>([]),
  sidebarCollapsed = ref(!!readState().fileSidebarCollapsed),
  bookmarksOpen = ref(true),
  trashOpen = ref(false),
  checkingBookmarks = ref(false),
  dialog = ref<
    | { kind: "folder"; name: string; busy: boolean }
    | {
        kind: "file";
        name: string;
        extension: string;
        content: string;
        busy: boolean;
      }
    | { kind: "delete"; items: Item[]; folderId: number; busy: boolean }
    | {
        kind: "move";
        items: Item[];
        from: number;
        target: Crumb;
        targetPath: Crumb[];
        pane: string;
        busy: boolean;
      }
    | {
        kind: "scripts";
        file: Item;
        rows: Row[];
        loading: boolean;
        error: string;
      }
    | null
  >(null),
  uploadInput = ref<HTMLInputElement>(),
  root = ref<HTMLElement>(),
  contextMenu = ref<{ x: number; y: number; actions: MenuAction[] } | null>(
    null,
  ),
  renaming = ref(""),
  renameValue = ref(""),
  dropFolder = ref(""),
  upload = ref(""),
  detailWidth = ref(Number(readState().fileDetailWidth) || 300),
  previews = ref<Record<string, { text?: string; image?: string; error?: boolean }>>(
    {},
  ),
  toasts = ref<{ id: string; text: string; error?: boolean }[]>([]);
const NEW_FILE_TYPES = [
  ".js",
  ".ts",
  ".json",
  ".html",
  ".xml",
  ".css",
  ".csv",
  ".txt",
  ".ftl",
  ".sql",
  ".md",
];
const first = pane();
const panes = ref<Pane[]>([first]),
  layout = ref<SplitLayout>(splitLayout([first.id])),
  view = ref<"list" | "grid">("list"),
  sortField = ref<"name" | "type" | "size" | "modified">("name"),
  sortDir = ref<"asc" | "desc">("asc");
const current = computed(
  () =>
    panes.value.find((p) => p.id === layout.value.active) ?? panes.value[0]!,
);
function paneOf(id: string) {
  return panes.value.find((p) => p.id === id) ?? current.value;
}
function paneInfo(id: string) {
  const p = paneOf(id);
  return {
    label:
      p.preview?.name ||
      p.restoredFile?.name ||
      p.path.at(-1)?.name ||
      "File Cabinet",
    icon: p.preview || p.restoredFile ? "file" : "folder",
    title:
      [...p.path.map((c) => c.name), p.preview?.name]
        .filter(Boolean)
        .join(" / ") || "File Cabinet",
  };
}
const currentBookmarks = computed(() =>
  bookmarks.value.filter((b) => b.environment === props.environment),
);
const currentTrash = computed(() =>
  trash.value
    .filter((t) => t.environment === props.environment)
    .sort((a, b) => b.deletedAt - a.deletedAt),
);
function draftOf(p: Pane) {
  const file = p.preview;
  return file
    ? drafts.value.find(
        (d) => d.environment === props.environment && d.id === Number(file.id),
      )
    : undefined;
}
function dirtyOf(p: Pane) {
  const draft = draftOf(p);
  return !!draft && draft.content !== draft.original;
}
const currentDraft = computed(() => draftOf(current.value));
const dirty = computed(() => dirtyOf(current.value));
function toast(text: string, error = false) {
  const id = uid();
  toasts.value.push({ id, text, error });
  setTimeout(
    () => (toasts.value = toasts.value.filter((t) => t.id !== id)),
    error ? 4000 : 2200,
  );
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function isText(row: Row) {
  return (
    TEXT_TYPES.has(String(row.filetype || "")) ||
    /\.(js|ts|json|txt|xml|html?|css|csv|ftl|sql|md)$/i.test(String(row.name))
  );
}
function isImage(row: Row) {
  return !!IMAGE_TYPES[String(row.filetype || "")];
}
function isPdf(row: Row) {
  return row.filetype === "PDF" || /\.pdf$/i.test(String(row.name));
}
function isScript(row: Row) {
  return (
    row.filetype === "JAVASCRIPT" ||
    row.filetype === "TYPESCRIPT" ||
    /\.(js|ts)$/i.test(String(row.name))
  );
}
function fileSize(bytes: unknown) {
  const n = Number(bytes);
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function folderSize(kb: unknown) {
  const n = Number(kb);
  if (!n) return "—";
  return n < 1024 ? `${n.toFixed(1)} KB` : `${(n / 1024).toFixed(1)} MB`;
}
function itemIcon(item: Row) {
  if (item.type === "folder") return "folder";
  if (isScript(item) || item.filetype === "JSON") return "code";
  if (item.filetype === "HTMLDOC") return "globe";
  return "file";
}
function iconTone(item: Row) {
  if (item.type === "folder")
    return item.foldertype === "SUITESCRIPTS" ? "tone-script" : "tone-folder";
  if (isScript(item)) return "tone-js";
  if (isPdf(item)) return "tone-pdf";
  if (isImage(item)) return "tone-image";
  return "tone-file";
}
function updateDraft(value: string) {
  const file = current.value.preview;
  if (!file) return;
  const draft = currentDraft.value;
  if (draft) {
    draft.content = value;
    storeDraft(draft);
  } else
    storeDraft({
      environment: props.environment,
      id: Number(file.id),
      content: value,
      original: String(file.content ?? ""),
    });
}
function discardDraft() {
  const file = current.value.preview;
  if (file) removeDraft(props.environment, Number(file.id));
}
function encode(text: string) {
  const bytes = new TextEncoder().encode(text);
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}
async function saveFile() {
  const target = current.value,
    file = target.preview,
    draft = currentDraft.value,
    environment = props.environment;
  if (!file || !draft || !dirty.value || target.loading || target.busy) return;
  const content = draft.content,
    original = draft.original;
  target.busy = "Saving…";
  try {
    await props.request("save-file", {
      id: Number(file.id),
      content,
      original,
    });
    if (target.preview === file && props.environment === environment) {
      file.content = content;
      file.base64 = encode(content);
      const latest = findDraft(environment, Number(file.id));
      if (latest?.content === content && latest.original === original)
        removeDraft(environment, Number(file.id));
      else if (latest) {
        latest.original = content;
        storeDraft(latest);
      }
      delete previews.value[`${environment}:${file.id}`];
    }
    toast(`Saved ${file.name}`);
  } catch (e) {
    toast(`Save failed: ${errorText(e)}`, true);
  } finally {
    target.busy = "";
  }
}
const selectedFolder = computed(() => current.value.path.at(-1));
function isBookmarked(id: unknown, kind: Kind) {
  return currentBookmarks.value.some(
    (b) => b.id === Number(id) && (b.kind || "folder") === kind,
  );
}
function itemsOf(p: Pane): Item[] {
  const term = p.filter.toLowerCase(),
    match = (r: Row) => `${r.name} ${r.id}`.toLowerCase().includes(term),
    value = (r: Item) =>
      sortField.value === "type"
        ? String(r.type === "folder" ? "" : r.filetype || "")
        : sortField.value === "size"
          ? Number(r.type === "folder" ? r.foldersize : r.filesize) || 0
          : sortField.value === "modified"
            ? Date.parse(String(r.lastmodifieddate || "")) || 0
            : String(r.name || "").toLowerCase(),
    compare = (a: Item, b: Item) => {
      const x = value(a),
        y = value(b),
        order = x < y ? -1 : x > y ? 1 : 0;
      return sortDir.value === "asc" ? order : -order;
    };
  return [
    ...p.folders
      .filter(match)
      .map((r) => ({ ...r, type: "folder" as const, key: `folder:${r.id}` }))
      .sort(compare),
    ...p.files
      .filter(match)
      .map((r) => ({ ...r, type: "file" as const, key: `file:${r.id}` }))
      .sort(compare),
  ];
}
// Cached per pane so unrelated re-renders (e.g. typing a draft) skip re-sorting.
const paneItems = computed(
  () => new Map(panes.value.map((p) => [p.id, itemsOf(p)])),
);
const items = computed(() => paneItems.value.get(current.value.id) ?? []);
// One collapsed sizing row preserves intrinsic column widths for records
// outside the rendered window. Names already use an ellipsized fixed column.
const tableSizes = computed(() => {
  const canvas = document.createElement("canvas").getContext("2d");
  if (canvas)
    canvas.font = `12px ${getComputedStyle(root.value ?? document.body).fontFamily}`;
  const widths = new Map<string, number>();
  const width = (text: string) => {
    if (!widths.has(text))
      widths.set(text, canvas?.measureText(text).width ?? text.length);
    return widths.get(text)!;
  };
  return new Map(
    [...paneItems.value].map(([id, list]) => {
      const cells = ["", "", "", "", ""];
      const maximum = [-1, -1, -1, -1, -1];
      for (const item of list) {
        const values = [
          String(item.name),
          item.type === "folder" ? "Folder" : String(item.filetype || "—"),
          item.type === "folder"
            ? folderSize(item.foldersize)
            : fileSize(item.filesize),
          String(item.lastmodifieddate || "—"),
          String(item.id),
        ];
        values.forEach((value, index) => {
          const size = index === 0 || index === 4 ? value.length : width(value);
          if (size > maximum[index]!) {
            maximum[index] = size;
            cells[index] = value;
          }
        });
      }
      return [id, cells];
    }),
  );
});
function selectedOf(p: Pane, list = itemsOf(p)) {
  const selected = new Set(p.selected);
  return list.filter((i) => selected.has(i.key));
}
const tableBodies = new Map<string, { reveal: (key: string) => void }>();
function setTableBody(id: string, body: unknown) {
  if (body) tableBodies.set(id, body as { reveal: (key: string) => void });
  else tableBodies.delete(id);
}
const selectedItems = computed(() => selectedOf(current.value, items.value));
function sortBy(field: typeof sortField.value) {
  if (sortField.value === field)
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  else {
    sortField.value = field;
    sortDir.value = "asc";
  }
}
let epoch = 0;
function expandTo(path: Crumb[]) {
  const ids = path.slice(0, -1).map((c) => c.id);
  treeExpanded.value = [...new Set([...treeExpanded.value, ...ids])];
  for (const id of ids)
    if (!treeChildren.value[id] && !treeLoading.value.includes(id))
      void loadTreeChildren(id);
}
async function navigate(path: Crumb[], target = current.value, restoringFile = false) {
  target.initialized = true;
  if (!restoringFile) target.restoredFile = undefined;
  const environment = props.environment,
    requestEpoch = epoch,
    requestSeq = ++target.requestSeq;
  target.loading = true;
  target.error = "";
  setPreview(target, null);
  target.selected = [];
  target.detail = null;
  try {
    const last = path.at(-1);
    const data = await props.request(
      last ? "folder" : "folders",
      last ? { id: last.id } : {},
    );
    if (
      environment !== props.environment ||
      requestEpoch !== epoch ||
      target.requestSeq !== requestSeq
    )
      return;
    const chain = Array.isArray(data.path)
      ? data.path.filter(
          (c: Row) => Number.isSafeInteger(c?.id) && typeof c.name === "string",
        )
      : [];
    target.path = last && chain.at(-1)?.id === last.id ? chain : path;
    target.folders = (last ? data.folders : data.rows) || [];
    target.files = last ? data.files || [] : [];
    if (!last) roots.value = target.folders;
    else {
      treeChildren.value[last.id] = target.folders;
      expandTo(target.path);
    }
  } catch (e) {
    if (requestEpoch === epoch && target.requestSeq === requestSeq)
      target.error = errorText(e);
  } finally {
    if (target.requestSeq === requestSeq) target.loading = false;
  }
}
function refresh(target = current.value) {
  const file = target.preview ?? target.restoredFile;
  return file
    ? openFile(file, target)
    : navigate([...target.path], target);
}
function refreshFolder(...ids: (number | undefined)[]) {
  for (const p of panes.value)
    if (p.initialized && !p.preview && ids.includes(p.path.at(-1)?.id)) void navigate([...p.path], p);
  for (const id of ids)
    if (id !== undefined && treeChildren.value[id]) void loadTreeChildren(id);
}
async function openFile(row: Row, target = current.value) {
  const environment = props.environment,
    requestEpoch = epoch,
    requestSeq = ++target.requestSeq;
  target.loading = true;
  target.error = "";
  setPreview(target, { id: row.id, name: row.name, filetype: row.filetype });
  target.editing = !!findDraft(environment, Number(row.id));
  try {
    const data = await props.request("file", { id: Number(row.id) });
    if (
      requestEpoch === epoch &&
      environment === props.environment &&
      target.requestSeq === requestSeq
    )
      setPreview(target, data);
  } catch (e) {
    if (requestEpoch === epoch && target.requestSeq === requestSeq)
      target.error = errorText(e);
  } finally {
    if (target.requestSeq === requestSeq) target.loading = false;
  }
}
function previewUrlOf(p: Pane) {
  const file = p.preview;
  if (!file?.binary || !file.base64 || !isImage(file)) return "";
  return `data:${IMAGE_TYPES[String(file.filetype)]};base64,${file.base64}`;
}
// PDFs need a blob URL; each pane owns (and revokes) its own.
function setPreview(p: Pane, file: Row | null) {
  if (p.pdfUrl) URL.revokeObjectURL(p.pdfUrl);
  p.pdfUrl = "";
  p.preview = file;
  if (file) p.restoredFile = undefined;
  if (file?.base64 && isPdf(file)) {
    const raw = atob(String(file.base64));
    p.pdfUrl = URL.createObjectURL(
      new Blob([Uint8Array.from(raw, (c) => c.charCodeAt(0))], {
        type: "application/pdf",
      }),
    );
  }
}
async function loadTreeChildren(id: number) {
  const requestEpoch = epoch;
  treeLoading.value = [...treeLoading.value, id];
  try {
    const data = await props.request("folder", { id });
    if (requestEpoch === epoch) treeChildren.value[id] = data.folders || [];
  } catch (e) {
    if (requestEpoch === epoch) toast(errorText(e), true);
  } finally {
    treeLoading.value = treeLoading.value.filter((x) => x !== id);
  }
}
async function toggleTree(folder: Row) {
  const id = Number(folder.id);
  if (treeExpanded.value.includes(id)) {
    treeExpanded.value = treeExpanded.value.filter((x) => x !== id);
    return;
  }
  treeExpanded.value = [...treeExpanded.value, id];
  if (!treeChildren.value[id]) await loadTreeChildren(id);
}
function toggleBookmark(row: Row, kind: Kind, path?: Crumb[]) {
  const id = Number(row.id);
  if (isBookmarked(id, kind)) {
    bookmarks.value = bookmarks.value.filter(
      (b) =>
        b.environment !== props.environment ||
        b.id !== id ||
        (b.kind || "folder") !== kind,
    );
    toast(`Removed bookmark ${row.name}`);
    return;
  }
  bookmarks.value.push({
    environment: props.environment,
    id,
    name: String(row.name),
    path:
      path ??
      (kind === "folder"
        ? [...current.value.path, { id, name: String(row.name) }]
        : [...current.value.path]),
    kind,
  });
  toast(`Bookmarked ${row.name}`);
}
function removeBookmark(bookmark: Bookmark) {
  bookmarks.value = bookmarks.value.filter((b) => b !== bookmark);
}
async function openBookmark(bookmark: Bookmark, target = current.value) {
  await navigate([...bookmark.path], target);
  if (bookmark.kind === "file" && !target.error)
    await openFile({ id: bookmark.id, name: bookmark.name }, target);
}
function openBookmarkInTab(bookmark: Bookmark) {
  const target = addPane(false);
  void openBookmark(bookmark, target);
}
async function checkBookmarks() {
  const list = currentBookmarks.value,
    environment = props.environment;
  if (!list.length || checkingBookmarks.value) return;
  checkingBookmarks.value = true;
  try {
    const ids = (kind: Kind) =>
      list.filter((b) => (b.kind || "folder") === kind).map((b) => b.id);
    const sql = (table: string, values: number[]) =>
      `SELECT id FROM ${table} WHERE id IN (${values.join(",")})`;
    const [files, folders] = await Promise.all(
      (["file", "folder"] as const).map(async (kind) => {
        const values = ids(kind);
        if (!values.length) return new Set<number>();
        const data = await props.request("query", {
          sql: sql(kind === "file" ? "file" : "MediaItemFolder", values),
        });
        return new Set<number>((data.rows || []).map((r: Row) => Number(r.id)));
      }),
    );
    if (environment !== props.environment) return;
    for (const b of list) {
      const found = (b.kind === "file" ? files : folders)!;
      b.missing = !found.has(b.id) && b.id > 0;
    }
  } catch (e) {
    toast(`Bookmark check failed: ${errorText(e)}`, true);
  } finally {
    checkingBookmarks.value = false;
  }
}
function showMenu(event: MouseEvent, actions: MenuAction[]) {
  const box = root.value;
  if (!box) return;
  const bounds = box.getBoundingClientRect(),
    scale = bounds.width / box.offsetWidth || 1,
    height = actions.length * 31 + 12;
  contextMenu.value = {
    x: Math.max(
      0,
      Math.min(box.offsetWidth - 210, (event.clientX - bounds.left) / scale),
    ),
    y: Math.max(
      0,
      Math.min(box.offsetHeight - height, (event.clientY - bounds.top) / scale),
    ),
    actions,
  };
}
function itemPath(item: Item): Crumb[] {
  return item.type === "folder"
    ? [...current.value.path, { id: Number(item.id), name: String(item.name) }]
    : [...current.value.path];
}
function itemMenu(event: MouseEvent, item: Item) {
  const target = current.value;
  if (!target.selected.includes(item.key)) {
    target.selected = [item.key];
    target.anchor = item.key;
  }
  showDetail(item);
  const id = Number(item.id),
    actions: MenuAction[] = [];
  if (item.type === "folder") {
    actions.push({
      label: "Open Folder",
      icon: "folder-open",
      run: () => navigate(itemPath(item)),
    });
  } else {
    actions.push(
      { label: "Open File", icon: "file", run: () => openFile(item) },
      { label: "Download", icon: "download", run: () => downloadItem(item) },
    );
  }
  actions.push({
    label: "Open in new tab",
    icon: "plus",
    run: () => openInNewTab(item),
  });
  if (props.openRecord)
    actions.push({
      label: "Open in NetSuite",
      icon: "external",
      run: () => props.openRecord!(item.type, id),
    });
  if (item.type === "file" && isScript(item))
    actions.push({
      label: "Scripts Using This File",
      icon: "code",
      run: () => scriptsUsing(item),
    });
  if (item.type === "file" && item.url)
    actions.push({
      label: "Copy URL",
      icon: "link",
      run: () => copy(String(item.url), "URL"),
    });
  if (id > 0)
    actions.push({ label: "Rename", icon: "edit", run: () => startRename(item) });
  actions.push(
    {
      label: item.type === "folder" ? "Copy Folder ID" : "Copy File ID",
      icon: "copy",
      run: () => copy(String(id), "ID"),
    },
    { label: "Copy Name", icon: "copy", run: () => copy(String(item.name), "name") },
    {
      label: isBookmarked(id, item.type) ? "Remove Bookmark" : "Add Bookmark",
      icon: "star",
      run: () => toggleBookmark(item, item.type, itemPath(item)),
    },
  );
  const deletable = (
    selectedItems.value.length > 1 ? selectedItems.value : [item]
  ).filter((i) => Number(i.id) > 0);
  if (deletable.length)
    actions.push({
      label:
        deletable.length > 1 ? `Delete ${deletable.length} Items` : "Delete",
      icon: "trash",
      danger: true,
      run: () => confirmDelete(deletable),
    });
  showMenu(event, actions);
}
function bodyMenu(event: MouseEvent) {
  if ((event.target as Element).closest(".fc-item")) return;
  const folder = selectedFolder.value,
    actions: MenuAction[] = [];
  if (folder)
    actions.push(
      { label: "New Folder", icon: "folder", run: () => openDialog("folder") },
      { label: "New File", icon: "file", run: () => openDialog("file") },
      { label: "Upload Files", icon: "upload", run: () => uploadInput.value?.click() },
      { label: "Copy Folder ID", icon: "copy", run: () => copy(String(folder.id), "ID") },
    );
  actions.push({ label: "Refresh", icon: "refresh", run: () => refresh() });
  showMenu(event, actions);
}
function bookmarkMenu(event: MouseEvent, bookmark: Bookmark) {
  showMenu(event, [
    { label: "Open", icon: "folder-open", run: () => openBookmark(bookmark) },
    { label: "Open in new tab", icon: "plus", run: () => openBookmarkInTab(bookmark) },
    { label: "Remove Bookmark", icon: "close", danger: true, run: () => removeBookmark(bookmark) },
  ]);
}
function runAction(action: MenuAction) {
  contextMenu.value = null;
  void action.run();
}
async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`Copied ${label}: ${value.length > 40 ? value.slice(0, 40) + "…" : value}`);
  } catch {
    toast("Could not copy to clipboard.", true);
  }
}
function selectItem(event: MouseEvent, item: Item) {
  if (renaming.value === item.key) return;
  const target = current.value;
  if (event.ctrlKey || event.metaKey) {
    target.selected = target.selected.includes(item.key)
      ? target.selected.filter((k) => k !== item.key)
      : [...target.selected, item.key];
    target.anchor = item.key;
  } else if (event.shiftKey && target.anchor) {
    const keys = items.value.map((i) => i.key),
      from = keys.indexOf(target.anchor),
      to = keys.indexOf(item.key);
    if (from >= 0 && to >= 0)
      target.selected = keys.slice(Math.min(from, to), Math.max(from, to) + 1);
  } else if (!(target.selected.includes(item.key) && target.selected.length > 1)) {
    target.selected = [item.key];
    target.anchor = item.key;
  }
  showDetail(item);
}
function openItem(item: Item) {
  if (renaming.value === item.key) return;
  if (item.type === "folder") void navigate(itemPath(item));
  else void openFile(item);
}
function listKeys(event: KeyboardEvent) {
  if (renaming.value || (event.target as Element).closest("input")) return;
  const target = current.value,
    list = items.value,
    selection = selectedItems.value;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    target.selected = list.map((i) => i.key);
  } else if (event.key === "Escape") {
    target.selected = [];
    target.detail = null;
  } else if (event.key === "Enter" && selection.length === 1) {
    openItem(selection[0]!);
  } else if (event.key === "F2" && selection.length === 1) {
    event.preventDefault();
    startRename(selection[0]!);
  } else if (event.key === "Delete" && selection.length) {
    const deletable = selection.filter((i) => Number(i.id) > 0);
    if (deletable.length) confirmDelete(deletable);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const keys = list.map((i) => i.key),
      index = keys.indexOf(target.anchor),
      next =
        list[
          Math.max(
            0,
            Math.min(keys.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
          )
        ];
    if (next) {
      target.selected = [next.key];
      target.anchor = next.key;
      showDetail(next);
      tableBodies.get(target.id)?.reveal(next.key);
      void nextTick(() =>
        root.value
          ?.querySelector(`[data-pane="${target.id}"] [data-key="${next.key}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
    }
  }
}
function showDetail(item: Item) {
  current.value.detail = item;
  if (item.type !== "file") return;
  const key = `${props.environment}:${item.id}`,
    environment = props.environment;
  if (previews.value[key] || Number(item.filesize) > 512000) return;
  if (!isText(item) && !isImage(item)) return;
  previews.value[key] = {};
  props
    .request("file", { id: Number(item.id) })
    .then((data) => {
      if (environment !== props.environment) return;
      previews.value[key] = data.binary
        ? isImage(item)
          ? {
              image: `data:${IMAGE_TYPES[String(item.filetype)]};base64,${data.base64}`,
            }
          : { error: true }
        : { text: String(data.content ?? "").split("\n").slice(0, 50).join("\n") };
    })
    .catch(() => (previews.value[key] = { error: true }));
}
function detailPreviewOf(p: Pane) {
  return p.detail
    ? previews.value[`${props.environment}:${p.detail.id}`]
    : undefined;
}
function startDetailResize(event: PointerEvent) {
  const start = event.clientX,
    width = detailWidth.value,
    box = root.value,
    scale = box ? box.getBoundingClientRect().width / box.offsetWidth || 1 : 1;
  const move = (e: PointerEvent) =>
    (detailWidth.value = Math.max(
      220,
      Math.min(560, width + (start - e.clientX) / scale),
    ));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    writeState({ fileDetailWidth: detailWidth.value });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
function startRename(item: Item) {
  renaming.value = item.key;
  renameValue.value = String(item.name);
  void nextTick(() => {
    const input = root.value?.querySelector<HTMLInputElement>(".fc-rename");
    if (!input) return;
    input.focus();
    const dot = item.type === "file" ? input.value.lastIndexOf(".") : -1,
      at = dot > 0 ? dot : input.value.length;
    input.setSelectionRange(0, at);
  });
}
function cancelRename() {
  if (current.value.busy !== "Renaming…") renaming.value = "";
}
async function commitRename(item: Item) {
  const name = renameValue.value.trim(),
    target = current.value,
    environment = props.environment;
  if (!name || name === item.name || target.busy) {
    renaming.value = "";
    return;
  }
  target.busy = "Renaming…";
  try {
    await props.request("rename-item", {
      kind: item.type,
      id: Number(item.id),
      folderId: Number(
        item.type === "folder" ? (item.parent ?? 0) : (item.folder ?? 0),
      ),
      name,
    });
    if (environment !== props.environment) return;
    const list = item.type === "folder" ? target.folders : target.files,
      row = list.find((r) => Number(r.id) === Number(item.id));
    if (row) row.name = name;
    for (const b of bookmarks.value)
      if (
        b.environment === environment &&
        b.id === Number(item.id) &&
        (b.kind || "folder") === item.type
      )
        b.name = name;
    if (target.detail?.key === item.key)
      target.detail = { ...target.detail, name };
    if (item.type === "folder") refreshFolder(target.path.at(-1)?.id);
    toast(`Renamed to ${name}`);
  } catch (e) {
    toast(`Rename failed: ${errorText(e)}`, true);
  } finally {
    target.busy = "";
    renaming.value = "";
  }
}
function confirmDelete(list: Item[]) {
  dialog.value = {
    kind: "delete",
    items: list,
    folderId: selectedFolder.value?.id ?? 0,
    busy: false,
  };
}
const deleteWarning = computed(() => {
  const d = dialog.value;
  if (d?.kind !== "delete") return "";
  const folders = d.items.filter((i) => i.type === "folder");
  if (!folders.length) return "";
  const files = folders.reduce((n, f) => n + (Number(f.numfolderfiles) || 0), 0);
  return files
    ? `${folders.length === 1 ? "This folder contains" : "These folders contain"} ${files} file(s). NetSuite only deletes empty folders.`
    : "Folders are deleted from NetSuite and cannot be restored from trash.";
});
async function executeDelete() {
  const d = dialog.value;
  if (d?.kind !== "delete" || d.busy) return;
  const target = current.value,
    environment = props.environment,
    folder = selectedFolder.value ?? { id: d.folderId, name: "Root" };
  d.busy = true;
  target.busy = "Deleting…";
  try {
    const files = d.items.filter((i) => i.type === "file");
    // Snapshot text files first so they can be restored for 15 days.
    for (const file of files) {
      if (!isText(file) || Number(file.filesize) > TRASH_LIMIT) continue;
      try {
        const data = await props.request("file", { id: Number(file.id) });
        if (!data.binary)
          addTrash({
            id: uid(),
            environment,
            fileId: Number(file.id),
            name: String(file.name),
            folder: { id: folder.id, name: folder.name },
            filetype: String(file.filetype || ""),
            content: String(data.content ?? ""),
            deletedAt: Date.now(),
          });
      } catch {}
    }
    const result = await props.request("delete-items", {
      folderId: d.folderId,
      fileIds: files.map((f) => Number(f.id)),
      folderIds: d.items
        .filter((i) => i.type === "folder")
        .map((f) => Number(f.id)),
    });
    const remaining: string[] = result.remaining || [];
    removeTrash(
      trash.value.filter(
        (t) =>
          t.environment === environment &&
          remaining.includes(`File ${t.fileId}`) &&
          t.deletedAt >= Date.now() - 60000,
      ),
    );
    if (remaining.length)
      toast(
        `${remaining.length} item(s) were not deleted. ${(result.errors || [])[0] || ""}`,
        true,
      );
    else toast(`Deleted ${d.items.length} item(s)`);
    dialog.value = null;
    refreshFolder(d.folderId || undefined);
    if (!d.folderId) void navigate([], target);
  } catch (e) {
    toast(`Delete failed: ${errorText(e)}`, true);
    d.busy = false;
  } finally {
    target.busy = "";
  }
}
function dragKeys(item: Item) {
  const target = current.value;
  return target.selected.includes(item.key) ? selectedItems.value : [item];
}
function itemDragStart(event: DragEvent, item: Item) {
  if (renaming.value || !event.dataTransfer) return;
  const list = dragKeys(item).filter((i) => Number(i.id) > 0);
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(
    "application/x-orvane-cabinet",
    JSON.stringify({
      environment: props.environment,
      from: selectedFolder.value?.id ?? 0,
      path: current.value.path,
      items: list.map((i) => ({
        type: i.type,
        id: Number(i.id),
        name: String(i.name),
        filetype: i.filetype,
      })),
    }),
  );
}
function dragPayload(event: DragEvent): Row | null {
  try {
    const data = JSON.parse(
      event.dataTransfer?.getData("application/x-orvane-cabinet") || "null",
    );
    return data?.environment === props.environment ? data : null;
  } catch {
    return null;
  }
}
function isCabinetDrag(event: DragEvent) {
  return !!event.dataTransfer?.types.includes("application/x-orvane-cabinet");
}
function folderDragOver(event: DragEvent, item: Item) {
  if (item.type !== "folder" || !isCabinetDrag(event)) return;
  event.preventDefault();
  dropFolder.value = item.key;
}
// Drops work across split groups: the target folder may be in another pane.
function dropOnFolder(event: DragEvent, item: Item, p: Pane) {
  dropFolder.value = "";
  p.dragOver = false;
  if (item.type !== "folder") return;
  const data = dragPayload(event);
  if (!data) return dropFiles(event, Number(item.id), p);
  const moving: Item[] = (data.items as Row[])
    .filter((i) => !(i.type === "folder" && i.id === Number(item.id)))
    .map((i) => ({ ...i, type: i.type as Kind, key: `${i.type}:${i.id}` }));
  if (!moving.length || data.from === Number(item.id)) return;
  dialog.value = {
    kind: "move",
    items: moving,
    from: Number(data.from),
    target: { id: Number(item.id), name: String(item.name) },
    targetPath: [...p.path, { id: Number(item.id), name: String(item.name) }],
    pane: p.id,
    busy: false,
  };
}
async function executeMove() {
  const d = dialog.value;
  if (d?.kind !== "move" || d.busy) return;
  const target = paneOf(d.pane);
  d.busy = true;
  target.busy = "Moving…";
  try {
    await props.request("move-items", {
      folderId: d.from,
      targetId: d.target.id,
      fileIds: d.items.filter((i) => i.type === "file").map((i) => i.id),
      folderIds: d.items.filter((i) => i.type === "folder").map((i) => i.id),
    });
    for (const b of bookmarks.value)
      if (
        b.environment === props.environment &&
        b.kind === "file" &&
        d.items.some((i) => i.type === "file" && i.id === b.id)
      )
        b.path = d.targetPath;
    toast(`Moved ${d.items.length} item(s) to ${d.target.name}`);
    dialog.value = null;
    refreshFolder(d.from, d.target.id);
  } catch (e) {
    toast(`Move failed: ${errorText(e)}`, true);
    d.busy = false;
  } finally {
    target.busy = "";
  }
}
function areaDragOver(event: DragEvent, p: Pane) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  p.dragOver = true;
}
function areaDragLeave(event: DragEvent, p: Pane) {
  if (!(event.currentTarget as Element).contains(event.relatedTarget as Node))
    p.dragOver = false;
}
function areaDrop(event: DragEvent, p: Pane) {
  p.dragOver = false;
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  void dropFiles(event, p.path.at(-1)?.id, p);
}
async function dropFiles(event: DragEvent, folderId: number | undefined, p: Pane) {
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  if (!folderId) {
    toast("Open a folder before uploading files.", true);
    return;
  }
  await uploadFiles(files, folderId, p);
}
async function uploadFiles(files: File[], folderId: number, p: Pane) {
  const target = p,
    environment = props.environment,
    errors: string[] = [];
  if (upload.value) return;
  for (const [index, file] of files.entries()) {
    if (environment !== props.environment) break;
    upload.value = `Uploading ${index + 1}/${files.length}: ${file.name}`;
    if (file.size > 5000000) {
      errors.push(`${file.name}: exceeds the 5 MB limit.`);
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let raw = "";
      for (let i = 0; i < bytes.length; i += 8192)
        raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await props.request("upload-file", {
        folderId,
        name: file.name,
        base64: btoa(raw),
      });
    } catch (e) {
      errors.push(`${file.name}: ${errorText(e)}`);
    }
  }
  upload.value = "";
  if (environment !== props.environment) return;
  refreshFolder(folderId);
  if (errors.length) {
    target.error = errors.join("\n");
    toast(`${errors.length} upload(s) failed`, true);
  } else toast(`Uploaded ${files.length} file(s)`);
}
function uploadPicked(event: Event) {
  const input = event.target as HTMLInputElement,
    files = Array.from(input.files || []),
    folder = selectedFolder.value;
  input.value = "";
  if (files.length && folder) void uploadFiles(files, folder.id, current.value);
}
function openDialog(kind: "folder" | "file") {
  if (!selectedFolder.value) return;
  dialog.value =
    kind === "folder"
      ? { kind, name: "", busy: false }
      : { kind, name: "", extension: ".js", content: "", busy: false };
  void nextTick(() =>
    root.value?.querySelector<HTMLInputElement>(".fc-dialog input")?.focus(),
  );
}
const newFileName = computed(() => {
  const d = dialog.value;
  if (d?.kind !== "file") return "";
  const name = d.name.trim();
  return !name || /\.[a-z0-9]+$/i.test(name) ? name : name + d.extension;
});
async function createFolder() {
  const d = dialog.value,
    parent = selectedFolder.value,
    target = current.value,
    environment = props.environment;
  if (d?.kind !== "folder" || !d.name.trim() || !parent || d.busy) return;
  d.busy = true;
  try {
    await props.request("create-folder", {
      folderId: parent.id,
      name: d.name.trim(),
    });
    if (environment === props.environment) {
      toast(`Created folder ${d.name.trim()}`);
      dialog.value = null;
      await navigate([...target.path], target);
    }
  } catch (e) {
    toast(`Create folder failed: ${errorText(e)}`, true);
    d.busy = false;
  }
}
async function createFile() {
  const d = dialog.value,
    name = newFileName.value,
    parent = selectedFolder.value,
    target = current.value,
    environment = props.environment;
  if (d?.kind !== "file" || !name || !parent || d.busy) return;
  d.busy = true;
  try {
    const created = await props.request("upload-file", {
      folderId: parent.id,
      name,
      base64: encode(d.content),
    });
    if (environment === props.environment) {
      dialog.value = null;
      toast(`Created ${name}`);
      await navigate([...target.path], target);
      if (created.id) {
        await openFile({ id: created.id, name }, target);
        target.editing = true;
      }
    }
  } catch (e) {
    toast(`Create file failed: ${errorText(e)}`, true);
    d.busy = false;
  }
}
async function scriptsUsing(file: Item) {
  const d = {
    kind: "scripts" as const,
    file,
    rows: [] as Row[],
    loading: true,
    error: "",
  };
  dialog.value = d;
  try {
    const data = await props.request("query", {
      sql: `SELECT id, scriptid, name, scripttype FROM script WHERE scriptfile = ${Number(file.id)} ORDER BY name`,
    });
    if (dialog.value === d) d.rows = data.rows || [];
  } catch (e) {
    d.error = errorText(e);
  } finally {
    d.loading = false;
  }
}
function addPane(focus = true, group?: SplitSide | null, after?: string) {
  const next = pane(),
    previous = layout.value.active;
  panes.value.push(next);
  addTab(layout.value, next.id, group, after);
  if (!focus) layout.value.active = previous;
  const mounted = paneOf(next.id);
  void navigate([], mounted);
  return mounted;
}
function duplicatePane(id: string) {
  const p = paneOf(id),
    file = p.preview ?? p.restoredFile,
    next = pane();
  panes.value.push(next);
  addTab(layout.value, next.id, groupOf(layout.value, id), id);
  const mounted = paneOf(next.id);
  void navigate([...p.path], mounted).then(() => {
    if (file?.id && !mounted.error) void openFile(file, mounted);
  });
}
function closePane(id: string) {
  const closed = closeTab(layout.value, id);
  if (!closed) return;
  const index = panes.value.findIndex((p) => p.id === id),
    [removed] = panes.value.splice(index, 1);
  if (removed) closedPanes.value.push({ pane: removed, closed });
  closedPanes.value = closedPanes.value.slice(-10);
}
function reopenPane() {
  const restored = closedPanes.value.pop();
  if (!restored) return;
  panes.value.push(restored.pane);
  reopenTab(layout.value, restored.closed);
}
async function openInNewTab(item: Row, from = current.value) {
  const target = addPane(true, groupOf(layout.value, from.id), from.id),
    path =
      item.type === "folder"
        ? [...from.path, { id: Number(item.id), name: String(item.name) }]
        : [...from.path];
  target.requestSeq++;
  await navigate(path, target);
  if (item.type === "file" && !target.error) await openFile(item, target);
}
// A File Cabinet item dropped on a tab strip opens in a new tab of that group.
function externalDrop(event: DragEvent, group: SplitSide | null) {
  const data = dragPayload(event);
  if (!data?.items?.length) return;
  const item = data.items[0],
    target = addPane(true, group),
    path =
      item.type === "folder"
        ? [...data.path, { id: item.id, name: item.name }]
        : data.path;
  target.requestSeq++;
  void navigate(path, target).then(() => {
    if (item.type === "file" && !target.error) void openFile(item, target);
  });
}
const storageId = computed(() =>
  props.storageKey ? `${props.environment}#${props.storageKey}` : props.environment,
);
function persistPanes() {
  if (resizingSplit.value || restoringPanes || !props.environment) return;
  const state = readState();
  const all =
    state.filePanes &&
    typeof state.filePanes === "object" &&
    !Array.isArray(state.filePanes)
      ? state.filePanes
      : {};
  const l = layout.value;
  all[storageId.value] = {
    active: l.active,
    layout: {
      left: l.left,
      right: l.right,
      leftActive: l.leftActive,
      rightActive: l.rightActive,
      ratio: l.ratio,
    },
    panes: l.tabs.map((id) => {
      const p = paneOf(id);
      return {
        id: p.id,
        path: p.path,
        file: p.preview?.id
          ? { id: p.preview.id, name: p.preview.name }
          : (p.restoredFile ?? null),
      };
    }),
  };
  props.block.value = JSON.stringify({ ...state, filePanes: all });
}
const resizingSplit = ref(false);
function finishSplitResize() {
  resizingSplit.value = false;
  persistPanes();
}
async function restorePanes() {
  const requestEpoch = epoch;
  const saved: Row | undefined = readState().filePanes?.[storageId.value];
  const source = Array.isArray(saved?.panes)
    ? saved.panes
        .slice(0, 20)
        .filter(
          (p: Row) =>
            p &&
            typeof p.id === "string" &&
            Array.isArray(p.path) &&
            p.path.every(
              (c: Row) =>
                Number.isSafeInteger(c.id) && typeof c.name === "string",
            ),
        )
    : [];
  restoringPanes = true;
  for (const p of panes.value) if (p.pdfUrl) URL.revokeObjectURL(p.pdfUrl);
  panes.value = source.length
    ? source.map((p: Row) => ({
        ...pane(),
        id: p.id,
        path: p.path,
        restoredFile: p.file,
      }))
    : [pane()];
  const ids = panes.value.map((p) => p.id);
  layout.value =
    restoreLayout(
      { ...saved?.layout, tabs: ids, active: saved?.active },
      ids,
    ) ?? splitLayout(ids);
  closedPanes.value = [];
  roots.value = [];
  treeChildren.value = {};
  treeExpanded.value = [];
  treeLoading.value = [];
  previews.value = {};
  const loadRoots = props
    .request("folders")
    .then((data) => {
      if (requestEpoch === epoch) roots.value = data.rows || [];
    })
    .catch(() => {});
  await Promise.all([loadRoots, initializeVisiblePanes()]);
  if (requestEpoch === epoch) {
    restoringPanes = false;
    await initializeVisiblePanes();
    persistPanes();
  }
}
function visiblePanes() {
  const l = layout.value;
  return l.left.length && l.right.length
    ? [l.leftActive, l.rightActive]
    : [l.active];
}
async function initializeVisiblePanes() {
  const requestEpoch = epoch;
  await Promise.all(
    visiblePanes().map(async (id) => {
      const target = paneOf(id);
      if (target.initialized) return;
      const file = target.restoredFile;
      const loading = navigate([...target.path], target, true);
      const sequence = target.requestSeq;
      await loading;
      if (
        requestEpoch === epoch &&
        target.requestSeq === sequence &&
        file &&
        Number.isSafeInteger(Number(file.id)) &&
        !target.error
      )
        await openFile({ id: Number(file.id), name: file.name }, target);
    }),
  );
}
watch(visiblePanes, () => {
  if (!restoringPanes) void initializeVisiblePanes();
});
watch(
  () => [
    layout.value,
    panes.value.map((p) => [
      p.id,
      p.path.map((c) => [c.id, c.name]),
      p.preview?.id || null,
    ]),
  ],
  persistPanes,
  { deep: true, flush: "sync" },
);
watch(sidebarCollapsed, (value) => writeState({ fileSidebarCollapsed: value }));
const searchTimers = new Map<string, ReturnType<typeof setTimeout>>();
async function searchAll(p: Pane) {
  clearTimeout(searchTimers.get(p.id));
  const term = p.search.trim();
  if (!term) {
    p.results = null;
    return;
  }
  const environment = props.environment,
    sequence = ++p.searchSeq;
  p.searching = true;
  try {
    const data = await props.request("search-files", { search: term });
    if (
      sequence === p.searchSeq &&
      environment === props.environment &&
      term === p.search.trim()
    )
      p.results = { folders: data.folders || [], files: data.files || [] };
  } catch (e) {
    if (sequence === p.searchSeq && environment === props.environment)
      toast(`Search failed: ${errorText(e)}`, true);
  } finally {
    if (sequence === p.searchSeq) p.searching = false;
  }
}
function searchHintOf(p: Pane) {
  const term = p.search.trim();
  if (!term || p.searching) return "";
  if (p.results)
    return p.results.folders.length || p.results.files.length
      ? ""
      : "No results found";
  return term.length < 3 && !/^\d+$/.test(term)
    ? "Type at least 3 characters to search"
    : "";
}
function searchInput(p: Pane) {
  clearTimeout(searchTimers.get(p.id));
  p.searchSeq++;
  p.results = null;
  p.searching = false;
  const term = p.search.trim();
  if (/^\d+$/.test(term) || term.length >= 3)
    searchTimers.set(
      p.id,
      setTimeout(() => void searchAll(p), 500),
    );
}
function clearSearch(p: Pane) {
  clearTimeout(searchTimers.get(p.id));
  p.searchSeq++;
  p.search = "";
  p.results = null;
  p.searching = false;
}
function openSearchFolder(row: Row, p: Pane) {
  clearSearch(p);
  void navigate([{ id: Number(row.id), name: String(row.name) }], p);
}
async function openSearchFile(row: Row, p: Pane) {
  clearSearch(p);
  if (row.folder != null && Number.isSafeInteger(Number(row.folder)))
    await navigate(
      [{ id: Number(row.folder), name: String(row.foldername || "Folder") }],
      p,
    );
  if (!p.error) await openFile(row, p);
}
function downloadItem(row: Row) {
  const save = (data: Row) => {
    const raw = atob(String(data.base64 ?? ""));
    const blob = new Blob([Uint8Array.from(raw, (c) => c.charCodeAt(0))], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = String(data.name || row.name || "file");
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${link.download}`);
  };
  if (row.base64 != null) return save(row);
  props
    .request("file", { id: Number(row.id) })
    .then(save)
    .catch((e) => toast(`Download failed: ${errorText(e)}`, true));
}
async function restoreTrash(entry: TrashEntry) {
  try {
    await props.request("upload-file", {
      folderId: entry.folder.id,
      name: entry.name,
      base64: encode(entry.content),
    });
    removeTrash([entry]);
    refreshFolder(entry.folder.id);
    toast(`Restored ${entry.name} to ${entry.folder.name}`);
  } catch (e) {
    toast(`Restore failed: ${errorText(e)}`, true);
  }
}
function purgeTrash(entry?: TrashEntry) {
  removeTrash(entry ? [entry] : currentTrash.value);
}
function daysLeft(entry: TrashEntry) {
  return Math.max(
    0,
    Math.ceil((entry.deletedAt + TRASH_DAYS * 86400000 - Date.now()) / 86400000),
  );
}
function closeContext(event: PointerEvent) {
  if (!(event.target as Element)?.closest(".fc-context-menu"))
    contextMenu.value = null;
}
function globalKeys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (contextMenu.value) contextMenu.value = null;
    else if (dialog.value && !("busy" in dialog.value && dialog.value.busy))
      dialog.value = null;
  }
}
watch(
  () => props.environment,
  () => {
    epoch++;
    void restorePanes();
  },
);
onMounted(() => {
  void (async () => {
    const start = epoch,
      environment = props.environment,
      legacy = readState();
    if (legacy.fileDrafts || legacy.fileTrash) {
      await importLegacy(legacy);
      writeState({ fileDrafts: undefined, fileTrash: undefined });
    } else void importLegacy({});
    await restorePanes();
    if (start !== epoch || environment !== props.environment) return;
    if (currentBookmarks.value.length) void checkBookmarks();
    const file = props.initialFile;
    if (!file || !Number.isSafeInteger(file.id)) return;
    const target = addPane();
    target.requestSeq++;
    await navigate([], target);
    if (!target.error) await openFile(file, target);
    emit("opened-initial");
  })();
  document.addEventListener("pointerdown", closeContext, true);
  document.addEventListener("keydown", globalKeys);
});
onBeforeUnmount(() => {
  epoch++;
  for (const timer of searchTimers.values()) clearTimeout(timer);
  for (const p of panes.value) if (p.pdfUrl) URL.revokeObjectURL(p.pdfUrl);
  document.removeEventListener("pointerdown", closeContext, true);
  document.removeEventListener("keydown", globalKeys);
});
</script>
<template>
  <section ref="root" class="fc-workspace" aria-label="File Cabinet">
    <aside v-if="sidebarCollapsed" class="fc-sidebar collapsed">
      <button
        aria-label="Expand sidebar"
        title="Expand sidebar"
        @click="sidebarCollapsed = false"
      >
        <Icon name="right" :size="14" />
      </button>
      <button aria-label="Refresh" title="Refresh" @click="refresh()">
        <Icon name="refresh" :size="14" />
      </button>
    </aside>
    <aside v-else class="fc-sidebar">
      <div class="fc-side-heading">
        <h2>Actions</h2>
        <button
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          @click="sidebarCollapsed = true"
        >
          <Icon name="back" :size="12" />
        </button>
      </div>
      <button class="fc-side-link" @click="refresh()">
        <Icon name="refresh" :size="14" /> Refresh
      </button>
      <button class="fc-side-link" @click="navigate([])">
        <Icon name="folder" :size="14" /> Root
      </button>
      <button
        class="fc-side-link"
        :aria-pressed="trashOpen"
        @click="trashOpen = !trashOpen"
      >
        <Icon name="trash" :size="14" /> Trash
        <span v-if="currentTrash.length" class="fc-badge">{{
          currentTrash.length
        }}</span>
      </button>
      <div v-if="selectedFolder && !current.preview" class="fc-info">
        <h2>Folder Info</h2>
        <dl>
          <dt>Name</dt>
          <dd>{{ selectedFolder.name }}</dd>
          <dt>ID</dt>
          <dd>{{ selectedFolder.id }}</dd>
          <dt>Contents</dt>
          <dd>{{ current.folders.length }} folders · {{ current.files.length }} files</dd>
          <dt>Size</dt>
          <dd>
            {{
              fileSize(
                current.files.reduce((n, f) => n + (Number(f.filesize) || 0), 0),
              )
            }}
          </dd>
        </dl>
      </div>
      <div class="fc-side-heading">
        <h2>Folders</h2>
      </div>
      <input
        v-model="treeFilter"
        class="fc-tree-filter"
        aria-label="Search folders"
        placeholder="Search folders"
      />
      <FileFolderTree
        :folders="roots"
        :children="treeChildren"
        :expanded="treeExpanded"
        :path="[]"
        :selected="selectedFolder?.id"
        :filter="treeFilter"
        :loading="treeLoading"
        @toggle="toggleTree"
        @navigate="navigate"
      />
      <div class="fc-side-heading">
        <button
          class="fc-collapse"
          :aria-expanded="bookmarksOpen"
          @click="bookmarksOpen = !bookmarksOpen"
        >
          <Icon :name="bookmarksOpen ? 'down' : 'right'" :size="11" />
          <h2>Bookmarks</h2>
          <span v-if="currentBookmarks.length" class="fc-badge">{{
            currentBookmarks.length
          }}</span>
        </button>
        <button
          v-if="currentBookmarks.length"
          aria-label="Check bookmark availability"
          title="Check availability"
          :disabled="checkingBookmarks"
          @click="checkBookmarks"
        >
          <Icon name="refresh" :size="12" />
        </button>
      </div>
      <template v-if="bookmarksOpen">
        <p v-if="!currentBookmarks.length" class="fc-hint">
          Bookmark a folder for quick access.
        </p>
        <div
          v-for="bookmark in currentBookmarks"
          :key="`${bookmark.kind || 'folder'}:${bookmark.id}`"
          class="fc-bookmark"
          :class="{ missing: bookmark.missing }"
          :title="`${bookmark.path.map((c) => c.name).join(' / ')}${bookmark.missing ? ' — not found' : ''}`"
          @contextmenu.prevent="bookmarkMenu($event, bookmark)"
        >
          <button
            @click="openBookmark(bookmark)"
            @mousedown.middle.prevent="openBookmarkInTab(bookmark)"
          >
            <Icon
              :name="bookmark.kind === 'file' ? 'file' : 'folder'"
              :size="13"
            />
            <span>{{ bookmark.name }}</span>
            <Icon v-if="bookmark.missing" name="alert" :size="12" /></button
          ><button
            :aria-label="`Remove ${bookmark.name} bookmark`"
            @click="removeBookmark(bookmark)"
          >
            <Icon name="close" :size="12" />
          </button>
        </div>
      </template>
    </aside>
    <SplitTabs
      class="fc-split"
      :layout="layout"
      :info="paneInfo"
      label="File Cabinet"
      accept="application/x-orvane-cabinet"
      :can-reopen="closedPanes.length > 0"
      @add="addPane(true, $event)"
      @close="closePane"
      @reopen="reopenPane"
      @reload="refresh(paneOf($event))"
      @duplicate="duplicatePane"
      @external="externalDrop"
      @resize-start="resizingSplit = true"
      @resize-end="finishSplitResize"
      lazy
    >
      <template #pane="{ id }"
        ><template v-for="p in [paneOf(id)]" :key="p.id"
          ><template v-for="list in [paneItems.get(p.id) ?? []]" :key="p.id"
            ><div class="fc-pane" :data-pane="p.id">
    <div class="fc-main">
      <div class="fc-breadcrumb">
        <button aria-label="Root" title="Root" @click="navigate([])">
          <Icon name="folder" :size="13" /></button
        ><template v-for="(part, index) in p.path" :key="part.id"
          ><Icon name="right" :size="10" class="fc-sep" /><button
            :class="{
              current: index === p.path.length - 1 && !p.preview,
            }"
            @click="navigate(p.path.slice(0, index + 1))"
          >
            {{ part.name }}
          </button></template
        ><template v-if="p.preview"
          ><Icon name="right" :size="10" class="fc-sep" /><span
            class="current"
            >{{ p.preview.name }}</span
          ></template
        >
        <div class="fc-spacer" />
        <template v-if="p.preview"
          ><button @click="downloadItem(p.preview)">
            <Icon name="download" :size="14" /> Download</button
          ><button @click="p.preview = null">
            <Icon name="back" :size="14" /> Back
          </button></template
        ><template v-else
          ><button
            v-if="p.path.at(-1)"
            :aria-label="
              isBookmarked(p.path.at(-1)!.id, 'folder')
                ? 'Remove folder bookmark'
                : 'Bookmark folder'
            "
            :aria-pressed="isBookmarked(p.path.at(-1)!.id, 'folder')"
            @click="toggleBookmark(p.path.at(-1)!, 'folder', [...p.path])"
          >
            <Icon name="star" :size="14" /></button
          ><input
            v-model="p.filter"
            class="fc-filter"
            placeholder="Filter name or ID…"
            aria-label="Filter files"
          /><button
            aria-label="Refresh folder"
            title="Refresh current location"
            :disabled="p.loading"
            @click="refresh()"
          >
            <Icon name="refresh" :size="14" :class="{ spin: p.loading }" /></button
          ><button
            v-if="p.path.at(-1)"
            aria-label="New folder"
            title="New Folder"
            @click="openDialog('folder')"
          >
            <Icon name="folder" :size="14" /><Icon name="plus" :size="9" /></button
          ><button
            v-if="p.path.at(-1)"
            aria-label="New file"
            title="New Text File"
            @click="openDialog('file')"
          >
            <Icon name="file" :size="14" /><Icon name="plus" :size="9" /></button
          ><button
            v-if="p.path.at(-1)"
            aria-label="Upload"
            title="Upload files"
            :disabled="!!upload"
            @click="uploadInput?.click()"
          >
            <Icon name="upload" :size="14" /></button
          ><input
            ref="uploadInput"
            type="file"
            multiple
            hidden
            @change="uploadPicked"
          />
          <div class="fc-seg">
            <button
              aria-label="Grid view"
              :aria-pressed="view === 'grid'"
              @click="view = 'grid'"
            >
              <Icon name="box" :size="13" /></button
            ><button
              aria-label="List view"
              :aria-pressed="view === 'list'"
              @click="view = 'list'"
            >
              <Icon name="list" :size="13" />
            </button>
          </div></template
        >
      </div>
      <div v-if="!p.preview" class="fc-search">
        <Icon name="search" :size="14" /><input
          v-model="p.search"
          aria-label="Search all files and folders"
          placeholder="Search all files and folders by name or ID…"
          @input="searchInput(p)"
          @keydown.enter="searchAll(p)"
          @keydown.esc="clearSearch(p)"
        /><span v-if="p.searching" class="fc-hint">Searching…</span
        ><button
          v-if="p.search"
          type="button"
          aria-label="Clear file search"
          @click="clearSearch(p)"
        >
          <Icon name="close" :size="13" />
        </button>
      </div>
      <div
        v-if="!p.preview && (p.results || searchHintOf(p))"
        class="fc-search-results"
      >
        <p v-if="searchHintOf(p)" class="fc-hint">{{ searchHintOf(p) }}</p>
        <template v-if="p.results">
          <div
            v-for="folder in p.results.folders"
            :key="'d' + folder.id"
            class="fc-result"
          >
            <button @click="openSearchFolder(folder, p)">
              <Icon name="folder" :size="14" class="tone-folder" />
              <span>{{ folder.name }}</span>
              <small>{{ folder.parentname || "Root" }} · {{ folder.id }}</small>
            </button>
            <button
              :aria-label="
                isBookmarked(folder.id, 'folder') ? 'Remove bookmark' : 'Add bookmark'
              "
              :aria-pressed="isBookmarked(folder.id, 'folder')"
              @click="
                toggleBookmark(folder, 'folder', [
                  { id: Number(folder.id), name: String(folder.name) },
                ])
              "
            >
              <Icon name="star" :size="12" />
            </button>
          </div>
          <div
            v-for="file in p.results.files"
            :key="'f' + file.id"
            class="fc-result"
          >
            <button @click="openSearchFile(file, p)">
              <Icon :name="itemIcon(file)" :size="14" class="tone-file" />
              <span>{{ file.name }}</span>
              <small>{{ file.foldername || "Folder" }} · {{ file.id }}</small>
            </button>
            <button
              :aria-label="
                isBookmarked(file.id, 'file') ? 'Remove bookmark' : 'Add bookmark'
              "
              :aria-pressed="isBookmarked(file.id, 'file')"
              @click="
                toggleBookmark(file, 'file', [
                  {
                    id: Number(file.folder),
                    name: String(file.foldername || 'Folder'),
                  },
                ])
              "
            >
              <Icon name="star" :size="12" />
            </button>
          </div>
        </template>
      </div>
      <div class="fc-body">
        <div v-if="trashOpen" class="fc-trash">
          <div class="fc-trash-head">
            <strong>Trash</strong>
            <span class="fc-hint"
              >Text files are kept for {{ TRASH_DAYS }} days.</span
            >
            <div class="fc-spacer" />
            <button
              v-if="currentTrash.length"
              class="danger"
              @click="purgeTrash()"
            >
              Empty trash
            </button>
            <button aria-label="Close trash" @click="trashOpen = false">
              <Icon name="close" :size="13" />
            </button>
          </div>
          <p v-if="!currentTrash.length" class="fc-hint">Trash is empty.</p>
          <div v-for="entry in currentTrash" :key="entry.id" class="fc-trash-row">
            <Icon name="file" :size="14" />
            <span>{{ entry.name }}</span>
            <small
              >{{ entry.folder.name }} ·
              {{ new Date(entry.deletedAt).toLocaleString() }} ·
              {{ daysLeft(entry) }} days left</small
            >
            <button @click="restoreTrash(entry)">Restore</button>
            <button
              class="danger"
              :aria-label="`Delete ${entry.name} permanently`"
              @click="purgeTrash(entry)"
            >
              <Icon name="trash" :size="13" />
            </button>
          </div>
        </div>
        <div v-if="p.busy" class="fc-overlay">
          <span class="fc-spinner" />{{ p.busy }}
        </div>
        <template v-if="p.preview">
          <div v-if="p.loading" class="fc-state">
            <span class="fc-spinner" />Loading {{ p.preview.name }}…
          </div>
          <div v-else-if="p.error" class="fc-state error" role="alert">
            <Icon name="alert" :size="22" />
            <p>{{ p.error }}</p>
            <button @click="refresh()">Retry</button>
          </div>
          <div v-else-if="previewUrlOf(p)" class="fc-media">
            <img :src="previewUrlOf(p)" :alt="String(p.preview.name)" />
          </div>
          <div v-else-if="p.pdfUrl" class="fc-media pdf">
            <iframe :src="p.pdfUrl" title="PDF Viewer" />
          </div>
          <div v-else-if="p.preview.binary" class="fc-state">
            <Icon name="file" :size="26" />
            <p>Unable to display this file type.</p>
            <button @click="downloadItem(p.preview)">Download</button>
          </div>
          <div v-else class="fc-preview">
            <div class="fc-edit-bar">
              <label class="fc-switch">
                <input v-model="p.editing" type="checkbox" />
                <span />{{ p.editing ? "Editing" : "Read-only" }}
              </label>
              <span v-if="dirtyOf(p)" class="fc-hint" :class="{ 'fc-warn': storageError }"
                >{{
                  storageError
                    ? "Unsaved draft · can't be kept locally right now, save before reloading"
                    : "Unsaved draft · kept locally"
                }}</span
              >
              <div class="fc-spacer" />
              <template v-if="p.editing">
                <button
                  v-if="dirtyOf(p)"
                  :disabled="!!p.busy"
                  @click="discardDraft"
                >
                  Discard draft
                </button>
                <button
                  class="primary"
                  :disabled="!dirtyOf(p) || !!p.busy"
                  @click="saveFile"
                >
                  {{ p.busy === "Saving…" ? "Saving…" : "Save"
                  }}<kbd v-if="p.busy !== 'Saving…'">Ctrl+S</kbd>
                </button>
              </template>
            </div>
            <NetSuiteFileEditor
              :key="`${environment}:${p.id}:${p.preview.id}`"
              :name="String(p.preview.name || '')"
              :readonly="!p.editing"
              :model-value="
                String(draftOf(p)?.content ?? p.preview.content ?? '')
              "
              @update:model-value="updateDraft"
              @save="saveFile"
            />
          </div>
        </template>
        <template v-else>
          <div
            
            class="fc-content"
            :class="{ grid: view === 'grid', 'drag-over': p.dragOver }"
            tabindex="0"
            @keydown="listKeys"
            @contextmenu.prevent="bodyMenu"
            @dragover="areaDragOver($event, p)"
            @dragleave="areaDragLeave($event, p)"
            @drop="areaDrop($event, p)"
            @click.self="
              p.selected = [];
              p.detail = null;
            "
          >
            <div v-if="p.dragOver" class="fc-drop-overlay">
              <Icon name="upload" :size="30" />
              <p>
                {{
                  p.path.at(-1)
                    ? `Drop files to upload to ${p.path.at(-1)!.name}`
                    : "Open a folder to upload files"
                }}
              </p>
            </div>
            <div v-if="upload" class="fc-upload-bar">
              <span class="fc-spinner" />{{ upload }}
            </div>
            <div v-if="p.loading" class="fc-state">
              <span class="fc-spinner" />Loading…
            </div>
            <div v-else-if="p.error" class="fc-state error" role="alert">
              <Icon name="alert" :size="22" />
              <p>{{ p.error }}</p>
              <button @click="refresh()">Retry</button>
            </div>
            <div v-else-if="!list.length" class="fc-state">
              <Icon name="folder-open" :size="30" />
              <p>{{ p.filter ? "No matching items" : "This folder is empty" }}</p>
            </div>
            <template v-else-if="view === 'grid'">
              <div
                v-for="item in list"
                :key="item.key"
                :data-key="item.key"
                class="fc-item fc-tile"
                role="row"
                :aria-label="item.name"
                :aria-selected="p.selected.includes(item.key)"
                :class="{
                  selected: p.selected.includes(item.key),
                  'drop-target': dropFolder === item.key,
                }"
                :draggable="renaming !== item.key && Number(item.id) > 0"
                @click="selectItem($event, item)"
                @dblclick="openItem(item)"
                @mousedown.middle.prevent="openInNewTab(item)"
                @contextmenu.prevent.stop="itemMenu($event, item)"
                @dragstart="itemDragStart($event, item)"
                @dragover="folderDragOver($event, item)"
                @dragleave="dropFolder = ''"
                @drop.prevent.stop="dropOnFolder($event, item, p)"
              >
                <Icon :name="itemIcon(item)" :size="26" :class="iconTone(item)" />
                <input
                  v-if="renaming === item.key"
                  v-model="renameValue"
                  class="fc-rename"
                  aria-label="New name"
                  @keydown.enter.stop="commitRename(item)"
                  @keydown.esc.stop="cancelRename"
                  @blur="cancelRename"
                  @click.stop
                />
                <span v-else :title="item.name">{{ item.name }}</span>
                <small>{{
                  item.type === "folder"
                    ? `${item.numfolderfiles ?? 0} files`
                    : fileSize(item.filesize)
                }}</small>
              </div>
            </template>
            <table v-else class="fc-table" :aria-rowcount="list.length + 1">
              <thead>
                <tr>
                  <th
                    v-for="col in [
                      ['name', 'Name'],
                      ['type', 'Type'],
                      ['size', 'Size'],
                      ['modified', 'Modified'],
                    ] as const"
                    :key="col[0]"
                    :class="`fc-th-${col[0]}`"
                    :aria-sort="
                      sortField === col[0]
                        ? sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    "
                    @click="sortBy(col[0])"
                  >
                    {{ col[1]
                    }}<Icon
                      v-if="sortField === col[0]"
                      :name="sortDir === 'asc' ? 'arrow' : 'down'"
                      :size="10"
                      :class="{ up: sortDir === 'asc' }"
                    />
                  </th>
                  <th class="fc-th-id">ID</th>
                </tr>
              </thead>
              <WindowedTableBody
                :ref="body => setTableBody(p.id, body)"
                :items="list"
                :columns="5"
                :pinned-key="renaming"
                :reset-key="JSON.stringify([p.path.map(part => part.id), p.filter, sortField, sortDir])"
              >
                <template #sizing>
                  <td />
                  <td>{{ tableSizes.get(p.id)?.[1] }}</td>
                  <td>{{ tableSizes.get(p.id)?.[2] }}</td>
                  <td>{{ tableSizes.get(p.id)?.[3] }}</td>
                  <td class="fc-td-id">{{ tableSizes.get(p.id)?.[4] }}</td>
                </template>
                <template #default="{ item, index }">
                <tr
                  :key="item.key"
                  :data-key="item.key"
                  :aria-rowindex="index + 2"
                  class="fc-item"
                  :aria-label="item.name"
                  :aria-selected="p.selected.includes(item.key)"
                  :class="{
                    selected: p.selected.includes(item.key),
                    'drop-target': dropFolder === item.key,
                  }"
                  :draggable="renaming !== item.key && Number(item.id) > 0"
                  @click="selectItem($event, item)"
                  @dblclick="openItem(item)"
                  @mousedown.middle.prevent="openInNewTab(item)"
                  @contextmenu.prevent.stop="itemMenu($event, item)"
                  @dragstart="itemDragStart($event, item)"
                  @dragover="folderDragOver($event, item)"
                  @dragleave="dropFolder = ''"
                  @drop.prevent.stop="dropOnFolder($event, item, p)"
                >
                  <td class="fc-td-name">
                    <Icon :name="itemIcon(item)" :size="14" :class="iconTone(item)" />
                    <input
                      v-if="renaming === item.key"
                      v-model="renameValue"
                      class="fc-rename"
                      aria-label="New name"
                      @keydown.enter.stop="commitRename(item)"
                      @keydown.esc.stop="cancelRename"
                      @blur="cancelRename"
                      @click.stop
                      @dblclick.stop
                    />
                    <span v-else>{{ item.name }}</span>
                  </td>
                  <td>{{ item.type === "folder" ? "Folder" : item.filetype || "—" }}</td>
                  <td>
                    {{
                      item.type === "folder"
                        ? folderSize(item.foldersize)
                        : fileSize(item.filesize)
                    }}
                  </td>
                  <td>{{ item.lastmodifieddate || "—" }}</td>
                  <td class="fc-td-id">{{ item.id }}</td>
                </tr>
                </template>
              </WindowedTableBody>
            </table>
          </div>
          <div class="fc-status">
            <span
              >{{ list.filter((i) => i.type === "folder").length }} folder{{ list.filter((i) => i.type === "folder").length === 1 ? "" : "s" }},
              {{ list.filter((i) => i.type === "file").length }} file{{ list.filter((i) => i.type === "file").length === 1 ? "" : "s" }}</span
            >
            <span v-if="selectedOf(p, list).length"
              >{{ selectedOf(p, list).length }} selected</span
            >
            <div class="fc-spacer" />
            <button
              v-if="selectedOf(p, list).length > 1"
              class="danger"
              @click="
                confirmDelete(selectedOf(p, list).filter((i) => Number(i.id) > 0))
              "
            >
              <Icon name="trash" :size="12" /> Delete
              {{ selectedOf(p, list).length }} Items
            </button>
          </div>
        </template>
      </div>
    </div>
    <aside
      v-if="p.detail && !p.preview"
      class="fc-detail"
      :style="{ width: detailWidth + 'px' }"
    >
      <div
        class="fc-detail-resize"
        role="separator"
        aria-label="Resize details"
        @pointerdown.prevent="startDetailResize"
      />
      <div class="fc-detail-head">
        <Icon
          :name="itemIcon(p.detail)"
          :size="15"
          :class="iconTone(p.detail)"
        />
        <h3>{{ p.detail.name }}</h3>
        <button
          :aria-label="
            isBookmarked(p.detail.id, p.detail.type)
              ? 'Remove bookmark'
              : 'Add bookmark'
          "
          :aria-pressed="isBookmarked(p.detail.id, p.detail.type)"
          @click="
            toggleBookmark(
              p.detail,
              p.detail.type,
              itemPath(p.detail),
            )
          "
        >
          <Icon name="star" :size="13" /></button
        ><button aria-label="Close details" @click="p.detail = null">
          <Icon name="close" :size="13" />
        </button>
      </div>
      <div class="fc-detail-body">
        <div
          v-if="p.detail.type === 'file' && detailPreviewOf(p)"
          class="fc-detail-preview"
        >
          <img
            v-if="detailPreviewOf(p)!.image"
            :src="detailPreviewOf(p)!.image"
            :alt="p.detail.name"
          />
          <pre v-else-if="detailPreviewOf(p)!.text != null">{{ detailPreviewOf(p)!.text }}</pre>
          <p v-else-if="detailPreviewOf(p)!.error" class="fc-hint">
            No preview available
          </p>
          <p v-else class="fc-hint"><span class="fc-spinner" />Loading preview…</p>
        </div>
        <div class="fc-detail-actions">
          <button class="primary" @click="openItem(p.detail)">
            <Icon
              :name="p.detail.type === 'folder' ? 'folder-open' : 'file'"
              :size="13"
            />
            {{ p.detail.type === "folder" ? "Open Folder" : "Open File" }}
          </button>
          <button
            v-if="p.detail.type === 'file'"
            @click="downloadItem(p.detail)"
          >
            <Icon name="download" :size="13" /> Download
          </button>
        </div>
        <dl class="fc-fields">
          <dt>Type</dt>
          <dd>
            {{
              p.detail.type === "folder"
                ? "Folder"
                : p.detail.filetype || "—"
            }}
          </dd>
          <dt>Size</dt>
          <dd>
            {{
              p.detail.type === "folder"
                ? folderSize(p.detail.foldersize)
                : fileSize(p.detail.filesize)
            }}
          </dd>
          <dt>Modified</dt>
          <dd>{{ p.detail.lastmodifieddate || "—" }}</dd>
          <template v-if="p.detail.createddate">
            <dt>Created</dt>
            <dd>{{ p.detail.createddate }}</dd>
          </template>
          <dt>Internal ID</dt>
          <dd>{{ p.detail.id }}</dd>
          <template v-if="p.detail.type === 'folder'">
            <dt>Files</dt>
            <dd>{{ p.detail.numfolderfiles ?? 0 }}</dd>
          </template>
          <template v-if="p.detail.description">
            <dt>Description</dt>
            <dd>{{ p.detail.description }}</dd>
          </template>
          <template v-if="openRecord">
            <dt>Open in NetSuite</dt>
            <dd>
              <button
                class="link"
                @click="openRecord(p.detail.type, p.detail.id)"
              >
                {{
                  p.detail.type === "file" ? "Edit File" : "Edit Folder"
                }}
                <Icon name="external" :size="11" />
              </button>
            </dd>
          </template>
        </dl>
      </div>
    </aside>
    </div></template></template></template>
    </SplitTabs>
    <div
      v-if="contextMenu"
      class="fc-context-menu"
      role="menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
    >
      <button
        v-for="action in contextMenu.actions"
        :key="action.label"
        role="menuitem"
        :class="{ danger: action.danger }"
        @click="runAction(action)"
      >
        <Icon :name="action.icon" :size="13" />{{ action.label }}
      </button>
    </div>
    <div
      v-if="dialog"
      class="fc-dialog-overlay"
      @click.self="
        !('busy' in dialog && dialog.busy) && (dialog = null)
      "
    >
      <form
        v-if="dialog.kind === 'folder'"
        class="fc-dialog"
        role="dialog"
        aria-label="New Folder"
        @submit.prevent="createFolder"
      >
        <h3><Icon name="folder" :size="15" class="tone-folder" /> New Folder</h3>
        <p>
          Create a new folder inside <strong>{{ selectedFolder?.name }}</strong>.
        </p>
        <input
          v-model="dialog.name"
          aria-label="New folder name"
          placeholder="Folder name"
          maxlength="200"
        />
        <div class="fc-dialog-actions">
          <button type="button" @click="dialog = null">Cancel</button
          ><button class="primary" :disabled="!dialog.name.trim() || dialog.busy">
            {{ dialog.busy ? "Creating…" : "Create" }}
          </button>
        </div>
      </form>
      <form
        v-else-if="dialog.kind === 'file'"
        class="fc-dialog"
        role="dialog"
        aria-label="New File"
        @submit.prevent="createFile"
      >
        <h3><Icon name="file" :size="15" /> New File</h3>
        <p>
          Create a text file inside <strong>{{ selectedFolder?.name }}</strong>.
        </p>
        <div class="fc-dialog-row">
          <input
            v-model="dialog.name"
            aria-label="New file name"
            placeholder="File name"
            maxlength="200"
          /><select v-model="dialog.extension" aria-label="File type">
            <option v-for="ext in NEW_FILE_TYPES" :key="ext" :value="ext">
              {{ ext }}
            </option>
          </select>
        </div>
        <p v-if="newFileName" class="fc-hint">
          Will create <strong>{{ newFileName }}</strong>
        </p>
        <textarea
          v-model="dialog.content"
          aria-label="Initial content"
          placeholder="Initial content (optional)"
          rows="6"
        />
        <div class="fc-dialog-actions">
          <button type="button" @click="dialog = null">Cancel</button
          ><button class="primary" :disabled="!newFileName || dialog.busy">
            {{ dialog.busy ? "Creating…" : "Create" }}
          </button>
        </div>
      </form>
      <div
        v-else-if="dialog.kind === 'delete'"
        class="fc-dialog"
        role="dialog"
        aria-label="Delete"
      >
        <h3 class="danger">
          <Icon name="alert" :size="15" />
          {{
            dialog.items.length === 1
              ? `Delete ${dialog.items[0]!.type === "folder" ? "Folder" : "File"}`
              : `Delete ${dialog.items.length} Items`
          }}
        </h3>
        <p v-if="dialog.items.length === 1">
          Are you sure you want to delete
          <strong>{{ dialog.items[0]!.name }}</strong>?
        </p>
        <template v-else>
          <p>
            Are you sure you want to delete
            <strong>{{ dialog.items.length }}</strong> items?
          </p>
          <ul>
            <li v-for="i in dialog.items.slice(0, 8)" :key="i.key">
              <Icon :name="itemIcon(i)" :size="12" /> {{ i.name }}
            </li>
            <li v-if="dialog.items.length > 8" class="fc-hint">
              … and {{ dialog.items.length - 8 }} more
            </li>
          </ul>
        </template>
        <p class="fc-hint">
          Text file content is saved to trash for {{ TRASH_DAYS }} days. Binary
          files cannot be restored.
        </p>
        <p v-if="deleteWarning" class="fc-warning">{{ deleteWarning }}</p>
        <div class="fc-dialog-actions">
          <button :disabled="dialog.busy" @click="dialog = null">Cancel</button
          ><button
            class="danger-fill"
            :disabled="dialog.busy"
            @click="executeDelete"
          >
            <Icon name="trash" :size="12" />
            {{ dialog.busy ? "Deleting…" : "Delete" }}
          </button>
        </div>
      </div>
      <div
        v-else-if="dialog.kind === 'move'"
        class="fc-dialog"
        role="dialog"
        aria-label="Move"
      >
        <h3>
          <Icon name="move" :size="15" />
          {{
            dialog.items.length === 1
              ? `Move ${dialog.items[0]!.type === "folder" ? "Folder" : "File"}`
              : `Move ${dialog.items.length} Items`
          }}
        </h3>
        <p>
          Move
          <strong>{{
            dialog.items.length === 1
              ? dialog.items[0]!.name
              : `${dialog.items.length} items`
          }}</strong>
          into <strong>{{ dialog.target.name }}</strong>?
        </p>
        <ul v-if="dialog.items.length > 1">
          <li v-for="i in dialog.items.slice(0, 8)" :key="i.key">
            <Icon :name="itemIcon(i)" :size="12" /> {{ i.name }}
          </li>
        </ul>
        <div class="fc-dialog-actions">
          <button :disabled="dialog.busy" @click="dialog = null">Cancel</button
          ><button class="primary" :disabled="dialog.busy" @click="executeMove">
            {{ dialog.busy ? "Moving…" : "Move" }}
          </button>
        </div>
      </div>
      <div
        v-else-if="dialog.kind === 'scripts'"
        class="fc-dialog"
        role="dialog"
        aria-label="Referencing Scripts"
      >
        <h3><Icon name="code" :size="15" /> Referencing Scripts</h3>
        <p>
          <strong>{{ dialog.file.name }}</strong>
          <code>#{{ dialog.file.id }}</code>
        </p>
        <p v-if="dialog.loading" class="fc-hint">
          <span class="fc-spinner" />Loading…
        </p>
        <p v-else-if="dialog.error" class="fc-warning">{{ dialog.error }}</p>
        <p v-else-if="!dialog.rows.length" class="fc-hint">
          No script records use this file.
        </p>
        <div v-for="s in dialog.rows" v-else :key="s.id" class="fc-script-ref">
          <div>
            <strong>{{ s.name || s.scriptid }}</strong>
            <small>{{ s.scriptid }} · {{ s.scripttype || "Script" }}</small>
          </div>
          <button
            v-if="openRecord"
            :aria-label="`Open ${s.name} in NetSuite`"
            @click="openRecord('script', s.id)"
          >
            <Icon name="external" :size="13" />
          </button>
        </div>
        <div class="fc-dialog-actions">
          <button @click="dialog = null">Close</button>
        </div>
      </div>
    </div>
    <div class="fc-toasts" aria-live="polite">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="fc-toast"
        :class="{ error: t.error }"
      >
        {{ t.text }}
      </div>
    </div>
  </section>
</template>
<style scoped>
.fc-workspace {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.fc-sidebar {
  width: 200px;
  flex: none;
  border-right: 1px solid #dce5e9;
  padding: 12px 10px;
  overflow: auto;
}
.fc-sidebar.collapsed {
  width: 38px;
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
}
.fc-sidebar.collapsed button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  color: #607583;
}
.fc-sidebar h2 {
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #718591;
  margin: 0;
}
.fc-side-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 0 6px;
}
.fc-side-heading:first-child {
  margin-top: 0;
}
.fc-side-heading > button {
  display: grid;
  place-items: center;
  padding: 3px;
  border-radius: 3px;
  color: #718591;
}
.fc-side-heading > .fc-collapse {
  display: flex;
  align-items: center;
  gap: 5px;
}
.fc-badge {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 9px;
  background: #dbe8ee;
  color: #4a6676;
  font-size: 10px;
  line-height: 16px;
}
.fc-collapse .fc-badge {
  margin-left: 4px;
}
.fc-info {
  margin-top: 14px;
}
.fc-info h2 {
  margin-bottom: 6px;
}
.fc-info dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 8px;
  margin: 0;
  font-size: 11px;
}
.fc-info dt {
  color: #8798a3;
}
.fc-info dd {
  margin: 0;
  color: #455968;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fc-tree-filter {
  width: 100%;
  min-width: 0;
  padding: 7px 8px;
  border: 0;
  border-radius: 4px;
  background: #eaf1f4;
  color: inherit;
  margin-bottom: 6px;
}
.fc-side-link,
.fc-bookmark button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #455968;
  cursor: pointer;
}
.fc-side-link:hover,
.fc-side-link[aria-pressed="true"],
.fc-bookmark button:hover {
  background: #e9f1f4;
}
.fc-bookmark {
  display: flex;
}
.fc-bookmark.missing button:first-child {
  color: #a5605d;
  text-decoration: line-through;
}
.fc-bookmark button:first-child {
  flex: 1;
  min-width: 0;
}
.fc-bookmark button:first-child span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-bookmark button:last-child {
  width: auto;
  opacity: 0;
}
.fc-bookmark:hover button:last-child {
  opacity: 1;
}
.fc-hint.fc-warn {
  color: #a5603d;
}
.fc-hint {
  color: #718591;
  line-height: 1.5;
  font-size: 12px;
}
.fc-main {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.fc-split {
  flex: 1;
  min-width: 0;
}
.fc-pane {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  container-type: inline-size;
}
/* Narrow split panes keep the list usable: no detail panel under the cursor. */
@container (max-width: 640px) {
  .fc-pane .fc-detail {
    display: none;
  }
}
.fc-breadcrumb {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 6px 10px;
  border-bottom: 1px solid #e2eaee;
  white-space: nowrap;
  overflow-x: auto;
}
.fc-breadcrumb > button,
.fc-breadcrumb .fc-seg button,
.fc-search button {
  display: flex;
  align-items: center;
  gap: 3px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: #547589;
  padding: 5px 6px;
  cursor: pointer;
}
.fc-breadcrumb > button:hover,
.fc-breadcrumb button[aria-pressed="true"] {
  background: #e3edf2;
}
.fc-breadcrumb .current {
  color: #2f4856;
  font-weight: 600;
}
.fc-sep {
  color: #a5b4bd;
}
.fc-filter {
  width: 170px;
  border: 0;
  background: #edf3f6;
  color: inherit;
  padding: 6px 8px;
  border-radius: 5px;
  margin: 0 4px;
}
.fc-seg {
  display: flex;
  margin-left: 4px;
  padding: 2px;
  border-radius: 5px;
  background: #edf3f6;
}
.fc-spacer {
  flex: 1;
}
.spin {
  animation: fc-spin 0.8s linear infinite;
}
@keyframes fc-spin {
  to {
    transform: rotate(360deg);
  }
}
.fc-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 7px;
  border: 2px solid #c7d6dd;
  border-top-color: #557a8e;
  border-radius: 50%;
  vertical-align: -2px;
  animation: fc-spin 0.8s linear infinite;
}
.fc-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid #e2eaee;
  color: #718591;
}
.fc-search input {
  flex: 1;
  min-width: 80px;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 5px 0;
}
.fc-search input:focus {
  outline: none;
}
.fc-search-results {
  display: flex;
  flex-direction: column;
  max-height: 220px;
  overflow: auto;
  padding: 4px 8px;
  border-bottom: 1px solid #e2eaee;
  background: #f5f8f9;
}
.fc-search-results > .fc-hint {
  padding: 6px;
}
.fc-result {
  display: flex;
  border-radius: 4px;
}
.fc-result:hover {
  background: #e8f0f4;
}
.fc-result button:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 7px 8px;
  color: inherit;
}
.fc-result button:first-child span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-result small {
  margin-left: auto;
  color: #8798a3;
  white-space: nowrap;
}
.fc-result button:last-child {
  padding: 0 8px;
  color: #a5b4bd;
}
.fc-result button[aria-pressed="true"],
.fc-detail-head button[aria-pressed="true"],
.fc-breadcrumb button[aria-label*="bookmark"][aria-pressed="true"] {
  color: #c99419;
}
.fc-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.fc-content,
.fc-preview {
  position: relative;
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.fc-content:focus {
  outline: none;
}
.fc-content.drag-over {
  box-shadow: inset 0 0 0 2px #6f9ab0;
}
.fc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.fc-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  font-weight: 600;
  color: #718591;
  padding: 7px 10px;
  background: #f7f9fa;
  border-bottom: 1px solid #e2eaee;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.fc-table th:hover {
  color: #455968;
}
.fc-table th :deep(svg) {
  margin-left: 4px;
  vertical-align: -1px;
}
.fc-table th .up {
  transform: rotate(-90deg);
}
.fc-th-name {
  width: 45%;
}
.fc-th-id {
  cursor: default !important;
}
.fc-table td {
  padding: 6px 10px;
  color: #4b6170;
  border-bottom: 1px solid #edf2f4;
  white-space: nowrap;
}
.fc-td-name {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 0;
  min-width: 100%;
}
.fc-td-name span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.fc-td-id {
  color: #8798a3 !important;
  font-variant-numeric: tabular-nums;
}
.fc-item {
  cursor: default;
  user-select: none;
}
.fc-item:hover {
  background: #f1f6f8;
}
.fc-item.selected {
  background: #dce9f0;
}
.fc-item.drop-target {
  background: #d3e6ef;
  box-shadow: inset 0 0 0 2px #6f9ab0;
}
.fc-rename {
  flex: 1;
  min-width: 0;
  padding: 2px 5px;
  border: 1px solid #6f9ab0;
  border-radius: 3px;
  font: inherit;
  color: inherit;
  background: #fff;
}
.fc-content.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
  align-content: start;
  padding: 10px;
}
.fc-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px 10px;
  border-radius: 6px;
  text-align: center;
  color: #455968;
}
.fc-tile span {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.fc-tile small {
  color: #8798a3;
  font-size: 11px;
}
.tone-folder {
  color: #d39b2a;
}
.tone-script {
  color: #6474c9;
}
.tone-js {
  color: #b48a12;
}
.tone-pdf {
  color: #c2463f;
}
.tone-image {
  color: #8a5cc0;
}
.tone-file {
  color: #8798a3;
}
.fc-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  min-height: 160px;
  color: #718591;
  text-align: center;
  padding: 20px;
}
.fc-state.error {
  color: #9b3835;
  white-space: pre-line;
}
.fc-state button,
.fc-dialog button,
.fc-status button,
.fc-edit-bar button,
.fc-trash button,
.fc-detail-actions button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 4px;
  border: 1px solid #cddbe2;
  background: #fff;
  color: #455968;
  font-size: 12px;
}
.primary {
  background: #4f7b93 !important;
  border-color: #4f7b93 !important;
  color: #fff !important;
}
.primary:disabled {
  opacity: 0.5;
}
.danger {
  color: #b2433e !important;
}
.danger-fill {
  background: #c24b45 !important;
  border-color: #c24b45 !important;
  color: #fff !important;
}
.fc-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f7f9fac9;
  color: #455968;
}
.fc-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #eef5f8e6;
  color: #4f7b93;
  pointer-events: none;
}
.fc-upload-bar {
  position: sticky;
  top: 0;
  z-index: 3;
  padding: 6px 12px;
  background: #e5eff4;
  color: #455968;
  font-size: 12px;
}
.fc-status {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 5px 12px;
  border-top: 1px solid #e2eaee;
  color: #718591;
  font-size: 11px;
  min-height: 30px;
}
.fc-status button {
  padding: 2px 8px;
  font-size: 11px;
}
.fc-preview {
  display: flex;
  flex-direction: column;
}
.fc-edit-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid #e2eaee;
}
.fc-edit-bar kbd {
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 3px;
  background: #ffffff33;
  font-size: 10px;
}
.fc-switch {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #455968;
  cursor: pointer;
  font-size: 12px;
}
.fc-switch input {
  position: absolute;
  opacity: 0;
}
.fc-switch span {
  position: relative;
  width: 28px;
  height: 16px;
  border-radius: 8px;
  background: #c5d3da;
  transition: background 0.15s;
}
.fc-switch span::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.fc-switch input:checked + span {
  background: #4f7b93;
}
.fc-switch input:checked + span::after {
  transform: translateX(12px);
}
.fc-switch input:focus-visible + span {
  outline: 2px solid #8ca7b5;
}
.fc-preview :deep(.file-editor) {
  flex: 1;
  height: auto;
}
.fc-media {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 16px;
  background: repeating-conic-gradient(#f1f4f6 0 25%, #fff 0 50%) 0 0 / 16px
    16px;
}
.fc-media img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.fc-media.pdf {
  padding: 0;
}
.fc-media iframe {
  width: 100%;
  height: 100%;
  border: 0;
}
.fc-trash {
  max-height: 45%;
  overflow: auto;
  border-bottom: 1px solid #dce5e9;
  background: #f7f9fa;
  padding: 8px 12px;
}
.fc-trash-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.fc-trash-head button:last-child {
  border: 0;
  background: none;
}
.fc-trash-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid #e8eef1;
  color: #455968;
}
.fc-trash-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-trash-row small {
  margin-right: auto;
  color: #8798a3;
}
.fc-detail {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid #dce5e9;
  background: #fbfcfd;
}
.fc-detail-resize {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}
.fc-detail-resize:hover {
  background: #8ca7b555;
}
.fc-detail-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #e2eaee;
}
.fc-detail-head h3 {
  flex: 1;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #2f4856;
  word-break: break-all;
}
.fc-detail-head button {
  padding: 2px;
  color: #8798a3;
}
.fc-detail-body {
  flex: 1;
  overflow: auto;
  padding: 10px 12px;
}
.fc-detail-preview {
  max-height: 300px;
  overflow: auto;
  border-radius: 5px;
  background: #eff4f6;
  margin-bottom: 10px;
}
.fc-detail-preview img {
  display: block;
  max-width: 100%;
  margin: 0 auto;
}
.fc-detail-preview pre {
  margin: 0;
  padding: 8px 10px;
  font:
    11px/1.5 Consolas,
    monospace;
  color: #344d5b;
  white-space: pre;
}
.fc-detail-preview .fc-hint {
  padding: 10px;
}
.fc-detail-actions {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}
.fc-detail-actions button {
  justify-content: center;
}
.fc-fields {
  display: grid;
  grid-template-columns: 1fr;
  gap: 2px;
  margin: 0;
  font-size: 12px;
}
.fc-fields dt {
  color: #8798a3;
  font-size: 11px;
  margin-top: 6px;
}
.fc-fields dd {
  margin: 0;
  color: #455968;
  word-break: break-word;
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  color: #3f7598;
}
.link:hover {
  text-decoration: underline;
}
.fc-context-menu {
  position: absolute;
  z-index: 30;
  width: 210px;
  padding: 4px;
  background: #fff;
  border: 1px solid #dce5e9;
  border-radius: 6px;
  box-shadow: 0 8px 22px #425c6b2e;
}
.fc-context-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 7px 9px;
  color: #455968;
  border-radius: 4px;
  font-size: 12px;
}
.fc-context-menu button:hover {
  background: #e8f0f4;
}
.fc-context-menu button.danger:hover {
  background: #f8e6e5;
}
.fc-dialog-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #2c3e4a40;
}
.fc-dialog {
  width: min(420px, calc(100% - 32px));
  max-height: calc(100% - 32px);
  overflow: auto;
  padding: 16px;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 14px 40px #2c3e4a40;
  color: #455968;
  font-size: 13px;
}
.fc-dialog h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 14px;
  color: #2f4856;
}
.fc-dialog p {
  margin: 0 0 10px;
}
.fc-dialog ul {
  margin: 0 0 10px;
  padding-left: 4px;
  list-style: none;
}
.fc-dialog li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.fc-dialog input,
.fc-dialog select,
.fc-dialog textarea {
  width: 100%;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid #cddbe2;
  border-radius: 4px;
  color: inherit;
  background: #fff;
  font: inherit;
  margin-bottom: 8px;
}
.fc-dialog textarea {
  font:
    12px/1.5 Consolas,
    monospace;
  resize: vertical;
}
.fc-dialog-row {
  display: flex;
  gap: 6px;
}
.fc-dialog-row select {
  width: 80px;
  flex: none;
}
.fc-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.fc-warning {
  padding: 7px 9px;
  border-radius: 4px;
  background: #eef4fb;
  color: #3f6489;
  font-size: 12px;
}
.fc-script-ref {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-top: 1px solid #edf2f4;
}
.fc-script-ref div {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.fc-script-ref small {
  color: #8798a3;
}
.fc-toasts {
  position: absolute;
  right: 14px;
  bottom: 40px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.fc-toast {
  max-width: 320px;
  padding: 8px 12px;
  border-radius: 6px;
  background: #2f4856;
  color: #fff;
  font-size: 12px;
  box-shadow: 0 6px 16px #2c3e4a33;
}
.fc-toast.error {
  background: #a5403b;
}
@media (max-width: 760px) {
  .fc-sidebar:not(.collapsed) {
    width: 150px;
  }
  .fc-detail {
    display: none;
  }
}
</style>
