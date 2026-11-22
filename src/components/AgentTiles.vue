<script setup lang="ts">
// Agent Sessions split panes, laid out like Hyprland tiles (UI Maker
// agent-session-workspace v2): 10px gaps, 10px corners, a 2px border that
// fades to the accent on focus, no drawn divider. Every pane reflows at once
// with easeOutQuint; new panes pop in from 87%. One pane fills the app with
// no gaps, exactly like a single session view.
//
// Keys: Alt+Shift+D split (Alt+Shift+= right, Alt+Shift+- down), Alt+arrows
// move focus, Alt+Shift+arrows swap panes, Ctrl+Shift+W close the pane.
// Drag a pane by its title to move it; drag a gap to resize, double-click it
// (or Enter on it) for an even split.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  findSplit,
  insertAt,
  layoutTiles,
  leaves,
  neighbour,
  replaceLeaf,
  swapLeaves,
  TILE_MIN,
  type TileEdge,
  type TileNode,
  type TileRect,
} from "../agentTiles";

// `nested`: a single-pane layout inside a pane; it leaves keys to the host.
const props = defineProps<{ root: TileNode; focus: string; nested?: boolean }>();
const emit = defineEmits<{
  "update:root": [root: TileNode];
  "update:focus": [id: string];
  split: [dir: "row" | "column" | "auto"];
  close: [id: string];
}>();

const DURATION = 480;
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)"; // Hyprland easeOutQuint
const POP = 0.87; // windowsIn / windowsOut popin 87%
const FADE_IN = 173;
const FADE_EASE = "cubic-bezier(0.5, 0.5, 0.75, 1)"; // almostLinear
const OUT = 149;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const box = ref<HTMLElement>();
const size = reactive({ w: 0, h: 0 });
type Drag = {
  id: string; x0: number; y0: number; started: boolean; dx: number; dy: number;
  home?: TileRect; remaining?: TileNode; targets?: Map<string, TileRect>;
  target?: string; edge?: TileEdge; slot?: TileRect; scale?: number; origin?: string;
};
const drag = ref<Drag | null>(null);
const preview = ref<TileNode | null>(null);
const shown = computed(() => preview.value ?? props.root);
const single = computed(() => props.root.type === "pane" && !drag.value?.started);
const layout = computed(() => layoutTiles(shown.value, size.w, size.h));

// Panes keep their DOM position while the tree changes, so a moved chat keeps
// its scroll, caret and draft.
const order = ref<string[]>([]);
watch(
  () => [...leaves(shown.value), drag.value?.started ? drag.value.id : ""],
  (ids) => {
    const live = ids.filter(Boolean);
    order.value = [...order.value.filter((id) => live.includes(id)), ...live.filter((id) => !order.value.includes(id))];
  },
  { immediate: true, flush: "sync" },
);
const rectOf = (id: string) =>
  drag.value?.started && drag.value.id === id ? drag.value.home! : layout.value.rects.get(id);
const place = (rect?: TileRect): Record<string, string> =>
  rect ? { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` } : { display: "none" };
function tileStyle(id: string) {
  const style: Record<string, string> = place(rectOf(id));
  const d = drag.value;
  if (d?.started && d.id === id) {
    style.transform = `translate(${d.dx}px, ${d.dy}px)`;
    style.scale = String(d.scale);
    style.transformOrigin = d.origin!;
  }
  return style;
}

/* ---------- reflow: measure, then move from where each pane was ---------- */
const tileEls = new Map<string, HTMLElement>();
const frameEls = new Map<string, HTMLElement>();
const setEl = (map: Map<string, HTMLElement>, id: string) => (el: unknown) => {
  if (el instanceof HTMLElement) map.set(id, el);
  else map.delete(id);
};
const running = new Map<string, Animation[]>();
let last = new Map<string, TileRect>();
let instant = false;
let settled = false;
const landing = new Map<string, TileRect>();
const same = (a: TileRect, b: TileRect) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
function stop(id: string) {
  running.get(id)?.forEach((a) => a.cancel());
  running.delete(id);
}
function visual(id: string): TileRect | undefined {
  const frame = frameEls.get(id);
  if (!running.get(id)?.length || !frame) return last.get(id);
  const s = getComputedStyle(frame);
  return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height) };
}
function morph(id: string, from: TileRect, to: TileRect) {
  const tile = tileEls.get(id),
    frame = frameEls.get(id);
  if (!tile || !frame) return;
  const timing = { duration: DURATION, easing: EASE };
  // A growing pane is revealed from its old size; a shrinking one takes its
  // new size at once and only travels. Text never leaves its own background.
  const w0 = Math.min(from.w, to.w),
    h0 = Math.min(from.h, to.h);
  const anims = [
    frame.animate(
      [
        { left: `${from.x}px`, top: `${from.y}px`, width: `${w0}px`, height: `${h0}px` },
        { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px` },
      ],
      timing,
    ),
    tile.animate(
      [
        { translate: `${from.x - to.x}px ${from.y - to.y}px`, clipPath: `inset(0 ${to.w - w0}px ${to.h - h0}px 0 round 10px)` },
        { translate: "0 0", clipPath: "inset(0 0 0 0 round 10px)" },
      ],
      timing,
    ),
  ];
  if (!same({ ...from, x: 0, y: 0 }, { ...to, x: 0, y: 0 }))
    anims.push(tile.animate([{ opacity: 0.9 }, { opacity: 1 }], { duration: 336, easing: "cubic-bezier(0.33, 1, 0.68, 1)" }));
  running.set(id, anims);
  anims[0]!.finished.then(() => running.delete(id), () => {});
}
function popIn(id: string) {
  const els = [tileEls.get(id), frameEls.get(id)].filter(Boolean) as HTMLElement[];
  const anims = els.flatMap((el) => [
    el.animate([{ scale: POP }, { scale: 1 }], { duration: DURATION, easing: EASE }),
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN, easing: FADE_EASE }),
  ]);
  running.set(id, anims);
  anims[0]?.finished.then(() => running.delete(id), () => {});
}
watch(
  layout,
  (next) => {
    const animate = settled && !instant && !reduced();
    const lifted = drag.value?.started ? drag.value.id : "";
    for (const [id, rect] of next.rects) {
      if (id === lifted) continue;
      const before = landing.get(id) ?? visual(id);
      landing.delete(id);
      if (!animate) continue;
      if (!before) {
        stop(id);
        popIn(id);
      } else if (!same(before, rect)) {
        stop(id);
        morph(id, before, rect);
      }
    }
    last = new Map(next.rects);
    if (lifted && drag.value?.home) last.set(lifted, drag.value.home);
    instant = false;
    if (size.w > 0 && size.h > 0) settled = true;
  },
  { flush: "post" },
);
function leave(el: Element, done: () => void) {
  const node = el as HTMLElement;
  if (reduced()) return done();
  node.style.zIndex = "0";
  node.style.pointerEvents = "none";
  node
    .animate([{ scale: 1, opacity: 1 }, { scale: POP, opacity: 0 }], { duration: OUT, easing: "linear", fill: "forwards" })
    .finished.then(done, done);
}

/* ---------- focus ---------- */
function focusPane(id: string, caret = false) {
  if (id !== props.focus) emit("update:focus", id);
  if (!caret) return;
  void nextTick(() => {
    const tile = tileEls.get(id);
    const field = tile?.querySelector<HTMLElement>(".cs-composer textarea, textarea, input:not([type=hidden])");
    (field ?? tile)?.focus({ preventScroll: true });
  });
}

/* ---------- gaps: the resize handle, never drawn ---------- */
const edges = ref(new Set<string>());
let hintTimer: ReturnType<typeof setTimeout> | undefined;
const resizing = ref("");
function gapStyle(g: { dir: "row" | "column"; x: number; y: number; w: number; h: number }) {
  const hit = 12;
  return g.dir === "row"
    ? place({ x: g.x + g.w / 2 - hit / 2, y: g.y, w: hit, h: g.h })
    : place({ x: g.x, y: g.y + g.h / 2 - hit / 2, w: g.w, h: hit });
}
function edgeTiles(gapId: string) {
  const g = layout.value.gaps.find((item) => item.id === gapId);
  const out = new Set<string>();
  if (!g) return out;
  for (const [id, r] of layout.value.rects) {
    if (g.dir === "row" && (Math.abs(r.x + r.w - g.x) < 1 || Math.abs(r.x - (g.x + g.w)) < 1) && r.y < g.y + g.h && r.y + r.h > g.y) out.add(id);
    if (g.dir === "column" && (Math.abs(r.y + r.h - g.y) < 1 || Math.abs(r.y - (g.y + g.h)) < 1) && r.x < g.x + g.w && r.x + r.w > g.x) out.add(id);
  }
  return out;
}
function hint(gapId: string | null, delay = 0) {
  clearTimeout(hintTimer);
  if (!gapId) return void (edges.value = new Set());
  if (delay) hintTimer = setTimeout(() => (edges.value = edgeTiles(gapId)), delay);
  else edges.value = edgeTiles(gapId);
}
function setRatio(gapId: string, ratio: number, animate: boolean) {
  const node = findSplit(props.root, gapId);
  if (!node) return;
  instant = !animate;
  node.ratio = Math.round(Math.min(1 - TILE_MIN, Math.max(TILE_MIN, ratio)) * 1000) / 1000;
}
function gapDown(event: PointerEvent, gapId: string) {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
  resizing.value = gapId;
  hint(gapId);
  const move = (e: PointerEvent) => {
    const g = layout.value.gaps.find((item) => item.id === gapId);
    const r = box.value?.getBoundingClientRect();
    if (!g || !r) return;
    const scale = r.width / (box.value!.offsetWidth || 1);
    const x = (e.clientX - r.left) / scale - g.box.x,
      y = (e.clientY - r.top) / scale - g.box.y;
    setRatio(gapId, g.dir === "row" ? x / g.box.w : y / g.box.h, false);
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
    resizing.value = "";
    hint(null);
    emit("update:root", props.root);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
}
function gapKey(event: KeyboardEvent, gapId: string, dir: "row" | "column") {
  const node = findSplit(props.root, gapId);
  if (!node) return;
  const back = dir === "row" ? "ArrowLeft" : "ArrowUp",
    forward = dir === "row" ? "ArrowRight" : "ArrowDown";
  let ratio: number | null = null;
  if (event.key === back || event.key === forward) ratio = node.ratio + (event.key === back ? -0.05 : 0.05);
  else if (event.key === "Enter" || event.key === "Home") ratio = 0.5;
  if (ratio === null) return;
  event.preventDefault();
  event.stopPropagation();
  setRatio(gapId, ratio, true);
  emit("update:root", props.root);
}
function evenOut(gapId: string) {
  setRatio(gapId, 0.5, true);
  emit("update:root", props.root);
}

/* ---------- drag a pane by its title: the others make room live ---------- */
function tileDown(event: PointerEvent, id: string) {
  focusPane(id);
  const grip = (event.target as HTMLElement).closest("[data-tile-grip]");
  if (!grip || event.button !== 0 || single.value) return;
  drag.value = { id, x0: event.clientX, y0: event.clientY, started: false, dx: 0, dy: 0 };
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", dragUp);
  document.addEventListener("pointercancel", dragCancel);
}
function boxPoint(e: PointerEvent) {
  const r = box.value!.getBoundingClientRect();
  const scale = r.width / (box.value!.offsetWidth || 1);
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale, scale };
}
function dragMove(e: PointerEvent) {
  const d = drag.value;
  if (!d) return;
  const p = boxPoint(e);
  d.dx = (e.clientX - d.x0) / p.scale;
  d.dy = (e.clientY - d.y0) / p.scale;
  if (!d.started) {
    if (Math.hypot(d.dx, d.dy) < 5) return;
    const home = layout.value.rects.get(d.id);
    if (!home) return dragCancel();
    d.home = home;
    d.remaining = replaceLeaf(props.root, d.id, null)!;
    d.targets = layoutTiles(d.remaining, size.w, size.h).rects;
    d.scale = Math.max(0.6, Math.min(1, 380 / home.w));
    const start = boxPoint({ clientX: d.x0, clientY: d.y0 } as PointerEvent);
    d.origin = `${start.x - home.x}px ${start.y - home.y}px`;
    stop(d.id);
    d.started = true;
    preview.value = d.remaining;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
  let target: string | undefined, edge: TileEdge | undefined;
  for (const [id, r] of d.targets!) {
    if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) continue;
    const fx = (p.x - r.x) / r.w - 0.5,
      fy = (p.y - r.y) / r.h - 0.5;
    edge = Math.abs(fx) > Math.abs(fy) ? (fx < 0 ? "left" : "right") : fy < 0 ? "top" : "bottom";
    target = id;
  }
  if (target === d.target && edge === d.edge) return;
  d.target = target;
  d.edge = edge;
  preview.value = target ? insertAt(d.remaining!, target, d.id, edge!) : d.remaining!;
  d.slot = target ? layoutTiles(preview.value, size.w, size.h).rects.get(d.id) : undefined;
}
function endDrag(commit: boolean) {
  document.removeEventListener("pointermove", dragMove);
  document.removeEventListener("pointerup", dragUp);
  document.removeEventListener("pointercancel", dragCancel);
  const d = drag.value;
  if (!d) return;
  if (!d.started) return void (drag.value = null);
  const tile = tileEls.get(d.id);
  if (tile && box.value) {
    const t = tile.getBoundingClientRect(),
      r = box.value.getBoundingClientRect(),
      scale = r.width / (box.value.offsetWidth || 1);
    landing.set(d.id, { x: (t.left - r.left) / scale, y: (t.top - r.top) / scale, w: t.width / scale, h: t.height / scale });
  }
  const next = commit && d.target ? preview.value : null;
  drag.value = null;
  preview.value = null;
  if (next) emit("update:root", next);
  focusPane(d.id, true);
}
const dragUp = () => endDrag(true);
const dragCancel = () => endDrag(false);

/* ---------- keys ---------- */
function keys(event: KeyboardEvent) {
  if (props.nested || event.defaultPrevented || event.isComposing) return;
  if (event.key === "Escape" && drag.value?.started) {
    event.preventDefault();
    event.stopPropagation();
    return endDrag(false);
  }
  const ids = leaves(props.root);
  let handled = true;
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.startsWith("Arrow")) {
    const next = neighbour(layout.value.rects, props.focus, event.key);
    if (!next) handled = false;
    else if (event.shiftKey) {
      emit("update:root", swapLeaves(props.root, props.focus, next));
      focusPane(props.focus, true);
    } else focusPane(next, true);
  } else if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && ["KeyD", "Equal", "Minus"].includes(event.code)) {
    emit("split", event.code === "Equal" ? "row" : event.code === "Minus" ? "column" : "auto");
  } else if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === "KeyW" && ids.length > 1) {
    emit("close", props.focus);
  } else handled = false;
  if (!handled) return;
  event.preventDefault();
  event.stopPropagation();
}

let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (!box.value) return;
    instant = true;
    size.w = box.value.clientWidth;
    size.h = box.value.clientHeight;
  });
  if (box.value) observer.observe(box.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(hintTimer);
  endDrag(false);
});
defineExpose({ rects: () => layout.value.rects });
</script>

<template>
  <div
    ref="box"
    class="agent-tiles"
    :class="{ single, moving: drag?.started, resizing: !!resizing }"
    @keydown="keys"
  >
    <TransitionGroup tag="div" class="agent-tiles-layer" :css="false" @leave="leave">
      <div
        v-for="id in order"
        :key="id"
        :ref="setEl(tileEls, id)"
        class="agent-tile"
        :class="{ focused: id === focus, lifted: drag?.started && drag.id === id }"
        :data-tile="id"
        :style="tileStyle(id)"
        @pointerdown.capture="tileDown($event, id)"
        @focusin="focusPane(id)"
      >
        <slot name="pane" :id="id" />
      </div>
    </TransitionGroup>
    <TransitionGroup tag="div" class="agent-tiles-layer agent-tiles-frames" :css="false" @leave="leave">
      <div
        v-for="id in order"
        :key="id"
        :ref="setEl(frameEls, id)"
        class="agent-tile-frame"
        :class="{ focused: id === focus, edge: edges.has(id), lifted: drag?.started && drag.id === id }"
        :style="place(rectOf(id))"
      ></div>
    </TransitionGroup>
    <div
      v-for="g in single ? [] : layout.gaps"
      :key="g.id"
      class="agent-tile-gap"
      :class="g.dir"
      role="separator"
      tabindex="0"
      :aria-orientation="g.dir === 'row' ? 'vertical' : 'horizontal'"
      aria-label="Resize session panes"
      aria-valuemin="20"
      aria-valuemax="80"
      :aria-valuenow="Math.round((findSplit(root, g.id)?.ratio ?? 0.5) * 100)"
      :style="gapStyle(g)"
      @pointerenter="!resizing && hint(g.id, 300)"
      @pointerleave="!resizing && hint(null)"
      @pointerdown="gapDown($event, g.id)"
      @dblclick="evenOut(g.id)"
      @keydown="gapKey($event, g.id, g.dir)"
      @focus="hint(g.id)"
      @blur="!resizing && hint(null)"
    ></div>
    <div v-if="drag?.started && drag.slot" class="agent-tile-drop" :style="place(drag.slot)"></div>
  </div>
</template>

<style scoped>
.agent-tiles {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #e9edf0;
}
.agent-tiles.single {
  background: transparent;
}
.agent-tiles-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.agent-tiles-frames {
  z-index: 2;
}
.agent-tile {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  pointer-events: auto;
  border-radius: 10px;
  background: var(--surface, #f7f9fa);
  container-type: inline-size;
}
.agent-tile > :deep(*) {
  flex: 1;
  min-height: 0;
}
.single .agent-tile {
  border-radius: 0;
  background: transparent;
  container-type: normal;
}
.agent-tile.lifted {
  z-index: 5;
  pointer-events: none;
  box-shadow: 0 0 0 1px #d3dee5, 0 6px 18px rgb(69 89 104 / 24%);
  transition: scale 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.agent-tile-frame {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #dbe4ea;
  border-radius: 10px;
  pointer-events: none;
  transition: border-color 200ms ease;
}
.agent-tile-frame::after {
  content: "";
  position: absolute;
  inset: -2px;
  padding: 2px;
  border-radius: inherit;
  background: linear-gradient(135deg, #6f8998, #a9bfcb 55%, #7f9caa);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  transition: opacity 540ms cubic-bezier(0.23, 1, 0.32, 1);
}
.agent-tile-frame.focused::after {
  opacity: 1;
}
.agent-tile-frame.edge {
  border-color: #b9cbd5;
}
.agent-tile-frame.lifted,
.single .agent-tile-frame {
  display: none;
}
.agent-tile-gap {
  position: absolute;
  z-index: 3;
  outline: 0;
}
.agent-tile-gap.row {
  cursor: col-resize;
}
.agent-tile-gap.column {
  cursor: row-resize;
}
.resizing,
.resizing * {
  user-select: none;
}
.moving,
.moving * {
  cursor: grabbing !important;
  user-select: none;
}
.agent-tiles:not(.single) :deep([data-tile-grip]) {
  cursor: grab;
}
.agent-tiles:not(.single) :deep(.cs-back) {
  display: none !important;
}
.agent-tile-drop {
  position: absolute;
  z-index: 4;
  pointer-events: none;
  border-radius: 10px;
  background: rgb(111 137 152 / 12%);
  box-shadow: inset 0 0 0 1px #6f8998;
  transition: left 480ms cubic-bezier(0.23, 1, 0.32, 1), top 480ms cubic-bezier(0.23, 1, 0.32, 1),
    width 480ms cubic-bezier(0.23, 1, 0.32, 1), height 480ms cubic-bezier(0.23, 1, 0.32, 1);
}
@media (prefers-reduced-motion: reduce) {
  .agent-tile,
  .agent-tile-frame,
  .agent-tile-frame::after,
  .agent-tile-drop {
    transition: none;
  }
}
</style>
