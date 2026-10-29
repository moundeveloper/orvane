<script setup lang="ts">
import { useNotesPortal } from "../portal";
import DOMPurify from "dompurify";
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  type ComputedRef,
} from "vue";
import { useNotesWorkspace } from "../stores/workspace";
import type { Block, BlockType } from "../types";
import BlockItem from "./BlockItem.vue";
import SlashMenu from "./SlashMenu.vue";
import FloatingToolbar from "./FloatingToolbar.vue";

const ws = useNotesWorkspace();
const tabFocused = inject<ComputedRef<boolean>>("notesTabFocused");

const editorEl = ref<HTMLElement>();
const focusRequest = ref<{ id: string; at: "start" | "end" } | null>(null);
const slashState = ref<{
  blockId: string;
  x: number;
  y: number;
  anchorTop: number;
  query?: string;
} | null>(null);
const dragIndex = ref<number | null>(null);
const dragIndices = ref<number[]>([]);
const dropIndex = ref<number | null>(null);
const selectedIds = ref<string[]>([]);
const selectionDrag = ref<{
  active: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
}>({
  active: false,
  startX: 0,
  startY: 0,
  x: 0,
  y: 0,
});
let gutterSelection = false;
let textSelectionAnchor: { node: Node; offset: number } | null = null;
let textSelectionAnchorContent: HTMLElement | null = null;

/** blocks visible after collapsing toggles */
const visibleBlocks = computed(() => {
  const out: { block: Block; index: number }[] = [];
  let hideDeeperThan: number | null = null;
  ws.blocks.forEach((b, index) => {
    if (hideDeeperThan !== null) {
      if (b.indent > hideDeeperThan) return;
      hideDeeperThan = null;
    }
    out.push({ block: b, index });
    if (b.type === "toggle" && b.collapsed) hideDeeperThan = b.indent;
  });
  return out;
});

const slashQuery = computed(() => {
  if (!slashState.value) return "";
  if (slashState.value.query !== undefined) return slashState.value.query;
  const block = ws.blocks.find((b) => b.id === slashState.value?.blockId);
  const text = block ? stripHtmlForQuery(block.html) : "";
  const match = text.match(/\/([^/]*)$/);
  return match?.[1] ?? "";
});

const dropTarget = computed(
  (): { index: number; side: "before" | "after" } | null => {
    if (dropIndex.value === null) return null;
    const vis = visibleBlocks.value;
    if (!vis.length) return null;
    const before = vis.find((entry) => entry.index >= dropIndex.value!);
    if (before) return { index: before.index, side: "before" };
    return { index: vis[vis.length - 1]!.index, side: "after" };
  },
);

function stripHtmlForQuery(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(html);
  return div.textContent ?? "";
}

function requestFocus(id: string, at: "start" | "end" = "end") {
  focusRequest.value = null;
  nextTick(() => (focusRequest.value = { id, at }));
}

function onFocusApplied(request: { id: string; at: "start" | "end" }) {
  if (focusRequest.value === request) focusRequest.value = null;
}

function linkedPageId(block: Block): string | null {
  return block.html.match(/data-page-link="([^"]+)"/)?.[1] ?? null;
}

function clearSelected() {
  selectedIds.value = [];
}

function onSelectBlock(index: number, additive: boolean) {
  const block = ws.blocks[index];
  if (!block) return;
  if (additive) {
    selectedIds.value = selectedIds.value.includes(block.id)
      ? selectedIds.value.filter((id) => id !== block.id)
      : [...selectedIds.value, block.id];
  } else {
    selectedIds.value = [block.id];
  }
}

// ---- block operations ----

async function onEnter(index: number, htmlBefore: string, htmlAfter: string) {
  const cur = ws.blocks[index];
  if (!cur) return;
  ws.snapshot();
  cur.html = htmlBefore;
  // continue list types; empty list item converts to paragraph
  let type: BlockType = ["bulleted", "numbered", "todo", "toggle"].includes(
    cur.type,
  )
    ? cur.type
    : "paragraph";
  if (htmlBefore === "" && htmlAfter === "" && type !== "paragraph") {
    cur.type = "paragraph";
    await ws.persistBlocks();
    return;
  }
  const nb = ws.newBlock(type, htmlAfter, cur.indent);
  if (nb.type === "todo") nb.checked = cur.checked ?? false;
  await ws.insertBlock(index, nb);
  requestFocus(nb.id, "start");
}

async function onBackspaceAtStart(index: number) {
  const cur = ws.blocks[index];
  if (!cur) return;
  ws.snapshot();
  if (stripHtmlForQuery(cur.html).trim() === "") {
    if (ws.blocks.length === 1) {
      cur.type = "paragraph";
      cur.html = "";
      cur.indent = 0;
      await ws.persistBlocks();
      requestFocus(cur.id, "start");
      return;
    }
    await ws.removeBlock(index);
    const target = ws.blocks[Math.max(0, index - 1)] ?? ws.blocks[index];
    if (target) requestFocus(target.id, "end");
    return;
  }
  if (cur.type !== "paragraph") {
    // first backspace converts to paragraph
    cur.type = "paragraph";
    await ws.persistBlocks();
    requestFocus(cur.id, "start");
    return;
  }
  if (cur.indent > 0) {
    cur.indent--;
    await ws.persistBlocks();
    requestFocus(cur.id, "start");
    return;
  }
  if (index === 0) return;
  const prev = ws.blocks[index - 1];
  if (!prev) return;
  if (["divider", "image", "code"].includes(prev.type)) {
    if (cur.html === "") {
      await ws.removeBlock(index - 1);
      requestFocus(cur.id, "start");
    }
    return;
  }
  const mergePoint = prev.html.length;
  prev.html = prev.html + cur.html;
  await ws.removeBlock(index);
  await ws.updateBlock(prev.id, { html: prev.html });
  requestFocus(prev.id, mergePoint === 0 ? "start" : "end");
}

async function onDeleteBlock(index: number) {
  const pageId = linkedPageId(ws.blocks[index]!);
  if (pageId) await ws.trashPage(pageId);
  ws.snapshot();
  await ws.removeBlock(index);
  const target = ws.blocks[Math.max(0, index - 1)];
  if (target) requestFocus(target.id, "end");
}

async function deleteSelectedBlocks() {
  const indices = selectedIds.value
    .map((id) => ws.blocks.findIndex((b) => b.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => b - a);
  if (!indices.length) return;
  ws.snapshot();
  const focusIndex = Math.max(0, indices[indices.length - 1]! - 1);
  for (const index of indices) {
    const pageId = linkedPageId(ws.blocks[index]!);
    if (pageId) await ws.trashPage(pageId);
    await ws.removeBlock(index);
  }
  selectedIds.value = [];
  const target = ws.blocks[focusIndex] ?? ws.blocks[0];
  if (target) requestFocus(target.id, "end");
}

function onArrow(index: number, dir: "up" | "down") {
  const vis = visibleBlocks.value;
  const vi = vis.findIndex((v) => v.index === index);
  const next = dir === "up" ? vis[vi - 1] : vis[vi + 1];
  if (next) requestFocus(next.block.id, dir === "up" ? "end" : "start");
}

async function onIndent(index: number, delta: number) {
  const b = ws.blocks[index];
  if (!b) return;
  const maxIndent = index === 0 ? 0 : ws.blocks[index - 1]!.indent + 1;
  const ni = Math.max(0, Math.min(maxIndent, b.indent + delta));
  if (ni === b.indent) return;
  ws.snapshot();
  b.indent = ni;
  await ws.persistBlocks();
}

async function onMove(index: number, dir: -1 | 1) {
  ws.snapshot();
  await ws.moveBlock(index, index + dir);
}

async function onConvert(index: number, type: BlockType) {
  const b = ws.blocks[index];
  if (!b) return;
  ws.snapshot();
  b.type = type;
  if (type === "todo" && b.checked === undefined) b.checked = false;
  if (type === "callout" && !b.icon) b.icon = "💡";
  if (type === "divider") b.html = "";
  await ws.persistBlocks();
  requestFocus(b.id, "end");
}

async function onDuplicate(index: number) {
  const src = ws.blocks[index];
  if (!src) return;
  ws.snapshot();
  const copy = { ...JSON.parse(JSON.stringify(src)), id: crypto.randomUUID() };
  await ws.insertBlock(index, copy);
  requestFocus(copy.id, "end");
}

// ---- slash menu ----

const portal = useNotesPortal();
function onSlash(blockId: string, rect: DOMRect, query?: string) {
  const top = portal.local(rect.left, rect.top),
    bottom = portal.local(rect.left, rect.bottom);
  slashState.value = {
    blockId,
    x: top.x,
    y: bottom.y + 4,
    anchorTop: top.y,
    query,
  };
}

async function onSlashPick(type: BlockType | "page") {
  const st = slashState.value;
  slashState.value = null;
  if (!st) return;
  const index = ws.blocks.findIndex((b) => b.id === st.blockId);
  if (index < 0) return;
  const b = ws.blocks[index]!;
  b.html = stripTrailingSlashCommand(b.html);
  ws.snapshot();
  if (type === "page") {
    const sub = await ws.createPage(ws.currentPageId, "New page");
    b.type = "paragraph";
    b.html += `<a href="#/page/${sub.id}" data-page-link="${sub.id}"></a>&nbsp;`;
    await ws.persistBlocks();
    requestFocus(b.id, "end");
    return;
  }
  if (type === "image") {
    b.type = "image";
    b.html = "";
    await ws.persistBlocks();
    return;
  }
  b.type = type;
  if (type === "todo") b.checked = false;
  if (type === "callout" && !b.icon) b.icon = "💡";
  if (type === "divider") {
    b.html = "";
    const nb = ws.newBlock("paragraph", "", b.indent);
    await ws.insertBlock(index, nb);
    requestFocus(nb.id, "start");
  } else {
    requestFocus(b.id, "end");
  }
  await ws.persistBlocks();
}

function stripTrailingSlashCommand(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(html);
  for (let i = div.childNodes.length - 1; i >= 0; i--) {
    const node = div.childNodes[i]!;
    if (node.nodeType === Node.TEXT_NODE) {
      const next = node.textContent?.replace(/\/[^/]*$/, "") ?? "";
      node.textContent = next;
      break;
    }
    if (node.nodeName === "BR") continue;
    break;
  }
  return div.innerHTML.replace(/\/[^/]*$/, "");
}

// ---- drag & drop ----

function onDragStart(index: number, e: DragEvent) {
  dragIndex.value = index;
  const block = ws.blocks[index];
  dragIndices.value =
    block && selectedIds.value.includes(block.id)
      ? selectedIds.value
          .map((id) => ws.blocks.findIndex((b) => b.id === id))
          .filter((i) => i >= 0)
      : [index];
  e.dataTransfer?.setData("slate/block-id", block?.id ?? "");
  e.dataTransfer!.effectAllowed = "move";
  e.dataTransfer!.dropEffect = "move";
  document.addEventListener("dragenter", onDocumentDragOver, true);
  document.addEventListener("dragover", onDocumentDragOver, true);
  document.addEventListener("drop", onDocumentDrop, true);
}

function insertionIndexFromPointer(y: number): number | null {
  if (dragIndex.value === null) return null;
  const vis = visibleBlocks.value;
  if (!vis.length) return 0;
  for (const { block, index } of vis) {
    const el = editorEl.value?.querySelector<HTMLElement>(
      `[data-block-id="${block.id}"]`,
    );
    if (!el) continue;
    const content = el.querySelector<HTMLElement>(
      ".block-content, .blk-divider, .blk-image, .blk-main",
    );
    const rect = (content ?? el).getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return index;
  }
  return vis[vis.length - 1]!.index + 1;
}

function acceptBlockDrag(e: DragEvent): boolean {
  if (dragIndex.value === null) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  return true;
}

function onDragOver(_index: number, e: DragEvent) {
  if (!acceptBlockDrag(e)) return;
  dropIndex.value = insertionIndexFromPointer(e.clientY);
}

function onEditorDragOver(e: DragEvent) {
  if (!acceptBlockDrag(e)) return;
  dropIndex.value = insertionIndexFromPointer(e.clientY);
}

function isNearEditor(e: DragEvent): boolean {
  const rect = editorEl.value?.getBoundingClientRect();
  if (!rect) return true;
  return (
    e.clientX >= rect.left - 140 &&
    e.clientX <= rect.right + 220 &&
    e.clientY >= rect.top - 80 &&
    e.clientY <= rect.bottom + 180
  );
}

function onDocumentDragOver(e: DragEvent) {
  if (!acceptBlockDrag(e)) return;
  const nextIndex = isNearEditor(e)
    ? insertionIndexFromPointer(e.clientY)
    : null;
  if (nextIndex !== null) dropIndex.value = nextIndex;
}

function onDocumentDrop(e: DragEvent) {
  if (dragIndex.value === null) return;
  e.preventDefault();
  e.stopPropagation();
  if (dropIndex.value === null && isNearEditor(e)) {
    dropIndex.value = insertionIndexFromPointer(e.clientY);
  }
  void onDrop();
}

function resetDragState() {
  dragIndex.value = null;
  dragIndices.value = [];
  dropIndex.value = null;
  document.removeEventListener("dragenter", onDocumentDragOver, true);
  document.removeEventListener("dragover", onDocumentDragOver, true);
  document.removeEventListener("drop", onDocumentDrop, true);
}

async function onDrop() {
  if (dragIndex.value === null) return;
  if (dropIndex.value === null) {
    resetDragState();
    return;
  }
  const from = dragIndex.value;
  const to = dropIndex.value;
  const moving = dragIndices.value.length ? dragIndices.value : [from];
  resetDragState();
  const movingSet = new Set(moving);
  const sortedMoving = [...movingSet].sort((a, b) => a - b);
  const firstMoving = sortedMoving[0]!;
  const lastMoving = sortedMoving[sortedMoving.length - 1]!;
  if (
    to >= firstMoving &&
    to <= lastMoving + 1 &&
    sortedMoving.every((index, offset) => index === firstMoving + offset)
  ) {
    return;
  }
  ws.snapshot();
  await ws.moveBlocks(moving, to);
}

function onSelectionPointerDown(e: PointerEvent | MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (
    target.closest(
      '.menu, button, input, textarea, a, [contenteditable="true"], .blk-handle',
    )
  )
    return;
  stopSelectionDrag();
  gutterSelection = !!target.closest(".selection-gutter");
  selectionDrag.value = {
    active: true,
    startX: e.clientX,
    startY: e.clientY,
    x: e.clientX,
    y: e.clientY,
  };
  selectedIds.value = [];
  e.preventDefault();
  document.addEventListener("pointermove", onSelectionPointerMove);
  document.addEventListener("pointerup", stopSelectionDrag);
  document.addEventListener("pointercancel", stopSelectionDrag);
  window.addEventListener("blur", stopSelectionDrag);
}

async function focusFirstBlock() {
  let first = ws.blocks[0];
  if (!first && ws.currentPageId) {
    first = ws.newBlock();
    await ws.insertBlock(-1, first);
  }
  if (first) requestFocus(first.id, "start");
}

defineExpose({ startSelectionDrag: onSelectionPointerDown, focusFirstBlock });

function onSelectionPointerMove(e: PointerEvent | MouseEvent) {
  if (!selectionDrag.value.active) return;
  selectionDrag.value.x = e.clientX;
  selectionDrag.value.y = e.clientY;
  const rect = selectionRect.value;
  selectedIds.value = visibleBlocks.value
    .filter(({ block }) => {
      const el = editorEl.value?.querySelector<HTMLElement>(
        `[data-block-id="${block.id}"]`,
      );
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const verticallyOverlaps = rect.top < r.bottom && rect.bottom > r.top;
      return gutterSelection
        ? verticallyOverlaps
        : rect.left < r.right && rect.right > r.left && verticallyOverlaps;
    })
    .map(({ block }) => block.id);
}

function stopSelectionDrag() {
  selectionDrag.value.active = false;
  gutterSelection = false;
  document.removeEventListener("pointermove", onSelectionPointerMove);
  document.removeEventListener("pointerup", stopSelectionDrag);
  document.removeEventListener("pointercancel", stopSelectionDrag);
  window.removeEventListener("blur", stopSelectionDrag);
}

function caretAtPoint(
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = documentWithCaret.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = documentWithCaret.caretRangeFromPoint?.(x, y);
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}

function closestTextCaret(
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  if (!editorEl.value) return null;
  const contents = Array.from(
    editorEl.value.querySelectorAll<HTMLElement>(".block-content"),
  );
  const direct = caretAtPoint(x, y);
  if (
    direct &&
    contents.some(
      (content) => content === direct.node || content.contains(direct.node),
    )
  ) {
    return direct;
  }

  let closest: HTMLElement | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const content of contents) {
    const rect = content.getBoundingClientRect();
    const distance =
      y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (distance < closestDistance) {
      closest = content;
      closestDistance = distance;
    }
  }
  if (!closest) return null;

  const rect = closest.getBoundingClientRect();
  const caret = caretAtPoint(
    Math.max(rect.left + 1, Math.min(rect.right - 1, x)),
    Math.max(rect.top + 1, Math.min(rect.bottom - 1, y)),
  );
  if (caret && (closest === caret.node || closest.contains(caret.node)))
    return caret;

  const range = document.createRange();
  range.selectNodeContents(closest);
  range.collapse(y <= rect.top + rect.height / 2);
  return { node: range.startContainer, offset: range.startOffset };
}

function onTextSelectionPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  if (e.detail > 1) {
    stopTextSelectionTracking();
    return;
  }
  const content = (e.target as HTMLElement).closest<HTMLElement>(
    ".block-content",
  );
  if (!content) return;
  const caret = closestTextCaret(e.clientX, e.clientY);
  if (!caret) return;
  content.focus({ preventScroll: true });
  textSelectionAnchor = caret;
  textSelectionAnchorContent = content;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.setPosition(caret.node, caret.offset);
  e.preventDefault();
  document.addEventListener("pointermove", onTextSelectionPointerMove);
  document.addEventListener("pointerup", stopTextSelectionTracking);
  document.addEventListener("pointercancel", stopTextSelectionTracking);
}

function onTextDoubleClick(e: MouseEvent) {
  if (e.button !== 0) return;
  const content = (e.target as HTMLElement).closest<HTMLElement>(
    ".block-content",
  );
  if (!content) return;
  const caret = caretAtPoint(e.clientX, e.clientY);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return;

  const text = caret.node.textContent ?? "";
  if (!text) return;
  const isWordCharacter = (character: string) =>
    /[\p{L}\p{M}\p{N}_'-]/u.test(character);
  let offset = Math.min(caret.offset, text.length - 1);
  if (
    !isWordCharacter(text[offset] ?? "") &&
    offset > 0 &&
    isWordCharacter(text[offset - 1] ?? "")
  ) {
    offset--;
  }
  if (!isWordCharacter(text[offset] ?? "")) return;

  let start = offset;
  let end = offset + 1;
  while (start > 0 && isWordCharacter(text[start - 1] ?? "")) start--;
  while (end < text.length && isWordCharacter(text[end] ?? "")) end++;

  stopTextSelectionTracking();
  content.focus();
  const range = document.createRange();
  range.setStart(caret.node, start);
  range.setEnd(caret.node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  e.preventDefault();
  e.stopPropagation();
}

function onTextSelectionPointerMove(e: PointerEvent) {
  if (!textSelectionAnchor || !(e.buttons & 1)) return;
  const caret = closestTextCaret(e.clientX, e.clientY);
  if (!caret) return;
  window
    .getSelection()
    ?.setBaseAndExtent(
      textSelectionAnchor.node,
      textSelectionAnchor.offset,
      caret.node,
      caret.offset,
    );
}

function stopTextSelectionTracking() {
  const selection = window.getSelection();
  if (
    selection?.isCollapsed &&
    selection.rangeCount &&
    textSelectionAnchorContent
  ) {
    const range = selection.getRangeAt(0).cloneRange();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  textSelectionAnchor = null;
  textSelectionAnchorContent = null;
  document.removeEventListener("pointermove", onTextSelectionPointerMove);
  document.removeEventListener("pointerup", stopTextSelectionTracking);
  document.removeEventListener("pointercancel", stopTextSelectionTracking);
}

function selectionContent(): HTMLElement | null {
  const node = window.getSelection()?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const content = element?.closest<HTMLElement>(".block-content") ?? null;
  return content && editorEl.value?.contains(content) ? content : null;
}

function onEditorKeydown(e: KeyboardEvent) {
  if ((e.target as HTMLElement).closest(".block-content")) return;
  const content = selectionContent();
  if (!content) return;
  const forwarded = new KeyboardEvent("keydown", {
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    repeat: e.repeat,
    cancelable: true,
    bubbles: false,
  });
  content.dispatchEvent(forwarded);
  if (forwarded.defaultPrevented) e.preventDefault();
}

function onEditorInput(e: Event) {
  if ((e.target as HTMLElement).closest(".block-content")) return;
  selectionContent()?.dispatchEvent(new Event("input", { bubbles: false }));
}

function onEditorPaste(e: ClipboardEvent) {
  if ((e.target as HTMLElement).closest(".block-content")) return;
  const content = selectionContent();
  if (!content) return;
  const forwarded = new ClipboardEvent("paste", {
    clipboardData: e.clipboardData ?? undefined,
    cancelable: true,
    bubbles: false,
  });
  content.dispatchEvent(forwarded);
  if (forwarded.defaultPrevented) e.preventDefault();
}

const selectionRect = computed(() => {
  const s = selectionDrag.value;
  return {
    left: Math.min(s.startX, s.x),
    top: Math.min(s.startY, s.y),
    width: Math.abs(s.x - s.startX),
    height: Math.abs(s.y - s.startY),
    right: Math.max(s.startX, s.x),
    bottom: Math.max(s.startY, s.y),
  };
});

// ---- empty page click / append ----

async function appendBlock() {
  const last = ws.blocks[ws.blocks.length - 1];
  if (
    last &&
    last.html === "" &&
    !["divider", "image", "code"].includes(last.type)
  ) {
    requestFocus(last.id, "end");
    return;
  }
  const nb = ws.newBlock();
  ws.snapshot();
  await ws.insertBlock(ws.blocks.length - 1, nb);
  requestFocus(nb.id, "start");
}

async function onPasteImage(index: number, dataUrl: string) {
  const current = ws.blocks[index];
  if (!current) return;
  ws.snapshot();
  if (
    current.type === "paragraph" &&
    stripHtmlForQuery(current.html).trim() === ""
  ) {
    await ws.updateBlock(current.id, {
      type: "image",
      html: dataUrl,
      caption: "",
    });
    return;
  }
  const image = ws.newBlock("image", dataUrl, current.indent);
  image.caption = "";
  await ws.insertBlock(index, image);
}

// ---- global undo/redo ----

function onKeydown(e: KeyboardEvent) {
  if (tabFocused && !tabFocused.value) return;
  if (e.key === "Escape" && selectedIds.value.length) {
    selectedIds.value = [];
    return;
  }
  if (
    (e.key === "Backspace" || e.key === "Delete") &&
    selectedIds.value.length
  ) {
    e.preventDefault();
    deleteSelectedBlocks();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    ws.undo();
  } else if (
    (e.key.toLowerCase() === "z" && e.shiftKey) ||
    e.key.toLowerCase() === "y"
  ) {
    e.preventDefault();
    ws.redo();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  if (ws.blocks.length === 0 && ws.currentPageId) await focusFirstBlock();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  stopSelectionDrag();
  stopTextSelectionTracking();
  resetDragState();
});
</script>

<template>
  <div
    ref="editorEl"
    class="notes-editor"
    :class="{ selecting: selectionDrag.active }"
    contenteditable="false"
    spellcheck="false"
    @pointerdown.capture="onTextSelectionPointerDown"
    @dblclick.capture="onTextDoubleClick"
    @keydown="onEditorKeydown"
    @input="onEditorInput"
    @paste="onEditorPaste"
    @dragenter="acceptBlockDrag"
    @dragover="onEditorDragOver"
    @drop.prevent.stop="onDrop"
  >
    <BlockItem
      v-for="{ block, index } in visibleBlocks"
      :key="block.id"
      :block="block"
      :index="index"
      :focus-request="focusRequest"
      :drop-target="dropTarget?.index === index ? dropTarget.side : null"
      :selected="selectedIds.includes(block.id)"
      :multi-selected="selectedIds.length > 1 && selectedIds.includes(block.id)"
      @enter="onEnter"
      @backspace-start="onBackspaceAtStart"
      @delete-block="onDeleteBlock"
      @arrow="onArrow"
      @indent="onIndent"
      @move="onMove"
      @convert="onConvert"
      @duplicate="onDuplicate"
      @slash="onSlash"
      @slash-close="slashState = null"
      @select-block="onSelectBlock"
      @clear-selected="clearSelected"
      @drag-start="onDragStart"
      @drag-over="onDragOver"
      @drag-end="resetDragState"
      @paste-image="onPasteImage"
      @focus-applied="onFocusApplied"
    />
    <Teleport to="body"
      ><div
        v-if="selectionDrag.active"
        class="selection-box"
        contenteditable="false"
        :style="{
          left: selectionRect.left + 'px',
          top: selectionRect.top + 'px',
          width: selectionRect.width + 'px',
          height: selectionRect.height + 'px',
        }"
    /></Teleport>
    <div class="editor-tail" contenteditable="false" @click="appendBlock" />

    <SlashMenu
      v-if="slashState"
      :x="slashState.x"
      :y="slashState.y"
      :anchor-top="slashState.anchorTop"
      :block-id="slashState.blockId"
      :query="slashQuery"
      @pick="onSlashPick"
      @close="slashState = null"
    />
    <FloatingToolbar :editor-root="editorEl" />
  </div>
</template>

<style scoped>
.notes-editor {
  position: relative;
  outline: none;
}
.notes-editor.selecting {
  user-select: none;
}
.editor-tail {
  height: 120px;
  cursor: text;
}
.selection-box {
  position: fixed;
  z-index: 950;
  border: 1px solid color-mix(in srgb, var(--notes-accent) 72%, transparent);
  background: color-mix(in srgb, var(--notes-accent) 12%, transparent);
  border-radius: 2px;
  pointer-events: none;
}
</style>
