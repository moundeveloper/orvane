<script setup lang="ts">
// Peek: a quick look at a file in a panel over the folder, styled after the
// Browser's Peek View. Up and Down step through the folder's files, from
// anywhere in Peek (the panel, a playing video, the side rail); Left and
// Right stay with the content, such as seeking in a video.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import Icon from "../Icon.vue";
import FileViewer from "./FileViewer.vue";
import {
  formatDate,
  formatSize,
  iconOf,
  isImage,
  toneOf,
  typeName,
  type ExplorerContext,
  type FileEntry,
} from "./explorer";

const props = defineProps<{ entry: FileEntry; position: number; total: number; ctx: ExplorerContext }>();
const emit = defineEmits<{ close: []; step: [number] }>();
const root = ref<HTMLElement>();
const folder = computed(() => props.entry.path.slice(0, Math.max(0, props.entry.path.length - props.entry.name.length)).replace(/[\\/]+$/, ""));

// ---- Keyboard and actions ----
function keydown(event: KeyboardEvent) {
  event.stopPropagation();
  const target = event.target as Element;
  if (target.closest(".cm-panels input, input, textarea")) return;
  const key = event.key;
  // A focused rail button keeps its own Enter and Space.
  if ((key === "Enter" || key === " ") && target.closest("button")) return;
  if (key === "Escape" || key === " ") {
    event.preventDefault();
    emit("close");
  } else if (key === "ArrowDown" || key === "PageDown" || key === "ArrowUp" || key === "PageUp") {
    // Text and tables scroll with these keys; a video or audio player does not.
    if (target.closest(".cm-editor, .peek-sheet-body")) return;
    event.preventDefault();
    emit("step", key === "ArrowDown" || key === "PageDown" ? 1 : -1);
  } else if (key === "Enter") {
    event.preventDefault();
    openDefault();
  }
}
function openDefault() {
  props.ctx.open(props.entry.path);
}
function copyPath() {
  void navigator.clipboard?.writeText(props.entry.path).then(() => props.ctx.toast("Path copied."));
}
onMounted(() => void nextTick(() => root.value?.focus({ preventScroll: true })));
watch(() => props.entry.path, () => void nextTick(() => {
  if (!root.value?.contains(document.activeElement)) root.value?.focus({ preventScroll: true });
}));
</script>
<template>
  <div class="peek-backdrop" @click="emit('close')"></div>
  <div ref="root" class="peek-panel" tabindex="-1" role="dialog" :aria-label="`Peek: ${entry.name}`" @keydown="keydown">
    <div class="peek-title">
      <Icon :name="iconOf(entry)" :size="15" :class="toneOf(entry)" />
      <strong :title="entry.name">{{ entry.name }}</strong>
      <!-- The folder sits in the header, never over the content. -->
      <span class="peek-path" :title="entry.path">{{ folder }}</span>
      <span class="peek-meta">{{ typeName(entry) }} · {{ formatSize(entry.size) }} · {{ formatDate(entry.mtime) }}</span>
      <b class="peek-count">{{ position + 1 }} / {{ total }}</b>
    </div>
    <FileViewer :path="entry.path" :token="ctx.token" :revision="entry.mtime" />
  </div>
  <div class="peek-rail" role="toolbar" aria-label="Peek" tabindex="-1" @keydown="keydown">
    <button type="button" aria-label="Close Peek" title="Close (Esc or Space)" @click="emit('close')">
      <Icon name="close" :size="15" />
    </button>
    <span class="peek-rail-line"></span>
    <button type="button" aria-label="Previous file" title="Previous (↑)" :disabled="total < 2" @click="emit('step', -1)">
      <Icon name="up" :size="15" />
    </button>
    <button type="button" aria-label="Next file" title="Next (↓)" :disabled="total < 2" @click="emit('step', 1)">
      <Icon name="up" :size="15" class="flip" />
    </button>
    <span class="peek-rail-line"></span>
    <button type="button" aria-label="Open in default app" title="Open in default app (Enter)" @click="openDefault">
      <Icon name="external" :size="15" />
    </button>
    <button type="button" aria-label="Show in system explorer" title="Show in system explorer" @click="ctx.reveal(entry.path)">
      <Icon name="folder-open" :size="15" />
    </button>
    <button
      type="button"
      aria-label="Place on canvas"
      :title="isImage(entry.path) ? 'Place on canvas as an image widget' : 'Place on canvas as a live file widget'"
      @click="ctx.addToCanvas(entry.path)"
    >
      <Icon :name="isImage(entry.path) ? 'image' : 'app'" :size="15" />
    </button>
    <button type="button" aria-label="Copy path" title="Copy path" @click="copyPath">
      <Icon name="link" :size="15" />
    </button>
  </div>
</template>
<style scoped>
.peek-backdrop {
  position: absolute;
  inset: 0;
  z-index: 30;
  background: rgb(79 104 121 / 13%);
  backdrop-filter: blur(2px);
  animation: peek-fade 0.18s ease;
}
.peek-panel {
  position: absolute;
  z-index: 31;
  top: 5%;
  left: 5%;
  width: calc(90% - 43px);
  height: 90%;
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  border-radius: 12px 0 0 12px;
  background: #fff;
  box-shadow:
    0 23px 65px rgb(39 63 78 / 18%),
    0 4px 16px rgb(39 63 78 / 8%);
  overflow: hidden;
  outline: none;
  animation: peek-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.peek-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  min-width: 0;
  padding: 9px 14px;
  border-bottom: 1px solid #e8eef1;
}
.peek-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #2f4856;
  font-size: 13px;
}
.peek-title strong {
  flex: none;
  max-width: 45%;
}
.peek-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #8798a3;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Long paths lose their start, keeping the nearest folders visible. */
  direction: rtl;
  text-align: left;
}
.peek-meta,
.peek-count {
  flex: none;
  color: #8798a3;
  font-size: 11px;
}
.peek-count {
  padding: 1px 7px;
  border-radius: 9px;
  background: #edf3f6;
  font-weight: 600;
}
@container (max-width: 620px) {
  .peek-meta {
    display: none;
  }
}
.peek-rail {
  position: absolute;
  z-index: 31;
  top: 5%;
  right: 5%;
  width: 43px;
  height: 90%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 9px 4px;
  border-left: 1px solid #e2eaee;
  border-radius: 0 12px 12px 0;
  background: #f8fafb;
  box-shadow: 14px 23px 65px rgb(39 63 78 / 14%);
  animation: peek-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.peek-rail button {
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  padding: 0;
  border-radius: 7px;
  background: none;
  color: #607583;
}
.peek-rail button:hover:not(:disabled) {
  background: #e3edf2;
  color: #2f4856;
}
.peek-rail button:disabled {
  opacity: 0.4;
}
.peek-rail .flip {
  transform: rotate(180deg);
}
.peek-rail-line {
  width: 17px;
  height: 1px;
  margin: 3px 0;
  background: #e2eaee;
}
@keyframes peek-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.982);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes peek-fade {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .peek-panel,
  .peek-rail,
  .peek-backdrop {
    animation: none;
  }
}
</style>
