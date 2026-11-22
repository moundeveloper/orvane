<script setup lang="ts">
import { useNotesPortal } from "../portal";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import { agentRequest } from "../../../exposition";
import Icon from "../../Icon.vue";

const props = defineProps<{ editorRoot?: HTMLElement }>();
const emit = defineEmits<{ beforeRewrite: [] }>();
const pos = ref<{ x: number; y: number } | null>(null);
const portal = useNotesPortal();
let savedRange: Range | null = null;
const toolbar = ref<HTMLElement>();
const card = ref<HTMLElement>();
const askInput = ref<HTMLInputElement>();
const ask = ref("");
const instructions = {
  Shorten: "Make the selection more concise while preserving its meaning and specifics.",
  Expand: "Explain the selection more clearly and fully without inventing facts.",
  Fix: "Fix spelling, grammar and punctuation while preserving meaning and tone.",
  Ask: "",
};
type RewriteAction = keyof typeof instructions;
type RewriteTarget = { range: Range; block: HTMLElement; html: string; text: string; x: number; y: number };
const target = shallowRef<RewriteTarget>();
const action = ref<RewriteAction>("Shorten");
let lastAction: RewriteAction = "Shorten";
let lastRequest: { instruction: string; previous?: string } | undefined;
let controller: AbortController | undefined;
const pending = ref(false);
const rewriteError = ref("");
const result = ref<{ text: string; model: string; seconds: number }>();
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const toolbarStyle = computed(() => {
  if (!pos.value) return {};
  const view = portal.viewport();
  const width = toolbar.value?.offsetWidth ?? 420;
  const left = Math.max(view.left + width / 2 + 8, Math.min(view.right - width / 2 - 8, pos.value.x));
  return { left: left + "px", top: pos.value.y + "px" };
});
const cardStyle = computed(() => {
  if (!target.value) return {};
  const view = portal.viewport();
  const width = Math.min(435, Math.max(150, view.right - view.left - 16));
  const left = Math.max(view.left + 8, Math.min(target.value.x, view.right - width - 8));
  const height = card.value?.offsetHeight ?? 170;
  const top = Math.max(view.top + 8, Math.min(target.value.y, view.bottom - height - 8));
  return { left: left + "px", top: top + "px", width: width + "px" };
});

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
    canRewrite.value = false;
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  savedRange = sel.getRangeAt(0).cloneRange();
  updateRewriteSelection();
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

function sameBlock(range: Range) {
  const host = range.commonAncestorContainer;
  const element = host instanceof Element ? host : host.parentElement;
  const block = element?.closest<HTMLElement>('.block-content[contenteditable="true"]');
  return block && props.editorRoot?.contains(block) ? block : undefined;
}
const canRewrite = ref(false);
function updateRewriteSelection() {
  canRewrite.value = !!savedRange && !!sameBlock(savedRange) &&
    savedRange.toString().trim().length <= 8_000;
}

function dismiss(restore = false) {
  const current = target.value;
  controller?.abort();
  controller = undefined;
  target.value = undefined;
  pending.value = false;
  result.value = undefined;
  rewriteError.value = "";
  ask.value = "";
  lastRequest = undefined;
  if (restore && current && sameBlock(current.range) === current.block && current.html === current.block.innerHTML) {
    current.block.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(current.range);
  }
}

async function requestRewrite(instruction: string, previous?: string) {
  const current = target.value;
  if (!current || pending.value) return;
  const request = new AbortController();
  controller = request;
  lastRequest = { instruction, previous };
  pending.value = true;
  rewriteError.value = "";
  const started = performance.now();
  try {
    const replacement = await agentRequest<{ text: string; model: string }>(
      "notes-rewrite", { selection: current.text, instruction, previous }, request.signal,
    );
    if (controller !== request) return;
    result.value = { ...replacement, seconds: Math.max(1, Math.round((performance.now() - started) / 1000)) };
  } catch (cause) {
    if (controller === request)
      rewriteError.value = cause instanceof Error ? cause.message : "The rewrite failed.";
  } finally {
    if (controller === request) {
      pending.value = false;
      controller = undefined;
    }
  }
}
function startRewrite(rewrite: RewriteAction) {
  if (pending.value) return;
  const range = savedRange?.cloneRange();
  const block = range && sameBlock(range);
  const text = range?.toString().trim();
  if (!range || !block || !text || text.length > 8_000) return;
  dismiss();
  const rect = range.getBoundingClientRect();
  const anchor = portal.local(rect.left, rect.bottom);
  target.value = { range, block, text, html: block.innerHTML, x: anchor.x, y: anchor.y + 9 };
  action.value = lastAction = rewrite;
  if (rewrite === "Ask") void nextTick(() => askInput.value?.focus({ preventScroll: true }));
  else void requestRewrite(instructions[rewrite]);
}
function retry() {
  if (lastRequest) void requestRewrite(lastRequest.instruction, lastRequest.previous);
}
function submitAsk() {
  const instruction = ask.value.trim();
  if (!instruction || pending.value) return;
  ask.value = "";
  void requestRewrite(instruction, result.value?.text);
}
function applyRewrite() {
  const current = target.value;
  const replacement = result.value?.text;
  if (!current || !replacement || pending.value) return;
  const { range, block, html } = current;
  if (sameBlock(range) !== block || block.innerHTML !== html || range.toString().trim() !== current.text) {
    rewriteError.value = "The selected text changed. Select it again to rewrite it.";
    return;
  }
  emit("beforeRewrite");
  block.focus({ preventScroll: true });
  const fragment = document.createDocumentFragment();
  replacement.split(/\r?\n/).forEach((line, index) => {
    if (index) fragment.append(document.createElement("br"));
    fragment.append(document.createTextNode(line));
  });
  const end = fragment.lastChild!;
  range.deleteContents();
  range.insertNode(fragment);
  const caret = document.createRange();
  caret.setStartAfter(end);
  caret.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  block.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
  dismiss();
}
function onRewriteKey(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented || !(event.target instanceof Node)) return;
  const inEditor = props.editorRoot?.contains(event.target);
  const inCard = card.value?.contains(event.target);
  if (!inEditor && !inCard && !toolbar.value?.contains(event.target)) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "/" && inEditor) {
    update();
    if (!canRewrite.value) return;
    startRewrite(lastAction);
  } else if (!target.value || event.ctrlKey || event.metaKey || event.altKey) return;
  else if (key === "escape") dismiss(true);
  else if (key === "tab" && inEditor && !event.shiftKey && result.value && !pending.value) applyRewrite();
  else if (key === "r" && lastRequest && !pending.value && (inEditor || event.target === card.value)) retry();
  else return;
  event.preventDefault();
  event.stopPropagation();
}
function outside(event: PointerEvent) {
  if (!target.value || !(event.target instanceof Node)) return;
  if (!toolbar.value?.contains(event.target) && !card.value?.contains(event.target)) dismiss();
}
const guestDown = () => { if (target.value) dismiss(); };
onMounted(() => {
  document.addEventListener("selectionchange", onSelChange);
  document.addEventListener("keydown", onRewriteKey, true);
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("orvane:guest-pointer-down", guestDown);
});
onBeforeUnmount(() => {
  document.removeEventListener("selectionchange", onSelChange);
  document.removeEventListener("keydown", onRewriteKey, true);
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("orvane:guest-pointer-down", guestDown);
  controller?.abort();
});
</script>

<template>
  <Teleport :to="portal.target.value ?? 'body'">
    <div
      v-if="pos"
      ref="toolbar"
      class="ftb notes-portal"
      role="toolbar"
      aria-label="Text formatting and rewrite"
      :style="toolbarStyle"
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
      <template v-if="canRewrite">
        <span class="rewrite-divider" aria-hidden="true" />
        <button v-for="kind in (['Shorten', 'Expand', 'Fix', 'Ask'] as const)" :key="kind"
          type="button" class="rewrite-action" :class="{ active: target && action === kind }"
          :disabled="pending"
          :title="`${kind} selected text · Ctrl+/`" @click="startRewrite(kind)">
          {{ kind === "Ask" ? "Ask…" : kind }}
        </button>
      </template>
    </div>
    <section v-if="target" ref="card" class="rewrite-card notes-portal" :style="cardStyle" tabindex="-1" aria-label="Rewrite suggestion">
      <header>
        <strong>{{ action === "Shorten" ? "Shorter" : action === "Expand" ? "Expanded" : action === "Fix" ? "Corrected" : "Rewrite" }}</strong>
        <span v-if="result">{{ wordCount(target.text) }} → {{ wordCount(result.text) }} words</span>
        <span v-if="result" class="rewrite-model">{{ result.model }} · {{ result.seconds }} s</span>
        <button type="button" class="rewrite-close" aria-label="Keep original" title="Keep original (Esc)" @click="dismiss(true)"><Icon name="close" :size="13" /></button>
      </header>
      <p v-if="pending" role="status" class="rewrite-status">Rewriting…</p>
      <p v-if="rewriteError" role="alert" class="rewrite-error">{{ rewriteError }}</p>
      <p v-if="result" class="rewrite-text">{{ result.text }}</p>
      <footer>
        <button v-if="result" type="button" :disabled="pending" @click="applyRewrite"><kbd>Tab</kbd> Replace</button>
        <button v-if="lastRequest" type="button" :disabled="pending" @click="retry"><kbd>R</kbd> Try again</button>
        <form @submit.prevent="submitAsk">
          <input ref="askInput" v-model="ask" aria-label="Rewrite instruction" :placeholder="result ? 'Make it a numbered step…' : 'How should it change?'" maxlength="1500" />
          <button type="submit" aria-label="Send rewrite instruction" :disabled="pending || !ask.trim()"><Icon name="up" :size="14" /></button>
        </form>
      </footer>
    </section>
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
.rewrite-divider { width: 1px; margin: 4px; background: #e3eaee; }
.ftb .rewrite-action { font-size: 12px; color: #273f50; white-space: nowrap; }
.rewrite-card {
  position: fixed;
  z-index: 801;
  max-height: 310px;
  overflow: auto;
  border: 1px solid #cfe0d4;
  border-radius: 10px;
  background: #f4f8f5;
  color: #455968;
  box-shadow: 0 1px 2px #263f5512, 0 5px 16px #263f551e;
  font-size: 12px;
}
.rewrite-card header, .rewrite-card footer, .rewrite-card form {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
}
.rewrite-card header, .rewrite-card footer { padding: 4px 8px 4px 10px; }
.rewrite-card header { border-bottom: 1px solid #dfeadf; }
.rewrite-card footer { border-top: 1px solid #dfeadf; flex-wrap: wrap; }
.rewrite-card header strong { color: #365d45; }
.rewrite-model { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rewrite-close { margin-left: auto; }
.rewrite-model + .rewrite-close { margin-left: 0; }
.rewrite-text, .rewrite-error, .rewrite-status { margin: 0; padding: 9px 11px; }
.rewrite-text { white-space: pre-wrap; overflow-wrap: anywhere; color: #273f50; font-size: 13px; }
.rewrite-error { color: #8b4b3e; }
.rewrite-card button { display: inline-flex; gap: 4px; align-items: center; padding: 3px 5px; border-radius: 5px; white-space: nowrap; }
.rewrite-card button:hover { background: #e3efe6; }
.rewrite-card button:disabled { opacity: .5; }
.rewrite-card form { flex: 1 1 146px; min-width: 0; }
.rewrite-card input { flex: 1; min-width: 0; padding: 4px 6px; border: 1px solid #d3dee5; border-radius: 5px; color: #273f50; background: #fbfcfd; font: inherit; }
.rewrite-card kbd { font: 10px "Cascadia Code", Consolas, monospace; padding: 1px 3px; border: 1px solid #ccdcd0; border-radius: 3px; }
.rewrite-card :focus-visible, .ftb :focus-visible { outline: 2px solid #6f8998; outline-offset: 1px; }
</style>
