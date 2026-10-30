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
  content: string;
  deletedAt: number;
};
export const TRASH_DAYS = 15;
// Total trash content kept per environment; oldest entries go first.
const TRASH_BUDGET = 20_000_000;
const db = new Dexie("orvane-netsuite-files");
db.version(1).stores({ drafts: "key, environment", trash: "id, environment" });
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
