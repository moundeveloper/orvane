import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, disposePinia } from "pinia";
import { reactive } from "vue";
import {
  captureBlockSnapshot,
  cloneBlockRecords,
} from "../src/components/notes/blockSnapshots.ts";
import { createOwnedWorkspaceStore } from "../src/components/notes/stores/workspace.ts";
import type { Block } from "../src/components/notes/types.ts";

const block = (id: string, patch: Partial<Block> = {}): Block => ({
  id,
  pageId: "page",
  type: "paragraph",
  html: "Text",
  indent: 0,
  position: 0,
  createdAt: "2026-11-02",
  updatedAt: "2026-11-02",
  ...patch,
});

test("shared history records stay immutable while active fields, order and restored copies change", () => {
  const active = reactive([
    block("a"),
    block("b", {
      type: "image",
      html: "data:image/png;base64,fixture",
      caption: "Before",
      imageWidth: 75,
    }),
    block("c", { type: "todo", checked: false, indent: 1 }),
  ]);
  const first = captureBlockSnapshot(active);
  active[0]!.html = "Edited directly";
  active[1]!.caption = "After";
  active[2]!.checked = true;
  const second = captureBlockSnapshot(active, first);
  assert.equal(first[0]!.html, "Text");
  assert.equal(first[1]!.caption, "Before");
  assert.equal(first[2]!.checked, false);
  assert.equal(Reflect.set(first[0]!, "html", "corrupted"), false);
  const third = captureBlockSnapshot(active, second);
  assert.equal(third[0], second[0]);
  const restored = cloneBlockRecords(first);
  restored.reverse();
  restored[0]!.indent = 4;
  restored[1]!.imageWidth = 20;
  assert.equal(first[0]!.id, "a");
  assert.equal(first[2]!.indent, 1);
  assert.equal(first[1]!.imageWidth, 75);
  delete active[1]!.caption;
  const fourth = captureBlockSnapshot(active, third);
  assert.equal(Object.hasOwn(fourth[1]!, "caption"), false);
  assert.equal(third[1]!.caption, "After");
});

test("JSON-compatible copies preserve unknown nested fields without mutable history aliases", () => {
  const active = reactive([
    block("nested") as Block & {
      extra: { values: string[] };
      ignored?: unknown;
    },
  ]);
  active[0]!.extra = { values: ["before"] };
  active[0]!.ignored = undefined;
  const first = captureBlockSnapshot(active);
  active[0]!.extra.values.push("after");
  const restored = cloneBlockRecords(first) as typeof active;
  assert.deepEqual(restored[0]!.extra.values, ["before"]);
  restored[0]!.extra.values[0] = "restored mutation";
  assert.deepEqual((first[0] as any).extra.values, ["before"]);
  assert.equal(Object.isFrozen((first[0] as any).extra.values), true);
  assert.equal(Object.hasOwn(first[0]!, "ignored"), false);
  const unusual = JSON.parse('{"__proto__":"data","optional":null}') as Record<
    string,
    unknown
  >;
  const source = {
    ...block("odd"),
    ...unusual,
    checked: undefined,
    indent: -0,
    position: NaN,
  };
  assert.deepEqual(
    cloneBlockRecords([source]),
    JSON.parse(JSON.stringify([source])),
  );
  const scalarOnly = {
    ...block("scalar"),
    ...unusual,
    checked: undefined,
    indent: -0,
  };
  assert.deepEqual(
    cloneBlockRecords([scalarOnly]),
    JSON.parse(JSON.stringify([scalarOnly])),
  );
  assert.equal(
    Object.getPrototypeOf(cloneBlockRecords([scalarOnly])[0]!),
    Object.prototype,
  );
});

test("the actual store retains its 100-step limit, undo/redo ordering and divergent-edit semantics", async () => {
  const pinia = createPinia(),
    owned = createOwnedWorkspaceStore("history-test", pinia),
    store = owned.store;
  store.persistBlocks = async () => {};
  try {
    store.blocks = [
      block("a"),
      block("b", { type: "toggle", collapsed: false }),
    ];
    for (let i = 0; i < 105; i++) {
      store.snapshot();
      store.blocks[0]!.html = String(i);
    }
    assert.equal(store.undoStack.length, 100);
    for (let i = 0; i < 100; i++) await store.undo();
    assert.equal(store.blocks[0]!.html, "4");
    assert.equal(store.redoStack.length, 100);
    for (let i = 0; i < 100; i++) await store.redo();
    assert.equal(store.blocks[0]!.html, "104");
    await store.undo();
    store.snapshot();
    store.blocks[1]!.collapsed = true;
    assert.equal(store.redoStack.length, 0);
    await store.undo();
    assert.equal(store.blocks[0]!.html, "103");
    assert.equal(store.blocks[1]!.collapsed, false);
    await store.redo();
    assert.equal(store.blocks[1]!.collapsed, true);
    assert.ok(store.undoStack.every((snapshot) => Object.isFrozen(snapshot)));
  } finally {
    owned.dispose();
    disposePinia(pinia);
  }
});
