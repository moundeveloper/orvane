<script setup lang="ts">
// Full-window look at a set of images: wheel or pinch zooms at the pointer,
// dragging pans, ← and → step through them. Teleported to <body> so it covers
// all of Orvane, outside the canvas transform.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";

export type PeekImage = { src: string; title: string; source?: string };
const props = defineProps<{
  items: PeekImage[];
  index: number;
  /** Optional selection: shows a Select toggle (Enter). */
  selected?: boolean;
}>();
const emit = defineEmits<{ close: []; step: [number]; toggle: [] }>();

const root = ref<HTMLElement>();
const stage = ref<HTMLElement>();
const item = computed(() => props.items[props.index]);
const view = ref({ x: 0, y: 0, scale: 1 });
const natural = ref({ width: 0, height: 0 });
let fitScale = 1;
const MIN = 0.05;
const MAX = 8;

function fit() {
  const box = stage.value?.getBoundingClientRect();
  const { width, height } = natural.value;
  if (!box || !width || !height) return;
  const pad = 48;
  fitScale = Math.min((box.width - pad) / width, (box.height - pad) / height);
  view.value = {
    scale: fitScale,
    x: (box.width - width * fitScale) / 2,
    y: (box.height - height * fitScale) / 2,
  };
}
// Zoom to `next`, keeping the point under (px, py) in place.
function zoomTo(next: number, px?: number, py?: number) {
  const box = stage.value?.getBoundingClientRect();
  if (!box) return;
  // Limits follow the fitted size too, so a small image shown large can
  // still zoom in.
  const scale = Math.min(Math.max(MAX, fitScale * 8), Math.max(Math.min(MIN, fitScale / 4), next));
  const cx = px ?? box.width / 2;
  const cy = py ?? box.height / 2;
  const { x, y, scale: old } = view.value;
  view.value = {
    scale,
    x: cx - ((cx - x) * scale) / old,
    y: cy - ((cy - y) * scale) / old,
  };
}
function loaded(event: Event) {
  const image = event.target as HTMLImageElement;
  natural.value = { width: image.naturalWidth, height: image.naturalHeight };
  fit();
}
watch(
  () => item.value?.src,
  () => (natural.value = { width: 0, height: 0 }),
);

function wheel(event: WheelEvent) {
  event.preventDefault();
  event.stopPropagation();
  const box = stage.value!.getBoundingClientRect();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1;
  // Pinch arrives as Ctrl+wheel with small deltas; mouse wheels as steps.
  const factor = Math.exp((-event.deltaY * unit) / (event.ctrlKey ? 100 : 400));
  zoomTo(view.value.scale * factor, event.clientX - box.left, event.clientY - box.top);
}
let drag: { id: number; x: number; y: number } | null = null;
const dragging = ref(false);
function down(event: PointerEvent) {
  if (event.button !== 0 && event.button !== 1) return;
  event.preventDefault();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return;
  view.value = {
    ...view.value,
    x: view.value.x + event.clientX - drag.x,
    y: view.value.y + event.clientY - drag.y,
  };
  drag.x = event.clientX;
  drag.y = event.clientY;
}
function up(event: PointerEvent) {
  if (drag?.id !== event.pointerId) return;
  drag = null;
  dragging.value = false;
}
// Double-click swaps between fitting the window and actual size.
function toggleZoom(event: MouseEvent) {
  const box = stage.value!.getBoundingClientRect();
  if (Math.abs(view.value.scale - fitScale) > 0.01) fit();
  else zoomTo(Math.max(1, fitScale * 2), event.clientX - box.left, event.clientY - box.top);
}

function keydown(event: KeyboardEvent) {
  event.stopPropagation();
  const key = event.key;
  if (key === "Escape") emit("close");
  else if (key === "ArrowRight" || key === "ArrowDown") emit("step", 1);
  else if (key === "ArrowLeft" || key === "ArrowUp") emit("step", -1);
  else if (key === "+" || key === "=") zoomTo(view.value.scale * 1.25);
  else if (key === "-" || key === "_") zoomTo(view.value.scale / 1.25);
  else if (key === "0") fit();
  else if (key === "1") zoomTo(1);
  else if (key === "Enter" && props.selected !== undefined) emit("toggle");
  else return;
  event.preventDefault();
}
const percent = computed(() => `${Math.round(view.value.scale * 100)}%`);
onMounted(() => void nextTick(() => root.value?.focus({ preventScroll: true })));
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="image-peek"
      role="dialog"
      :aria-label="`Peek: ${item?.title ?? ''}`"
      tabindex="-1"
      @keydown="keydown"
      @wheel.prevent.stop
      @pointerdown.stop
    >
      <header class="image-peek-bar">
        <strong :title="item?.title">{{ item?.title }}</strong>
        <a
          v-if="item?.source"
          :href="item.source"
          target="_blank"
          rel="noopener noreferrer"
          class="image-peek-source"
          >{{ item.source }}</a
        >
        <span class="image-peek-grow"></span>
        <span class="image-peek-zoom" aria-live="polite">{{ percent }}</span>
        <b class="image-peek-count">{{ index + 1 }} / {{ items.length }}</b>
      </header>
      <div
        ref="stage"
        class="image-peek-stage"
        :class="{ dragging }"
        @wheel="wheel"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
        @dblclick="toggleZoom"
      >
        <img
          v-if="item"
          :key="item.src"
          :src="item.src"
          :alt="item.title"
          draggable="false"
          :style="{
            visibility: natural.width ? 'visible' : 'hidden',
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }"
          @load="loaded"
        />
      </div>
      <nav class="image-peek-rail" role="toolbar" aria-label="Peek">
        <button type="button" aria-label="Close Peek" title="Close (Esc)" @click="emit('close')">
          <Icon name="close" :size="15" />
        </button>
        <span class="line"></span>
        <button type="button" aria-label="Previous image" title="Previous (←)" :disabled="items.length < 2" @click="emit('step', -1)">
          <Icon name="up" :size="15" class="left" />
        </button>
        <button type="button" aria-label="Next image" title="Next (→)" :disabled="items.length < 2" @click="emit('step', 1)">
          <Icon name="up" :size="15" class="right" />
        </button>
        <span class="line"></span>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" @click="zoomTo(view.scale * 1.25)">+</button>
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" @click="zoomTo(view.scale / 1.25)">−</button>
        <button type="button" aria-label="Fit to window" title="Fit (0)" class="fit" @click="fit">Fit</button>
        <template v-if="selected !== undefined">
          <span class="line"></span>
          <button
            type="button"
            class="select"
            :aria-pressed="selected"
            :aria-label="selected ? 'Selected' : 'Select'"
            title="Select (Enter)"
            @click="emit('toggle')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          </button>
        </template>
      </nav>
    </div>
  </Teleport>
</template>

<style scoped>
.image-peek {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 48px;
  grid-template-rows: 40px minmax(0, 1fr);
  background: rgb(233 237 240 / 92%);
  backdrop-filter: blur(6px);
  color: #455968;
  font:
    13px/1.4 "Inter Variable",
    Inter,
    system-ui,
    sans-serif;
  outline: none;
  animation: image-peek-in 160ms ease-out;
}
@keyframes image-peek-in {
  from {
    opacity: 0;
  }
}
.image-peek-bar {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 0 16px;
  border-bottom: 1px solid #dbe4e9;
  background: #f7f9fa;
}
.image-peek-bar strong {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #273f50;
  font-weight: 600;
}
.image-peek-source {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #6f8998;
  font-size: 12px;
}
.image-peek-grow {
  flex: 1;
}
.image-peek-zoom,
.image-peek-count {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #5d7381;
}
.image-peek-count {
  font-weight: 600;
  color: #273f50;
}
.image-peek-stage {
  position: relative;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.image-peek-stage.dragging {
  cursor: grabbing;
}
.image-peek-stage img {
  position: absolute;
  left: 0;
  top: 0;
  max-width: none;
  transform-origin: 0 0;
  user-select: none;
  box-shadow:
    0 1px 2px #263f5514,
    0 12px 36px #263f5526;
  will-change: transform;
}
.image-peek-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 9px 4px;
  border-left: 1px solid #dbe4e9;
  background: #f7f9fa;
}
.image-peek-rail button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 8px;
  color: #455968;
  font-size: 16px;
}
.image-peek-rail button:hover:not(:disabled) {
  background: #e5ecf0;
}
.image-peek-rail .fit {
  font-size: 11px;
  font-weight: 600;
}
.image-peek-rail .left {
  transform: rotate(-90deg);
}
.image-peek-rail .right {
  transform: rotate(90deg);
}
.image-peek-rail .line {
  width: 18px;
  height: 1px;
  margin: 3px 0;
  background: #dbe4e9;
}
.image-peek-rail .select svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.image-peek-rail .select[aria-pressed="true"] {
  background: #6f8998;
  color: #fff;
}
@media (prefers-reduced-motion: reduce) {
  .image-peek {
    animation: none;
  }
}
</style>
