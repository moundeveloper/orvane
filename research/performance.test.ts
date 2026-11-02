import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";
import { createPinia, setActivePinia, disposePinia } from "pinia";
import { emptyWorkspace, type CanvasApp } from "../src/model.ts";
import { trackWorkspace } from "../src/workspaceTracking.ts";
import { sharedRead, invalidateReads } from "../src/sharedReads.ts";
import { db } from "../src/components/notes/db.ts";
import { createOwnedWorkspaceStore } from "../src/components/notes/stores/workspace.ts";
import { WorkspaceStorage } from "../src/storage.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
  value: new EventTarget(),
  configurable: true,
});

test("one-app edits do not traverse the other 49 apps; membership and metadata remain tracked", () => {
  let visits = 0,
    changes = 0;
  const workspace = reactive(emptyWorkspace());
  workspace.apps = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    x: 0,
    blocks: [
      {
        get value() {
          if (i) visits++;
          return "";
        },
      },
    ],
  })) as unknown as CanvasApp[];
  const tracker = trackWorkspace(workspace, () => changes++);
  visits = 0;
  workspace.apps[0]!.x++;
  assert.equal(visits, 0);
  assert.equal(changes, 1);
  tracker.pause();
  for (let i = 0; i < 25; i++) workspace.apps[0]!.x++;
  assert.equal(changes, 1);
  tracker.resume();
  assert.equal(changes, 2);
  assert.equal(visits, 0);
  const removed = workspace.apps.pop()!;
  const afterRemoval = changes;
  removed.x++;
  assert.equal(changes, afterRemoval);
  workspace.shortcuts.home = "z";
  assert.equal(changes, afterRemoval + 1);
  tracker.stop();
});

test("shared reads isolate subscriber cancellation, editable results, failures and invalidation", async () => {
  let resolve!: (value: { rows: number[] }) => void;
  let calls = 0;
  const run = () => {
    calls++;
    return new Promise<{ rows: number[] }>((r) => (resolve = r));
  };
  const abort = new AbortController();
  const first = sharedRead("test:read", run, abort.signal);
  const cancelled = assert.rejects(first, { name: "AbortError" });
  const second = sharedRead("test:read", run);
  const third = sharedRead("test:read", run);
  await tick();
  abort.abort();
  resolve({ rows: [1] });
  await cancelled;
  const [a, b] = await Promise.all([second, third]);
  a.rows.push(2);
  assert.deepEqual(b.rows, [1]);
  assert.equal(calls, 1);
  await assert.rejects(
    sharedRead("test:failure", async () => {
      throw Error("offline");
    }),
  );
  assert.equal(await sharedRead("test:failure", async () => 2), 2);
  const old = sharedRead("test:epoch", async () => {
    await tick();
    return 1;
  });
  invalidateReads("test:");
  assert.equal(await sharedRead("test:epoch", async () => 2), 2);
  assert.equal(await old, 1);
});

test("50 Notes subscribers share one read and retain independent editable records", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await tick();
    return json([{ id: "page", title: "Original" }]);
  };
  try {
    const pages = await Promise.all(
      Array.from({ length: 50 }, () => db.pages.toArray()),
    );
    assert.equal(calls, 1);
    pages[0]![0]!.title = "Local";
    assert.equal(pages[1]![0]!.title, "Original");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Notes parallel reads respect read/write barriers and recover after failed writes", async () => {
  const order: string[] = [];
  const releases: (() => void)[] = [];
  globalThis.fetch = async (_url, init) => {
    const p = JSON.parse(String(init!.body));
    const name = `${p.action}:${p.key ?? p.pageId ?? p.collection}`;
    order.push(name);
    if (p.action === "list") await new Promise<void>((r) => releases.push(r));
    return p.action === "put"
      ? json({ error: "failure" }, 500)
      : json(p.action === "get" ? { key: "later", value: 1 } : []);
  };
  try {
    const a = db.pages.toArray();
    const b = db.blocks.where("pageId").equals("a").toArray();
    const write = assert.rejects(
      db.settings.put({ key: "write", value: 1 }),
      /failure/,
    );
    const after = db.settings.get("later");
    await tick();
    assert.deepEqual(order, ["list:pages", "list:a"]);
    releases.forEach((r) => r());
    await Promise.all([a, b, write, after]);
    assert.deepEqual(order, [
      "list:pages",
      "list:a",
      "put:settings",
      "get:later",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("100 owned Notes close cycles remove state without disposing another view of the same tab", () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const surviving = createOwnedWorkspaceStore("same-tab", pinia);
  try {
    surviving.store.currentPageId = "surviving";
    for (let i = 0; i < 100; i++) {
      const owned = createOwnedWorkspaceStore("same-tab", pinia);
      owned.store.undoStack = [[]];
      owned.dispose();
      assert.equal(Object.keys(pinia.state.value).length, 1);
      assert.equal(surviving.store.currentPageId, "surviving");
    }
    surviving.dispose();
    assert.equal(Object.keys(pinia.state.value).length, 0);
  } finally {
    disposePinia(pinia);
  }
});

test("Notes ignores superseded page loads and attributes a pending save to its original page", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const owned = createOwnedWorkspaceStore("navigation", pinia);
  const ws = owned.store;
  let release!: () => void;
  const events: string[] = [];
  const onChange = (event: Event) => {
    const id = (event as CustomEvent).detail.blocksPageId;
    if (id) events.push(id);
  };
  window.addEventListener("magic-notes-workspace-changed", onChange);
  globalThis.fetch = async (_url, init) => {
    const p = JSON.parse(String(init!.body));
    if (p.action === "list" && p.pageId === "a")
      await new Promise<void>((r) => (release = r));
    return json(p.action === "list" ? [] : {});
  };
  try {
    const first = ws.openPage("a");
    await tick();
    const second = ws.openPage("b");
    await tick();
    release();
    await Promise.all([first, second]);
    assert.equal(ws.currentPageId, "b");
    assert.deepEqual(ws.recentIds, ["b"]);
    ws.currentPageId = "a";
    const save = ws.persistBlocks();
    ws.currentPageId = "b";
    await save;
    assert.deepEqual(events, ["a"]);
  } finally {
    window.removeEventListener("magic-notes-workspace-changed", onChange);
    owned.dispose();
    disposePinia(pinia);
    globalThis.fetch = originalFetch;
  }
});

test("ordinary pending saves coalesce before serialization; checkpoints remain distinct and ordered", async () => {
  const writes: any[] = [];
  let release!: () => void;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    writes.push(body);
    if (writes.length === 1) await new Promise<void>((r) => (release = r));
    return json({ revision: writes.length });
  };
  const store = new WorkspaceStorage(() => {});
  store.writer = true;
  try {
    const first = store.write(emptyWorkspace());
    await tick();
    const obsolete = emptyWorkspace();
    Object.defineProperty(obsolete, "toJSON", {
      value() {
        throw Error("superseded save was serialized");
      },
    });
    const second = store.write(obsolete);
    const latest = emptyWorkspace();
    latest.shortcuts.home = "z";
    const third = store.write(latest);
    assert.equal(second, third);
    const checkpoint = emptyWorkspace();
    checkpoint.shortcuts.home = "y";
    const imported = store.write(checkpoint, "Before import", emptyWorkspace());
    checkpoint.shortcuts.home = "x";
    const final = store.write(emptyWorkspace());
    release();
    await Promise.all([first, second, third, imported, final]);
    assert.equal(writes.length, 4);
    assert.deepEqual(
      writes.map((x) => x.expectedRevision),
      [0, 1, 2, 3],
    );
    assert.equal(writes[1].data.shortcuts.home, "z");
    assert.equal(writes[2].data.shortcuts.home, "y");
    assert.equal(writes[2].reason, "Before import");
    assert.ok(writes[2].snapshotBase);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("close synchronously captures the final pending workspace for the release beacon", async () => {
  const beacons: Blob[] = [];
  Object.defineProperty(globalThis.navigator, "sendBeacon", {
    configurable: true,
    value: (_url: string, blob: Blob) => {
      beacons.push(blob);
      return true;
    },
  });
  globalThis.fetch = async () => json({ revision: 1 });
  const store = new WorkspaceStorage(() => {});
  store.writer = true;
  try {
    const final = emptyWorkspace();
    final.shortcuts.home = "z";
    const save = store.write(final);
    await store.close();
    await assert.rejects(save, /read-only/);
    assert.equal(beacons.length, 1);
    assert.equal(JSON.parse(await beacons[0]!.text()).data.shortcuts.home, "z");
  } finally {
    globalThis.fetch = originalFetch;
    delete (navigator as any).sendBeacon;
  }
});

test("concurrent empty Notes startup seeds one welcome page", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const views = Array.from({ length: 12 }, (_, i) =>
    createOwnedWorkspaceStore(`startup-${i}`, pinia),
  );
  let adds = 0;
  globalThis.fetch = async (_url, init) => {
    const p = JSON.parse(String(init!.body));
    if (p.collection === "pages" && p.action === "add") adds++;
    return json(p.action === "list" ? [] : p.action === "get" ? null : {});
  };
  try {
    await Promise.all(views.map((view) => view.store.load()));
    assert.equal(adds, 1);
    assert.ok(
      views.every((view) => view.store.pages.length === 1 && view.store.loaded),
    );
    views[0]!.store.pages[0]!.title = "Local edit";
    assert.equal(views[1]!.store.pages[0]!.title, "Welcome to Notes");
  } finally {
    views.forEach((view) => view.dispose());
    disposePinia(pinia);
    globalThis.fetch = originalFetch;
  }
});

test("workspace save failures propagate and conflicts prevent later queued writes", async () => {
  const store = new WorkspaceStorage(() => {});
  store.writer = true;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? json({ error: "unavailable" }, 503)
      : calls === 3
        ? json({ error: "revision conflict" }, 409)
        : json({ revision: 1 });
  };
  try {
    await assert.rejects(store.write(emptyWorkspace()), /unavailable/);
    await store.write(emptyWorkspace());
    const conflict = store.write(emptyWorkspace());
    await assert.rejects(conflict, /revision conflict/);
    assert.equal(store.conflicted, true);
    assert.throws(() => store.write(emptyWorkspace()), /read-only/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stale Notes metadata responses cannot replace a newer local page edit', async () => {
  const pinia = createPinia(); setActivePinia(pinia);
  const owned = createOwnedWorkspaceStore('metadata-race', pinia);
  let release!: () => void;
  globalThis.fetch = async (_url, init) => {
    const p = JSON.parse(String(init!.body));
    if (p.action === 'list') {
      await new Promise<void>(r => release = r);
      return json([{id:'page',title:'Old'}]);
    }
    return json({});
  };
  try {
    owned.store.pages = [{id:'page',title:'Local'}] as any;
    const refresh = owned.store.refreshPages();
    await tick();
    const save = owned.store.savePage(owned.store.pages[0]!);
    release(); await Promise.all([refresh,save]);
    assert.equal(owned.store.pages[0]!.title, 'Local');
  } finally {owned.dispose();disposePinia(pinia);globalThis.fetch=originalFetch;}
});
