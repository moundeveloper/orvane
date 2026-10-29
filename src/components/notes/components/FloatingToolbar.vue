<script setup lang="ts">
import { useNotesPortal } from "../portal";
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";

const props = defineProps<{ editorRoot?: HTMLElement }>();
const pos = ref<{ x: number; y: number } | null>(null);
const portal = useNotesPortal();
let savedRange: Range | null = null;

const active = reactive({
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  highlight: false,
  link: false,
});

function selectionBlock(): HTMLElement | null {
  const sel = window.getSelection();
  const node = sel?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const block = element?.closest<HTMLElement>(".block-content") ?? null;
  return block && props.editorRoot?.contains(block) ? block : null;
}

function closestInSelection(selector: string): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const end =
    range.endContainer instanceof Element
      ? range.endContainer
      : range.endContainer.parentElement;
  const block = selectionBlock();
  const startMatch = start?.closest<HTMLElement>(selector);
  if (startMatch && block?.contains(startMatch)) return startMatch;
  const endMatch = end?.closest<HTMLElement>(selector);
  if (endMatch && block?.contains(endMatch)) return endMatch;
  const common =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const commonMatch = common?.closest<HTMLElement>(selector);
  return commonMatch && block?.contains(commonMatch) ? commonMatch : null;
}

function syncActive() {
  active.bold = document.queryCommandState("bold");
  active.italic = document.queryCommandState("italic");
  active.underline = document.queryCommandState("underline");
  active.strike = document.queryCommandState("strikeThrough");
  active.code = !!closestInSelection("code");
  active.highlight = !!closestInSelection(
    '[data-highlight="true"], mark, span[style*="background"]',
  );
  active.link = !!closestInSelection("a[href]");
}

function update() {
  const sel = window.getSelection();
  if (
    !sel ||
    sel.isCollapsed ||
    !sel.rangeCount ||
    !sel.toString().trim() ||
    !selectionBlock()
  ) {
    pos.value = null;
    savedRange = null;
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  savedRange = sel.getRangeAt(0).cloneRange();
  syncActive();
  const anchor = portal.local(rect.left + rect.width / 2, rect.top);
  pos.value = {
    x: anchor.x,
    y: Math.max(portal.viewport().top + 8, anchor.y - 44),
  };
}

function restoreSelection(): boolean {
  if (!savedRange) return false;
  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(savedRange);
  return true;
}

function dispatchInput() {
  const block = selectionBlock();
  block?.dispatchEvent(new Event("input", { bubbles: true }));
  requestAnimationFrame(update);
}

function cmd(name: string, value?: string) {
  restoreSelection();
  document.execCommand(name, false, value);
  dispatchInput();
}

function unwrap(node: HTMLElement) {
  const parent = node.parentNode;
  if (!parent) return;
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  parent.removeChild(node);
}

function cloneShell(node: HTMLElement, text: string): HTMLElement | null {
  if (!text) return null;
  const clone = node.cloneNode(false) as HTMLElement;
  clone.textContent = text;
  return clone;
}

function unwrapSelectionFrom(node: HTMLElement): boolean {
  if (!restoreSelection()) return false;
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!range.intersectsNode(node)) return false;

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(node);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const before = beforeRange.toString();
  const selected = range.toString();

  const afterRange = document.createRange();
  afterRange.selectNodeContents(node);
  afterRange.setStart(range.endContainer, range.endOffset);
  const after = afterRange.toString();

  const parent = node.parentNode;
  if (!parent || !selected) return false;

  const fragment = document.createDocumentFragment();
  const beforeNode = cloneShell(node, before);
  if (beforeNode) fragment.append(beforeNode);
  const selectedNode = document.createTextNode(selected);
  fragment.append(selectedNode);
  const afterNode = cloneShell(node, after);
  if (afterNode) fragment.append(afterNode);

  parent.replaceChild(fragment, node);

  const next = document.createRange();
  next.selectNode(selectedNode);
  sel.removeAllRanges();
  sel.addRange(next);
  savedRange = next.cloneRange();
  return true;
}

function wrapSelection(node: HTMLElement, plainText = false) {
  if (!restoreSelection()) return;
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (plainText) {
    node.textContent = sel.toString();
  } else {
    node.append(range.extractContents());
  }
  range.deleteContents();
  range.insertNode(node);
  const next = document.createRange();
  next.selectNodeContents(node);
  sel.removeAllRanges();
  sel.addRange(next);
  savedRange = next.cloneRange();
  dispatchInput();
}

function inlineCode() {
  restoreSelection();
  const code = closestInSelection("code");
  if (code) {
    if (unwrapSelectionFrom(code)) dispatchInput();
    return;
  }
  wrapSelection(document.createElement("code"), true);
}

function highlight() {
  restoreSelection();
  const mark = closestInSelection(
    '[data-highlight="true"], mark, span[style*="background"]',
  );
  if (mark) {
    if (unwrapSelectionFrom(mark)) dispatchInput();
    return;
  }
  const span = document.createElement("span");
  span.dataset.highlight = "true";
  span.style.backgroundColor = "rgba(255, 212, 0, 0.4)";
  wrapSelection(span);
}

function link() {
  restoreSelection();
  const existing = closestInSelection("a[href]") as HTMLAnchorElement | null;
  const url = prompt("Link URL:", existing?.getAttribute("href") ?? "");
  restoreSelection();
  if (url === null) return;
  if (existing) {
    if (url.trim()) existing.setAttribute("href", url.trim());
    else unwrapSelectionFrom(existing);
    dispatchInput();
    return;
  }
  if (!url.trim()) return;
  const a = document.createElement("a");
  a.setAttribute("href", url.trim());
  wrapSelection(a);
}

function onSelChange() {
  requestAnimationFrame(update);
}

onMounted(() => document.addEventListener("selectionchange", onSelChange));
onBeforeUnmount(() =>
  document.removeEventListener("selectionchange", onSelChange),
);
</script>

<template>
  <Teleport :to="portal.target.value ?? 'body'">
    <div
      v-if="pos"
      class="ftb notes-portal"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      @mousedown.prevent
    >
      <button
        aria-label="Bold (Ctrl+B)"
        :class="{ active: active.bold }"
        @click="cmd('bold')"
      >
        <b>B</b>
      </button>
      <button
        aria-label="Italic (Ctrl+I)"
        :class="{ active: active.italic }"
        @click="cmd('italic')"
      >
        <i>I</i>
      </button>
      <button
        aria-label="Underline (Ctrl+U)"
        :class="{ active: active.underline }"
        @click="cmd('underline')"
      >
        <u>U</u>
      </button>
      <button
        aria-label="Strikethrough"
        :class="{ active: active.strike }"
        @click="cmd('strikeThrough')"
      >
        <s>S</s>
      </button>
      <button
        aria-label="Inline code (Ctrl+E)"
        :class="{ active: active.code }"
        @click="inlineCode"
        class="mono"
      >
        ‹›
      </button>
      <button
        aria-label="Highlight"
        :class="{ active: active.highlight }"
        @click="highlight"
      >
        🖍
      </button>
      <button aria-label="Link" :class="{ active: active.link }" @click="link">
        🔗
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.ftb {
  position: fixed;
  z-index: 800;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  background: var(--notes-bg-modal);
  border-radius: 8px;
  box-shadow: var(--notes-shadow);
  padding: 4px;
}
.ftb button {
  padding: 4px 9px;
  border-radius: 4px;
  font-size: 14px;
  color: var(--notes-text);
}
.ftb button:hover {
  background: var(--notes-bg-hover);
}
.ftb button.active {
  background: var(--notes-bg-active);
  color: var(--notes-accent);
}
.mono {
  font-family: monospace;
}
</style>
