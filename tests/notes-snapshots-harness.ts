import {
  createPinia,
  disposePinia,
  getActivePinia,
  setActivePinia,
} from "pinia";
import { toRaw } from "vue";
import { createOwnedWorkspaceStore } from "../src/components/notes/stores/workspace";
import type { Block, Page } from "../src/components/notes/types";

export function notesBlocks(pageId: string, count: number): Block[] {
  const timestamp = "2026-11-02T12:00:00.000Z";
  return Array.from({ length: count }, (_, i) => ({
    id: `${pageId}:${i}`,
    pageId,
    type: "paragraph",
    html: i === count - 1 ? "" : `<p>${"x".repeat(1024)}</p>`,
    indent: 0,
    position: i,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}
export async function profileNotesSnapshots(count = 1000, steps = 100) {
  const previousPinia = getActivePinia(),
    pinia = createPinia();
  const owned = createOwnedWorkspaceStore("snapshot-profile", pinia),
    store = owned.store;
  const pageId = "snapshot-profile";
  const originalStringify = JSON.stringify,
    originalParse = JSON.parse,
    originalFetch = window.fetch;
  let arrays = 0,
    characters = 0,
    parsedArrays = 0,
    writes = 0;
  const reset = () => {
    arrays = 0;
    characters = 0;
    parsedArrays = 0;
    writes = 0;
  };
  const stats = () => ({
    documentSerializations: arrays,
    serializedDocumentCharacters: characters,
    parsedDocuments: parsedArrays,
    blockPayloadSerializations: writes,
  });
  const isDocument = (value: any) =>
    Array.isArray(value) && value[0]?.pageId === pageId;
  JSON.stringify = function (value: any, ...args: any[]) {
    const text = (originalStringify as any)(value, ...args);
    if (isDocument(value)) {
      arrays++;
      characters += text.length;
    }
    if (value?.collection === "blocks" && value?.rows?.[0]?.pageId === pageId)
      writes++;
    return text;
  } as typeof JSON.stringify;
  JSON.parse = function (text: string, ...args: any[]) {
    const result = (originalParse as any)(text, ...args);
    if (isDocument(result)) parsedArrays++;
    return result;
  } as typeof JSON.parse;
  window.fetch = async (url, init) => {
    if (String(url) !== "/__orvane/notes/data") return originalFetch(url, init);
    return new Response("{}", {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    store.currentPageId = pageId;
    store.blocks = notesBlocks(pageId, count);
    store.pages = [
      {
        id: pageId,
        parentId: null,
        type: "page",
        title: "Fixture",
        icon: null,
        isFavorite: false,
        trashedAt: null,
        position: 0,
        createdAt: "2026-11-02",
        updatedAt: "2026-11-02",
      },
    ] as Page[];
    const initial = store.blocks[0]!.html;
    reset();
    for (let i = 0; i < steps; i++) {
      store.snapshot();
      store.blocks[0]!.html = `${initial}:${i}`;
    }
    const snapshots = {
      ...stats(),
      historyEntries: store.undoStack.length,
      uniqueHistoryBlockObjects: new Set(
        store.undoStack.flatMap((snapshot) =>
          snapshot.map((block) => toRaw(block)),
        ),
      ).size,
    };
    reset();
    await store.persistBlocks();
    const persistence = stats();
    return { count, steps, snapshots, persistence };
  } finally {
    JSON.stringify = originalStringify;
    JSON.parse = originalParse;
    window.fetch = originalFetch;
    owned.dispose();
    disposePinia(pinia);
    setActivePinia(previousPinia);
  }
}

export async function exerciseNotesSnapshotHistory() {
  const { db } = await import("../src/components/notes/db");
  const previous = getActivePinia(),
    pinia = createPinia();
  const pageId = "history-page",
    otherPageId = "history-other";
  const pages = [pageId, otherPageId].map((id, position) => ({
    id,
    parentId: null,
    type: "page" as const,
    title: id,
    icon: null,
    isFavorite: false,
    trashedAt: null,
    position,
    createdAt: "2026-11-02",
    updatedAt: "2026-11-02",
  }));
  const blocks = notesBlocks(pageId, 6);
  Object.assign(blocks[0]!, { html: "Initial" });
  Object.assign(blocks[1]!, {
    type: "toggle",
    html: "Parent",
    collapsed: false,
  });
  Object.assign(blocks[2]!, {
    type: "todo",
    html: "Child",
    indent: 1,
    checked: false,
  });
  Object.assign(blocks[3]!, {
    type: "image",
    html: "data:image/png;base64,fixture",
    caption: "Before",
    imageWidth: 80,
  });
  Object.assign(blocks[4]!, {
    type: "code",
    html: "const value = 1;",
    lang: "javascript",
  });
  const owned = [
    createOwnedWorkspaceStore("history-a", pinia),
    createOwnedWorkspaceStore("history-b", pinia),
  ];
  const a = owned[0]!.store,
    b = owned[1]!.store;
  try {
    await db.pages.bulkPut(pages);
    await db.blocks.bulkPut([...blocks, ...notesBlocks(otherPageId, 1)]);
    await Promise.all([a.load(), b.load()]);
    await Promise.all([a.openPage(pageId), b.openPage(pageId)]);
    a.snapshot();
    a.blocks[0]!.type = "heading1";
    await a.persistBlocks();
    a.snapshot();
    a.blocks[2]!.checked = true;
    a.blocks[3]!.caption = "After";
    a.blocks[3]!.imageWidth = 60;
    await a.persistBlocks();
    const beforeMove = JSON.stringify(a.blocks);
    a.snapshot();
    await a.moveBlocks([1, 2], 5);
    const moved = JSON.stringify(a.blocks),
      movedOrder = a.blocks.map((block) => Number(block.id.split(":").at(-1)));
    await a.undo();
    const undoRestored = JSON.stringify(a.blocks) === beforeMove;
    await a.redo();
    const redoRestored = JSON.stringify(a.blocks) === moved;
    await a.undo();
    a.snapshot();
    await a.updateBlock(a.blocks[0]!.id, { html: "Typing branch" });
    const branchClearedRedo = a.redoStack.length === 0;
    await a.undo();
    const undoBranch = a.blocks[0]!.html;
    await a.redo();
    const redoBranch = a.blocks[0]!.html;
    await b.refreshBlocks(pageId);
    b.snapshot();
    b.blocks[3]!.caption = "Second view";
    await b.persistBlocks();
    await a.refreshBlocks(pageId);
    const sharedUpdate = a.blocks[3]!.caption;
    await a.undo();
    const independentHistory =
      b.undoStack[0]![3]!.caption === "After" &&
      b.blocks[3]!.caption === "Second view" &&
      a.blocks[3]!.caption === "After";
    owned[0]!.dispose();
    const reopened = createOwnedWorkspaceStore("history-reopened", pinia);
    owned.push(reopened);
    await reopened.store.load();
    await reopened.store.openPage(pageId);
    const durable = {
      type: reopened.store.blocks[0]!.type,
      html: reopened.store.blocks[0]!.html,
      checked: reopened.store.blocks[2]!.checked,
      caption: reopened.store.blocks[3]!.caption,
      imageWidth: reopened.store.blocks[3]!.imageWidth,
      lang: reopened.store.blocks[4]!.lang,
    };
    await reopened.store.openPage(otherPageId);
    return {
      movedOrder,
      undoRestored,
      redoRestored,
      branchClearedRedo,
      undoBranch,
      redoBranch,
      sharedUpdate,
      independentHistory,
      durable,
      switchedPage: reopened.store.currentPageId,
      historyAfterSwitch: reopened.store.undoStack.length,
    };
  } finally {
    for (const view of owned) view.dispose();
    disposePinia(pinia);
    setActivePinia(previous);
  }
}

export async function exerciseQueuedNotesSnapshots() {
  const { db } = await import("../src/components/notes/db");
  const previous = getActivePinia(),
    pinia = createPinia(),
    owned = createOwnedWorkspaceStore("queued-notes", pinia),
    store = owned.store;
  const pageId = "queued-page",
    otherPageId = "queued-other";
  const pages = [pageId, otherPageId].map((id, position) => ({
    id,
    parentId: null,
    type: "page" as const,
    title: id,
    icon: null,
    isFavorite: false,
    trashedAt: null,
    position,
    createdAt: "2026-11-02",
    updatedAt: "2026-11-02",
  }));
  const original = window.fetch;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    start = new Promise<void>((resolve) => {
      started = resolve;
    });
  const calls: string[] = [];
  let fail = false;
  try {
    await db.pages.bulkPut(pages);
    await db.blocks.bulkPut([
      ...notesBlocks(pageId, 3),
      ...notesBlocks(otherPageId, 1),
    ]);
    await store.load();
    await store.openPage(pageId);
    store.blocks[0]!.html = "Captured before queue";
    (store.blocks[0] as any).extension = { values: [1] };
    window.fetch = async (url, init) => {
      if (String(url) !== "/__orvane/notes/data") return original(url, init);
      const payload = JSON.parse(String(init?.body));
      calls.push(
        `${payload.collection}:${payload.action}:${payload.pageId || payload.rows?.[0]?.id || payload.rows?.[0]?.key || ""}`,
      );
      if (
        payload.collection === "settings" &&
        payload.rows?.[0]?.key === "snapshot-blocker"
      ) {
        started();
        await gate;
      }
      if (fail && payload.action === "replaceBlocks") {
        fail = false;
        return new Response('{"error":"Fixture save failure"}', {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return original(url, init);
    };
    const blocker = db.settings.put({ key: "snapshot-blocker", value: 1 });
    await start;
    const saving = store.persistBlocks();
    store.blocks[0]!.html = "Mutated after queue";
    (store.blocks[0] as any).extension.values.push(2);
    store.currentPageId = otherPageId;
    store.blocks = notesBlocks(otherPageId, 1);
    release();
    await Promise.all([blocker, saving]);
    const queuedOrder = calls.slice();
    const saved = await db.blocks.where("pageId").equals(pageId).toArray();
    const captured = saved[0]!.html;
    const extension = structuredClone((saved[0] as any).extension);
    store.currentPageId = pageId;
    store.blocks = saved;
    store.blocks[0]!.html = "Retry value";
    fail = true;
    let failure = "";
    try {
      await store.persistBlocks();
    } catch (error) {
      failure = String(error);
    }
    await store.persistBlocks();
    const recovered = await db.blocks.where("pageId").equals(pageId).toArray();
    return {
      queuedOrder,
      captured,
      extension,
      failed: failure.includes("Fixture save failure"),
      recovered: recovered[0]!.html,
      otherDocument: (
        await db.blocks.where("pageId").equals(otherPageId).toArray()
      )[0]!.html,
    };
  } finally {
    release();
    window.fetch = original;
    owned.dispose();
    disposePinia(pinia);
    setActivePinia(previous);
  }
}
