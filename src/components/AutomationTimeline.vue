<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Workspace } from "../model";
import { overlaps, plannedRuns, SOURCE_LABEL, type AutomationRun } from "../automationRuns";
import { describeSchedule } from "../triggers";
import Icon from "./Icon.vue";

// One day of Action-library workflows on a horizontal time axis: a lane per
// workflow, a bar per run as long as it took, planned runs from the
// triggers dashed, a now line, and shaded bands where runs overlapped.
const props = defineProps<{
  workspace: Workspace;
  liveRuns: Omit<AutomationRun, "end" | "error">[];
}>();
const emit = defineEmits<{ open: [workflowId: string] }>();

const HOUR = 3_600_000;
const now = ref(Date.now());
let ticker = 0;
onMounted(() => {
  ticker = window.setInterval(() => (now.value = Date.now()), 30_000);
  void nextTick(() => root.value?.focus({ preventScroll: true }));
});
onBeforeUnmount(() => clearInterval(ticker));

const dayStart = (at: number) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const day = ref(dayStart(Date.now()));
const isToday = computed(() => day.value === dayStart(now.value));
const filter = ref<"all" | "triggers" | "failed">("all");

type Bar = { id: string; workflowId: string; start: number; end: number; kind: "ok" | "fail" | "live" | "plan"; run?: AutomationRun; source?: string };
const dayEnd = computed(() => day.value + 24 * HOUR);
const name = (id: string) => props.workspace.actions?.find((a) => a.id === id)?.name || "Deleted workflow";

const bars = computed<Bar[]>(() => {
  const from = day.value,
    to = dayEnd.value;
  const out: Bar[] = [];
  for (const run of props.workspace.runs ?? [])
    if (run.end >= from && run.start < to)
      out.push({ id: run.id, workflowId: run.workflowId, start: run.start, end: run.end, kind: run.error ? "fail" : "ok", run, source: SOURCE_LABEL[run.source] });
  for (const run of props.liveRuns)
    if (run.start < to)
      out.push({ id: run.id, workflowId: run.workflowId, start: run.start, end: Math.max(now.value, run.start), kind: "live", source: SOURCE_LABEL[run.source] });
  // Planned runs: from now (or the start of a future day) to the end of the day.
  if (dayEnd.value > now.value)
    for (const trigger of props.workspace.triggers ?? []) {
      if (!trigger.enabled) continue;
      const past = (props.workspace.runs ?? []).filter((r) => r.workflowId === trigger.workflowId);
      const typical = past.length ? past.reduce((sum, r) => sum + (r.end - r.start), 0) / past.length : 60_000;
      for (const at of plannedRuns(trigger, Math.max(from, now.value), to))
        out.push({ id: `${trigger.id}:${at}`, workflowId: trigger.workflowId, start: at, end: at + typical, kind: "plan", source: trigger.name });
    }
  return out;
});
const bands = computed(() =>
  overlaps(bars.value.filter((b) => b.kind !== "plan").map((b) => ({ lane: b.workflowId, start: b.start, end: b.end }))),
);

const lanes = computed(() => {
  const ids: string[] = [];
  for (const bar of [...bars.value].sort((a, b) => a.start - b.start)) if (!ids.includes(bar.workflowId)) ids.push(bar.workflowId);
  return ids
    .map((id) => {
      const triggers = (props.workspace.triggers ?? []).filter((t) => t.workflowId === id && t.enabled);
      const own = bars.value.filter((b) => b.workflowId === id);
      return {
        id,
        name: name(id),
        detail: triggers.length ? triggers.map((t) => describeSchedule(t.schedule)).join(" · ") : `${own[0]?.source ?? ""}`,
        triggered: triggers.length > 0,
        failed: own.some((b) => b.kind === "fail"),
        bars: own,
      };
    })
    .filter((lane) => (filter.value === "triggers" ? lane.triggered : filter.value === "failed" ? lane.failed : true));
});

// The visible hours: the day's activity, at least 8 hours, never past midnight.
const range = computed(() => {
  const times = bars.value.flatMap((b) => [b.start, b.end]);
  if (isToday.value) times.push(now.value);
  let first = times.length ? Math.floor((Math.min(...times) - day.value) / HOUR) : 8;
  let last = times.length ? Math.ceil((Math.max(...times) - day.value) / HOUR) : 20;
  first = Math.max(0, Math.min(first, 8));
  last = Math.min(24, Math.max(last, first + 8, 18));
  if (last - first < 8) first = Math.max(0, last - 8);
  return { from: day.value + first * HOUR, to: day.value + last * HOUR, hours: Array.from({ length: last - first }, (_, i) => first + i) };
});
const pct = (at: number) => ((Math.min(Math.max(at, range.value.from), range.value.to) - range.value.from) / (range.value.to - range.value.from)) * 100;
const span = (start: number, end: number) => ({ left: `${pct(start)}%`, width: `max(5px, ${pct(end) - pct(start)}%)` });

const summary = computed(() => {
  const real = bars.value.filter((b) => b.kind !== "plan");
  const failed = real.filter((b) => b.kind === "fail").length;
  const label = isToday.value ? "Today" : new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(day.value);
  return `${label} · ${real.length} run${real.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}${bands.value.length ? ` · ${bands.value.length} overlap${bands.value.length === 1 ? "" : "s"}` : ""}`;
});

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function barLabel(bar: Bar) {
  if (bar.kind === "fail") return "✕";
  if (bar.kind === "live") return "";
  return (bar.kind === "plan" ? "~" : "") + duration(bar.end - bar.start);
}
function barTitle(bar: Bar) {
  const what = { ok: "ran", fail: "failed", live: "running", plan: "planned" }[bar.kind];
  return `${name(bar.workflowId)} ${what} at ${clock.format(bar.start)}${bar.kind === "plan" ? "" : `, ${duration(bar.end - bar.start)}`}`;
}

const selectedId = ref("");
const selected = computed(() => bars.value.find((b) => b.id === selectedId.value));
const alongside = computed(() => {
  const bar = selected.value;
  if (!bar) return [];
  return [...new Set(bars.value.filter((b) => b.kind !== "plan" && b.workflowId !== bar.workflowId && b.start < bar.end && b.end > bar.start).map((b) => name(b.workflowId)))];
});
watch([day, filter], () => (selectedId.value = ""));

const root = ref<HTMLElement>();
function shiftDay(delta: number) {
  const d = new Date(day.value);
  d.setDate(d.getDate() + delta);
  day.value = d.getTime();
}
function key(event: KeyboardEvent) {
  if ((event.target as Element).closest("input,textarea,[contenteditable]")) return;
  if (event.key === "Escape" && selectedId.value) {
    event.preventDefault();
    event.stopPropagation();
    selectedId.value = "";
  } else if (event.key === "[" || (event.key === "ArrowLeft" && event.altKey)) (event.preventDefault(), shiftDay(-1));
  else if (event.key === "]" || (event.key === "ArrowRight" && event.altKey)) (event.preventDefault(), shiftDay(1));
  else if (event.key.toLowerCase() === "t" && !event.ctrlKey && !event.metaKey) (event.preventDefault(), (day.value = dayStart(Date.now())));
}
</script>

<template>
  <section ref="root" class="automation-timeline" tabindex="-1" aria-label="Automation timeline" @keydown="key">
    <header class="at-head">
      <span class="at-summary">{{ summary }}</span>
      <span class="at-grow" />
      <div class="at-seg" role="group" aria-label="Show">
        <button v-for="f in (['all', 'triggers', 'failed'] as const)" :key="f" type="button" :aria-pressed="filter === f" @click="filter = f">
          {{ f === "all" ? "All" : f === "triggers" ? "Triggers" : "Failed" }}
        </button>
      </div>
      <div class="at-nav">
        <button type="button" aria-label="Previous day" title="Previous day ([)" @click="shiftDay(-1)"><Icon name="back" :size="13" /></button>
        <button type="button" class="at-today" :disabled="isToday" title="Today (T)" @click="day = dayStart(Date.now())">Today</button>
        <button type="button" aria-label="Next day" title="Next day (])" @click="shiftDay(1)"><Icon name="forward" :size="13" /></button>
      </div>
    </header>
    <div class="at-scroll">
      <div class="at-grid">
        <div class="at-corner" />
        <div class="at-axis">
          <span v-for="hour in range.hours" :key="hour" :style="{ left: `${pct(day + hour * 3_600_000)}%` }">{{ String(hour).padStart(2, "0") }}</span>
          <i v-for="band in bands" :key="band[0]" class="at-busy" :style="span(band[0], band[1])" />
          <b v-if="isToday" class="at-now-label" :style="{ left: `${pct(now)}%` }">{{ clock.format(now) }}</b>
        </div>
        <template v-for="lane in lanes" :key="lane.id">
          <button type="button" class="at-name" :title="`Open ${lane.name}`" @click="emit('open', lane.id)">
            <b>{{ lane.name }}</b><small>{{ lane.detail }}</small>
          </button>
          <div class="at-lane" :style="{ backgroundSize: `${100 / range.hours.length}% 100%` }">
            <button
              v-for="bar in lane.bars"
              :key="bar.id"
              type="button"
              class="at-run"
              :class="[bar.kind, { on: bar.id === selectedId }]"
              :style="span(bar.start, bar.end)"
              :aria-label="barTitle(bar)"
              :aria-pressed="bar.id === selectedId"
              :title="barTitle(bar)"
              @click="selectedId = selectedId === bar.id ? '' : bar.id"
            >
              <span>{{ barLabel(bar) }}</span>
            </button>
          </div>
        </template>
        <div v-if="lanes.length" class="at-overlay">
          <span v-for="band in bands" :key="band[0]" class="at-overlap" :style="span(band[0], band[1])" />
          <span v-if="isToday" class="at-now" :style="{ left: `${pct(now)}%` }" />
        </div>
      </div>
      <p v-if="!lanes.length" class="at-empty">
        {{ filter === "all" ? "No workflow ran or is planned on this day." : filter === "failed" ? "Nothing failed on this day." : "No triggers ran or are planned on this day." }}
      </p>
    </div>
    <div v-if="selected" class="at-detail" role="dialog" aria-label="Run details">
      <strong>{{ name(selected.workflowId) }} · {{ clock.format(selected.start) }}<template v-if="selected.kind !== 'plan'"> – {{ clock.format(selected.end) }}</template></strong>
      <p v-if="selected.run?.error" class="at-error">{{ selected.run.error }}</p>
      <p v-else-if="selected.kind === 'live'" class="at-note">Running for {{ duration(now - selected.start) }}</p>
      <p v-else-if="selected.kind === 'plan'" class="at-note">Planned by {{ selected.source }}, usually takes {{ duration(selected.end - selected.start) }}</p>
      <p v-else class="at-note">Took {{ duration(selected.end - selected.start) }}</p>
      <div v-if="selected.kind !== 'plan'" class="at-row"><span>Started by</span><b>{{ selected.source }}</b></div>
      <div v-if="alongside.length" class="at-row"><span>Ran alongside</span><b>{{ alongside.join(", ") }}</b></div>
      <button type="button" class="subtle-button" @click="emit('open', selected.workflowId)">Open workflow</button>
    </div>
    <footer class="at-legend">
      <span><i class="ok" />Ran</span><span><i class="fail" />Failed</span><span><i class="live" />Running</span><span><i class="plan" />Planned</span><span><i class="overlap" />Overlap</span>
      <span class="at-grow" /><span>[ ] day · T today · Esc close details</span>
    </footer>
  </section>
</template>

<style scoped>
.automation-timeline {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  outline: none;
  font-size: 13px;
  color: #455968;
}
.at-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid #e3eaee;
}
.at-summary {
  color: #8296a2;
  font-size: 12px;
}
.at-grow {
  flex: 1;
}
.at-seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: #e8eff3;
}
.at-seg button {
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #5d7381;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.at-seg button[aria-pressed="true"] {
  background: #fbfcfd;
  color: #273f50;
  box-shadow: 0 1px 2px #263f5512;
}
.at-nav {
  display: flex;
  align-items: center;
  gap: 2px;
}
.at-nav button {
  display: grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  padding: 0 4px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #6f8998;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.at-nav button:hover:not(:disabled) {
  background: #e7eef2;
}
.at-nav .at-today:disabled {
  color: #b3c2ca;
  cursor: default;
}
.at-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.at-grid {
  position: relative;
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
}
.at-corner {
  border-bottom: 1px solid #e3eaee;
}
.at-axis {
  position: relative;
  height: 34px;
  border-bottom: 1px solid #e3eaee;
}
.at-axis span {
  position: absolute;
  top: 9px;
  padding-left: 4px;
  color: #9aabb5;
  font: 11px "Cascadia Code", Consolas, monospace;
}
.at-busy {
  position: absolute;
  bottom: 0;
  height: 4px;
  border-radius: 2px 2px 0 0;
  background: #d8a594;
}
.at-now-label {
  position: absolute;
  top: 8px;
  padding: 0 4px;
  border-radius: 4px;
  background: #6f8998;
  color: #fff;
  font: 500 10.5px/16px "Cascadia Code", Consolas, monospace;
  transform: translateX(-50%);
}
.at-name {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  height: 48px;
  padding: 0 16px;
  border: 0;
  border-bottom: 1px solid #edf1f4;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.at-name:hover {
  background: #eef3f6;
}
.at-name b,
.at-name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.at-name b {
  color: #273f50;
  font-size: 12.5px;
  font-weight: 550;
}
.at-name small {
  color: #8296a2;
  font-size: 11px;
}
.at-lane {
  position: relative;
  height: 48px;
  border-bottom: 1px solid #edf1f4;
  background-image: linear-gradient(to right, #edf1f4 1px, transparent 1px);
}
.at-run {
  position: absolute;
  top: 13px;
  z-index: 1;
  display: flex;
  align-items: center;
  height: 22px;
  padding: 0 6px;
  overflow: hidden;
  border: 0;
  border-radius: 5px;
  background: #8fb39b;
  color: #fff;
  font: 500 11px/1 "Inter Variable", Inter, sans-serif;
  white-space: nowrap;
  cursor: pointer;
}
.at-run span {
  overflow: hidden;
  text-overflow: clip;
}
.at-run.fail {
  background: #c78d7b;
}
.at-run.live {
  background: #6f8998;
}
.at-run.live::after {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 10px;
  background: linear-gradient(90deg, transparent, #ffffff55);
  animation: at-pulse 1.4s ease-in-out infinite;
}
@keyframes at-pulse {
  50% {
    opacity: 0.2;
  }
}
.at-run.plan {
  border: 1.5px dashed #9fb6c3;
  background: transparent;
  color: #6f8998;
}
.at-run.on {
  box-shadow: 0 0 0 2px #fbfcfd, 0 0 0 4px #6f8998;
}
.at-run:focus-visible {
  outline: 2px solid #365f78;
  outline-offset: 2px;
}
.at-overlay {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 200px;
  pointer-events: none;
}
.at-overlap {
  position: absolute;
  top: 0;
  bottom: 0;
  border-right: 1px dashed #d8a594;
  border-left: 1px dashed #d8a594;
  background: #c78d7b14;
}
.at-now {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1.5px solid #6f8998;
}
.at-empty {
  margin: 0;
  padding: 24px 16px;
  color: #8296a2;
  font-size: 12px;
}
.at-detail {
  position: absolute;
  right: 16px;
  bottom: 44px;
  z-index: 3;
  display: grid;
  gap: 4px;
  width: 290px;
  padding: 10px 12px;
  border: 1px solid #dbe4ea;
  border-radius: 9px;
  background: #fbfcfd;
  box-shadow: 0 12px 32px -8px #263f5533;
  font-size: 12px;
}
.at-detail strong {
  color: #273f50;
  font-weight: 600;
}
.at-detail p {
  margin: 0 0 4px;
  overflow-wrap: anywhere;
}
.at-error {
  color: #9a5a49;
}
.at-note {
  color: #8296a2;
}
.at-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #8296a2;
  font-size: 11.5px;
}
.at-row b {
  overflow: hidden;
  color: #455968;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.at-detail .subtle-button {
  justify-self: start;
  margin-top: 4px;
}
.at-legend {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 9px 16px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
.at-legend i {
  display: inline-block;
  width: 14px;
  height: 8px;
  margin-right: 6px;
  border-radius: 3px;
}
.at-legend i.ok {
  background: #8fb39b;
}
.at-legend i.fail {
  background: #c78d7b;
}
.at-legend i.live {
  background: #6f8998;
}
.at-legend i.plan {
  border: 1.5px dashed #9fb6c3;
}
.at-legend i.overlap {
  border: 1px dashed #d8a594;
  background: #c78d7b22;
}
@media (prefers-reduced-motion: reduce) {
  .at-run.live::after {
    animation: none;
  }
}
</style>
