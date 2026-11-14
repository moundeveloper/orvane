<script setup lang="ts">
// Board tools: a small rail on the left of the canvas and, while a drawing
// tool is active, a transparent overlay that turns pointer input into
// sticky notes, arrows (attached to the apps or notes they start and end
// on) and freehand strokes. Coordinates are converted to canvas space.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { uid, type Board, type BoardEnd, type CanvasApp } from "../model";
import { arrowPoints, BOARD_COLORS, distanceToSegment, hitStroke, NOTE_COLORS, strokePath, thin, type Tool } from "../board";

const props = defineProps<{
  board: Board;
  apps: CanvasApp[];
  allApps: CanvasApp[];
  camera: { x: number; y: number; zoom: number };
  tool: Tool;
  color: string;
}>();
const emit = defineEmits<{ "update:tool": [Tool]; "update:color": [string]; created: [id: string, kind: "note" | "arrow" | "stroke"] }>();
const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: "select", icon: "button", label: "Select (Esc)" },
  { id: "note", icon: "text", label: "Sticky note" },
  { id: "arrow", icon: "forward", label: "Arrow between apps" },
  { id: "pen", icon: "edit", label: "Draw" },
  { id: "eraser", icon: "trash", label: "Eraser" },
];
const toWorld = (x: number, y: number) => ({ x: (x - props.camera.x) / props.camera.zoom, y: (y - props.camera.y) / props.camera.zoom });
const toScreen = (p: { x: number; y: number }) => ({ x: p.x * props.camera.zoom + props.camera.x, y: p.y * props.camera.zoom + props.camera.y });

// What lies under the pointer, ignoring this overlay: an app or a note.
function endAt(clientX: number, clientY: number): BoardEnd {
  const world = toWorld(clientX, clientY);
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const app = el.closest?.<HTMLElement>(".canvas-app")?.dataset.appId;
    if (app) return { appId: app, ...world };
    const note = el.closest?.<HTMLElement>(".board-note")?.dataset.noteId;
    if (note) return { noteId: note, ...world };
  }
  return world;
}

// ---- Live drawing state (screen coordinates for the preview) ----
const drawing = ref<number[] | null>(null);
const pending = ref<{ from: BoardEnd; x: number; y: number } | null>(null);
let pointerId = -1;
function down(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    // Not an active pointer (e.g. synthetic input); events still arrive here.
  }
  pointerId = event.pointerId;
  const world = toWorld(event.clientX, event.clientY);
  if (props.tool === "note") {
    const note = { id: uid(), x: Math.round(world.x - 100), y: Math.round(world.y - 20), width: 200, height: 160, text: "", color: NOTE_COLORS[0]! };
    props.board.notes.push(note);
    emit("created", note.id, "note");
    emit("update:tool", "select");
  } else if (props.tool === "pen") drawing.value = [world.x, world.y];
  else if (props.tool === "arrow") pending.value = { from: endAt(event.clientX, event.clientY), x: event.clientX, y: event.clientY };
  else if (props.tool === "eraser") erase(world);
}
function move(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  const world = toWorld(event.clientX, event.clientY);
  if (drawing.value) drawing.value.push(world.x, world.y);
  else if (pending.value) pending.value = { ...pending.value, x: event.clientX, y: event.clientY };
  else if (props.tool === "eraser" && event.buttons & 1) erase(world);
}
function up(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  pointerId = -1;
  if (drawing.value) {
    const points = thin(drawing.value, 2 / props.camera.zoom);
    drawing.value = null;
    if (points.length >= 2) {
      const stroke = { id: uid(), points: points.slice(0, 8000), color: props.color, width: Math.max(1, 3 / Math.min(2, props.camera.zoom)) };
      props.board.strokes.push(stroke);
      emit("created", stroke.id, "stroke");
    }
  } else if (pending.value) {
    const from = pending.value.from;
    const start = toScreen(from);
    pending.value = null;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 12) return;
    const to = endAt(event.clientX, event.clientY);
    // An arrow from an app to itself is just a mis-drag.
    if ((from.appId && from.appId === to.appId) || (from.noteId && from.noteId === to.noteId)) return;
    const arrow = { id: uid(), from, to, color: props.color };
    props.board.arrows.push(arrow);
    emit("created", arrow.id, "arrow");
  }
}
function erase(p: { x: number; y: number }) {
  const tolerance = 10 / props.camera.zoom;
  const strokes = props.board.strokes.filter((s) => !hitStroke(s.points, p, tolerance + s.width / 2));
  if (strokes.length !== props.board.strokes.length) props.board.strokes = strokes;
  const arrows = props.board.arrows.filter((a) => {
    const pts = arrowPoints(a, props.apps, props.board, props.allApps);
    return !pts || distanceToSegment(p, pts.a, pts.b) > tolerance;
  });
  if (arrows.length !== props.board.arrows.length) props.board.arrows = arrows;
  const notes = props.board.notes.filter((n) => !(p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height));
  if (notes.length !== props.board.notes.length) removeNotes(notes);
}
// Removing a note also removes arrows attached to it.
function removeNotes(keep: Board["notes"]) {
  const ids = new Set(keep.map((n) => n.id));
  props.board.notes = keep;
  props.board.arrows = props.board.arrows.filter((a) => (!a.from.noteId || ids.has(a.from.noteId)) && (!a.to.noteId || ids.has(a.to.noteId)));
}
const preview = computed(() => {
  if (drawing.value) {
    const pts = drawing.value.flatMap((v, i) => (i % 2 ? [] : [toScreen({ x: v, y: drawing.value![i + 1]! }).x, toScreen({ x: v, y: drawing.value![i + 1]! }).y]));
    return { kind: "pen" as const, d: strokePath(pts) };
  }
  if (pending.value) {
    const a = toScreen(pending.value.from);
    return { kind: "arrow" as const, a, b: { x: pending.value.x, y: pending.value.y } };
  }
  return null;
});
function keys(event: KeyboardEvent) {
  if (event.key === "Escape" && props.tool !== "select") {
    drawing.value = null;
    pending.value = null;
    emit("update:tool", "select");
  }
}
onMounted(() => window.addEventListener("keydown", keys));
onBeforeUnmount(() => window.removeEventListener("keydown", keys));
const colorIndex = computed(() => Math.max(0, BOARD_COLORS.indexOf(props.color)));
</script>
<template>
  <div class="board-rail" role="toolbar" aria-label="Board tools" @pointerdown.stop>
    <button
      v-for="t in TOOLS"
      :key="t.id"
      type="button"
      :title="t.label"
      :aria-label="t.label"
      :aria-pressed="tool === t.id"
      @click="emit('update:tool', tool === t.id && t.id !== 'select' ? 'select' : t.id)"
    >
      <Icon :name="t.icon" :size="15" />
    </button>
    <span class="board-rail-line"></span>
    <button
      type="button"
      title="Colour for arrows and drawings"
      aria-label="Change drawing colour"
      @click="emit('update:color', BOARD_COLORS[(colorIndex + 1) % BOARD_COLORS.length]!)"
    >
      <span class="board-rail-swatch" :style="{ background: color }"></span>
    </button>
  </div>
  <div
    v-if="tool !== 'select'"
    class="board-capture"
    :class="`tool-${tool}`"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="up"
  >
    <svg v-if="preview" class="board-preview" aria-hidden="true">
      <path v-if="preview.kind === 'pen'" :d="preview.d" :stroke="color" :stroke-width="Math.max(1, 3 * Math.min(1, camera.zoom))" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      <line v-else :x1="preview.a.x" :y1="preview.a.y" :x2="preview.b.x" :y2="preview.b.y" :stroke="color" stroke-width="2.5" stroke-dasharray="6 5" />
    </svg>
    <p class="board-hint">
      {{
        tool === "note"
          ? "Click to place a sticky note"
          : tool === "arrow"
            ? "Drag from one app or note to another"
            : tool === "pen"
              ? "Draw freely"
              : "Drag over items to erase them"
      }}
      · Esc to stop
    </p>
  </div>
</template>
<style scoped>
.board-rail {
  position: fixed;
  left: 14px;
  top: 50%;
  z-index: 12;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px;
  border-radius: 9px;
  background: rgb(247 249 250 / 92%);
  box-shadow:
    0 6px 18px rgb(39 63 78 / 10%),
    0 1px 3px rgb(39 63 78 / 8%);
  transform: translateY(-50%);
}
.board-rail button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 6px;
  background: none;
  color: #607583;
}
.board-rail button:hover {
  background: #e3edf2;
}
.board-rail button[aria-pressed="true"] {
  background: #dce9f0;
  color: #2f4856;
  box-shadow: inset 0 0 0 1px #b6cbd6;
}
.board-rail-line {
  height: 1px;
  margin: 2px 5px;
  background: #e2eaee;
}
.board-rail-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 2px rgb(255 255 255 / 70%);
}
.board-capture {
  position: fixed;
  inset: 0;
  z-index: 8;
  touch-action: none;
}
.board-capture.tool-pen,
.board-capture.tool-arrow,
.board-capture.tool-note {
  cursor: crosshair;
}
.board-capture.tool-eraser {
  cursor: cell;
}
.board-preview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.board-hint {
  position: fixed;
  left: 50%;
  top: 58px;
  margin: 0;
  padding: 5px 11px;
  border-radius: 6px;
  background: rgb(52 79 94 / 88%);
  color: #fff;
  font-size: 12px;
  transform: translateX(-50%);
  pointer-events: none;
}
</style>
