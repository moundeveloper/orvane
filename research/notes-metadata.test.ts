import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, disposePinia } from "pinia";
import { createOwnedWorkspaceStore } from "../src/components/notes/stores/workspace.ts";
import type { Page } from "../src/components/notes/types.ts";

const page = (
  id: string,
  parentId: string | null = null,
  position = 0,
): Page => ({
  id,
  parentId,
  position,
  type: "page",
  title: id,
  icon: null,
  isFavorite: false,
  trashedAt: null,
  createdAt: "2026-11-02",
  updatedAt: "2026-11-02",
});

test("child lookups track editable membership, parent, ordering, trash and replacements", () => {
  const pinia = createPinia();
  const owned = createOwnedWorkspaceStore("metadata", pinia);
  const ws = owned.store;
  const ids = (parent: string | null) =>
    ws.childrenOf(parent).map((page) => page.id);
  try {
    ws.pages = [
      page("a", null, 2),
      page("b", null, 1),
      page("c", "a"),
      page("d", null, 1),
    ];
    assert.deepEqual(ids(null), ["b", "d", "a"]); // Stable equal-position order.
    assert.deepEqual(ids("a"), ["c"]);
    assert.deepEqual(ids("missing"), []);
    ws.pages[0]!.position = 0;
    assert.deepEqual(ids(null), ["a", "b", "d"]);
    ws.pages[2]!.parentId = "b";
    assert.deepEqual(ids("a"), []);
    assert.deepEqual(ids("b"), ["c"]);
    ws.pages[1]!.trashedAt = "now";
    assert.deepEqual(ids(null), ["a", "d"]);
    ws.pages[1]!.trashedAt = null;
    assert.deepEqual(ids(null), ["a", "b", "d"]);
    ws.pages.push(page("e", "b", -1));
    assert.deepEqual(ids("b"), ["e", "c"]);
    ws.pages.splice(2, 1);
    assert.deepEqual(ids("b"), ["e"]);
    ws.pages = [page("replacement")];
    assert.deepEqual(ids(null), ["replacement"]);
    assert.deepEqual(ids("b"), []);
  } finally {
    owned.dispose();
    disposePinia(pinia);
  }
});

test("child arrays are detached, records stay editable and stores retain independent indices", () => {
  const pinia = createPinia();
  const first = createOwnedWorkspaceStore("first", pinia);
  const second = createOwnedWorkspaceStore("second", pinia);
  try {
    first.store.pages = [page("a"), page("b", null, 1)];
    second.store.pages = structuredClone(
      first.store.$state.pages.map((record) => ({ ...record })),
    );
    const children = first.store.childrenOf(null);
    children.reverse();
    children.pop();
    children.push(page("local"));
    assert.deepEqual(
      first.store.childrenOf(null).map((record) => record.id),
      ["a", "b"],
    );
    first.store.childrenOf(null)[0]!.title = "Edited";
    assert.equal(first.store.pages[0]!.title, "Edited");
    assert.equal(second.store.childrenOf(null)[0]!.title, "a");
    first.store.pages[0]!.parentId = "b";
    assert.equal(first.store.childrenOf(null).length, 1);
    assert.equal(second.store.childrenOf(null).length, 2);
    first.dispose();
    assert.equal(second.store.childrenOf(null).length, 2);
    assert.equal(Object.keys(pinia.state.value).length, 1);
  } finally {
    first.dispose();
    second.dispose();
    disposePinia(pinia);
  }
});

test("stable repeated lookups and metadata-only edits do not rescan parent fields", () => {
  const pinia = createPinia();
  const owned = createOwnedWorkspaceStore("counted", pinia);
  let reads = 0;
  try {
    owned.store.pages = Array.from({ length: 500 }, (_, i) => ({
      ...page(String(i)),
      get parentId() {
        reads++;
        return null;
      },
    }));
    for (let pass = 0; pass < 2; pass++) {
      assert.equal(owned.store.childrenOf(null).length, 500);
      for (let i = 0; i < 500; i++)
        assert.equal(owned.store.childrenOf(String(i)).length, 0);
    }
    assert.equal(reads, 500);
    reads = 0;
    owned.store.pages[0]!.title = "Rename";
    owned.store.pages[0]!.icon = "icon";
    owned.store.pages[0]!.isFavorite = true;
    owned.store.pages[0]!.updatedAt = "later";
    assert.equal(owned.store.childrenOf(null)[0]!.title, "Rename");
    assert.equal(reads, 0);
  } finally {
    owned.dispose();
    disposePinia(pinia);
  }
});
