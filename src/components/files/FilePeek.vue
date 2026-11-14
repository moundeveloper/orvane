<script setup lang="ts">
// Peek: a quick look at a file in a panel over the folder, styled after the
// Browser's Peek View. Arrow keys step through the folder's files.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import Icon from "../Icon.vue";
import PeekCode from "./PeekCode.vue";
import {
  api,
  formatDate,
  formatSize,
  iconOf,
  isImage,
  languageOf,
  peekKind,
  rawUrl,
  toneOf,
  typeName,
  type ExplorerContext,
  type FileEntry,
} from "./explorer";

const props = defineProps<{ entry: FileEntry; position: number; total: number; ctx: ExplorerContext }>();
const emit = defineEmits<{ close: []; step: [number] }>();
const root = ref<HTMLElement>();
const kind = computed(() => peekKind(props.entry));
const url = computed(() => rawUrl(props.entry.path, props.ctx.token));
const loading = ref(false);
const error = ref("");
const text = ref<string | null>(null);
const truncated = ref(false);
const binary = ref(false);
type Sheet = { names: string[]; index: number; rows: string[][]; truncated: boolean };
const sheet = shallowRef<Sheet | null>(null);
const mediaFailed = ref(false);
let seq = 0;
async function load(sheetIndex = 0) {
  const id = ++seq;
  error.value = "";
  mediaFailed.value = false;
  if (kind.value !== "sheet" || sheetIndex === 0) sheet.value = null;
  text.value = null;
  binary.value = false;
  if (kind.value !== "text" && kind.value !== "sheet") return;
  loading.value = true;
  try {
    if (kind.value === "sheet") {
      const data = await api<Sheet>("sheet", { path: props.entry.path, index: sheetIndex });
      if (id !== seq) return;
      sheet.value = data;
      sheetTop.value = 0;
      if (sheetBody.value) sheetBody.value.scrollTop = 0;
    } else {
      const data = await api<{ kind: string; text?: string; truncated?: boolean }>("preview", { path: props.entry.path });
      if (id !== seq) return;
      if (data.kind === "text") {
        text.value = data.text ?? "";
        truncated.value = !!data.truncated;
      } else binary.value = true;
    }
  } catch (e) {
    if (id === seq) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (id === seq) loading.value = false;
  }
}
watch(() => props.entry.path, () => void load(), { immediate: true });

// ---- Spreadsheet: opaque column header above windowed rows (DESIGN.md) ----
const sheetBody = ref<HTMLElement>();
const sheetHead = ref<HTMLElement>();
const sheetTop = ref(0);
const sheetHeight = ref(400);
const ROW = 26;
const columns = computed(() => Math.max(1, ...(sheet.value?.rows.map((r) => r.length) ?? [1])));
const gridColumns = computed(() => `46px repeat(${columns.value}, minmax(110px, 160px))`);
const letters = (n: number) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const visibleRows = computed(() => {
  const rows = sheet.value?.rows ?? [];
  const start = Math.max(0, Math.floor(sheetTop.value / ROW) - 10);
  const end = Math.min(rows.length, Math.ceil((sheetTop.value + sheetHeight.value) / ROW) + 10);
  return rows.slice(start, end).map((cells, i) => ({ index: start + i, cells }));
});
function sheetScroll() {
  const body = sheetBody.value;
  if (!body) return;
  sheetTop.value = body.scrollTop;
  sheetHeight.value = body.clientHeight;
  if (sheetHead.value) sheetHead.value.scrollLeft = body.scrollLeft;
}

// ---- Keyboard and actions ----
function keydown(event: KeyboardEvent) {
  event.stopPropagation();
  if ((event.target as Element).closest(".cm-panels input, input, textarea")) return;
  const key = event.key;
  if (key === "Escape" || key === " ") {
    event.preventDefault();
    emit("close");
  } else if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown") {
    if ((event.target as Element).closest(".cm-editor, .peek-sheet-body, video, audio")) return;
    event.preventDefault();
    emit("step", 1);
  } else if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") {
    if ((event.target as Element).closest(".cm-editor, .peek-sheet-body, video, audio")) return;
    event.preventDefault();
    emit("step", -1);
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
let observer: ResizeObserver | undefined;
watch(sheetBody, (body) => {
  observer?.disconnect();
  if (!body) return;
  observer = new ResizeObserver(() => sheetScroll());
  observer.observe(body);
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <div class="peek-backdrop" @click="emit('close')"></div>
  <div ref="root" class="peek-panel" tabindex="-1" role="dialog" :aria-label="`Peek: ${entry.name}`" @keydown="keydown">
    <div class="peek-title">
      <Icon :name="iconOf(entry)" :size="15" :class="toneOf(entry)" />
      <strong :title="entry.name">{{ entry.name }}</strong>
      <span>{{ typeName(entry) }} · {{ formatSize(entry.size) }} · {{ formatDate(entry.mtime) }}</span>
    </div>
    <div class="peek-stage" :class="kind">
      <p v-if="loading" class="peek-note"><span class="peek-spinner" />Loading…</p>
      <p v-else-if="error" class="peek-note error"><Icon name="alert" :size="15" />{{ error }}</p>
      <template v-else-if="kind === 'image'">
        <img v-if="!mediaFailed" :key="url" class="peek-image" :src="url" :alt="entry.name" @error="mediaFailed = true" />
        <p v-else class="peek-note">This image format cannot be shown here.</p>
      </template>
      <template v-else-if="kind === 'video'">
        <video v-if="!mediaFailed" :key="url" class="peek-video" :src="url" controls autoplay @error="mediaFailed = true"></video>
        <p v-else class="peek-note">
          This video's format or codec cannot play here.
          <button @click="openDefault">Open in default app</button>
        </p>
      </template>
      <div v-else-if="kind === 'audio'" class="peek-audio">
        <Icon name="music" :size="54" class="tone-image" />
        <audio v-if="!mediaFailed" :key="url" :src="url" controls autoplay @error="mediaFailed = true"></audio>
        <p v-else class="peek-note">This audio format cannot play here.</p>
      </div>
      <iframe v-else-if="kind === 'pdf'" :key="url" class="peek-pdf" :src="url" :title="entry.name"></iframe>
      <div v-else-if="kind === 'sheet' && sheet" class="peek-sheet">
        <div ref="sheetHead" class="peek-sheet-head" :style="{ gridTemplateColumns: gridColumns }">
          <span></span><span v-for="c in columns" :key="c">{{ letters(c - 1) }}</span>
        </div>
        <div ref="sheetBody" class="peek-sheet-body" tabindex="0" @scroll="sheetScroll">
          <div :style="{ height: sheet.rows.length * ROW + 'px', position: 'relative', width: 'max-content', minWidth: '100%' }">
            <div
              v-for="row in visibleRows"
              :key="row.index"
              class="peek-sheet-row"
              :style="{ gridTemplateColumns: gridColumns, transform: `translateY(${row.index * ROW}px)` }"
            >
              <span class="peek-rownum">{{ row.index + 1 }}</span>
              <span v-for="c in columns" :key="c" :title="row.cells[c - 1]">{{ row.cells[c - 1] ?? "" }}</span>
            </div>
          </div>
          <p v-if="!sheet.rows.length" class="peek-note">This sheet is empty.</p>
        </div>
        <div class="peek-sheet-tabs">
          <button
            v-for="(name, index) in sheet.names"
            :key="index"
            :aria-pressed="index === sheet.index"
            @click="load(index)"
          >
            {{ name }}
          </button>
          <span v-if="sheet.truncated" class="peek-hint">Showing the first 2,000 rows and 80 columns.</span>
        </div>
      </div>
      <template v-else-if="kind === 'text'">
        <template v-if="text !== null">
          <PeekCode :text="text" :language="languageOf(entry.ext)" :label="`Contents of ${entry.name}`" />
          <p v-if="truncated" class="peek-hint bar">Only the first 2 MB is shown.</p>
        </template>
        <div v-else-if="binary" class="peek-note column">
          <Icon :name="iconOf(entry)" :size="48" :class="toneOf(entry)" />
          <span>No preview for {{ typeName(entry) }}s.</span>
          <button @click="openDefault">Open in default app</button>
        </div>
      </template>
    </div>
  </div>
  <div class="peek-address">
    <Icon name="file" :size="12" /><span>{{ entry.path }}</span><b>{{ position + 1 }} / {{ total }}</b>
  </div>
  <div class="peek-rail" role="toolbar" aria-label="Peek">
    <button type="button" aria-label="Close Peek" title="Close (Esc or Space)" @click="emit('close')">
      <Icon name="close" :size="15" />
    </button>
    <span class="peek-rail-line"></span>
    <button type="button" aria-label="Previous file" title="Previous (←)" :disabled="total < 2" @click="emit('step', -1)">
      <Icon name="up" :size="15" />
    </button>
    <button type="button" aria-label="Next file" title="Next (→)" :disabled="total < 2" @click="emit('step', 1)">
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
      v-if="isImage(entry.path)"
      type="button"
      aria-label="Place on canvas"
      title="Place on canvas as an image widget"
      @click="ctx.addToCanvas(entry.path)"
    >
      <Icon name="image" :size="15" />
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
.peek-title span {
  flex: none;
  margin-left: auto;
  color: #8798a3;
  font-size: 11px;
}
.peek-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.peek-stage.image,
.peek-stage.video,
.peek-stage.audio {
  align-items: center;
  justify-content: center;
  padding: 14px;
  background: repeating-conic-gradient(#f2f5f7 0 25%, #fbfcfd 0 50%) 0 0 / 16px 16px;
}
.peek-stage.video {
  background: #1e2a31;
}
.peek-image,
.peek-video {
  max-width: 100%;
  max-height: 100%;
  min-height: 0;
  object-fit: contain;
  border-radius: 4px;
}
.peek-image {
  box-shadow: 0 4px 18px rgb(39 63 78 / 12%);
}
.peek-audio {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}
.peek-audio audio {
  width: min(420px, 80%);
}
.peek-pdf {
  flex: 1;
  width: 100%;
  border: 0;
}
.peek-note {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: auto;
  padding: 24px;
  color: #718591;
  font-size: 12px;
  text-align: center;
}
.peek-stage.video .peek-note {
  color: #c5d3db;
}
.peek-note.column {
  flex-direction: column;
  gap: 12px;
}
.peek-note.error {
  color: #a5603d;
}
.peek-note button {
  padding: 5px 11px;
  border-radius: 5px;
  background: #e3edf2;
  color: #455968;
  font-size: 12px;
}
.peek-hint {
  margin: 0;
  color: #8798a3;
  font-size: 11px;
}
.peek-hint.bar {
  flex: none;
  padding: 5px 14px;
  border-top: 1px solid #e8eef1;
}
.peek-sheet {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.peek-sheet-head,
.peek-sheet-row {
  display: grid;
  width: max-content;
  min-width: 100%;
  font-size: 12px;
}
.peek-sheet-head {
  flex: none;
  overflow: hidden;
  width: auto;
  background: #f1f5f7;
  border-bottom: 1px solid #dce5e9;
  color: #718591;
  font-weight: 600;
  /* Room for the body's scrollbar so columns stay aligned. */
  padding-right: 5px;
}
.peek-sheet-head > span {
  padding: 5px 8px;
  border-right: 1px solid #e2eaee;
  text-align: center;
}
.peek-sheet-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  outline: none;
}
.peek-sheet-row {
  position: absolute;
  top: 0;
  left: 0;
  height: 26px;
}
.peek-sheet-row > span {
  overflow: hidden;
  padding: 0 8px;
  border-right: 1px solid #edf2f4;
  border-bottom: 1px solid #edf2f4;
  color: #344f5e;
  line-height: 25px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peek-rownum {
  position: sticky;
  left: 0;
  background: #f1f5f7;
  color: #8798a3 !important;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.peek-sheet-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 3px 8px;
  border-top: 1px solid #e2eaee;
  background: #f7f9fa;
  overflow-x: auto;
}
.peek-sheet-tabs button {
  flex: none;
  padding: 4px 10px;
  border-radius: 4px;
  background: none;
  color: #607583;
  font-size: 12px;
}
.peek-sheet-tabs button[aria-pressed="true"] {
  background: #fff;
  color: #2f4856;
  box-shadow: inset 0 -2px #7895a5;
}
.peek-sheet-tabs .peek-hint {
  margin-left: auto;
  padding-left: 12px;
  white-space: nowrap;
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
.peek-address {
  position: absolute;
  z-index: 32;
  left: calc(5% + 14px);
  bottom: calc(5% + 12px);
  max-width: 60%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: 1px solid #e2eaee;
  border-radius: 6px;
  background: #f8fafbf0;
  box-shadow: 0 2px 6px rgb(60 83 96 / 7%);
  color: #607583;
  font-size: 10px;
  pointer-events: none;
  animation: peek-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.peek-address span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peek-address b {
  flex: none;
  color: #8798a3;
  font-weight: 600;
}
.peek-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #c7d6dd;
  border-top-color: #557a8e;
  border-radius: 50%;
  animation: peek-spin 0.8s linear infinite;
}
.tone-folder { color: #d39b2a; }
.tone-image { color: #8a5cc0; }
.tone-code { color: #4f7b93; }
.tone-archive { color: #b0763a; }
.tone-file { color: #8798a3; }
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
@keyframes peek-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .peek-panel,
  .peek-rail,
  .peek-address,
  .peek-backdrop {
    animation: none;
  }
}
</style>
