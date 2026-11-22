<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import {
  rewindVisible,
  type RewindApp,
  type RewindEntry,
} from "../canvasRewind";
import Icon from "./Icon.vue";

const props = defineProps<{
  entries: RewindEntry[];
  apps: RewindApp[];
  camera: { x: number; y: number; zoom: number };
  canRestore: boolean;
  busy: boolean;
  loading: boolean;
  error: string;
}>();
const preview = defineModel<boolean>({ required: true });
const emit = defineEmits<{
  close: [];
  restore: [entry: RewindEntry, appId?: string];
}>();
const index = ref<number | null>(null);
const selected = ref("");
const rail = ref<HTMLElement>();
const now = Date.now();
const active = computed(() =>
  index.value === null ? undefined : props.entries[index.value],
);
const allIds = computed(() => new Set(props.apps.map((app) => app.id)));
const current = computed(
  () => new Map(props.apps.filter(rewindVisible).map((app) => [app.id, app])),
);
const past = computed(
  () => active.value?.state.apps.filter(rewindVisible) ?? [],
);
const later = computed(() => {
  const seen = new Set(past.value.map((app) => app.id));
  return [...current.value.values()].filter((app) => !seen.has(app.id));
});
const latest = computed(() => Math.max(now, props.entries.at(-1)?.at ?? now));
const start = computed(() =>
  Math.min(latest.value - 60_000, props.entries[0]?.at ?? latest.value),
);
const end = computed(() => latest.value + (latest.value - start.value) * 0.035);
const percent = (at: number) =>
  ((at - start.value) / (end.value - start.value)) * 100;
const markers = computed(() =>
  Array.from(
    { length: 6 },
    (_, i) => start.value + ((end.value - start.value) * i) / 5,
  ),
);
const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dayTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const markerLabel = (stamp: number) =>
  end.value - start.value < 600_000
    ? clock.format(stamp)
    : end.value - start.value < 86_400_000
      ? time.format(stamp)
      : new Date(stamp).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
const label = computed(() =>
  active.value ? dayTime.format(active.value.at) : "Live",
);

function pick(step: number | null) {
  if (props.busy) return;
  index.value = step;
  selected.value = "";
  preview.value = step !== null;
}
function move(direction: number, hour = false) {
  const items = props.entries;
  const at = index.value ?? items.length;
  if (!items.length) return;
  if (hour) {
    const target = (active.value?.at ?? end.value) + direction * 3_600_000;
    let found = -1;
    if (direction < 0) {
      for (let i = at - 1; i >= 0; i--) {
        if (items[i]!.at <= target) {
          found = i;
          break;
        }
      }
    } else found = items.findIndex((entry, i) => entry.at >= target && i > at);
    if (found >= 0) return pick(found);
    return pick(direction < 0 ? 0 : null);
  }
  const next = Math.max(0, at + direction);
  pick(next >= items.length ? null : next);
}
function seek(event: PointerEvent) {
  const rect = rail.value?.getBoundingClientRect();
  if (!rect || !props.entries.length) return;
  const ratio = Math.max(
    0,
    Math.min(1, (event.clientX - rect.left) / rect.width),
  );
  if (ratio >= 0.992) return pick(null);
  const at = start.value + ratio * (end.value - start.value);
  const nearest = props.entries.reduce(
    (best, entry, i, entries) =>
      Math.abs(entry.at - at) < Math.abs(entries[best]!.at - at) ? i : best,
    0,
  );
  pick(nearest);
}
function grab(event: PointerEvent) {
  if (event.button !== 0 || props.busy) return;
  rail.value?.setPointerCapture(event.pointerId);
  rail.value?.focus({ preventScroll: true });
  seek(event);
}
function restore(one = false) {
  if (!active.value || !props.canRestore || props.busy) return;
  if (one && (!selected.value || !allIds.value.has(selected.value))) return;
  emit("restore", active.value, one ? selected.value : undefined);
}
function key(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return;
  if (event.key === "Escape") emit("close");
  else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
    move(event.key === "ArrowLeft" ? -1 : 1, event.shiftKey);
  else if (event.key === "Home") {
    if (props.entries.length) pick(0);
  } else if (event.key === "End") pick(null);
  else if (event.key.toLowerCase() === "a") restore(true);
  else if (
    event.key === "Enter" &&
    !(event.target instanceof HTMLButtonElement)
  )
    restore();
  else return;
  event.preventDefault();
}
const boxStyle = (app: RewindApp) => ({
  left: app.x + "px",
  top: app.y + "px",
  width: app.width + "px",
  height: app.height + "px",
});
onMounted(
  () => void nextTick(() => rail.value?.focus({ preventScroll: true })),
);
defineExpose({ key });
</script>

<template>
  <div
    v-if="active"
    class="rewind-plane"
    :style="{
      transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
    }"
  >
    <button
      v-for="app in past"
      :key="app.id"
      type="button"
      class="rewind-window"
      :class="{ returns: !current.has(app.id), selected: selected === app.id }"
      :style="boxStyle(app)"
      :aria-pressed="selected === app.id"
      :disabled="!allIds.has(app.id) || busy"
      @pointerdown.stop
      @click="selected = app.id"
    >
      <span
        ><Icon :name="app.icon || 'app'" :size="14" />{{
          app.name || "Untitled app"
        }}</span
      >
      <small v-if="!allIds.has(app.id)">No longer available</small>
      <small v-else-if="!current.has(app.id)">Comes back</small>
      <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
    </button>
    <div
      v-for="app in later"
      :key="app.id"
      class="rewind-window later"
      :style="boxStyle(app)"
    >
      <span
        ><Icon :name="app.icon || 'app'" :size="14" />{{
          app.name || "Untitled app"
        }}</span
      >
      <small>Added later</small>
    </div>
  </div>
  <section
    class="rewind-bar"
    aria-label="Canvas history"
    @pointerdown.stop
    @wheel.stop
  >
    <header>
      <strong>{{ label }}</strong>
      <span v-if="loading">Loading canvas history…</span>
      <span v-else-if="active"
        >{{ active.description }} · {{ past.length }}
        {{ past.length === 1 ? "app" : "apps"
        }}<span v-if="active.state.layoutName">
          · {{ active.state.layoutName }}</span
        ></span
      >
      <span v-else>{{
        entries.length
          ? "Move the playhead to preview an arrangement."
          : "Canvas history starts with your next saved change."
      }}</span>
      <div class="rewind-actions">
        <button
          type="button"
          :disabled="!active || !selected || !canRestore || busy"
          @click="restore(true)"
        >
          Restore one app <kbd>A</kbd>
        </button>
        <button
          type="button"
          class="rewind-primary"
          :disabled="!active || !canRestore || busy"
          @click="restore()"
        >
          Restore canvas <kbd>Enter</kbd>
        </button>
        <button
          type="button"
          aria-label="Back to live"
          title="Back to live (Esc)"
          :disabled="busy"
          @click="emit('close')"
        >
          <Icon name="close" :size="14" />
        </button>
      </div>
    </header>
    <div
      ref="rail"
      class="rewind-rail"
      tabindex="0"
      role="slider"
      aria-label="Canvas history playhead"
      :aria-valuemin="0"
      :aria-valuemax="entries.length"
      :aria-valuenow="index ?? entries.length"
      :aria-valuetext="label"
      @pointerdown="grab"
      @pointermove="rail?.hasPointerCapture($event.pointerId) && seek($event)"
    >
      <div class="rewind-ticks" aria-hidden="true" />
      <i
        v-for="entry in entries"
        :key="entry.revision"
        class="rewind-dot"
        :class="{ mcp: entry.author === 'mcp', closed: entry.closed }"
        :style="{ left: percent(entry.at) + '%' }"
        :title="entry.description"
      />
      <div
        class="rewind-head"
        :style="{ left: (active ? percent(active.at) : 100) + '%' }"
        aria-hidden="true"
      />
      <div class="rewind-live" aria-hidden="true">LIVE</div>
      <div class="rewind-labels" aria-hidden="true">
        <span v-for="stamp in markers" :key="stamp">{{
          markerLabel(stamp)
        }}</span>
      </div>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <footer>
      <span
        ><i class="rewind-dot" /> You <i class="rewind-dot mcp" /> MCP
        <i class="rewind-dot closed" /> Closed</span
      >
      <span
        ><kbd>←</kbd> <kbd>→</kbd> Step <kbd>Shift</kbd> + arrow · Hour
        <kbd>Esc</kbd> Live</span
      >
    </footer>
  </section>
</template>

<style scoped>
.rewind-plane {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  pointer-events: none;
}
.rewind-window {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 9px;
  align-items: start;
  overflow: hidden;
  padding: 12px;
  border: 1px solid #ccd8df;
  border-radius: 10px;
  background: #f7f9fa;
  color: #273f50;
  text-align: left;
  box-shadow: 0 2px 10px #263f5517;
  pointer-events: auto;
}
.rewind-window.returns {
  border: 1px dashed #8296a2;
}
.rewind-window.selected {
  outline: 2px solid #6f8998;
}
.rewind-window.later {
  opacity: 0.38;
  pointer-events: none;
}
.rewind-window span {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
}
.rewind-window small {
  color: #5d7381;
}
.rewind-window i {
  width: 62%;
  height: 6px;
  border-radius: 3px;
  background: #e3eaee;
}
.rewind-window i:nth-of-type(2) {
  width: 43%;
}
.rewind-window i:nth-of-type(3) {
  width: 57%;
}
.rewind-bar {
  position: fixed;
  z-index: 700;
  left: 50%;
  bottom: 74px;
  transform: translateX(-50%);
  width: min(860px, calc(100vw - 30px));
  padding: 10px 14px;
  border: 1px solid #ffffffa3;
  border-radius: 12px;
  background: rgb(247 250 252 / 86%);
  backdrop-filter: blur(8px) saturate(1.2);
  box-shadow:
    0 1px 2px #263f5514,
    0 12px 30px #263f5526;
  color: #455968;
  font-size: 12px;
}
.rewind-bar header,
.rewind-bar footer,
.rewind-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rewind-bar strong {
  color: #273f50;
  font-variant-numeric: tabular-nums;
}
.rewind-actions {
  margin-left: auto;
}
.rewind-actions button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  color: inherit;
  font: inherit;
}
.rewind-actions button:disabled {
  opacity: 0.55;
}
.rewind-actions .rewind-primary {
  background: #365f78;
  color: #fff;
  border-color: #365f78;
}
.rewind-rail {
  position: relative;
  height: 42px;
  margin: 7px 10px 2px;
  cursor: ew-resize;
  touch-action: none;
}
.rewind-ticks {
  position: absolute;
  inset: 9px 0 auto;
  height: 11px;
  background: repeating-linear-gradient(
    90deg,
    #b6c6cf 0px 1px,
    transparent 1px calc(100% / 36)
  );
}
.rewind-dot {
  width: 8px;
  height: 8px;
  border: 1px solid #fbfcfd;
  border-radius: 50%;
  background: #6f8998;
}
.rewind-rail .rewind-dot {
  position: absolute;
  top: 7px;
  transform: translateX(-50%);
}
.rewind-dot.mcp {
  background: #365f78;
}
.rewind-dot.closed {
  background: #a0624f;
}
.rewind-head {
  position: absolute;
  top: 3px;
  height: 20px;
  width: 2px;
  background: #365f78;
  pointer-events: none;
}
.rewind-head::before {
  content: "";
  position: absolute;
  top: -3px;
  left: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid #365f78;
  background: #fbfcfd;
}
.rewind-labels {
  position: absolute;
  left: -10px;
  right: -10px;
  top: 27px;
  display: flex;
  justify-content: space-between;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
  font-size: 10px;
}
.rewind-live {
  position: absolute;
  right: 4px;
  top: 0;
  font-size: 9px;
  font-weight: 600;
  color: #8a4d3e;
  pointer-events: none;
}
.rewind-bar footer {
  justify-content: space-between;
  font-size: 11px;
  color: #5d7381;
}
.rewind-bar footer span {
  display: flex;
  align-items: center;
  gap: 5px;
}
.rewind-bar p {
  margin: 4px 0;
  color: #8b4b3e;
}
.rewind-bar kbd {
  line-height: 1;
  padding: 2px 4px;
  border: 1px solid #cddbe2;
  border-radius: 3px;
  font:
    10px "Cascadia Code",
    Consolas,
    monospace;
}
.rewind-primary kbd {
  background: #4b7590;
  border-color: #5f86a0;
  color: #e9f1f6;
}
.rewind-bar button:focus-visible,
.rewind-window:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 2px;
}
.rewind-rail:focus-visible {
  outline: none;
}
.rewind-rail:focus-visible .rewind-head::before {
  outline: 2px solid #6f8998;
  outline-offset: 2px;
}
</style>
