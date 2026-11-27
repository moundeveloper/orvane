<script setup lang="ts">
// A script's execution logs (Magic NetSuite's "Execution Logs" panel): time
// range, levels, deployments and a text filter; rows open to the whole
// message. Clear deletes the logs in NetSuite, so it asks once more first.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import DatePicker from "./pickers/DatePicker.vue";
import { copyText, message, type NetSuiteRequest, type Row } from "../netsuiteScripts";

const props = defineProps<{
  environment: string;
  request: NetSuiteRequest;
  scriptId: number | null;
  deployments: Row[];
}>();
const LEVELS = [
  { id: "DEBUG", label: "Debug" },
  { id: "AUDIT", label: "Audit" },
  { id: "ERROR", label: "Error" },
  { id: "EMERGENCY", label: "Emergency" },
] as const;
type Range = "hour" | "today" | "week" | "month" | "custom";
const range = ref<Range>("today");
const levels = ref<string[]>(LEVELS.map((l) => l.id));
const chosen = ref<number[]>([]);
const text = ref("");
const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const customFrom = ref(day(new Date(Date.now() - 7 * 86_400_000)));
const customTo = ref(day(new Date()));
const rows = ref<Row[]>([]),
  total = ref(0),
  loading = ref(false),
  error = ref(""),
  opened = ref<number | null>(null),
  confirmClear = ref(false),
  clearing = ref(false),
  refreshedAt = ref("");
/** The day range NetSuite filters by, and the exact start for "Last hour". */
const window_ = computed(() => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range.value === "hour") return { from: new Date(now.getTime() - 3_600_000), to: now, after: now.getTime() - 3_600_000 };
  if (range.value === "today") return { from: start, to: now, after: 0 };
  if (range.value === "week") return { from: new Date(start.getTime() - 6 * 86_400_000), to: now, after: 0 };
  if (range.value === "month") return { from: new Date(start.getTime() - 29 * 86_400_000), to: now, after: 0 };
  const from = new Date(`${customFrom.value}T00:00:00`);
  const to = new Date(`${customTo.value}T23:59:59`);
  return { from, to: to < from ? from : to, after: 0 };
});
const deploymentName = (id: unknown) => {
  const row = props.deployments.find((d) => Number(d.primarykey) === Number(id));
  return row ? String(row.scriptid) : "";
};
/** The part that tells deployments apart: customdeploy_x_inv_ch → _inv_ch. */
function shortName(name: string) {
  const all = props.deployments.map((d) => String(d.scriptid));
  if (all.length < 2) return name.replace(/^customdeploy_?/, "") || name;
  let prefix = all[0]!;
  for (const other of all) while (!other.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = prefix.lastIndexOf("_");
  return cut > 0 ? name.slice(cut) : name;
}
const shown = computed(() => {
  const needle = text.value.trim().toLowerCase();
  const after = window_.value.after;
  return rows.value.filter((row) => {
    if (after && (Date.parse(String(row.datetime ?? "")) || 0) < after) return false;
    if (!needle) return true;
    return [row.title, row.detail, row.deploymentScriptId, row.user].some((v) =>
      String(v ?? "").toLowerCase().includes(needle),
    );
  });
});
const errorsOnly = computed(
  () => levels.value.length === 2 && levels.value.includes("ERROR") && levels.value.includes("EMERGENCY"),
);
function showErrors() {
  levels.value = errorsOnly.value ? LEVELS.map((l) => l.id) : ["ERROR", "EMERGENCY"];
}
function toggleLevel(id: string) {
  levels.value = levels.value.includes(id)
    ? levels.value.filter((l) => l !== id)
    : [...levels.value, id];
}
function toggleDeployment(id: number) {
  chosen.value = chosen.value.includes(id)
    ? chosen.value.filter((d) => d !== id)
    : [...chosen.value, id];
}
let sequence = 0;
async function load() {
  const script = props.scriptId;
  const ticket = ++sequence;
  confirmClear.value = false;
  if (!script || !props.environment) {
    rows.value = [];
    total.value = 0;
    return;
  }
  if (!levels.value.length) {
    rows.value = [];
    total.value = 0;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const data = await props.request("log-search", {
      from: window_.value.from.toISOString(),
      to: window_.value.to.toISOString(),
      levels: levels.value,
      scriptIds: [script],
      deploymentIds: chosen.value,
    });
    if (ticket !== sequence) return;
    rows.value = ((data.rows ?? []) as Row[]).sort(
      (a, b) => (Date.parse(String(b.datetime ?? "")) || 0) - (Date.parse(String(a.datetime ?? "")) || 0) || Number(b.id) - Number(a.id),
    );
    total.value = Number(data.totalCount ?? rows.value.length);
    refreshedAt.value = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    if (ticket === sequence) {
      error.value = message(e);
      rows.value = [];
    }
  } finally {
    if (ticket === sequence) loading.value = false;
  }
}
let timer: ReturnType<typeof setTimeout> | undefined;
function soon() {
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 180);
}
watch(
  [() => props.scriptId, () => props.environment, range, levels, chosen, customFrom, customTo],
  ([script], [before]) => {
    if (script !== before) {
      chosen.value = [];
      opened.value = null;
    }
    soon();
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));
const clearTargets = computed(() =>
  chosen.value.length
    ? props.deployments.filter((d) => chosen.value.includes(Number(d.primarykey)))
    : props.deployments,
);
async function clear() {
  if (!confirmClear.value) {
    confirmClear.value = true;
    return;
  }
  confirmClear.value = false;
  clearing.value = true;
  error.value = "";
  try {
    for (const deployment of clearTargets.value)
      await props.request("clear-script-logs", { deploymentId: Number(deployment.primarykey) });
  } catch (e) {
    error.value = message(e);
  } finally {
    clearing.value = false;
    await load();
  }
}
const time = (row: Row) => {
  const d = new Date(String(row.datetime ?? ""));
  if (Number.isNaN(d.getTime())) return String(row.time ?? "");
  const two = (n: number) => String(n).padStart(2, "0");
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  // Today: 24-hour time with seconds; older: day.month and the time.
  return day(d) === day(new Date())
    ? `${clock}:${two(d.getSeconds())}`
    : `${two(d.getDate())}.${two(d.getMonth() + 1)} ${clock}`;
};
const copied = ref<number | null>(null);
async function copy(row: Row) {
  try {
    await copyText(`${row.level} ${row.datetime ?? ""} ${row.title ?? ""}\n${row.detail ?? ""}`);
    copied.value = Number(row.id);
    setTimeout(() => copied.value === Number(row.id) && (copied.value = null), 1400);
  } catch {
    error.value = "Could not copy to the clipboard.";
  }
}
defineExpose({ reload: load });
</script>

<template>
  <section class="script-logs" aria-label="Execution logs">
    <div class="sl-filters">
      <div class="sl-title">
        <strong>Execution logs</strong>
        <span v-if="scriptId">{{ loading ? "loading…" : `${shown.length}${total > rows.length ? ` of ${total}` : ""} in range` }}</span>
        <span class="sl-space" />
        <button
          type="button"
          class="sl-clear"
          :class="{ confirm: confirmClear }"
          :disabled="!scriptId || clearing || !clearTargets.length"
          :title="chosen.length ? 'Delete the logs of the chosen deployments in NetSuite' : 'Delete all of this script\'s logs in NetSuite'"
          @click="clear"
          @blur="confirmClear = false"
        >
          <Icon name="trash" :size="12" />{{ clearing ? "Clearing…" : confirmClear ? `Delete ${clearTargets.length === 1 ? "1 deployment's" : `${clearTargets.length} deployments'`} logs?` : "Clear" }}
        </button>
        <button type="button" class="sl-icon" aria-label="Refresh logs" title="Refresh logs" :disabled="!scriptId || loading" @click="load">
          <Icon name="refresh" :size="13" />
        </button>
      </div>
      <div class="sl-chips" role="group" aria-label="Time range">
        <button type="button" class="sl-chip" :aria-pressed="range === 'hour'" @click="range = 'hour'">Last hour</button>
        <button type="button" class="sl-chip" :aria-pressed="range === 'today'" @click="range = 'today'">Today</button>
        <button type="button" class="sl-chip" :aria-pressed="range === 'week'" @click="range = 'week'">7 days</button>
        <button type="button" class="sl-chip" :aria-pressed="range === 'month'" @click="range = 'month'">30 days</button>
        <button type="button" class="sl-chip" :aria-pressed="range === 'custom'" @click="range = 'custom'">Dates…</button>
      </div>
      <div v-if="range === 'custom'" class="sl-range">
        <DatePicker v-model="customFrom" aria-label="From" />
        <span>→</span>
        <DatePicker v-model="customTo" aria-label="To" />
      </div>
      <div class="sl-chips" role="group" aria-label="Levels">
        <button type="button" class="sl-chip" :aria-pressed="errorsOnly" @click="showErrors">Errors</button>
        <span class="sl-gap" />
        <button
          v-for="level in LEVELS"
          :key="level.id"
          type="button"
          class="sl-chip"
          :aria-pressed="levels.includes(level.id)"
          @click="toggleLevel(level.id)"
        ><i class="sl-lv" :class="level.id.toLowerCase()" />{{ level.label }}</button>
      </div>
      <div v-if="deployments.length > 1" class="sl-chips" role="group" aria-label="Deployments">
        <button
          v-for="d in deployments"
          :key="String(d.primarykey)"
          type="button"
          class="sl-chip sl-mono"
          :aria-pressed="chosen.includes(Number(d.primarykey))"
          :title="String(d.scriptid)"
          @click="toggleDeployment(Number(d.primarykey))"
        >{{ shortName(String(d.scriptid)) }}</button>
      </div>
      <label class="sl-search">
        <Icon name="search" :size="13" />
        <input v-model="text" placeholder="Filter logs" aria-label="Filter logs" spellcheck="false" />
      </label>
    </div>
    <p v-if="error" class="sl-note sl-error" role="alert">{{ error }}</p>
    <div class="sl-list">
      <p v-if="!scriptId" class="sl-note">Choose a script to see its logs.</p>
      <p v-else-if="!loading && !shown.length && !error" class="sl-note">No logs match these filters.</p>
      <article
        v-for="row in shown"
        :key="String(row.id)"
        class="sl-row"
        :class="{ bad: ['ERROR', 'EMERGENCY'].includes(String(row.level).toUpperCase()), open: opened === Number(row.id) }"
      >
        <button type="button" class="sl-head" :aria-expanded="opened === Number(row.id)" @click="opened = opened === Number(row.id) ? null : Number(row.id)">
          <time>{{ time(row) }}</time>
          <span class="sl-main">
            <b class="sl-level" :class="String(row.level).toLowerCase()">{{ String(row.level).toUpperCase() }}</b>
            <span class="sl-text">{{ row.title || deploymentName(row.deploymentId) || "(no title)" }}</span>
            <span class="sl-meta">{{ shortName(String(row.deploymentScriptId || deploymentName(row.deploymentId) || "")) }}{{ row.detail && opened !== Number(row.id) ? ` · ${String(row.detail).slice(0, 140)}` : "" }}</span>
          </span>
        </button>
        <div v-if="opened === Number(row.id)" class="sl-detail">
          <pre>{{ row.detail || "(no details)" }}</pre>
          <div class="sl-detail-foot">
            <span>{{ row.user }}{{ row.detailTruncated ? " · details cut at 1,000 characters" : "" }}</span>
            <button type="button" class="sl-copy" @click="copy(row)">{{ copied === Number(row.id) ? "Copied" : "Copy" }}</button>
          </div>
        </div>
      </article>
    </div>
    <footer v-if="refreshedAt && scriptId" class="sl-foot">Refreshed {{ refreshedAt }}</footer>
  </section>
</template>

<style scoped>
.script-logs {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
  font-size: 12px;
}
.sl-filters {
  grid-row: 1;
  display: grid;
  gap: 6px;
  padding: 10px 12px 8px;
}
.sl-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sl-title strong {
  color: #273f50;
  font-weight: 600;
}
.sl-title > span:not(.sl-space) {
  color: #8296a2;
  font-size: 11.5px;
  white-space: nowrap;
}
.sl-space {
  flex: 1;
}
.sl-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sl-gap {
  width: 4px;
}
.sl-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid #e3eaee;
  border-radius: 6px;
  background: none;
  color: #5d7381;
  font-size: 11.5px;
  white-space: nowrap;
}
.sl-chip:hover {
  background: #eef3f6;
}
.sl-chip[aria-pressed="true"] {
  border-color: transparent;
  background: #e4edf2;
  color: #273f50;
}
.sl-mono {
  font: 11px "Cascadia Code", Consolas, monospace;
}
.sl-lv {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: #7a8f9b;
}
.sl-lv.audit {
  background: #365f78;
}
.sl-lv.error {
  background: #a0624f;
}
.sl-lv.emergency {
  background: #7b3b2d;
}
.sl-range {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #8296a2;
}
.sl-range :deep(.select-trigger),
.sl-range > :deep(button) {
  flex: 1;
  min-width: 0;
}
.sl-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid #dbe5eb;
  border-radius: 7px;
  background: #fbfcfd;
  color: #8296a2;
}
.sl-search:focus-within {
  border-color: #7b97a7;
}
.sl-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: #273f50;
  font: inherit;
  outline: none;
}
.sl-clear,
.sl-icon {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #a0624f;
  font-size: 11.5px;
  white-space: nowrap;
}
.sl-clear.confirm {
  background: #f6e6e1;
  color: #7b3b2d;
}
.sl-icon {
  width: 24px;
  justify-content: center;
  padding: 0;
  color: #6f8998;
}
.sl-clear:hover:not(:disabled),
.sl-icon:hover:not(:disabled) {
  background: #eef3f6;
}
.sl-clear:disabled,
.sl-icon:disabled {
  opacity: 0.45;
}
.sl-list {
  grid-row: 3;
  overflow: auto;
  padding: 0 6px 8px;
}
.sl-note {
  margin: 0;
  padding: 10px 12px;
  color: #5d7381;
}
.sl-error {
  grid-row: 2;
  color: #8c4637;
  white-space: pre-wrap;
}
.sl-row {
  border-radius: 7px;
}
.sl-row.bad {
  background: #f8eeea;
}
.sl-head {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  gap: 0 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
}
.sl-row:not(.bad) .sl-head:hover {
  background: #eef3f6;
}
.sl-head time {
  padding-top: 1px;
  color: #8296a2;
  font: 11px "Cascadia Code", Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.sl-main {
  min-width: 0;
}
.sl-level {
  margin-right: 6px;
  font: 600 10px "Cascadia Code", Consolas, monospace;
  letter-spacing: 0.03em;
  color: #7a8f9b;
}
.sl-level.audit {
  color: #365f78;
}
.sl-level.error {
  color: #a0624f;
}
.sl-level.emergency {
  color: #7b3b2d;
}
.sl-text {
  color: #273f50;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.sl-meta {
  display: block;
  overflow: hidden;
  color: #5d7381;
  font: 11px "Cascadia Code", Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-detail {
  padding: 0 8px 8px 86px;
}
.sl-detail pre {
  max-height: 260px;
  margin: 0;
  padding: 7px 9px;
  overflow: auto;
  border: 1px solid #e3eaee;
  border-radius: 7px;
  background: #f2f6f8;
  color: #4b6170;
  font: 11px/1.55 "Cascadia Code", Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sl-detail-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  color: #8296a2;
  font-size: 11px;
}
.sl-detail-foot span {
  flex: 1;
}
.sl-copy {
  padding: 0 6px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #385d76;
  font-size: 11px;
}
.sl-copy:hover {
  background: #e1ebf1;
}
.sl-foot {
  grid-row: 4;
  padding: 4px 12px 6px;
  color: #8296a2;
  font-size: 11px;
}
</style>
