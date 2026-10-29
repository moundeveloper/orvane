import type { Block, Page, Settings } from "./types";
type Row = Block | Page | Settings;
let pending: Promise<unknown> = Promise.resolve();
async function request<T>(payload: Record<string, unknown>): Promise<T> {
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
  const result = pending.then(run, run);
  pending = result.catch(() => {});
  return result;
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
