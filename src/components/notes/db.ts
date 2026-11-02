import type { Block, Page, Settings } from "./types";
type Row = Block | Page | Settings;
let pending: Promise<unknown> = Promise.resolve();
let writeBarrier: Promise<unknown> = pending;
const reads = new Map<string, Promise<unknown>>();
async function request<T>(payload: Record<string, unknown>): Promise<T> {
  const read = payload.action === "get" || payload.action === "list";
  const key = JSON.stringify(payload);
  if (read) {
    const existing = reads.get(key);
    if (existing) return structuredClone(await existing) as T;
  } else {
    // A read requested after a write must not join a pre-write response.
    reads.clear();
  }
  const run = async () => {
    const response = await fetch("/__orvane/notes/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      window.dispatchEvent(
        new CustomEvent("orvane-notes-error", { detail: data.error }),
      );
      throw Error(data.error || "Notes could not be saved.");
    }
    return data as T;
  };
  const result = (read ? writeBarrier : pending).then(run, run);
  if (!read) {
    pending = result.catch(() => {});
    writeBarrier = pending;
    return result;
  }
  // Unrelated reads in the same write epoch can run together. The next write
  // still waits for every earlier read, and later reads wait for that write.
  pending = Promise.allSettled([pending, result]).then(() => undefined);
  reads.set(key, result);
  try {
    // Each view owns its editable records and undo stack.
    return structuredClone(await result);
  } finally {
    if (reads.get(key) === result) reads.delete(key);
  }
}
class NotesTable<T extends Row> {
  constructor(private collection: "pages" | "blocks" | "settings") {}
  toArray() {
    return request<T[]>({ collection: this.collection, action: "list" });
  }
  get(key: string) {
    return request<T | undefined>({
      collection: this.collection,
      action: "get",
      key,
    });
  }
  put(row: T) {
    return request({ collection: this.collection, action: "put", rows: [row] });
  }
  add(row: T) {
    return request({ collection: this.collection, action: "add", rows: [row] });
  }
  bulkPut(rows: T[]) {
    return request({ collection: this.collection, action: "bulkPut", rows });
  }
  bulkAdd(rows: T[]) {
    return request({ collection: this.collection, action: "bulkAdd", rows });
  }
  delete(key: string) {
    return request({ collection: this.collection, action: "delete", key });
  }
  where(field: string) {
    if (field !== "pageId") throw Error("Unsupported notes index.");
    return {
      equals: (pageId: string) => ({
        toArray: () =>
          request<T[]>({ collection: this.collection, action: "list", pageId }),
        delete: () =>
          request({
            collection: this.collection,
            action: "deletePage",
            pageId,
          }),
      }),
    };
  }
}
export const db = {
  pages: new NotesTable<Page>("pages"),
  blocks: new NotesTable<Block>("blocks"),
  settings: new NotesTable<Settings>("settings"),
  replaceBlocks: (pageId: string, rows: Block[]) =>
    request({ collection: "blocks", action: "replaceBlocks", pageId, rows }),
};
export function uid() {
  return crypto.randomUUID();
}
export function now() {
  return new Date().toISOString();
}
