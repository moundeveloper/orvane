<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{ label: string; minWidth?: number }>();
const viewport = ref<HTMLElement>();
const width = ref(0);
const zoom = ref(1);
const dragging = ref(false);
const minZoom = 0.4;
const maxZoom = 2;
let observer: ResizeObserver;
let drag:
  { id: number; x: number; y: number; left: number; top: number } | undefined;

function screenScale(box: HTMLElement) {
  return box.getBoundingClientRect().width / box.offsetWidth || 1;
}
async function setZoom(value: number, point?: { x: number; y: number }) {
  const box = viewport.value;
  if (!box) return;
  const next =
    Math.round(Math.max(minZoom, Math.min(maxZoom, value)) * 100) / 100;
  if (next === zoom.value) return;
  const x = point?.x ?? box.clientWidth / 2;
  const y = point?.y ?? box.clientHeight / 2;
  const left = ((box.scrollLeft + x) * next) / zoom.value - x;
  const top = ((box.scrollTop + y) * next) / zoom.value - y;
  zoom.value = next;
  await nextTick();
  box.scrollTo(left, top);
}
function wheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey) || !viewport.value) return;
  event.stopPropagation();
  event.preventDefault();
  const box = viewport.value;
  const bounds = box.getBoundingClientRect();
  const scale = screenScale(box);
  const delta =
    event.deltaY *
    (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1);
  void setZoom(zoom.value * Math.exp(-delta * 0.003), {
    x: (event.clientX - bounds.left) / scale,
    y: (event.clientY - bounds.top) / scale,
  });
}
function startPan(event: PointerEvent) {
  const box = viewport.value;
  if (
    event.pointerType !== "mouse" ||
    event.button !== 0 ||
    event.shiftKey ||
    !box ||
    (box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight)
  )
    return;
  if (
    event.clientX >=
      box.getBoundingClientRect().left + box.clientWidth * screenScale(box) ||
    event.clientY >=
      box.getBoundingClientRect().top + box.clientHeight * screenScale(box)
  )
    return;
  event.stopPropagation();
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: box.scrollLeft,
    top: box.scrollTop,
  };
  box.setPointerCapture(event.pointerId);
  dragging.value = true;
}
function pan(event: PointerEvent) {
  const box = viewport.value;
  if (!box || !drag || drag.id !== event.pointerId) return;
  const scale = screenScale(box);
  box.scrollTo(
    drag.left - (event.clientX - drag.x) / scale,
    drag.top - (event.clientY - drag.y) / scale,
  );
}
function stopPan(event: PointerEvent) {
  if (event.pointerId !== drag?.id) return;
  drag = undefined;
  dragging.value = false;
}
onMounted(() => {
  const box = viewport.value!;
  observer = new ResizeObserver(() => {
    width.value = box.clientWidth;
  });
  observer.observe(box);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="ex-diagram">
    <div class="ex-diagram-toolbar" role="group" aria-label="Diagram controls">
      <span>Drag to pan</span>
      <button
        type="button"
        aria-label="Zoom out"
        :disabled="zoom <= minZoom"
        @click="setZoom(zoom / 1.25)"
      >
        −
      </button>
      <button
        type="button"
        aria-label="Reset diagram zoom"
        title="Reset to 100%"
        @click="setZoom(1)"
      >
        {{ Math.round(zoom * 100) }}%
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        :disabled="zoom >= maxZoom"
        @click="setZoom(zoom * 1.25)"
      >
        +
      </button>
    </div>
    <div
      ref="viewport"
      class="ex-diagram-viewport"
      :class="{ 'ex-diagram-dragging': dragging }"
      tabindex="0"
      role="region"
      :aria-label="label"
      @wheel="wheel"
      @pointerdown="startPan"
      @pointermove="pan"
      @pointerup="stopPan"
      @pointercancel="stopPan"
      @lostpointercapture="stopPan"
    >
      <div
        class="ex-diagram-content"
        :style="{
          zoom,
          width: props.minWidth
            ? Math.max(width, props.minWidth) + 'px'
            : 'max-content',
        }"
      >
        <slot />
      </div>
    </div>
  </div>
</template>
