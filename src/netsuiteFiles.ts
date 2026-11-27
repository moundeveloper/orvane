import Dexie from "dexie";
import { ref } from "vue";

// File Cabinet drafts and trash hold whole file contents. They live in their
// own IndexedDB store, shared by every File Cabinet tab, so typing never
// re-serializes or re-saves the workspace.
export type FileDraft = {
  environment: string;
  id: number;
  content: string;
  original: string;
};
export type TrashEntry = {
  id: string;
  environment: string;
  fileId: number;
  name: string;
  folder: { id: number; name: string };
  filetype: string;
  // Text content; for a folder (kind "folder") a JSON FolderSnapshot.
  content: string;
  deletedAt: number;
  kind?: "file" | "folder";
  files?: number;
  folders?: number;
};
// What a deleted folder held, as Magic NetSuite keeps it: text files with
// their content, other files by name only (they cannot be restored).
export type FolderSnapshot = {
  files: { name: string; filetype: string; content: string | null }[];
  folders: { name: string; snapshot: FolderSnapshot }[];
};
export const TRASH_DAYS = 15;
// Total trash content kept per environment; oldest entries go first.
const TRASH_BUDGET = 20_000_000;
const db = new Dexie("orvane-netsuite-files");
db.version(1).stores({ drafts: "key, environment", trash: "id, environment" });
db.version(2).stores({
  drafts: "key, environment",
  trash: "id, environment",
  versions: "id, file",
});
const draftKey = (d: { environment: string; id: number }) =>
  `${d.environment}|${d.id}`;
export const drafts = ref<FileDraft[]>([]),
  trash = ref<TrashEntry[]>([]),
  // Set when IndexedDB is unavailable: drafts then live only until reload.
  storageError = ref("");
let loading: Promise<void> | undefined;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function failed(error: unknown) {
  console.warn("File Cabinet drafts could not be stored.", error);
  storageError.value = error instanceof Error ? error.message : String(error);
}
const validDraft = (d: FileDraft) =>
  d &&
  typeof d.environment === "string" &&
  Number.isSafeInteger(d.id) &&
  typeof d.content === "string" &&
  typeof d.original === "string";
const validTrash = (t: TrashEntry) =>
  t &&
  typeof t.id === "string" &&
  typeof t.environment === "string" &&
  typeof t.content === "string" &&
  Number.isSafeInteger(t.folder?.id) &&
  t.deletedAt > Date.now() - TRASH_DAYS * 86400000;
export function loadFiles() {
  return (loading ||= (async () => {
    try {
      const [savedDrafts, savedTrash] = await Promise.all([
        db.table("drafts").toArray(),
        db.table("trash").toArray(),
      ]);
      // Keep anything added while loading.
      const known = new Set(drafts.value.map(draftKey));
      drafts.value.push(
        ...savedDrafts
          .map(({ key: _key, ...d }) => d as FileDraft)
          .filter((d) => validDraft(d) && !known.has(draftKey(d))),
      );
      const fresh = savedTrash.filter(validTrash),
        ids = new Set(trash.value.map((t) => t.id));
      trash.value.push(...fresh.filter((t) => !ids.has(t.id)));
      const expired = savedTrash
        .filter((t) => !fresh.includes(t))
        .map((t) => t.id);
      if (expired.length) await db.table("trash").bulkDelete(expired);
    } catch (e) {
      failed(e);
    }
  })());
}
// One-time move of drafts/trash that older versions kept inside block JSON.
export async function importLegacy(state: {
  fileDrafts?: unknown;
  fileTrash?: unknown;
}) {
  await loadFiles();
  const legacyDrafts = (
    Array.isArray(state.fileDrafts) ? state.fileDrafts : []
  ).filter(validDraft) as FileDraft[];
  for (const d of legacyDrafts)
    if (!findDraft(d.environment, d.id)) {
      drafts.value.push(d);
      writeDraft(d);
    }
  const legacyTrash = (
    Array.isArray(state.fileTrash) ? state.fileTrash : []
  ).filter(validTrash) as TrashEntry[];
  for (const t of legacyTrash)
    if (!trash.value.some((x) => x.id === t.id)) addTrash(t);
}
export function findDraft(environment: string, id: number) {
  return drafts.value.find((d) => d.environment === environment && d.id === id);
}
function writeDraft(draft: FileDraft) {
  const key = draftKey(draft);
  clearTimeout(timers.get(key));
  timers.delete(key);
  db.table("drafts")
    .put({ key, ...draft })
    .catch(failed);
}
// Typing updates the reactive draft at once and writes it at most every 300 ms.
export function updateDraft(draft: FileDraft) {
  if (!drafts.value.includes(draft)) drafts.value.push(draft);
  const key = draftKey(draft);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => writeDraft(draft), 300),
  );
}
export function removeDraft(environment: string, id: number) {
  const key = draftKey({ environment, id });
  clearTimeout(timers.get(key));
  timers.delete(key);
  drafts.value = drafts.value.filter(
    (d) => d.environment !== environment || d.id !== id,
  );
  db.table("drafts").delete(key).catch(failed);
}
export function addTrash(entry: TrashEntry) {
  trash.value.push(entry);
  db.table("trash").put(entry).catch(failed);
  const mine = trash.value
    .filter((t) => t.environment === entry.environment)
    .sort((a, b) => b.deletedAt - a.deletedAt);
  let total = 0;
  const over = mine.filter((t) => (total += t.content.length) > TRASH_BUDGET);
  if (over.length) removeTrash(over);
}
export function removeTrash(entries: TrashEntry[]) {
  const ids = new Set(entries.map((t) => t.id));
  trash.value = trash.value.filter((t) => !ids.has(t.id));
  db.table("trash").bulkDelete([...ids]).catch(failed);
}
// Flushes pending draft writes, e.g. before the window closes.
export function flushDrafts() {
  for (const key of [...timers.keys()]) {
    const draft = drafts.value.find((d) => draftKey(d) === key);
    if (draft) writeDraft(draft);
  }
}
if (typeof window !== "undefined")
  window.addEventListener("pagehide", flushDrafts);

// Local save history, ported from Magic NetSuite's file versions: before a
// save replaces a file's content in NetSuite, the content it replaced is kept
// here. At most VERSION_LIMIT per file and environment; the oldest goes first.
export type FileVersion = {
  id: string;
  environment: string;
  fileId: number;
  content: string;
  savedAt: number;
  lines: number;
  added: number;
  removed: number;
};
export const VERSION_LIMIT = 5;
// IndexedDB keeps the versions; this map serves reads and keeps them for the
// session when IndexedDB fails.
const versionCache = new Map<string, FileVersion[]>();
const fileKey = (environment: string, fileId: number) =>
  `${environment}|${fileId}`;
export async function listVersions(environment: string, fileId: number) {
  const key = fileKey(environment, fileId);
  if (!versionCache.has(key))
    try {
      const rows = (await db
        .table("versions")
        .where("file")
        .equals(key)
        .toArray()) as (FileVersion & { file: string })[];
      versionCache.set(
        key,
        rows.map(({ file: _file, ...v }) => v as FileVersion),
      );
    } catch (e) {
      failed(e);
      versionCache.set(key, versionCache.get(key) ?? []);
    }
  return [...versionCache.get(key)!].sort((a, b) => b.savedAt - a.savedAt);
}
export async function addVersion(
  environment: string,
  fileId: number,
  content: string,
  replacedBy: string,
) {
  const key = fileKey(environment, fileId),
    list = await listVersions(environment, fileId),
    delta = lineDelta(content, replacedBy),
    version: FileVersion = {
      id: `${key}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`,
      environment,
      fileId,
      content,
      savedAt: Date.now(),
      lines: content ? content.split("\n").length : 0,
      ...delta,
    };
  const kept = [version, ...list].slice(0, VERSION_LIMIT),
    dropped = list.filter((v) => !kept.includes(v));
  versionCache.set(key, kept);
  try {
    await db.table("versions").put({ ...version, file: key });
    if (dropped.length)
      await db.table("versions").bulkDelete(dropped.map((v) => v.id));
  } catch (e) {
    failed(e);
  }
  return kept;
}
export async function clearVersions(environment: string, fileId: number) {
  const key = fileKey(environment, fileId);
  versionCache.set(key, []);
  try {
    await db.table("versions").where("file").equals(key).delete();
  } catch (e) {
    failed(e);
  }
}
export async function removeVersion(version: FileVersion) {
  const key = fileKey(version.environment, version.fileId);
  versionCache.set(
    key,
    (await listVersions(version.environment, version.fileId)).filter(
      (v) => v.id !== version.id,
    ),
  );
  try {
    await db.table("versions").delete(version.id);
  } catch (e) {
    failed(e);
  }
}
// Lines added and removed going from `before` to `after`.
export function lineDelta(before: string, after: string) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA),
    y = b.slice(start, endB);
  let common = 0;
  if (x.length * y.length <= 4_000_000) {
    // Longest common subsequence, one row at a time.
    let row = new Array<number>(y.length + 1).fill(0);
    for (const line of x) {
      const next = new Array<number>(y.length + 1).fill(0);
      for (let j = 0; j < y.length; j++)
        next[j + 1] =
          line === y[j] ? row[j]! + 1 : Math.max(row[j + 1]!, next[j]!);
      row = next;
    }
    common = row[y.length]!;
  } else {
    // Too large to align: count lines that only one side has.
    const counts = new Map<string, number>();
    for (const line of x) counts.set(line, (counts.get(line) ?? 0) + 1);
    for (const line of y) {
      const n = counts.get(line) ?? 0;
      if (n) {
        common++;
        counts.set(line, n - 1);
      }
    }
  }
  return { added: y.length - common, removed: x.length - common };
}
