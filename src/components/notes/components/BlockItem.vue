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
  watch,
} from "vue";
import { useNotesWorkspace } from "../stores/workspace";
import { escapeHtml } from "../stores/workspace";
import type { Block, BlockType } from "../types";
import IconPicker from "./IconPicker.vue";

const props = defineProps<{
  block: Block;
  index: number;
  focusRequest: { id: string; at: "start" | "end" } | null;
  dropTarget: "before" | "after" | null;
  selected: boolean;
  multiSelected: boolean;
}>();

const emit = defineEmits<{
  (e: "enter", index: number, before: string, after: string): void;
  (e: "backspace-start", index: number): void;
  (e: "delete-block", index: number): void;
  (e: "arrow", index: number, dir: "up" | "down"): void;
  (e: "indent", index: number, delta: number): void;
  (e: "move", index: number, dir: -1 | 1): void;
  (e: "convert", index: number, type: BlockType): void;
  (e: "duplicate", index: number): void;
  (e: "slash", blockId: string, rect: DOMRect, query?: string): void;
  (e: "slash-close"): void;
  (e: "select-block", index: number, additive: boolean): void;
  (e: "clear-selected"): void;
  (e: "drag-start", index: number, ev: DragEvent): void;
  (e: "drag-over", index: number, ev: DragEvent): void;
  (e: "drag-end"): void;
  (e: "paste-image", index: number, dataUrl: string): void;
  (e: "focus-applied", request: { id: string; at: "start" | "end" }): void;
}>();

const ws = useNotesWorkspace();
const openPageTab =
  inject<(id: string, activate?: boolean) => void>("openPageTab");
const navigatePage = inject<(id: string) => void>("navigatePage");
const contentEl = ref<HTMLElement>();
const contentEmpty = ref(isHtmlVisuallyEmpty(props.block.html));
const menuPos = ref<{ x: number; y: number } | null>(null);
const portal = useNotesPortal();
const imageInput = ref<HTMLInputElement>();
const imageFrame = ref<HTMLElement>();
const imageWidth = ref(
  Math.max(20, Math.min(100, props.block.imageWidth ?? 100)),
);
let imageResize: {
  startX: number;
  startWidth: number;
  containerWidth: number;
} | null = null;

watch(
  () => props.block.imageWidth,
  (width) => {
    if (!imageResize)
      imageWidth.value = Math.max(20, Math.min(100, width ?? 100));
  },
);

const imageFrameStyle = computed(() => ({
  width: `${imageWidth.value}%`,
}));

const numberLabel = computed(() => {
  if (props.block.type !== "numbered") return 0;
  let n = 1;
  for (let i = props.index - 1; i >= 0; i--) {
    const b = ws.blocks[i];
    if (!b) break;
    if (b.type === "numbered" && b.indent === props.block.indent) n++;
    else if (
      b.indent < props.block.indent ||
      (b.type !== "numbered" && b.indent === props.block.indent)
    )
      break;
  }
  return n;
});

const placeholder = computed(() => {
  switch (props.block.type) {
    case "heading1":
      return "Heading 1";
    case "heading2":
      return "Heading 2";
    case "heading3":
      return "Heading 3";
    case "todo":
      return "To-do";
    case "toggle":
      return "Toggle";
    case "quote":
      return "Quote";
    case "callout":
      return "Callout";
    case "code":
      return "Code";
    default:
      return "Type '/' for commands";
  }
});

const isText = computed(() => !["divider", "image"].includes(props.block.type));
// ---- caret helpers ----

function isHtmlVisuallyEmpty(html: string): boolean {
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(html);
  const text = (div.textContent ?? "").replace(/\u200B/g, "").trim();
  return (
    !text && !div.querySelector("img, video, audio, iframe, [data-page-link]")
  );
}

function caretAtStart(): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !contentEl.value) return false;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(contentEl.value);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length === 0;
}

function caretAtEnd(): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !contentEl.value) return false;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(contentEl.value);
  r.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return r.toString().length === 0;
}

function slashQueryAtCaret(): string | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !contentEl.value) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(contentEl.value);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  const match = r.toString().match(/\/([^/]*)$/);
  return match?.[1] ?? null;
}

function splitAtCaret(): { before: string; after: string } {
  const el = contentEl.value!;
  const sel = window.getSelection()!;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const post = range.cloneRange();
  post.selectNodeContents(el);
  post.setStart(range.endContainer, range.endOffset);
  const frag2html = (f: DocumentFragment) => {
    const d = document.createElement("div");
    d.appendChild(f);
    return storedHtml(d.innerHTML);
  };
  return {
    before: frag2html(pre.cloneContents()),
    after: frag2html(post.cloneContents()),
  };
}

function focusAt(at: "start" | "end") {
  const el = contentEl.value;
  if (!el) return;
  const html = renderHtml(props.block.html);
  if (storedHtml(el.innerHTML) !== props.block.html)
    el.innerHTML = DOMPurify.sanitize(html);
  el.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(at === "start");
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode();
  if (text) {
    if (at === "end") {
      let next: Node | null;
      while ((next = walker.nextNode())) text = next;
    }
    range.setStart(text, at === "start" ? 0 : text.textContent!.length);
    range.collapse(true);
  }
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  revealCaret();
}

function revealCaret() {
  const el = contentEl.value;
  const selection = window.getSelection();
  if (!el || !selection?.rangeCount || !el.contains(selection.focusNode))
    return;
  const range = document.createRange();
  range.setStart(selection.focusNode!, selection.focusOffset);
  range.collapse(true);
  // Native focus scrolling is unreliable inside the transformed canvas.
  // Reveal the caret in the Notes viewport without moving the canvas itself.
  const viewport = el.closest<HTMLElement>(".notes-page-scroll");
  if (viewport) {
    const bounds = viewport.getBoundingClientRect();
    const top = Math.max(bounds.top, viewport.querySelector(".crumbs")?.getBoundingClientRect().bottom || bounds.top);
    const caret = range.getClientRects()[0] || el.getBoundingClientRect();
    const scale = bounds.height / viewport.offsetHeight || 1;
    const delta =
      caret.top < top + 12
        ? caret.top - top - 12
        : caret.bottom > bounds.bottom - 12
          ? caret.bottom - bounds.bottom + 12
          : 0;
    viewport.scrollTop += delta / scale;
  }
}

function onNavigationKeyup(event: KeyboardEvent) {
  if (event.key.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown"].includes(event.key))
    revealCaret();
}

function contentHasSelection(): boolean {
  const el = contentEl.value;
  const selection = window.getSelection();
  return !!(
    el &&
    selection?.rangeCount &&
    (el.contains(selection.anchorNode) || el.contains(selection.focusNode))
  );
}

watch(
  () => props.focusRequest,
  (fr) => {
    if (fr?.id === props.block.id) {
      nextTick(() => {
        focusAt(fr.at);
        emit("focus-applied", fr);
      });
    }
  },
);

onMounted(() => {
  if (contentEl.value && isText.value) {
    contentEl.value.innerHTML = renderHtml(props.block.html);
    contentEmpty.value = isHtmlVisuallyEmpty(contentEl.value.innerHTML);
  }
});

// re-sync DOM when html changed externally (undo/redo)
watch(
  () => props.block.html,
  (html) => {
    const el = contentEl.value;
    contentEmpty.value = isHtmlVisuallyEmpty(html);
    if (
      el &&
      isText.value &&
      storedHtml(el.innerHTML) !== html &&
      !contentHasSelection()
    ) {
      el.innerHTML = renderHtml(html);
    }
  },
);

watch(
  () =>
    ws.pages
      .map(
        (p) =>
          `${p.id}:${p.title}:${p.icon ?? ""}:${p.type}:${p.trashedAt ?? ""}`,
      )
      .join("|"),
  () => {
    const el = contentEl.value;
    if (el && isText.value && !contentHasSelection())
      el.innerHTML = renderHtml(props.block.html);
  },
);

// ---- input / markdown shortcuts ----

let saveTimer: number | undefined;
function onInput() {
  const el = contentEl.value;
  if (!el) return;
  const html = storedHtml(el.innerHTML === "<br>" ? "" : el.innerHTML);
  props.block.html = html;
  contentEmpty.value = isHtmlVisuallyEmpty(html);
  const query = slashQueryAtCaret();
  if (query !== null) {
    emit("slash", props.block.id, el.getBoundingClientRect(), query);
  }
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(
    () => ws.updateBlock(props.block.id, { html }),
    250,
  );
}

const MD_MAP: [RegExp, BlockType][] = [
  [/^### $/, "heading3"],
  [/^## $/, "heading2"],
  [/^# $/, "heading1"],
  [/^- $|^\* $/, "bulleted"],
  [/^1\. $/, "numbered"],
  [/^\[\] $|^\[ \] $/, "todo"],
  [/^> $/, "quote"],
  [/^```$/, "code"],
];

function tryMarkdown(): boolean {
  const el = contentEl.value;
  if (!el || props.block.type === "code") return false;
  const text = el.textContent ?? "";
  if (text === "---") {
    el.innerHTML = "";
    props.block.html = "";
    emit("convert", props.index, "divider");
    return true;
  }
  for (const [re, type] of MD_MAP) {
    if (re.test(text)) {
      el.innerHTML = "";
      props.block.html = "";
      emit("convert", props.index, type);
      return true;
    }
  }
  return false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === "/" && !mod) {
    nextTick(() => {
      const rect = contentEl.value?.getBoundingClientRect();
      if (rect) emit("slash", props.block.id, rect);
    });
    return;
  }

  if (e.key === " " || e.key === "`" || e.key === "-") {
    setTimeout(() => tryMarkdown());
  }

  if (e.key === "Enter") {
    if (props.block.type === "code" && !e.shiftKey) return;
    if (e.shiftKey && props.block.type !== "code") return;
    e.preventDefault();
    const { before, after } = splitAtCaret();
    contentEl.value!.innerHTML = renderHtml(before);
    contentEmpty.value = isHtmlVisuallyEmpty(before);
    emit("enter", props.index, before, after);
  } else if (e.key === "Backspace") {
    if (caretAtStart() && window.getSelection()?.isCollapsed) {
      e.preventDefault();
      emit("backspace-start", props.index);
    }
  } else if (e.key === "Tab") {
    e.preventDefault();
    emit("indent", props.index, e.shiftKey ? -1 : 1);
  } else if (e.key === "ArrowUp") {
    if (mod && e.shiftKey) {
      e.preventDefault();
      emit("move", props.index, -1);
      return;
    }
    if (!e.shiftKey && caretAtStart()) {
      e.preventDefault();
      emit("arrow", props.index, "up");
    }
  } else if (e.key === "ArrowDown") {
    if (mod && e.shiftKey) {
      e.preventDefault();
      emit("move", props.index, 1);
      return;
    }
    if (!e.shiftKey && caretAtEnd()) {
      e.preventDefault();
      emit("arrow", props.index, "down");
    }
  } else if (mod && e.key.toLowerCase() === "b") {
    e.preventDefault();
    document.execCommand("bold");
    onInput();
  } else if (mod && e.key.toLowerCase() === "i") {
    e.preventDefault();
    document.execCommand("italic");
    onInput();
  } else if (mod && e.key.toLowerCase() === "u") {
    e.preventDefault();
    document.execCommand("underline");
    onInput();
  } else if (mod && e.key.toLowerCase() === "e") {
    e.preventDefault();
    const sel = window.getSelection()?.toString();
    if (sel) {
      document.execCommand(
        "insertHTML",
        false,
        `<code>${escapeHtml(sel)}</code>`,
      );
      onInput();
    }
  } else if (e.key === "Escape") {
    emit("slash-close");
  }
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function onPaste(e: ClipboardEvent) {
  const imageItem = Array.from(e.clipboardData?.items ?? []).find(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
  const image =
    imageItem?.getAsFile() ??
    Array.from(e.clipboardData?.files ?? []).find((file) =>
      file.type.startsWith("image/"),
    );
  if (image) {
    e.preventDefault();
    try {
      const dataUrl = await readImage(image);
      if (dataUrl) emit("paste-image", props.index, dataUrl);
    } catch (error) {
      console.error("Failed to paste image.", error);
    }
    return;
  }
  e.preventDefault();
  const text = e.clipboardData?.getData("text/plain") ?? "";
  document.execCommand(
    "insertHTML",
    false,
    escapeHtml(text).replace(/\n/g, "<br>"),
  );
  onInput();
}

function onClickContent(e: MouseEvent) {
  emit("clear-selected");
  const link = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-page-link], a",
  );
  if (link) {
    e.preventDefault();
    const pageId = link.dataset.pageLink;
    if (pageId) {
      navigatePage?.(pageId);
    } else if (link.getAttribute("href")?.startsWith("#/page/")) {
      const id = link.getAttribute("href")!.replace("#/page/", "");
      navigatePage?.(id);
    } else if (link instanceof HTMLAnchorElement && link.href) {
      window.open(link.href, "_blank");
    }
  }
}

function onMouseupContent(e: MouseEvent) {
  if (e.button !== 1) return;
  const link = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-page-link], a",
  );
  if (!link) return;
  e.preventDefault();
  e.stopPropagation();
  const pageId = link.dataset.pageLink;
  if (pageId) openPageTab?.(pageId, false);
}

function preventMiddleContent(e: MouseEvent) {
  if (e.button !== 1) return;
  if (!(e.target as HTMLElement).closest<HTMLElement>("[data-page-link], a"))
    return;
  e.preventDefault();
  e.stopPropagation();
}

function renderHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(html);
  div.querySelectorAll<HTMLElement>("[data-page-link]").forEach((node) => {
    const id = node.dataset.pageLink;
    if (!id) return;
    const page = ws.pages.find((p) => p.id === id && !p.trashedAt);
    const a = document.createElement("a");
    a.href = `#/page/${id}`;
    a.dataset.pageLink = id;
    a.className = "page-link-card";
    a.contentEditable = "false";
    const icon = document.createElement("span");
    icon.className = "page-link-icon";
    icon.textContent = page?.icon ?? (page?.type === "database" ? "▦" : "▤");
    const title = document.createElement("span");
    title.className = "page-link-title";
    title.textContent = page?.title || "Untitled";
    a.append(icon, title);
    node.replaceWith(a);
  });
  return div.innerHTML;
}

function storedHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(html);
  div.querySelectorAll<HTMLElement>("[data-page-link]").forEach((node) => {
    const id = node.dataset.pageLink;
    if (!id) return;
    const a = document.createElement("a");
    a.href = `#/page/${id}`;
    a.dataset.pageLink = id;
    node.replaceWith(a);
  });
  return div.innerHTML;
}

// ---- todo / toggle / image ----

function toggleCheck() {
  ws.updateBlock(props.block.id, { checked: !props.block.checked });
}

function toggleCollapse() {
  ws.updateBlock(props.block.id, { collapsed: !props.block.collapsed });
}

function setCalloutIcon(icon: string) {
  ws.updateBlock(props.block.id, { icon });
}

async function onImagePick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () =>
    ws.updateBlock(props.block.id, { html: reader.result as string });
  reader.readAsDataURL(file);
}

function startImageResize(e: PointerEvent) {
  if (e.button !== 0 || !imageFrame.value) return;
  const container = imageFrame.value.parentElement;
  if (!container) return;
  const containerWidth = container.getBoundingClientRect().width;
  if (containerWidth <= 0) return;

  e.preventDefault();
  e.stopPropagation();
  ws.snapshot();
  imageResize = {
    startX: e.clientX,
    startWidth: imageFrame.value.getBoundingClientRect().width,
    containerWidth,
  };
  document.body.style.cursor = "ew-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onImageResize);
  window.addEventListener("pointerup", stopImageResize);
  window.addEventListener("pointercancel", stopImageResize);
}

function onImageResize(e: PointerEvent) {
  if (!imageResize) return;
  const nextWidth = imageResize.startWidth + e.clientX - imageResize.startX;
  imageWidth.value = Math.max(
    20,
    Math.min(100, (nextWidth / imageResize.containerWidth) * 100),
  );
}

function stopImageResize() {
  if (!imageResize) return;
  imageResize = null;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  window.removeEventListener("pointermove", onImageResize);
  window.removeEventListener("pointerup", stopImageResize);
  window.removeEventListener("pointercancel", stopImageResize);
  void ws.updateBlock(props.block.id, {
    imageWidth: Math.round(imageWidth.value * 10) / 10,
  });
}

// ---- handle menu ----

function closeMenu() {
  menuPos.value = null;
  window.removeEventListener("click", closeMenu);
  window.removeEventListener("scroll", onMenuViewportScroll, true);
}

function onMenuViewportScroll(e: Event) {
  const target = e.target;
  if (target instanceof Element && target.closest(".block-handle-menu")) return;
  closeMenu();
}

function openMenu(e: MouseEvent) {
  closeMenu();
  menuPos.value = portal.local(e.clientX, e.clientY);
  setTimeout(() => {
    window.addEventListener("click", closeMenu);
    window.addEventListener("scroll", onMenuViewportScroll, true);
  });
}

onBeforeUnmount(() => {
  closeMenu();
  stopImageResize();
});

function onBlockMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.closest(".block-content, input, button, a")) return;
  emit("select-block", props.index, e.shiftKey || e.ctrlKey || e.metaKey);
}

const TURN_INTO: { type: BlockType; label: string; icon: string }[] = [
  { type: "paragraph", label: "Text", icon: "¶" },
  { type: "heading1", label: "Heading 1", icon: "H1" },
  { type: "heading2", label: "Heading 2", icon: "H2" },
  { type: "heading3", label: "Heading 3", icon: "H3" },
  { type: "bulleted", label: "Bulleted list", icon: "•" },
  { type: "numbered", label: "Numbered list", icon: "1." },
  { type: "todo", label: "To-do", icon: "☑" },
  { type: "toggle", label: "Toggle", icon: "▸" },
  { type: "quote", label: "Quote", icon: "❝" },
  { type: "callout", label: "Callout", icon: "💡" },
  { type: "code", label: "Code", icon: "‹›" },
];
function copyCode() {
  navigator.clipboard.writeText(contentEl.value?.textContent ?? "");
}
</script>

<template>
  <div
    :data-block-id="block.id"
    class="blk"
    :class="[
      { selected, 'multi-selected': multiSelected },
      dropTarget ? `drop-${dropTarget}` : '',
      'type-' + block.type,
    ]"
    :style="{ marginLeft: block.indent * 26 + 'px' }"
    contenteditable="false"
    @dragover="emit('drag-over', index, $event)"
  >
    <div class="blk-gutter" contenteditable="false">
      <button
        class="blk-handle"
        draggable="true"
        aria-label="Drag to move · Click for menu"
        @dragstart="emit('drag-start', index, $event)"
        @dragend="emit('drag-end')"
        @click="openMenu"
      >
        ⠿
      </button>
    </div>

    <!-- prefix -->
    <span
      v-if="block.type === 'bulleted'"
      class="blk-prefix"
      contenteditable="false"
      >•</span
    >
    <span
      v-else-if="block.type === 'numbered'"
      class="blk-prefix num"
      contenteditable="false"
      >{{ numberLabel }}.</span
    >
    <button
      v-else-if="block.type === 'todo'"
      class="blk-prefix check"
      contenteditable="false"
      :class="{ checked: block.checked }"
      @click="toggleCheck"
    >
      {{ block.checked ? "✓" : "" }}
    </button>
    <button
      v-else-if="block.type === 'toggle'"
      class="blk-prefix toggle-arrow"
      contenteditable="false"
      :class="{ open: !block.collapsed }"
      @click="toggleCollapse"
    >
      ▸
    </button>
    <span
      v-else-if="block.type === 'callout'"
      class="blk-prefix callout-icon"
      contenteditable="false"
    >
      <IconPicker
        :model-value="block.icon ?? '💡'"
        fallback="💡"
        aria-label="Change callout icon"
        @update:model-value="(icon) => setCalloutIcon(icon ?? '💡')"
      />
    </span>

    <!-- content -->
    <hr
      v-if="block.type === 'divider'"
      class="blk-divider"
      contenteditable="false"
    />

    <div
      v-else-if="block.type === 'image'"
      class="blk-image"
      contenteditable="false"
      @mousedown="onBlockMouseDown"
    >
      <template v-if="block.html">
        <div ref="imageFrame" class="img-frame" :style="imageFrameStyle">
          <img
            :src="block.html"
            :alt="block.caption ?? 'image'"
            draggable="false"
          />
          <button
            class="img-resize-handle"
            type="button"
            aria-label="Drag to resize image"
            @pointerdown="startImageResize"
          />
        </div>
        <input
          class="img-caption"
          :value="block.caption ?? ''"
          placeholder="Add a caption…"
          @change="
            ws.updateBlock(block.id, {
              caption: ($event.target as HTMLInputElement).value,
            })
          "
        />
      </template>
      <button v-else class="img-placeholder" @click="imageInput?.click()">
        🖼 Click to add an image
      </button>
      <input
        ref="imageInput"
        type="file"
        accept="image/*"
        hidden
        @change="onImagePick"
      />
    </div>

    <div v-else class="blk-main" @mousedown="onBlockMouseDown">
      <div
        v-if="block.type === 'code'"
        class="code-bar"
        contenteditable="false"
      >
        <input
          class="code-lang"
          :value="block.lang ?? ''"
          placeholder="language"
          @change="
            ws.updateBlock(block.id, {
              lang: ($event.target as HTMLInputElement).value,
            })
          "
        />
        <button class="icon-btn" aria-label="Copy code" @click="copyCode">
          ⧉
        </button>
      </div>
      <div
        ref="contentEl"
        class="block-content"
        :class="{ done: block.type === 'todo' && block.checked }"
        contenteditable="true"
        spellcheck="false"
        tabindex="0"
        :data-placeholder="placeholder"
        :data-empty="contentEmpty ? 'true' : undefined"
        @input="onInput"
        @keydown="onKeydown"
        @keyup="onNavigationKeyup"
        @paste="onPaste"
        @click="onClickContent"
        @mousedown="preventMiddleContent"
        @pointerdown="preventMiddleContent"
        @mouseup="onMouseupContent"
        @auxclick.stop.prevent="onMouseupContent"
      />
    </div>

    <!-- handle menu -->
    <Teleport :to="portal.target.value ?? 'body'">
      <div
        v-if="menuPos"
        class="menu notes-portal block-handle-menu"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
      >
        <div class="menu-label">Turn into</div>
        <button
          v-for="t in TURN_INTO"
          :key="t.type"
          class="menu-item"
          @click="emit('convert', index, t.type)"
        >
          <span class="mi-icon">{{ t.icon }}</span> {{ t.label }}
        </button>
        <div class="menu-sep" />
        <button class="menu-item" @click="emit('duplicate', index)">
          <span class="mi-icon">⧉</span> Duplicate
        </button>
        <button class="menu-item" @click="emit('move', index, -1)">
          <span class="mi-icon">↑</span> Move up
        </button>
        <button class="menu-item" @click="emit('move', index, 1)">
          <span class="mi-icon">↓</span> Move down
        </button>
        <button
          class="menu-item"
          style="color: var(--notes-danger)"
          @click="emit('delete-block', index)"
        >
          <span class="mi-icon">🗑</span> Delete
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.blk {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 2px 0;
  border-radius: 4px;
}
.blk.drop-before::after,
.blk.drop-after::after {
  content: "";
  position: absolute;
  left: -28px;
  right: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--notes-accent);
  pointer-events: none;
  z-index: 3;
}
.blk.drop-before::after {
  top: -2px;
}
.blk.drop-after::after {
  bottom: -2px;
}
.blk.selected::before {
  content: "";
  position: absolute;
  inset: 0 -6px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--notes-accent) 12%, transparent);
  pointer-events: none;
  z-index: 0;
}
.blk.multi-selected::before {
  background: color-mix(in srgb, var(--notes-accent) 16%, transparent);
}
.blk > * {
  position: relative;
  z-index: 1;
}
.blk-gutter {
  position: absolute;
  left: -28px;
  top: 5px;
  width: 28px;
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity 0.1s;
  z-index: 3;
}
.type-heading1 .blk-gutter {
  top: 24px;
}
.type-heading2 .blk-gutter {
  top: 18px;
}
.type-heading3 .blk-gutter {
  top: 12px;
}
.type-quote .blk-gutter {
  top: 8px;
}
.type-code .blk-gutter,
.type-callout .blk-gutter {
  top: 12px;
}
.blk:hover .blk-gutter,
.blk:focus-within .blk-gutter,
.blk-gutter:hover {
  opacity: 1;
}
.blk-handle {
  cursor: grab;
  color: var(--notes-text-faint);
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.blk-handle:hover {
  background: var(--notes-bg-hover);
}

.blk-prefix {
  flex-shrink: 0;
  width: 22px;
  text-align: center;
  padding-top: 4px;
  color: var(--notes-text-secondary);
  font-size: 14px;
}
.blk-prefix.num {
  font-variant-numeric: tabular-nums;
}
.blk-prefix.check {
  width: 16px;
  height: 16px;
  margin: 6px 3px 0;
  border: 1.5px solid var(--notes-text-secondary);
  border-radius: 3px;
  font-size: 11px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.blk-prefix.check.checked {
  background: var(--notes-accent);
  border-color: var(--notes-accent);
  color: white;
}
.toggle-arrow {
  transition: transform 0.15s;
  font-size: 12px;
  padding-top: 5px;
}
.toggle-arrow.open {
  transform: rotate(90deg);
}

.blk-main {
  flex: 1;
  min-width: 0;
}
.block-content {
  outline: none;
  padding: 3px 2px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
  cursor: text;
}
.block-content[data-empty="true"]::before {
  content: attr(data-placeholder);
  color: var(--notes-text-faint);
  pointer-events: none;
}
.blk:not(.type-callout):not(:hover):not(:focus-within)
  .block-content[data-empty="true"]::before {
  content: "";
}
.type-paragraph .block-content[data-empty="true"]::before {
  content: "";
}
.blk:focus-within.type-paragraph .block-content[data-empty="true"]::before {
  content: attr(data-placeholder);
}
.type-callout .block-content[data-empty="true"]::before {
  content: attr(data-placeholder);
}
.block-content.done {
  text-decoration: line-through;
  color: var(--notes-text-faint);
}
:deep(.page-link-card) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  min-height: 26px;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--notes-text);
  font-weight: 600;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  cursor: pointer;
  vertical-align: baseline;
}
:deep(.page-link-card:hover) {
  background: var(--notes-bg-hover);
}
:deep(.page-link-icon) {
  width: 18px;
  color: var(--notes-text-secondary);
  text-align: center;
  flex-shrink: 0;
}
:deep(.page-link-title) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-heading1 .block-content {
  font-size: 28px;
  font-weight: 700;
  margin-top: 14px;
}
.type-heading2 .block-content {
  font-size: 22px;
  font-weight: 650;
  margin-top: 10px;
}
.type-heading3 .block-content {
  font-size: 18px;
  font-weight: 600;
  margin-top: 6px;
}
.type-quote .blk-main {
  border-left: 3px solid var(--notes-text);
  padding-left: 12px;
  margin: 2px 0;
}
.type-callout .blk-main,
.type-callout .blk-prefix {
  background: var(--notes-bg-callout);
}
.blk-prefix.callout-icon {
  padding-top: 3px;
  font-size: 16px;
}
.type-callout {
  background: var(--notes-bg-callout);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 4px 0;
  cursor: default;
}
.type-code .blk-main {
  background: var(--notes-bg-code);
  border-radius: 6px;
  border: 1px solid var(--notes-border);
  margin: 4px 0;
  cursor: default;
}
.type-code .block-content {
  font-family: "SFMono-Regular", Consolas, "Cascadia Code", monospace;
  font-size: 13px;
  padding: 8px 12px 12px;
}
.code-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 0;
}
.code-lang {
  background: transparent;
  border: none;
  outline: none;
  font-size: 12px;
  color: var(--notes-text-faint);
  width: 120px;
}
.blk-divider {
  flex: 1;
  border: none;
  border-top: 1px solid var(--notes-border);
  margin: 10px 0;
}
.blk-image {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.img-frame {
  position: relative;
  min-width: 20%;
  max-width: 100%;
}
.img-frame img {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.img-resize-handle {
  position: absolute;
  top: 50%;
  right: -5px;
  width: 10px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--notes-border);
  border-radius: 3px;
  background: var(--notes-bg);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--notes-text) 16%, transparent);
  cursor: ew-resize;
  opacity: 0;
  transform: translateY(-50%);
  transition: opacity 0.1s;
}
.img-frame:hover .img-resize-handle,
.img-resize-handle:focus-visible {
  opacity: 1;
}
.img-caption {
  border: none;
  outline: none;
  background: transparent;
  font-size: 12px;
  color: var(--notes-text-secondary);
}
.img-placeholder {
  padding: 24px;
  background: var(--notes-bg-code);
  border-radius: 6px;
  color: var(--notes-text-secondary);
  text-align: center;
  width: 100%;
}
.img-placeholder:hover {
  background: var(--notes-bg-hover);
}
</style>
