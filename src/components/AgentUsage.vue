<script setup lang="ts">
// Subscription limits in the composer: a pill with the session CLI's tighter
// window (5-hour or weekly), and a popover with both CLIs and reset times.
// The numbers are what each CLI last reported in a run; nothing is fetched.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { usePopover } from "./pickers/usePopover";
import { agentNames, type AgentProvider, type AgentUsage, type AgentUsageWindow } from "../agentSessions";
import { agentRequest } from "../exposition";

const props = defineProps<{ provider: AgentProvider }>();
const usage = ref<Partial<Record<AgentProvider, AgentUsage | null>>>({});
const trigger = ref<HTMLButtonElement>();
const popover = ref<HTMLElement>();
const { open, style, show, close } = usePopover(trigger, popover, 150, {
  width: 25,
  alignEnd: true,
  preferAbove: true,
});

async function refresh() {
  try {
    usage.value = await agentRequest<Record<AgentProvider, AgentUsage | null>>("usage");
  } catch {
    // Keep the last numbers.
  }
}
const level = (used: number) => (used >= 95 ? "full" : used >= 80 ? "high" : "");
/** The window closest to its limit for the session's CLI. */
const tight = computed(() => {
  const own = usage.value[props.provider];
  const windows = [
    own?.fiveHour && { label: "5h", ...own.fiveHour },
    own?.weekly && { label: "Week", ...own.weekly },
  ].filter(Boolean) as (AgentUsageWindow & { label: string })[];
  return windows.sort((a, b) => b.used - a.used)[0];
});
const providers = computed(() =>
  ([props.provider, props.provider === "claude" ? "codex" : "claude"] as AgentProvider[]).filter((p) => usage.value[p]),
);
const clock = (ms: number) => {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
};
function toggle() {
  if (open.value) close(true);
  else {
    void refresh();
    show();
  }
}
function key(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }
}
// Alt+U from anywhere in this Agent Sessions app (it types nothing in fields).
function altU(event: KeyboardEvent) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.key.toLowerCase() !== "u") return;
  const app = trigger.value?.closest(".agent-sessions-app");
  if (!app || !(event.target instanceof Node) || !app.contains(event.target)) return;
  event.preventDefault();
  toggle();
}
const guestDown = () => open.value && close();
onMounted(() => {
  void refresh();
  window.addEventListener("keydown", altU, true);
  window.addEventListener("orvane:guest-pointer-down", guestDown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", altU, true);
  window.removeEventListener("orvane:guest-pointer-down", guestDown);
});
defineExpose({ refresh });
</script>

<template>
  <button
    v-if="tight"
    ref="trigger"
    type="button"
    class="au-pill"
    :class="level(tight.used)"
    :aria-label="`${agentNames[provider]} usage: ${tight.label} ${tight.used}%`"
    aria-haspopup="dialog"
    :aria-expanded="open"
    title="Usage · Alt U"
    @click="toggle"
  >
    <i aria-hidden="true"></i>{{ tight.label }} {{ tight.used }}%
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      class="select-popover au-pop"
      role="dialog"
      aria-label="Usage"
      tabindex="-1"
      :style="style"
      @keydown="key"
    >
      <header><span>Usage</span><kbd>Alt U</kbd></header>
      <template v-for="name in providers" :key="name">
        <div class="au-head">
          <b>{{ agentNames[name] }}</b><small>reported {{ clock(usage[name]!.at) }}</small>
        </div>
        <div
          v-for="row in [
            { label: '5-hour', window: usage[name]!.fiveHour },
            { label: 'Weekly', window: usage[name]!.weekly },
          ].filter((r) => r.window)"
          :key="row.label"
          class="au-row"
          :class="level(row.window!.used)"
        >
          <span>{{ row.label }}</span>
          <span class="au-bar"><i :style="{ width: `${row.window!.used}%` }"></i></span>
          <em>{{ row.window!.used }}%</em>
          <small>{{ row.window!.resetsAt ? `resets ${clock(row.window!.resetsAt)}` : "" }}</small>
        </div>
      </template>
      <p v-if="!providers.length" class="au-empty">No usage reported yet. It appears after a run.</p>
      <footer>Last values each CLI reported in a run. Nothing is sent to check.</footer>
    </div>
  </Teleport>
</template>

<style scoped>
.au-pill {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: #e6eef3;
  color: #5d7381;
  font: inherit;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.au-pill i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6f8998;
}
.au-pill.high {
  background: #f6f0e4;
  color: #8a6a33;
}
.au-pill.high i {
  background: #b08a4a;
}
.au-pill.full {
  background: #f6e8e3;
  color: #a0624f;
}
.au-pill.full i {
  background: #a0624f;
}
.au-pill:hover,
.au-pill[aria-expanded="true"] {
  filter: brightness(0.97);
}
.au-pill:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px #6f899840;
}
.au-pop {
  position: fixed;
  z-index: 9000;
  box-sizing: border-box;
  width: 25em;
  max-width: calc(100vw - 16px);
  padding: 0.85em 1em 0.8em;
  font-size: 12px;
  color: #455968;
}
.au-pop:focus {
  outline: none;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #7a8f9b;
  font-size: 0.875em;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
kbd {
  padding: 1px 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  color: #5d7381;
  font: 400 0.875em "Cascadia Code", Consolas, monospace;
  letter-spacing: 0;
  text-transform: none;
}
.au-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 0.7em 0 0.3em;
}
.au-head b {
  color: #273f50;
  font-weight: 600;
}
.au-head small,
.au-row small {
  color: #8296a2;
  font-size: 0.92em;
}
.au-row {
  display: grid;
  grid-template-columns: 4.8em 1fr 2.8em 8.2em;
  align-items: center;
  gap: 0.65em;
  height: 2em;
}
.au-bar {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: #e3eaee;
}
.au-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: #6f8998;
}
.au-row em {
  color: #273f50;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.au-row.high em {
  color: #8a6a33;
}
.au-row.high .au-bar i {
  background: #b08a4a;
}
.au-row.full em {
  color: #a0624f;
}
.au-row.full .au-bar i {
  background: #a0624f;
}
.au-empty {
  margin: 0.8em 0 0;
  color: #8296a2;
}
footer {
  margin-top: 0.7em;
  padding-top: 0.6em;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 0.92em;
}
</style>
