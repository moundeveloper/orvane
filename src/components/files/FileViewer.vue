<script setup lang="ts">
// Shows one file by type: image, video, audio, PDF, spreadsheet, or
// highlighted text. Used by File Explorer peek and by canvas file widgets.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import Icon from "../Icon.vue";
import PeekCode from "./PeekCode.vue";
import { api, iconOf, languageOf, peekKind, rawUrl, toneOf, typeName, type FileEntry } from "./explorer";

const props = defineProps<{ path: string; token: string; revision?: number }>();
const name = computed(() => props.path.split(/[\\/]/).pop() ?? props.path);
const entry = computed<FileEntry>(() => {
  const ext = name.value.includes(".") ? name.value.split(".").pop()!.toLowerCase() : "";
  return { name: name.value, path: props.path, dir: false, size: 0, mtime: 0, ext, hidden: false, link: false };
});
const kind = computed(() => peekKind(entry.value));
// The revision busts the media cache when the file changes on disk.
const url = computed(() => `${rawUrl(props.path, props.token)}&v=${props.revision ?? 0}`);
const loading = ref(false);
const error = ref("");
const text = ref<string | null>(null);
const truncated = ref(false);
const binary = ref(false);
type Sheet = { names: string[]; index: number; rows: string[][]; truncated: boolean };
const sheet = shallowRef<Sheet | null>(null);
const mediaFailed = ref(false);
let seq = 0;
async function load(sheetIndex = sheet.value?.index ?? 0) {
  const id = ++seq;
  error.value = "";
  mediaFailed.value = false;
  binary.value = false;
  if (kind.value !== "text" && kind.value !== "sheet") return;
  loading.value = !text.value && !sheet.value;
  try {
    if (kind.value === "sheet") {
      const data = await api<Sheet>("sheet", { path: props.path, index: sheetIndex });
      if (id !== seq) return;
      if (data.index !== sheet.value?.index) {
        sheetTop.value = 0;
        if (sheetBody.value) sheetBody.value.scrollTop = 0;
      }
      sheet.value = data;
    } else {
      const data = await api<{ kind: string; text?: string; truncated?: boolean }>("preview", { path: props.path });
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
watch(
  () => props.path,
  () => {
    text.value = null;
    sheet.value = null;
    void load(0);
  },
  { immediate: true },
);
watch(
  () => props.revision,
  () => void load(),
);
defineExpose({ reload: () => load() });

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
let observer: ResizeObserver | undefined;
watch(sheetBody, (body) => {
  observer?.disconnect();
  if (!body) return;
  observer = new ResizeObserver(() => sheetScroll());
  observer.observe(body);
});
onBeforeUnmount(() => observer?.disconnect());
function openDefault() {
  void api("open", { path: props.path }).catch(() => undefined);
}
</script>
<template>
  <div class="peek-stage" :class="kind">
    <p v-if="loading" class="peek-note"><span class="peek-spinner" />Loading…</p>
    <p v-else-if="error" class="peek-note error"><Icon name="alert" :size="15" />{{ error }}</p>
    <template v-else-if="kind === 'image'">
      <img v-if="!mediaFailed" :key="url" class="peek-image" :src="url" :alt="name" draggable="false" @error="mediaFailed = true" />
      <p v-else class="peek-note">This image format cannot be shown here.</p>
    </template>
    <template v-else-if="kind === 'video'">
      <video v-if="!mediaFailed" :key="url" class="peek-video" :src="url" controls @error="mediaFailed = true"></video>
      <p v-else class="peek-note">
        This video's format or codec cannot play here.
        <button @click="openDefault">Open in default app</button>
      </p>
    </template>
    <div v-else-if="kind === 'audio'" class="peek-audio">
      <Icon name="music" :size="48" class="tone-image" />
      <audio v-if="!mediaFailed" :key="url" :src="url" controls @error="mediaFailed = true"></audio>
      <p v-else class="peek-note">This audio format cannot play here.</p>
    </div>
    <iframe v-else-if="kind === 'pdf'" :key="url" class="peek-pdf" :src="url" :title="name"></iframe>
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
        <button v-for="(sheetName, index) in sheet.names" :key="index" :aria-pressed="index === sheet.index" @click="load(index)">
          {{ sheetName }}
        </button>
        <span v-if="sheet.truncated" class="peek-hint">Showing the first 2,000 rows and 80 columns.</span>
      </div>
    </div>
    <template v-else-if="kind === 'text'">
      <template v-if="text !== null">
        <PeekCode :text="text" :language="languageOf(entry.ext)" :label="`Contents of ${name}`" />
        <p v-if="truncated" class="peek-hint bar">Only the first 2 MB is shown.</p>
      </template>
      <div v-else-if="binary" class="peek-note column">
        <Icon :name="iconOf(entry)" :size="48" :class="toneOf(entry)" />
        <span>No preview for {{ typeName(entry) }}s.</span>
        <button @click="openDefault">Open in default app</button>
      </div>
    </template>
  </div>
</template>
<style scoped>
.peek-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
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
  padding: 0;
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
.peek-video {
  width: 100%;
  height: 100%;
  border-radius: 0;
}
.peek-image {
  box-shadow: 0 4px 18px rgb(39 63 78 / 12%);
}
.peek-audio {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  width: 100%;
}
.peek-audio audio {
  width: min(420px, 90%);
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
.peek-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #c7d6dd;
  border-top-color: #557a8e;
  border-radius: 50%;
  animation: viewer-spin 0.8s linear infinite;
}
.tone-folder { color: #d39b2a; }
.tone-image { color: #8a5cc0; }
.tone-code { color: #4f7b93; }
.tone-archive { color: #b0763a; }
.tone-file { color: #8798a3; }
@keyframes viewer-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
