<script setup lang="ts">
// Arrows, freehand strokes and sticky notes in the transformed canvas plane.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import CustomSelect from "./CustomSelect.vue";
import { uid, type Board, type CanvasApp, type NoteLink } from "../model";
import { db } from "./notes/db";
import { NOTES_WORKSPACE_CHANGED_EVENT } from "./notes/stores/workspace";
import type { Page } from "./notes/types";
import { arrowPoints, NOTE_COLORS, strokePath, type Tool } from "../board";
import { DRAG_MIME } from "./files/explorer";
import { PAGE_DRAG_MIME } from "../commands";

const props = defineProps<{
  board: Board;
  apps: CanvasApp[];
  allApps: CanvasApp[];
  zoom: number;
  tool: Tool;
  editable: boolean;
  selected: string;
  editNote: string;
  stackLevel: (id: string) => number | undefined;
}>();
const emit = defineEmits<{
  select: [id: string];
  erase: [id: string];
  editNote: [id: string];
  openLink: [link: NoteLink];
  savedNote: [pageId: string];
}>();
const arrows = computed(() =>
  props.board.arrows.flatMap((arrow) => {
    const points = arrowPoints(arrow, props.apps, props.board, props.allApps);
    return points ? [{ arrow, ...points }] : [];
  }),
);
const markerColors = computed(() => [...new Set(props.board.arrows.map((a) => a.color))]);
const markerId = (color: string) => `board-head-${color.slice(1)}`;
function pick(id: string, event: Event) {
  // Only the left button picks or erases; middle-drag pans the canvas.
  if (event instanceof PointerEvent && event.button !== 0) return;
  if (props.tool === "eraser") return emit("erase", id);
  if (props.tool !== "select") return;
  event.stopPropagation();
  emit("select", id);
}
function pickNoteControl(id: string, event: PointerEvent) {
  if (event.button === 1) return;
  event.stopPropagation();
  if (event.button === 0 && props.tool === "select") emit("select", id);
}

// ---- Sticky notes: drag by the top strip, resize from the corner ----
function dragNote(event: PointerEvent, note: Board["notes"][number], mode: "move" | "resize") {
  if (!props.editable || props.tool !== "select" || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  emit("select", note.id);
  const start = { x: event.clientX, y: event.clientY, nx: note.x, ny: note.y, w: note.width, h: note.height };
  const move = (e: PointerEvent) => {
    const dx = (e.clientX - start.x) / props.zoom,
      dy = (e.clientY - start.y) / props.zoom;
    if (mode === "move") {
      note.x = Math.round(start.nx + dx);
      note.y = Math.round(start.ny + dy);
    } else {
      note.width = Math.round(Math.min(4000, Math.max(120, start.w + dx)));
      note.height = Math.round(Math.min(4000, Math.max(80, start.h + dy)));
    }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
function cycleColor(note: Board["notes"][number]) {
  note.color = NOTE_COLORS[(NOTE_COLORS.indexOf(note.color) + 1) % NOTE_COLORS.length]!;
}
const textareas = ref<HTMLTextAreaElement[]>();
watch(() => props.editNote, (id) => {
  if (id) void nextTick(() => textareas.value?.find((textarea) => textarea.dataset.id === id)?.focus({ preventScroll: true }));
}, { immediate: true, flush: "post" });
function startEdit(id: string) {
  if (!props.editable) return;
  emit("editNote", id);
  void nextTick(() => textareas.value?.find((t) => t.dataset.id === id)?.focus());
}

const capture = ref<{ noteId: string; key: string; destination: string; pages: Page[]; loading: boolean; saving: boolean; error: string }>();
let captureButton: HTMLButtonElement | undefined;
function dismissCapture(restoreFocus = false) {
  capture.value = undefined;
  document.removeEventListener("pointerdown", captureOutside, true);
  if (restoreFocus) captureButton?.focus({ preventScroll: true });
  captureButton = undefined;
}
function captureOutside(event: PointerEvent) {
  if (!(event.target as Element)?.closest(".sticky-save, .sticky-save-control, .select-popover")) dismissCapture();
}
async function openCapture(noteId: string, event: MouseEvent) {
  if (capture.value?.noteId === noteId) return dismissCapture(true);
  captureButton = event.currentTarget as HTMLButtonElement;
  capture.value = { noteId, key: uid(), destination: "new", pages: [], loading: true, saving: false, error: "" };
  const request = capture.value;
  document.addEventListener("pointerdown", captureOutside, true);
  try {
    request.pages = (await db.pages.toArray()).filter((page) => page.type === "page" && !page.trashedAt);
  } catch (error) {
    request.error = error instanceof Error ? error.message : "Notes pages could not load.";
  } finally {
    request.loading = false;
    if (capture.value === request) await nextTick(() => captureButton?.closest(".board-note")?.querySelector<HTMLButtonElement>(".sticky-save button")?.focus());
  }
}
function pageLabel(page: Page, pages: Page[]) {
  const titles = [page.title || "Untitled"];
  const visited = new Set([page.id]);
  let parent = pages.find((item) => item.id === page.parentId);
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    titles.unshift(parent.title || "Untitled");
    parent = pages.find((item) => item.id === parent?.parentId);
  }
  return titles.join(" / ");
}
async function saveCapture(note: Board["notes"][number]) {
  const request = capture.value;
  if (!request || request.saving || !note.text.trim() || !props.editable) return;
  request.saving = true;
  try {
    const existing = request.destination !== "new";
    const { pageId } = await db.saveCapture(request.key, note.text, existing ? request.destination : undefined);
    window.dispatchEvent(new CustomEvent(NOTES_WORKSPACE_CHANGED_EVENT, { detail: { source: "sticky-note", pages: !existing, blocksPageId: pageId } }));
    if (capture.value === request) dismissCapture(true);
    emit("savedNote", pageId);
  } catch (error) {
    request.error = error instanceof Error ? error.message : "The sticky note could not be saved.";
  } finally {
    request.saving = false;
  }
}
onBeforeUnmount(() => dismissCapture());
// ---- Links: drop a File Explorer item or a Browser tab on a note ----
const dropNote = ref("");
const linkable = (event: DragEvent) =>
  props.editable &&
  !!event.dataTransfer &&
  [DRAG_MIME, PAGE_DRAG_MIME].some((type) => event.dataTransfer!.types.includes(type));
function noteDragOver(event: DragEvent, id: string) {
  if (!linkable(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer!.dropEffect = "link";
  dropNote.value = id;
}
function noteDrop(event: DragEvent, note: Board["notes"][number]) {
  dropNote.value = "";
  if (!linkable(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const data = event.dataTransfer!;
  try {
    if (data.types.includes(PAGE_DRAG_MIME)) {
      const page = JSON.parse(data.getData(PAGE_DRAG_MIME)) as { url?: string; title?: string };
      if (typeof page.url === "string" && /^https?:/i.test(page.url))
        note.link = { kind: "page", target: page.url, label: (page.title || page.url).slice(0, 300) };
      return;
    }
    const files = JSON.parse(data.getData(DRAG_MIME)) as { paths?: string[]; dirs?: string[] };
    // Several items dropped: the note links to the first.
    const path = files.paths?.[0];
    if (typeof path !== "string" || !path) return;
    note.link = {
      kind: files.dirs?.includes(path) ? "folder" : "file",
      target: path,
      label: (path.split(/[\\/]/).filter(Boolean).pop() || path).slice(0, 300),
    };
  } catch {
    // Not data we understand; the note is left as it was.
  }
}
const linkIcon = (link: NoteLink) => (link.kind === "page" ? "globe" : link.kind === "folder" ? "folder" : "file");
// Arrow labels are edited in place (Electron has no window.prompt).
const labelling = ref<{ id: string; x: number; y: number; text: string } | null>(null);
const labelInput = ref<HTMLInputElement>();
function editArrowLabel(arrow: Board["arrows"][number], a: { x: number; y: number }, b: { x: number; y: number }) {
  if (!props.editable) return;
  labelling.value = { id: arrow.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: arrow.label ?? "" };
  void nextTick(() => labelInput.value?.select());
}
function commitLabel() {
  const current = labelling.value;
  labelling.value = null;
  const arrow = current && props.board.arrows.find((x) => x.id === current.id);
  if (arrow) arrow.label = current!.text.trim().slice(0, 200) || undefined;
}
</script>
<template>
  <svg class="board-svg" width="1" height="1" aria-hidden="true">
    <defs>
      <marker
        v-for="color in markerColors"
        :id="markerId(color)"
        :key="color"
        viewBox="0 0 10 10"
        refX="8.5"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M0 0L10 5L0 10z" :fill="color" />
      </marker>
    </defs>
    <g
      v-for="stroke in board.strokes"
      :key="stroke.id"
      class="board-item"
      :class="{ selected: selected === stroke.id }"
      @pointerdown="pick(stroke.id, $event)"
      @pointerenter="tool === 'eraser' && ($event.buttons & 1) && emit('erase', stroke.id)"
    >
      <path class="board-hit" :d="strokePath(stroke.points)" :stroke-width="Math.max(14 / zoom, stroke.width + 8)" />
      <path :d="strokePath(stroke.points)" :stroke="stroke.color" :stroke-width="stroke.width" fill="none" stroke-linecap="round" stroke-linejoin="round" />
    </g>
    <g
      v-for="{ arrow, a, b } in arrows"
      :key="arrow.id"
      class="board-item"
      :class="{ selected: selected === arrow.id }"
      @pointerdown="pick(arrow.id, $event)"
      @dblclick.stop="editArrowLabel(arrow, a, b)"
      @pointerenter="tool === 'eraser' && ($event.buttons & 1) && emit('erase', arrow.id)"
    >
      <line class="board-hit" :x1="a.x" :y1="a.y" :x2="b.x" :y2="b.y" :stroke-width="Math.max(14 / zoom, 12)" />
      <line :x1="a.x" :y1="a.y" :x2="b.x" :y2="b.y" :stroke="arrow.color" stroke-width="2.5" stroke-linecap="round" :marker-end="`url(#${markerId(arrow.color)})`" />
      <text v-if="arrow.label" class="board-label" :x="(a.x + b.x) / 2" :y="(a.y + b.y) / 2 - 8" text-anchor="middle">{{ arrow.label }}</text>
    </g>
  </svg>
  <input
    v-if="labelling"
    ref="labelInput"
    v-model="labelling.text"
    class="board-label-input"
    aria-label="Arrow label"
    maxlength="200"
    :style="{ left: labelling.x + 'px', top: labelling.y + 'px' }"
    @keydown.stop
    @keydown.enter="commitLabel"
    @keydown.esc="labelling = null"
    @pointerdown="$event.button !== 1 && $event.stopPropagation()"
    @blur="commitLabel"
  />
  <div
    v-for="note in board.notes"
    :key="note.id"
    class="board-note"
    :class="{ selected: selected === note.id, erasing: tool === 'eraser' }"
    :data-note-id="note.id"
    :style="{ left: note.x + 'px', top: note.y + 'px', width: note.width + 'px', height: note.height + 'px', background: note.color, zIndex: stackLevel(note.id) }"
    @pointerdown="pick(note.id, $event)"
    @dblclick.stop="startEdit(note.id)"
    @dragover="noteDragOver($event, note.id)"
    @dragleave="dropNote === note.id && (dropNote = '')"
    @drop="noteDrop($event, note)"
  >
    <div v-if="dropNote === note.id" class="board-note-drop" aria-hidden="true">Link to this note</div>
    <div class="board-note-bar" @pointerdown="dragNote($event, note, 'move')">
      <template v-if="editable && selected === note.id">
        <button type="button" class="sticky-save-control" title="Save to Notes" aria-label="Save to Notes" :aria-expanded="capture?.noteId === note.id" :disabled="!note.text.trim()" @pointerdown.stop @click="openCapture(note.id, $event)">
          <Icon name="text" :size="12" />
        </button>
        <button type="button" title="Change colour" aria-label="Change note colour" @pointerdown.stop @click="cycleColor(note)">
          <span class="board-swatch" :style="{ background: note.color }"></span>
        </button>
        <button type="button" title="Delete note" aria-label="Delete note" @pointerdown.stop @click="emit('erase', note.id)">
          <Icon name="trash" :size="12" />
        </button>
      </template>
    </div>
    <div v-if="capture?.noteId === note.id" class="sticky-save select-popover" role="group" aria-label="Save sticky note to Notes" @pointerdown.stop @keydown.esc.stop.prevent="dismissCapture(true)">
      <CustomSelect v-model="capture.destination" aria-label="Notes destination" :disabled="capture.loading || capture.saving" :options="[{ value: 'new', label: 'New Notes page' }, ...capture.pages.map((page) => ({ value: page.id, label: pageLabel(page, capture!.pages) }))]" />
      <button type="button" class="subtle-button" :disabled="capture.loading || capture.saving" @click="saveCapture(note)">Save to Notes</button>
      <p v-if="capture.error" class="field-help" role="status">{{ capture.error }}</p>
    </div>
    <textarea
      v-if="editNote === note.id"
      ref="textareas"
      v-model="note.text"
      :data-id="note.id"
      class="board-note-text"
      aria-label="Sticky note"
      placeholder="Write something…"
      maxlength="20000"
      @keydown.stop
      @keydown.esc="emit('editNote', '')"
      @pointerdown="pickNoteControl(note.id, $event)"
      @blur="emit('editNote', '')"
    ></textarea>
    <div v-else class="board-note-text read" :class="{ empty: !note.text }">{{ note.text || "Double-click to write" }}</div>
    <div v-if="note.link" class="board-note-link">
      <button
        type="button"
        class="board-note-link-open"
        :title="note.link.target"
        :aria-label="`Open ${note.link.label}`"
        @pointerdown="pickNoteControl(note.id, $event)"
        @dblclick.stop
        @click="emit('openLink', note.link)"
      >
        <Icon :name="linkIcon(note.link)" :size="12" /><span>{{ note.link.label }}</span>
      </button>
      <button
        v-if="editable && selected === note.id"
        type="button"
        class="board-note-unlink"
        title="Remove link"
        aria-label="Remove link"
        @pointerdown="pickNoteControl(note.id, $event)"
        @click="delete note.link"
      >
        <Icon name="unlink" :size="11" />
      </button>
    </div>
    <div v-if="editable && tool === 'select'" class="board-note-resize" @pointerdown="dragNote($event, note, 'resize')"></div>
  </div>
</template>
<style scoped>
.board-svg {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  pointer-events: none;
}
.board-item {
  pointer-events: visiblePainted;
  cursor: pointer;
}
.board-hit {
  stroke: transparent;
  fill: none;
  stroke-linecap: round;
}
.board-item.selected .board-hit {
  stroke: rgb(111 154 176 / 28%);
}
.board-label {
  fill: #344f5e;
  font: 600 13px Inter, system-ui, sans-serif;
  paint-order: stroke;
  stroke: #e9edf0;
  stroke-width: 4px;
}
.board-label-input {
  position: absolute;
  z-index: 2;
  width: 180px;
  padding: 4px 8px;
  border: 1px solid #6f9ab0;
  border-radius: 5px;
  background: #fff;
  color: #344f5e;
  font: 600 13px Inter, system-ui, sans-serif;
  text-align: center;
  transform: translate(-50%, -50%);
  outline: none;
}
.board-note {
  position: absolute;
  display: flex;
  flex-direction: column;
  border-radius: 4px;
  box-shadow:
    0 6px 16px rgb(39 63 78 / 12%),
    0 1px 2px rgb(39 63 78 / 10%);
  color: #3d4a33;
}
.board-note.selected {
  outline: 2px solid #6f9ab0;
  outline-offset: 2px;
}
.board-note.erasing {
  cursor: crosshair;
}
.board-note-bar {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  flex: none;
  height: 20px;
  padding: 2px 4px;
  cursor: grab;
}
.board-note-bar button {
  display: grid;
  place-items: center;
  width: 18px;
  height: 16px;
  padding: 0;
  border-radius: 3px;
  background: rgb(255 255 255 / 55%);
  color: #5d6a52;
}
.board-note-bar button:disabled {
  opacity: 0.55;
}
.sticky-save {
  position: absolute;
  inset: 22px 4px auto auto;
  width: 210px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px;
  z-index: 2;
  padding: 5px;
}
.sticky-save .field-help {
  grid-column: 1 / -1;
}
.board-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 25%);
}
.board-note-text {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 2px 12px 12px;
  border: 0;
  background: transparent;
  color: inherit;
  font: 14px/1.45 "Segoe Print", "Bradley Hand", Inter, sans-serif;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  resize: none;
  outline: none;
}
.board-note-text.read {
  user-select: none;
}
.board-note-text.empty {
  opacity: 0.45;
}
.board-note-drop {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  border-radius: 4px;
  outline: 2px dashed #6f9ab0;
  outline-offset: -4px;
  background: rgb(255 255 255 / 45%);
  color: #344f5e;
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
}
.board-note-link {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: none;
  margin: 0 10px 10px;
  min-width: 0;
}
.board-note-link-open {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 3px 7px;
  border-radius: 4px;
  background: rgb(255 255 255 / 55%);
  color: #344f5e;
  font-size: 11px;
}
.board-note-link-open:hover {
  background: rgb(255 255 255 / 80%);
}
.board-note-link-open span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-note-unlink {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 4px;
  background: rgb(255 255 255 / 55%);
  color: #5d6a52;
}
.board-note-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, rgb(0 0 0 / 12%) 50%);
  border-bottom-right-radius: 4px;
}
</style>
