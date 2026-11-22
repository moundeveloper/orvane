<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { usePopover } from "./pickers/usePopover";
import {
  agentEditModeNames,
  agentEditModes,
  agentEfforts,
  type AgentEditMode,
  type AgentEffort,
  type AgentProvider,
} from "../agentSessions";

// Two pills beside the model picker: reasoning effort (a four-step slider in
// a popover) and how edits are handled (cycled by click or Shift+Tab).
const props = defineProps<{ provider: AgentProvider; disabled?: boolean }>();
const effort = defineModel<AgentEffort | "">("effort", { default: "" });
const mode = defineModel<AgentEditMode | "">("mode", { default: "" });

const names: Record<AgentEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};
const trigger = ref<HTMLButtonElement>();
const popover = ref<HTMLElement>();
const slider = ref<HTMLElement>();
// Opens above the pill, like the model list beside it.
const { open, style, show, close } = usePopover(trigger, popover, 132, { preferAbove: true });

const modes = computed(() => agentEditModes[props.provider]);
// Unset means what the CLI does today: Claude asks first, Codex auto-accepts.
const currentMode = computed<AgentEditMode>(() =>
  mode.value && modes.value.includes(mode.value) ? mode.value : modes.value[0]!,
);
const index = computed(() => (effort.value ? agentEfforts.indexOf(effort.value) : -1));

function setEffort(next: number) {
  effort.value = agentEfforts[Math.max(0, Math.min(agentEfforts.length - 1, next))]!;
}
/** Moves the effort one step; from the provider default it starts at High. */
function nudge(step: number) {
  setEffort(index.value < 0 ? 2 : index.value + step);
}
function cycleMode() {
  if (props.disabled) return;
  const list = modes.value;
  mode.value = list[(list.indexOf(currentMode.value) + 1) % list.length]!;
}
function sliderKey(event: KeyboardEvent) {
  const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
  if (step) {
    event.preventDefault();
    nudge(step);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    setEffort(event.key === "Home" ? 0 : agentEfforts.length - 1);
  }
}
function popoverKey(event: KeyboardEvent) {
  if (event.key === "Escape" || event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }
}
function pickAt(event: PointerEvent) {
  const box = slider.value!.getBoundingClientRect();
  const ratio = (event.clientX - box.left) / box.width;
  setEffort(Math.round(ratio * (agentEfforts.length - 1)));
}
function drag(event: PointerEvent) {
  if (event.buttons !== 1) return;
  pickAt(event);
}
function toggle() {
  if (props.disabled) return;
  show();
  if (open.value) void nextTick(() => slider.value?.focus({ preventScroll: true }));
}
const guestDown = () => open.value && close();
onMounted(() => window.addEventListener("orvane:guest-pointer-down", guestDown));
onBeforeUnmount(() => window.removeEventListener("orvane:guest-pointer-down", guestDown));

defineExpose({ cycleMode });
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="cm-pill"
    aria-label="Effort"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :disabled="disabled"
    @click="toggle"
  >
    <Icon name="settings" :size="13" /><span>Effort</span
    ><b>{{ effort ? names[effort] : "Default" }}</b>
  </button>
  <button
    type="button"
    class="cm-pill"
    :class="{ 'cm-full': currentMode === 'full' }"
    :aria-label="`Edits: ${agentEditModeNames[currentMode]}`"
    :title="currentMode === 'full'
      ? 'Full access: runs anything without asking, outside any sandbox (Shift+Tab to change)'
      : 'Change how edits are handled (Shift+Tab)'"
    aria-keyshortcuts="Shift+Tab"
    :disabled="disabled || modes.length < 2"
    @click="cycleMode"
  >
    <Icon name="edit" :size="13" /><span>Edits</span
    ><b>{{ agentEditModeNames[currentMode] }}</b>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      class="select-popover cm-effort"
      role="dialog"
      aria-label="Effort"
      tabindex="-1"
      :style="style"
      @keydown="popoverKey"
    >
      <header>
        <span>Effort</span><strong>{{ effort ? names[effort] : "Default" }}</strong>
      </header>
      <div class="cm-ends"><span>Faster</span><span>Smarter</span></div>
      <div
        ref="slider"
        class="cm-track"
        role="slider"
        tabindex="0"
        aria-label="Effort"
        aria-valuemin="0"
        :aria-valuemax="agentEfforts.length - 1"
        :aria-valuenow="Math.max(0, index)"
        :aria-valuetext="effort ? names[effort] : 'Provider default'"
        @keydown="sliderKey"
        @pointerdown="pickAt"
        @pointermove="drag"
      >
        <span class="cm-fill" :style="{ width: `${(Math.max(0, index) / 3) * 100}%` }" />
        <i v-for="n in agentEfforts.length" :key="n" class="cm-notch" :style="{ left: `${((n - 1) / 3) * 100}%` }" />
        <span v-if="index >= 0" class="cm-knob" :style="{ left: `${(index / 3) * 100}%` }" />
      </div>
      <div class="cm-levels">
        <button
          v-for="(level, n) in agentEfforts"
          :key="level"
          type="button"
          tabindex="-1"
          :class="{ on: n === index }"
          :style="{ left: `${(n / 3) * 100}%` }"
          @click="setEffort(n)"
        >
          {{ names[level] }}
        </button>
      </div>
      <footer>
        <span>Arrow keys change it</span>
        <button type="button" :disabled="!effort" @click="effort = ''">Use default</button>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.cm-pill {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #5d7381;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.cm-pill.cm-full,
.cm-pill.cm-full b {
  color: #b08a4a;
}
.cm-pill b {
  font-weight: 500;
  color: #365f78;
}
.cm-pill:hover:not(:disabled),
.cm-pill[aria-expanded="true"] {
  background: #e7eef2;
}
.cm-pill:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
.cm-pill:disabled {
  cursor: default;
  opacity: 0.55;
}
.cm-effort {
  position: fixed;
  z-index: 9000;
  width: 17em;
  padding: 0.85em 1em 0.75em;
  font-size: 12px;
}
.cm-effort:focus {
  outline: none;
}
header {
  display: flex;
  align-items: baseline;
  gap: 0.5em;
  color: #5d7381;
}
header strong {
  font-weight: 600;
  color: #273f50;
}
.cm-ends {
  display: flex;
  justify-content: space-between;
  margin: 0.7em 0 0.35em;
  font-size: 0.92em;
  color: #8296a2;
}
.cm-track {
  position: relative;
  height: 1.5em;
  margin: 0 0.45em;
  cursor: pointer;
  touch-action: none;
}
.cm-track::before {
  content: "";
  position: absolute;
  inset: calc(50% - 2px) 0 auto;
  height: 4px;
  border-radius: 2px;
  background: #e1e9ee;
}
.cm-track:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 3px;
  border-radius: 4px;
}
.cm-fill {
  position: absolute;
  left: 0;
  top: calc(50% - 2px);
  height: 4px;
  border-radius: 2px;
  background: #6f8998;
}
.cm-notch {
  position: absolute;
  top: calc(50% - 3px);
  width: 6px;
  height: 6px;
  margin-left: -3px;
  border-radius: 50%;
  background: #c9d6de;
}
.cm-knob {
  position: absolute;
  top: calc(50% - 7px);
  width: 14px;
  height: 14px;
  margin-left: -7px;
  border-radius: 50%;
  background: #fbfcfd;
  box-shadow: 0 0 0 1.5px #365f78, 0 2px 5px #263f5533;
  transition: left 120ms ease-out;
}
/* Each label sits under its notch; the end ones stay inside the popover. */
.cm-levels {
  position: relative;
  height: 1.7em;
  margin: 0.35em 0.45em 0;
}
.cm-levels button {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  padding: 0.2em 0;
  border: 0;
  background: none;
  color: #8296a2;
  font: inherit;
  cursor: pointer;
}
.cm-levels button:first-child {
  transform: translateX(-0.45em);
}
.cm-levels button:last-child {
  transform: translateX(calc(-100% + 0.45em));
}
.cm-levels button.on {
  color: #273f50;
  font-weight: 500;
}
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.6em;
  padding-top: 0.6em;
  border-top: 1px solid #e3eaee;
  font-size: 0.92em;
  color: #8296a2;
}
footer button {
  padding: 0.15em 0.4em;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #365f78;
  font: inherit;
  cursor: pointer;
}
footer button:hover:not(:disabled) {
  background: #e7eef2;
}
footer button:disabled {
  color: #a9b8c1;
  cursor: default;
}
@media (prefers-reduced-motion: reduce) {
  .cm-knob {
    transition: none;
  }
}
</style>
