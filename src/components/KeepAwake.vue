<script setup lang="ts">
// The "Keeping PC awake" pill in a working session's header. Windows stays
// awake while any agent turn runs (not while it waits for an approval).
import { onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { agentNames } from "../agentSessions";
import { awakeRuns, harness } from "../agentHarness";

const open = ref(false);
const anchor = ref<HTMLElement>();
const button = ref<HTMLButtonElement>();
function close(refocus = false) {
  open.value = false;
  if (refocus) button.value?.focus({ preventScroll: true });
}
function outside(event: Event) {
  if (open.value && (event.type === "orvane:guest-pointer-down" || !anchor.value?.contains(event.target as Node)))
    close();
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("orvane:guest-pointer-down", outside);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("orvane:guest-pointer-down", outside);
});
</script>

<template>
  <span ref="anchor" class="ka-anchor">
    <button
      ref="button"
      type="button"
      class="ka-pill"
      :class="{ off: !harness.awake }"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="open = !open"
    >
      <Icon name="sun" :size="12" />{{ harness.awake ? "Keeping PC awake" : "PC may sleep" }}
    </button>
    <div
      v-if="open"
      class="ka-panel select-popover"
      role="dialog"
      aria-label="Keep the PC awake"
      @keydown.esc.stop.prevent="close(true)"
    >
      <p class="ka-title">Keep the PC awake</p>
      <div class="ka-seg" role="group" aria-label="Keep awake">
        <button type="button" :aria-pressed="harness.settings.keepAwake" @click="harness.settings.keepAwake = true">
          While a turn runs
        </button>
        <button type="button" :aria-pressed="!harness.settings.keepAwake" @click="harness.settings.keepAwake = false">
          Off
        </button>
      </div>
      <p class="ka-note">The screen can still turn off. Waiting for an approval lets the PC sleep.</p>
      <ul v-if="awakeRuns.length" class="ka-runs">
        <li v-for="run in awakeRuns" :key="run.id">
          <span class="ka-prov" :class="run.provider">{{ agentNames[run.provider] }}</span>
          <span :title="run.title">{{ run.title }}</span>
        </li>
      </ul>
    </div>
  </span>
</template>

<style scoped>
.ka-anchor {
  position: relative;
  display: inline-flex;
}
.ka-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid #d6e1e7;
  border-radius: 11px;
  background: #eef3f6;
  color: #385d76;
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
}
.ka-pill.off {
  color: #7a8f9b;
}
.ka-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  width: 260px;
  padding: 10px;
  border: 1px solid #d3dee5;
  border-radius: 9px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 10px 28px #263f5524;
  color: #455968;
  font-size: 12px;
  animation: ka-in 120ms ease-out;
}
@keyframes ka-in {
  from {
    opacity: 0;
  }
}
.ka-title {
  margin: 0 0 8px;
  color: #273f50;
  font-weight: 600;
}
.ka-seg {
  display: flex;
  padding: 2px;
  border-radius: 7px;
  background: #e8eff3;
}
.ka-seg button {
  flex: 1;
  height: 24px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #5d7381;
  font: inherit;
  font-size: 11.5px;
}
.ka-seg button[aria-pressed="true"] {
  background: #fbfcfd;
  color: #273f50;
  box-shadow: 0 1px 2px #263f5512;
}
.ka-note {
  margin: 8px 0 0;
  color: #7a8f9b;
  font-size: 11px;
  line-height: 1.4;
}
.ka-runs {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding: 8px 0 0;
  border-top: 1px solid #e3eaee;
  list-style: none;
}
.ka-runs li {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ka-prov {
  flex: none;
  color: #5d7381;
  font-size: 11px;
}
.ka-runs li span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .ka-panel {
    animation: none;
  }
}
</style>
