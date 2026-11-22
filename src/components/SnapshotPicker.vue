<script setup lang="ts">
// Ctrl+Alt+S in an agent composer: pick a canvas app to send as context, its
// text and, when it can be captured, a picture. Number keys pick directly.
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { snapshotApps } from "../agentHarness";

const emit = defineEmits<{ pick: [appId: string, picture: boolean]; close: [] }>();
const apps = ref(snapshotApps().slice(0, 9));
const active = ref(0);
const picture = ref(true);
const panel = ref<HTMLElement>();

function pick(index = active.value) {
  const app = apps.value[index];
  if (app) emit("pick", app.id, picture.value);
}
function key(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = apps.value.length || 1;
    active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
  } else if (event.key === "Enter") {
    event.preventDefault();
    pick();
  } else if (event.key === "Tab") {
    event.preventDefault();
    picture.value = !picture.value;
  } else if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    pick(Number(event.key) - 1);
  }
}
function outside(event: Event) {
  if (event.type === "orvane:guest-pointer-down" || !panel.value?.contains(event.target as Node)) emit("close");
}
onMounted(async () => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("orvane:guest-pointer-down", outside);
  await nextTick();
  panel.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("orvane:guest-pointer-down", outside);
});
</script>

<template>
  <div
    ref="panel"
    class="snapshot-picker select-popover"
    role="listbox"
    aria-label="Snapshot an app"
    tabindex="-1"
    @keydown="key"
  >
    <div class="snapshot-head">
      <span>Snapshot an app</span>
      <div class="snapshot-seg" role="group" aria-label="Include">
        <button type="button" :aria-pressed="picture" @click="picture = true">Picture and text</button>
        <button type="button" :aria-pressed="!picture" @click="picture = false">Text only</button>
      </div>
    </div>
    <div class="snapshot-list">
      <button
        v-for="(app, index) in apps"
        :key="app.id"
        type="button"
        role="option"
        tabindex="-1"
        :aria-selected="index === active"
        @pointerenter="active = index"
        @click="pick(index)"
      >
        <kbd>{{ index + 1 }}</kbd>
        <Icon :name="(app.icon as 'app')" :size="14" />
        <span class="name">{{ app.name }}</span>
      </button>
      <p v-if="!apps.length" class="snapshot-empty">No other apps on the canvas.</p>
    </div>
    <div class="snapshot-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
      <span><kbd>Enter</kbd> add</span>
      <span><kbd>Tab</kbd> picture or text</span>
      <span><kbd>Esc</kbd> close</span>
    </div>
  </div>
</template>

<style scoped>
.snapshot-picker {
  position: absolute;
  left: 8px;
  bottom: calc(100% + 6px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  width: min(360px, calc(100% - 16px));
  max-height: 300px;
  border: 1px solid #d3dee5;
  border-radius: 9px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 10px 28px #263f5524;
  font-size: 12.5px;
  color: #455968;
  outline: none;
  overflow: hidden;
  animation: snapshot-in 120ms ease-out;
}
@keyframes snapshot-in {
  from {
    opacity: 0;
  }
}
.snapshot-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid #e3eaee;
}
.snapshot-head > span {
  flex: 1;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.snapshot-seg {
  display: flex;
  padding: 2px;
  border-radius: 7px;
  background: #e8eff3;
}
.snapshot-seg button {
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #5d7381;
  font: inherit;
  font-size: 11px;
}
.snapshot-seg button[aria-pressed="true"] {
  background: #fbfcfd;
  color: #273f50;
  box-shadow: 0 1px 2px #263f5512;
}
.snapshot-list {
  overflow: auto;
  padding: 4px;
}
.snapshot-list button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
.snapshot-list button[aria-selected="true"] {
  background: #e4edf2;
  color: #273f50;
}
.snapshot-list button :deep(svg) {
  color: #6f8998;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.snapshot-empty {
  margin: 0;
  padding: 10px;
  color: #8296a2;
}
.snapshot-foot {
  display: flex;
  gap: 12px;
  height: 28px;
  align-items: center;
  padding: 0 10px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
.snapshot-foot kbd {
  margin-right: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .snapshot-picker {
    animation: none;
  }
}
</style>
