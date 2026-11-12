import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenTree, treeWindow, TREE_ROW_HEIGHT } from "../src/components/notes/pageTree.ts";
import type { Page } from "../src/components/notes/types.ts";

const page = (id: string, parentId: string | null) =>
  ({ id, parentId, title: id }) as Page;
const pages = [
  page("a", null),
  page("a1", "a"),
  page("a2", "a"),
  page("a2x", "a2"),
  page("b", null),
];
const childrenOf = (parentId: string | null) =>
  pages.filter((item) => item.parentId === parentId);

test("the tree flattens in order and only descends into expanded pages", () => {
  const ids = (expanded: string[]) =>
    flattenTree(childrenOf, new Set(expanded)).map(
      (row) => `${row.depth}:${row.page.id}`,
    );
  assert.deepEqual(ids([]), ["0:a", "0:b"]);
  assert.deepEqual(ids(["a"]), ["0:a", "1:a1", "1:a2", "0:b"]);
  assert.deepEqual(ids(["a", "a2"]), ["0:a", "1:a1", "1:a2", "2:a2x", "0:b"]);
  // An expanded page under a collapsed one stays hidden.
  assert.deepEqual(ids(["a2"]), ["0:a", "0:b"]);
});

test("short lists mount every row; long lists mount the rows in view", () => {
  assert.deepEqual(treeWindow(100, 0, 400, 0), { start: 0, end: 100 });
  // Unmeasured (hidden) scrollers mount everything rather than nothing.
  assert.deepEqual(treeWindow(5000, 0, 0, 0), { start: 0, end: 5000 });
  const top = treeWindow(5000, 0, 280, 60);
  assert.equal(top.start, 0);
  assert.ok(top.end >= 10 && top.end <= 30);
  const middle = treeWindow(5000, 60 + 1000 * TREE_ROW_HEIGHT, 280, 60);
  assert.ok(middle.start <= 1000 && middle.start >= 980);
  assert.ok(middle.end >= 1010 && middle.end <= 1030);
  // Scrolled past the end (after pages were removed) clamps to the list.
  assert.deepEqual(treeWindow(200, 1e7, 280, 0), { start: 200, end: 200 });
});
