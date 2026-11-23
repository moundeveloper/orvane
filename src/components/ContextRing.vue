<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePopover } from "./pickers/usePopover";
import type { AgentContext } from "../agentSessions";

// How full the session's context window is: a percentage beside the send
// button and a thin ring around it. The percentage opens the breakdown, with
// /compact and Fork fresh where the CLI supports them.
const props = defineProps<{
  context?: AgentContext | null;
  /** Draw the ring around the slotted button (the send button). */
  ring?: boolean;
  canCompact?: boolean;
  canFork?: boolean;
}>();
const emit = defineEmits<{ compact: []; fork: [] }>();

const trigger = ref<HTMLButtonElement>();
const popover = ref<HTMLElement>();
const { open, style, show, close } = usePopover(trigger, popover, 150, {
  width: 25,
  alignEnd: true,
  preferAbove: true,
});

const share = computed(() =>
  props.context ? Math.min(1, props.context.used / props.context.window) : 0,
);
const percent = computed(() => Math.round(share.value * 100));
const level = computed(() =>
  share.value >= 0.9 ? "full" : share.value >= 0.75 ? "high" : "",
);
const short = (n: number) =>
  n >= 999_500
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);
const rows = computed(() =>
  !props.context
    ? []
    : [
        {
          key: "cached",
          label: "Earlier context, from cache",
          value: props.context.cached,
        },
        { key: "added", label: "Added this turn", value: props.context.added },
        { key: "output", label: "Latest reply", value: props.context.output },
      ],
);
const width = (n: number) =>
  `${Math.min(100, (n / (props.context?.window || 1)) * 100)}%`;

function key(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }
}
function act(kind: "compact" | "fork") {
  close();
  if (kind === "compact") emit("compact");
  else emit("fork");
}
const guestDown = () => open.value && close();
watch(
  () => props.context,
  (context) => {
    if (!context) close();
  },
);
onMounted(() =>
  window.addEventListener("orvane:guest-pointer-down", guestDown),
);
onBeforeUnmount(() =>
  window.removeEventListener("orvane:guest-pointer-down", guestDown),
);
defineExpose({ toggle: show });
</script>

<template>
  <button
    v-if="context"
    ref="trigger"
    type="button"
    class="cr-pct"
    :class="level"
    :aria-label="`Context ${percent}% used`"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :title="`${short(context.used)} of ${context.estimatedWindow ? 'about ' : ''}${short(context.window)} tokens in context`"
    @click="show"
  >
    {{ percent }}%
  </button>
  <span class="cr-wrap" :class="level">
    <svg
      v-if="context && ring"
      class="cr-ring"
      viewBox="0 0 36 36"
      aria-hidden="true"
    >
      <circle class="cr-track" cx="18" cy="18" r="16.5" pathLength="100" />
      <circle
        class="cr-used"
        cx="18"
        cy="18"
        r="16.5"
        pathLength="100"
        :style="{ strokeDashoffset: String(100 - Math.max(1.5, percent)) }"
      />
    </svg>
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="open && context"
      ref="popover"
      class="select-popover cr-pop"
      role="dialog"
      aria-label="Context used"
      tabindex="-1"
      :style="style"
      @keydown="key"
    >
      <header>
        <span>Context</span
        ><strong
          >{{ short(context.used) }} of {{ context.estimatedWindow ? "≈" : ""
          }}{{ short(context.window) }}</strong
        ><em>{{ percent }}%</em>
      </header>
      <div class="cr-stack" aria-hidden="true">
        <i
          v-for="row in rows"
          :key="row.key"
          :class="row.key"
          :style="{ width: width(row.value) }"
        />
      </div>
      <dl>
        <template v-for="row in rows" :key="row.key">
          <dt><i :class="row.key" />{{ row.label }}</dt>
          <dd>{{ short(row.value) }}</dd>
        </template>
      </dl>
      <footer>
        <button v-if="canCompact" type="button" @click="act('compact')">
          <code>/compact</code> now
        </button>
        <button v-if="canFork" type="button" @click="act('fork')">
          Fork fresh
        </button>
        <span>{{ context.model || "Updates after each reply" }}</span>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.cr-pct {
  flex: none;
  height: 26px;
  padding: 0 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #5d7381;
  font:
    11px/1 "Cascadia Code",
    Consolas,
    monospace;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.cr-pct:hover,
.cr-pct[aria-expanded="true"] {
  background: #e7eef2;
}
.cr-pct:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
.cr-pct.high {
  color: #8a6a32;
}
.cr-pct.full {
  color: #8c4637;
}
.cr-wrap {
  position: relative;
  flex: none;
  display: inline-grid;
  place-items: center;
}
/* Inside the round ring the button is round too, not a square in a circle. */
.cr-wrap:has(> .cr-ring) > :slotted(button) {
  border-radius: 50%;
}
.cr-ring {
  position: absolute;
  inset: -4px;
  width: calc(100% + 8px);
  height: calc(100% + 8px);
  transform: rotate(-90deg);
  pointer-events: none;
}
.cr-ring circle {
  fill: none;
  stroke-width: 2;
}
.cr-track {
  stroke: #d9e3e9;
}
.cr-used {
  stroke: #365f78;
  stroke-linecap: round;
  stroke-dasharray: 100;
  transition: stroke-dashoffset 300ms ease;
}
.cr-wrap.high .cr-used {
  stroke: #b08a4a;
}
.cr-wrap.full .cr-used {
  stroke: #a0624f;
}
.cr-pop {
  position: fixed;
  z-index: 9000;
  box-sizing: border-box;
  width: 25em;
  max-width: calc(100vw - 16px);
  padding: 0.85em 1em 0.7em;
  font-size: 12px;
}
.cr-pop:focus {
  outline: none;
}
header {
  display: flex;
  align-items: baseline;
  gap: 0.55em;
  color: #8296a2;
}
header strong {
  color: #273f50;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
header em {
  margin-left: auto;
  font:
    0.92em "Cascadia Code",
    Consolas,
    monospace;
  font-style: normal;
}
.cr-stack {
  display: flex;
  gap: 2px;
  height: 7px;
  margin: 0.75em 0 0.6em;
  border-radius: 4px;
  overflow: hidden;
  background: #e8eff3;
}
.cr-stack i {
  display: block;
  height: 100%;
}
.cached {
  background: #365f78;
}
.added {
  background: #6f8998;
}
.output {
  background: #a9bcc7;
}
dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.35em 0.8em;
  margin: 0;
}
dt {
  display: flex;
  align-items: center;
  gap: 0.6em;
  color: #455968;
}
dt i {
  width: 0.65em;
  height: 0.65em;
  border-radius: 2px;
}
dd {
  margin: 0;
  color: #5d7381;
  font:
    0.95em "Cascadia Code",
    Consolas,
    monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
footer {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin-top: 0.75em;
  padding-top: 0.65em;
  border-top: 1px solid #e3eaee;
}
footer button {
  height: 2.15em;
  padding: 0 0.7em;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  color: #273f50;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
footer button:hover {
  background: #eef3f6;
}
footer button:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
footer code {
  font:
    0.95em "Cascadia Code",
    Consolas,
    monospace;
  color: #385d76;
}
footer span {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.92em;
  color: #8296a2;
}
@media (prefers-reduced-motion: reduce) {
  .cr-used {
    transition: none;
  }
}
</style>
