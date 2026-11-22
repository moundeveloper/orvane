<script setup lang="ts">
// The bell in Agent sessions: every run that waits for the user, is working,
// or finished unread, across all panes. Approvals are answered here. Opened
// with Ctrl+Alt+U from anywhere in Orvane.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { agentRequest } from "../exposition";
import { agentNames, type AgentRunSummary } from "../agentSessions";
import { activityCount, activityGroups, harness, markSeen } from "../agentHarness";

const emit = defineEmits<{ open: [runId: string] }>();
const open = ref(false);
const filter = ref<"all" | "waiting" | "running">("all");
const anchor = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const button = ref<HTMLButtonElement>();
const error = ref("");
const deciding = ref("");
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

const sections = computed(() => {
  const { waiting, running, done } = activityGroups.value;
  return [
    { id: "waiting", label: "Waiting for you", runs: filter.value === "running" ? [] : waiting },
    { id: "running", label: "Running", runs: filter.value === "waiting" ? [] : running },
    { id: "done", label: "Done", runs: filter.value === "all" ? done : [] },
  ].filter((section) => section.runs.length);
});

async function show() {
  open.value = true;
  error.value = "";
  now.value = Date.now();
  clearInterval(clock);
  clock = setInterval(() => (now.value = Date.now()), 1000);
  await nextTick();
  panel.value?.focus({ preventScroll: true });
}
function close(refocus = false) {
  open.value = false;
  clearInterval(clock);
  if (refocus) button.value?.focus({ preventScroll: true });
}
function toggle() {
  if (open.value) close();
  else void show();
}
watch(
  () => harness.activityOpen,
  (asked) => {
    if (!asked) return;
    harness.activityOpen = false;
    void show();
  },
  { immediate: true },
);
function outside(event: Event) {
  if (!open.value) return;
  if (event.type === "orvane:guest-pointer-down" || !anchor.value?.contains(event.target as Node)) close();
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("orvane:guest-pointer-down", outside);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("orvane:guest-pointer-down", outside);
  clearInterval(clock);
});

function elapsed(run: AgentRunSummary) {
  const from = run.startedAt;
  if (!from) return "";
  const seconds = Math.max(0, Math.round(((run.endedAt ?? now.value) - from) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function ago(run: AgentRunSummary) {
  if (!run.endedAt) return "";
  const minutes = Math.round((now.value - run.endedAt) / 60_000);
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}
function detail(run: AgentRunSummary) {
  if (run.approval) return `${run.approval.tool}: ${run.approval.detail}`;
  if (run.status === "failed") return "Stopped with an error";
  if (run.status === "stopped") return "Stopped";
  return run.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? run.folder;
}
async function decide(run: AgentRunSummary, allow: boolean) {
  if (!run.approval || deciding.value) return;
  deciding.value = run.id;
  error.value = "";
  try {
    await agentRequest("permission", { id: run.id, requestId: run.approval.id, allow });
    run.awaitingApproval = false;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "The answer was not sent.";
  } finally {
    deciding.value = "";
  }
}
function openRun(run: AgentRunSummary) {
  markSeen(run.id);
  close();
  emit("open", run.id);
}
function readAll() {
  markSeen(...activityGroups.value.done.map((run) => run.id));
}
function key(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...(panel.value?.querySelectorAll<HTMLElement>(".aa-open") ?? [])];
  if (!rows.length) return;
  event.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "ArrowDown" ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
  rows[next]!.focus();
}
defineExpose({ show });
</script>

<template>
  <span ref="anchor" class="aa-anchor">
    <button
      ref="button"
      type="button"
      class="aa-bell"
      :class="{ on: open }"
      :aria-expanded="open"
      aria-haspopup="dialog"
      aria-label="Agent activity"
      aria-keyshortcuts="Control+Alt+U"
      title="Agent activity (Ctrl+Alt+U)"
      @click="toggle"
    >
      <Icon name="bell" :size="14" /><span v-if="activityCount" class="aa-count">{{ activityCount }}</span>
    </button>
    <div
      v-if="open"
      ref="panel"
      class="aa-panel select-popover"
      role="dialog"
      aria-label="Agent activity"
      tabindex="-1"
      @keydown="key"
    >
      <div class="aa-head">
        <strong>Activity</strong>
        <div class="aa-seg" role="group" aria-label="Show">
          <button
            v-for="item in (['all', 'waiting', 'running'] as const)"
            :key="item"
            type="button"
            :aria-pressed="filter === item"
            @click="filter = item"
          >
            {{ item === "all" ? "All" : item === "waiting" ? "Waiting" : "Running" }}
          </button>
        </div>
        <span class="aa-grow" />
        <button type="button" class="aa-link" :disabled="!activityGroups.done.length" @click="readAll">
          Mark all read
        </button>
      </div>
      <div class="aa-list">
        <template v-for="section in sections" :key="section.id">
          <p class="aa-label">{{ section.label }}</p>
          <div
            v-for="run in section.runs"
            :key="run.id"
            class="aa-row"
            :class="[section.id, { failed: run.status === 'failed' }]"
          >
            <button type="button" class="aa-open" @click="openRun(run)">
              <span class="aa-prov" :class="run.provider">{{ agentNames[run.provider] }}</span>
              <span class="aa-text">
                <b :title="run.title">{{ run.title || "Untitled turn" }}</b>
                <span :title="detail(run)">{{ detail(run) }}</span>
              </span>
            </button>
            <span v-if="section.id === 'waiting' && run.approval" class="aa-actions">
              <button type="button" class="aa-btn aa-allow" :disabled="deciding === run.id" @click="decide(run, true)">
                Allow once
              </button>
              <button type="button" class="aa-btn" :disabled="deciding === run.id" @click="decide(run, false)">Deny</button>
            </span>
            <time v-else class="aa-time">{{ section.id === "done" ? ago(run) : elapsed(run) }}</time>
          </div>
        </template>
        <p v-if="!sections.length" class="aa-empty">Nothing is waiting, running or unread.</p>
      </div>
      <p v-if="error" class="aa-error" role="alert">{{ error }}</p>
      <div class="aa-foot">
        <button
          type="button"
          class="aa-switch"
          role="switch"
          :aria-checked="harness.settings.alerts"
          @click="harness.settings.alerts = !harness.settings.alerts"
        >
          <span class="aa-knob" />Alerts when Orvane is in the background
        </button>
        <span class="aa-grow" />
        <kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>U</kbd>
      </div>
    </div>
  </span>
</template>

<style scoped>
.aa-anchor {
  position: relative;
  display: inline-flex;
}
.aa-bell {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
.aa-bell:hover {
  background: #e4edf2;
}
.aa-prov,
.aa-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #5d7381;
}
.aa-prov::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9db0bc;
}
.aa-prov.codex::before {
  border-radius: 1.5px;
  background: #8a9fae;
}
.aa-btn {
  height: 24px;
  padding: 0 8px;
  border: 1px solid #d3dee5;
  border-radius: 6px;
  background: transparent;
  font: inherit;
  font-size: 11.5px;
  color: #455968;
}
.aa-btn:hover {
  background: #e4edf2;
}
.aa-btn:disabled {
  opacity: 0.5;
}
.aa-allow {
  border-color: #bacfd9;
  background: #dce9ef;
  color: #273f50;
}
.aa-bell.on {
  background: #e4edf2;
  color: #273f50;
}
.aa-count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #b08a4a;
  color: #fff;
  font: 600 10px/16px inherit;
  text-align: center;
}
.aa-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  width: 400px;
  max-width: calc(100vw - 24px);
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
  font-size: 12.5px;
  color: #455968;
  outline: none;
  animation: aa-in 140ms ease-out;
}
@keyframes aa-in {
  from {
    opacity: 0;
  }
}
.aa-head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 10px 0 12px;
  border-bottom: 1px solid #e3eaee;
}
.aa-head strong {
  color: #273f50;
  font-weight: 600;
}
.aa-grow {
  flex: 1;
}
.aa-seg {
  display: flex;
  padding: 2px;
  border-radius: 7px;
  background: #e8eff3;
}
.aa-seg button {
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #5d7381;
  font: inherit;
  font-size: 11px;
}
.aa-seg button[aria-pressed="true"] {
  background: #fbfcfd;
  color: #273f50;
  box-shadow: 0 1px 2px #263f5512;
}
.aa-link {
  border: 0;
  background: none;
  color: #385d76;
  font: inherit;
  font-size: 11.5px;
}
.aa-link:disabled {
  color: #9aabb5;
}
.aa-list {
  max-height: 340px;
  overflow: auto;
  padding: 0 4px 4px;
}
.aa-label {
  margin: 0;
  padding: 10px 8px 4px;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.aa-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 3px 6px 3px 0;
  border-radius: 7px;
}
.aa-row:hover,
.aa-row:focus-within {
  background: #eef3f6;
}
.aa-row.waiting {
  background: #fcfaf5;
  box-shadow: inset 0 0 0 1px #e7d9bd;
}
.aa-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  text-align: left;
  color: inherit;
}
.aa-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}
.aa-text b {
  overflow: hidden;
  color: #273f50;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aa-text span {
  overflow: hidden;
  color: #5d7381;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aa-row.done .aa-text b::after {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 6px;
  border-radius: 50%;
  background: #365f78;
  vertical-align: 2px;
}
.aa-row.failed .aa-text span {
  color: #a0624f;
}
.aa-actions {
  display: flex;
  gap: 5px;
}
.aa-time {
  color: #8296a2;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.aa-empty,
.aa-error {
  margin: 0;
  padding: 14px 10px;
  color: #8296a2;
}
.aa-error {
  padding: 6px 12px;
  color: #a0624f;
}
.aa-foot {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 32px;
  padding: 0 10px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
.aa-switch {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
}
.aa-knob {
  position: relative;
  width: 24px;
  height: 14px;
  border-radius: 7px;
  background: #d3dee5;
  transition: background 0.15s;
}
.aa-knob::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.aa-switch[aria-checked="true"] .aa-knob {
  background: #365f78;
}
.aa-switch[aria-checked="true"] .aa-knob::after {
  transform: translateX(10px);
}
@media (prefers-reduced-motion: reduce) {
  .aa-panel,
  .aa-knob,
  .aa-knob::after {
    animation: none;
    transition: none;
  }
}
</style>
