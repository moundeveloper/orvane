<script setup lang="ts">
// NetSuite Scripts: the port of Magic NetSuite's scripts list and script page
// (UI Maker "NetSuite Scripts", picked variant "Table → Workbench").
// Table: every script, deployments open inline with their actions, and the
// selected script's execution logs beside it. Opening a script turns the
// same view into the workbench: a narrow list, the editor, and deployments
// above the same logs. Esc goes back with the same script selected.
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import Icon from "./Icon.vue";
import WindowedScriptsBody from "./WindowedScriptsBody.vue";
import ScriptDeploymentActions from "./ScriptDeploymentActions.vue";
import ScriptLogs from "./ScriptLogs.vue";
import ScriptEditor from "./ScriptEditor.vue";
import type { Block } from "../model";
import {
  copyText,
  deployed,
  levelLabel,
  message,
  recordBound,
  statusLabel,
  typeLabel,
  type Row,
} from "../netsuiteScripts";

defineOptions({ name: "NetSuiteScripts" });
const props = defineProps<{
  block: Block;
  environment: string;
  request: (op: string, args?: Record<string, unknown>) => Promise<Row>;
  openRecord: (kind: string, id: unknown) => unknown;
  openPage?: (url: string, background?: boolean) => Promise<void>;
  status?: string;
  // Script to show when the app opens, e.g. from the File Cabinet.
  initialScript?: { id: number; scriptid: string };
}>();
const emit = defineEmits<{
  "edit-file": [file: { id: number; name: string }];
  "opened-initial": [];
}>();
const root = ref<HTMLElement>();
const busy = ref(false),
  error = ref(""),
  scripts = shallowRef<Row[]>([]),
  expanded = ref<number[]>([]),
  deployments = shallowRef<Record<number, Row[]>>({}),
  deploymentErrors = ref<Record<number, string>>({}),
  deploymentsLoading = ref<number[]>([]),
  selectedId = ref<number | null>(null),
  mode = ref<"table" | "script">("table"),
  active = ref(true);
const search = ref(""),
  types = ref<string[]>([]),
  order = ref("name"),
  descending = ref(false);
/* ---------- On record ---------- */
const recordPicker = ref(false),
  recordTypes = ref<Row[]>([]),
  recordSearch = ref(""),
  recordType = ref(""),
  recordRows = ref<Row[]>([]),
  recordAnchor = ref<HTMLElement>(),
  recordField = ref<HTMLInputElement>();
const recordScripts = computed(() => new Set(recordRows.value.map((r) => Number(r.id))));

const typeCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const row of scripts.value) {
    const type = String(row.scripttype || "");
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || typeLabel(a[0]).localeCompare(typeLabel(b[0])));
});
const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return scripts.value
    .filter(
      (row) =>
        (!types.value.length || types.value.includes(String(row.scripttype))) &&
        (!recordType.value || recordScripts.value.has(Number(row.id))) &&
        (!needle ||
          [row.name, row.scriptid, row.scriptfile, row.owner, row.id].some((v) =>
            String(v ?? "").toLowerCase().includes(needle),
          )),
    )
    .sort((a, b) => {
      const key = order.value;
      const x = key === "deployments" ? Number(a.deployments ?? 0) : key === "scripttype" ? typeLabel(a.scripttype) : String(a[key] ?? "");
      const y = key === "deployments" ? Number(b.deployments ?? 0) : key === "scripttype" ? typeLabel(b.scripttype) : String(b[key] ?? "");
      const result = typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true });
      return result * (descending.value ? -1 : 1);
    });
});
/** The narrow list (script mode) groups by type like the mock. */
const groups = computed(() => {
  const map = new Map<string, Row[]>();
  for (const row of filtered.value) {
    const label = typeLabel(row.scripttype);
    map.set(label, [...(map.get(label) ?? []), row]);
  }
  return [...map];
});
const selected = computed(() => scripts.value.find((r) => Number(r.id) === selectedId.value) ?? null);
const deploymentsOf = (row: Row | null) => {
  if (!row) return [];
  const list = deployments.value[Number(row.id)] ?? [];
  return recordType.value
    ? list.filter((d) => String(d.recordtype ?? "").toUpperCase() === recordType.value.toUpperCase())
    : list;
};
const selectedDeployments = computed(() => deploymentsOf(selected.value));
const columns = [
  { label: "Name", key: "name" },
  { label: "Type", key: "scripttype" },
  { label: "Script ID", key: "scriptid" },
  { label: "Script file", key: "scriptfile" },
  { label: "Owner", key: "owner" },
  { label: "Deploy.", key: "deployments" },
];
function sortBy(key: string) {
  if (order.value === key) descending.value = !descending.value;
  else {
    order.value = key;
    descending.value = false;
  }
}
function toggleType(type: string) {
  types.value = types.value.includes(type) ? types.value.filter((t) => t !== type) : [...types.value, type];
}
let generation = 0,
  autoLoadKey = "";
async function loadScripts() {
  if (!props.environment || busy.value) return;
  const ticket = generation;
  busy.value = true;
  error.value = "";
  try {
    const data = await props.request("scripts");
    if (ticket !== generation) return;
    scripts.value = Array.isArray(data.rows) ? data.rows : [];
    deployments.value = {};
    deploymentErrors.value = {};
    if (selectedId.value) void loadDeployments(selectedId.value);
    for (const id of expanded.value) void loadDeployments(id);
  } catch (e) {
    if (ticket === generation) error.value = message(e);
  } finally {
    if (ticket === generation) busy.value = false;
  }
}
async function loadDeployments(id: number, force = false) {
  if (!props.environment || deploymentsLoading.value.includes(id)) return;
  if (!force && deployments.value[id]) return;
  const ticket = generation;
  deploymentsLoading.value = [...deploymentsLoading.value, id];
  delete deploymentErrors.value[id];
  try {
    const data = await props.request("deployments", { id });
    if (ticket === generation) deployments.value = { ...deployments.value, [id]: Array.isArray(data.rows) ? data.rows : [] };
  } catch (e) {
    if (ticket === generation) deploymentErrors.value[id] = message(e);
  } finally {
    if (ticket === generation) deploymentsLoading.value = deploymentsLoading.value.filter((x) => x !== id);
  }
}
function select(row: Row) {
  selectedId.value = Number(row.id);
  void loadDeployments(Number(row.id));
}
function toggle(row: Row) {
  const id = Number(row.id);
  select(row);
  if (expanded.value.includes(id)) expanded.value = expanded.value.filter((x) => x !== id);
  else {
    expanded.value = [...expanded.value, id];
    void loadDeployments(id);
  }
}
async function openScript(row: Row | null = selected.value) {
  if (!row) return;
  select(row);
  mode.value = "script";
  await nextTick();
  root.value?.querySelector<HTMLElement>(`.nr[data-id="${row.id}"]`)?.scrollIntoView({ block: "nearest" });
}
async function backToTable() {
  mode.value = "table";
  await nextTick();
  root.value?.querySelector<HTMLElement>(`[data-script-key="${selectedId.value}"] .script-row`)?.focus({ preventScroll: false });
}
function move(step: number) {
  const list = filtered.value;
  if (!list.length) return;
  const at = list.findIndex((r) => Number(r.id) === selectedId.value);
  const next = list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + step))]!;
  select(next);
  void nextTick(() => {
    const target = mode.value === "table"
      ? root.value?.querySelector<HTMLElement>(`[data-script-key="${next.id}"] .script-row`)
      : root.value?.querySelector<HTMLElement>(`.nr[data-id="${next.id}"]`);
    target?.focus({ preventScroll: false });
  });
}
/** Keys of the list (they defer to text fields and the code editor). */
function key(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = !!target?.closest("input, textarea, [contenteditable='true'], .cm-editor");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    root.value?.querySelector<HTMLInputElement>(".scripts-search input")?.focus();
    return;
  }
  if (event.key === "Escape" && !typing && mode.value === "script" && !event.defaultPrevented) {
    event.preventDefault();
    void backToTable();
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
    if (mode.value === "table" && selected.value) {
      event.preventDefault();
      void openScript();
    }
    return;
  }
  if (event.altKey && !event.ctrlKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    root.value?.querySelector<HTMLInputElement>(".script-logs .sl-search input")?.focus();
    return;
  }
  if (typing || !target?.closest(".scripts-list")) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  } else if (mode.value === "table" && selected.value && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    const open = expanded.value.includes(Number(selected.value.id));
    if ((event.key === "ArrowRight") !== open) {
      event.preventDefault();
      toggle(selected.value);
    }
  } else if (event.key === "Enter" && selected.value) {
    event.preventDefault();
    if (mode.value === "table") toggle(selected.value);
    else void openScript();
  } else if (event.key.toLowerCase() === "c" && !event.ctrlKey && !event.metaKey && selected.value) {
    void copy(selected.value.scriptid, "Script ID");
  }
}
/* ---------- Copy IDs (right-click) ---------- */
const menu = ref<{ x: number; y: number; row: Row; deployment?: Row } | null>(null);
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
async function copy(value: unknown, what: string) {
  menu.value = null;
  try {
    await copyText(value);
    notice.value = `${what} copied`;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.value = ""), 1600);
  } catch {
    error.value = "Could not copy to the clipboard.";
  }
}
function contextMenu(event: MouseEvent, row: Row, deployment?: Row) {
  event.preventDefault();
  select(row);
  menu.value = { x: event.clientX, y: event.clientY, row, deployment };
}
function dismissMenus(event: PointerEvent) {
  const target = event.target as Node;
  if (menu.value && !(target instanceof Element && target.closest(".scripts-menu"))) menu.value = null;
  if (recordPicker.value && !recordAnchor.value?.contains(target)) recordPicker.value = false;
}
function escapeMenus(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (menu.value || recordPicker.value) {
    event.preventDefault();
    event.stopPropagation();
    menu.value = null;
    recordPicker.value = false;
  }
}
/* ---------- On record ---------- */
async function openRecordPicker() {
  recordPicker.value = !recordPicker.value;
  if (!recordPicker.value) return;
  recordSearch.value = "";
  await nextTick();
  recordField.value?.focus();
  if (recordTypes.value.length) return;
  try {
    const data = await props.request("record-deployments");
    recordTypes.value = Array.isArray(data.recordTypes) ? data.recordTypes : [];
  } catch (e) {
    error.value = message(e);
  }
}
const recordOptions = computed(() => {
  const needle = recordSearch.value.trim().toLowerCase();
  return recordTypes.value.filter((r) => String(r.recordtype).toLowerCase().includes(needle)).slice(0, 80);
});
async function chooseRecord(type: string) {
  recordPicker.value = false;
  recordType.value = type;
  recordRows.value = [];
  if (!type) return;
  try {
    const data = await props.request("record-deployments", { recordType: type });
    if (recordType.value !== type) return;
    recordRows.value = Array.isArray(data.rows) ? data.rows : [];
    // Their deployments come with the answer: open them.
    const byScript: Record<number, Row[]> = { ...deployments.value };
    for (const id of recordScripts.value) delete byScript[id];
    deployments.value = byScript;
    expanded.value = [...recordScripts.value];
    for (const id of recordScripts.value) void loadDeployments(id, true);
  } catch (e) {
    error.value = message(e);
  }
}
/** NetSuite's own record type IDs (SALESORDER, customrecord_x), as Magic showed them. */
const recordLabel = (type: string) => type;
/* ---------- Lifecycle ---------- */
watch(
  () => props.environment,
  () => {
    generation++;
    error.value = "";
    scripts.value = [];
    deployments.value = {};
    deploymentErrors.value = {};
    deploymentsLoading.value = [];
    expanded.value = [];
    selectedId.value = null;
    mode.value = "table";
    types.value = [];
    recordType.value = "";
    recordRows.value = [];
    recordTypes.value = [];
  },
);
watch(
  [() => props.environment, busy, active],
  ([environment, running, shown]) => {
    if (!environment || !shown) {
      autoLoadKey = "";
      return;
    }
    if (running || autoLoadKey === environment) return;
    autoLoadKey = environment;
    void loadScripts();
  },
  { immediate: true },
);
watch(
  () => props.status,
  (status, previous) => {
    if (status === "ready" && previous && previous !== "ready" && error.value && props.environment && active.value && !busy.value) {
      error.value = "";
      autoLoadKey = props.environment;
      void loadScripts();
    }
  },
);
// A script asked for from elsewhere (the File Cabinet) opens on its page.
watch(
  [() => props.initialScript, scripts],
  ([wanted, list]) => {
    if (!wanted || !list.length) return;
    const row = list.find((r) => Number(r.id) === wanted.id);
    if (row) void openScript(row);
    else search.value = wanted.scriptid || String(wanted.id);
    emit("opened-initial");
  },
  { immediate: true },
);
onActivated(() => (active.value = true));
onDeactivated(() => (active.value = false));
onMounted(() => {
  document.addEventListener("pointerdown", dismissMenus, true);
  document.addEventListener("keydown", escapeMenus, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", dismissMenus, true);
  document.removeEventListener("keydown", escapeMenus, true);
  clearTimeout(noticeTimer);
});
const logs = ref<{ reload(): void }>();
</script>

<template>
  <section ref="root" class="ns-scripts" :class="mode" @keydown="key">
    <header class="sc-bar">
      <button v-if="mode === 'script'" type="button" class="sc-icon" aria-label="Back to the table" title="Back to the table · Esc" @click="backToTable">
        <Icon name="back" :size="14" />
      </button>
      <strong class="sc-title">Scripts</strong>
      <label class="scripts-search">
        <Icon name="search" :size="13" />
        <input v-model="search" placeholder="Search name, ID, file, owner" aria-label="Search scripts" spellcheck="false" />
        <kbd>/</kbd>
      </label>
      <div class="sc-types" role="group" aria-label="Script types">
        <button
          v-for="[type, count] in typeCounts"
          :key="type"
          type="button"
          class="sc-chip"
          :aria-pressed="types.includes(type)"
          @click="toggleType(type)"
        >{{ typeLabel(type) }}<b>{{ count }}</b></button>
      </div>
      <span ref="recordAnchor" class="sc-record">
        <button
          v-if="recordType"
          type="button"
          class="sc-chip"
          aria-pressed="true"
          :title="`Scripts deployed on ${recordType}`"
          @click="chooseRecord('')"
        >On {{ recordLabel(recordType) }}<Icon name="close" :size="11" /></button>
        <button v-else type="button" class="sc-btn" :aria-expanded="recordPicker" title="Scripts deployed on a record type" @click="openRecordPicker">
          <Icon name="rows" :size="13" />On record…
        </button>
        <div v-if="recordPicker" class="select-popover sc-record-menu" role="dialog" aria-label="Record type">
          <label class="sc-record-field">
            <Icon name="search" :size="13" />
            <input ref="recordField" v-model="recordSearch" placeholder="Find a record type" spellcheck="false"
              @keydown.enter.prevent="recordOptions[0] && chooseRecord(String(recordOptions[0].recordtype))" />
          </label>
          <p v-if="!recordTypes.length" class="sc-note">Reading record types…</p>
          <button v-for="r in recordOptions" :key="String(r.recordtype)" type="button" class="sc-record-row" @click="chooseRecord(String(r.recordtype))">
            <span>{{ r.recordtype }}</span><b>{{ r.deployments }}</b>
          </button>
        </div>
      </span>
      <button type="button" class="sc-btn" :disabled="busy" @click="loadScripts">
        <Icon name="refresh" :size="13" />{{ busy ? "Loading…" : "Refresh" }}
      </button>
    </header>
    <p v-if="error" class="sc-error" role="alert">{{ error }} <button type="button" class="sc-x" aria-label="Dismiss" @click="error = ''"><Icon name="close" :size="11" /></button></p>
    <div class="sc-body">
      <!-- List: the full table, or the narrow list beside the editor. -->
      <section class="scripts-list" aria-label="Scripts">
        <template v-if="mode === 'table'">
          <div class="sc-cols sc-head" role="row">
            <span />
            <button
              v-for="column in columns"
              :key="column.key"
              type="button"
              :class="{ sorted: order === column.key }"
              @click="sortBy(column.key)"
            >{{ column.label }}{{ order === column.key ? (descending ? " ↓" : " ↑") : "" }}</button>
          </div>
          <WindowedScriptsBody
            class="sc-rows"
            :rows="filtered"
            :expanded="expanded"
            :reset-key="JSON.stringify([environment, search, types, order, descending, recordType])"
          >
            <template #default="{ row }">
              <div :key="String(row.id)" :data-script-key="String(row.id)" class="sc-record-item">
                <div
                  class="sc-cols sc-row script-row"
                  :class="{ open: expanded.includes(Number(row.id)) }"
                  role="row"
                  tabindex="0"
                  :aria-selected="selectedId === Number(row.id)"
                  :aria-expanded="expanded.includes(Number(row.id))"
                  @click="select(row)"
                  @dblclick="openScript(row)"
                  @contextmenu="contextMenu($event, row)"
                  @focus="selectedId !== Number(row.id) && select(row)"
                >
                  <button type="button" class="sc-chev" tabindex="-1" :aria-label="expanded.includes(Number(row.id)) ? 'Hide deployments' : 'Show deployments'" @click.stop="toggle(row)">
                    <Icon name="right" :size="13" />
                  </button>
                  <span class="sc-name" :title="String(row.name)">{{ row.name }}</span>
                  <span class="sc-muted">{{ typeLabel(row.scripttype) }}</span>
                  <span class="sc-mono" :title="String(row.scriptid)">{{ row.scriptid }}</span>
                  <span class="sc-mono" :title="String(row.scriptfile ?? '')">{{ row.scriptfile }}</span>
                  <span class="sc-muted" :title="String(row.owner ?? '')">{{ row.owner }}</span>
                  <span class="sc-count" :title="row.deployments !== undefined ? `${row.deployed ?? 0} of ${row.deployments} deployed` : ''">
                    <i class="sc-dot" :class="row.deployments === undefined ? '' : Number(row.deployed) > 0 ? 'on' : 'off'" />{{ row.deployments ?? "" }}
                  </span>
                </div>
                <div v-if="expanded.includes(Number(row.id))" class="sc-sub" @contextmenu.prevent>
                  <p v-if="deploymentsLoading.includes(Number(row.id)) && !deployments[Number(row.id)]" class="sc-note">Reading deployments…</p>
                  <p v-else-if="deploymentErrors[Number(row.id)]" class="sc-note sc-bad">{{ deploymentErrors[Number(row.id)] }}</p>
                  <p v-else-if="!deploymentsOf(row).length" class="sc-note">No deployments.</p>
                  <template v-else>
                    <div class="sc-dcols sc-dhead">
                      <span>Deployment</span><span>Deployed</span><span>Status</span><span>Log level</span><span>{{ recordBound(row.scripttype) ? "Applies to" : "" }}</span><span />
                    </div>
                    <div
                      v-for="d in deploymentsOf(row)"
                      :key="String(d.primarykey)"
                      class="sc-dcols sc-drow"
                      @contextmenu="contextMenu($event, row, d)"
                    >
                      <span class="sc-mono sc-strong" :title="String(d.scriptid)">{{ d.scriptid }}</span>
                      <span class="sc-state" :class="{ off: !deployed(d) }"><i class="sc-dot" :class="deployed(d) ? 'on' : 'off'" />{{ deployed(d) ? "Deployed" : "Off" }}</span>
                      <span>{{ statusLabel(d.status) }}</span>
                      <span>{{ levelLabel(d.loglevel) }}</span>
                      <span class="sc-muted">{{ recordBound(row.scripttype) ? recordLabel(String(d.recordtype || "All records")) : "" }}</span>
                      <ScriptDeploymentActions
                        :deployment="d"
                        :script-type="String(row.scripttype)"
                        :environment="environment"
                        :request="request"
                        :open-record="openRecord"
                        :open-page="openPage"
                        @error="error = $event"
                        @ran="selectedId === Number(row.id) && logs?.reload()"
                      />
                    </div>
                  </template>
                </div>
              </div>
            </template>
          </WindowedScriptsBody>
          <p v-if="busy && !scripts.length" class="sc-note">Reading scripts…</p>
          <p v-else-if="!scripts.length" class="sc-note">No scripts found.</p>
          <p v-else-if="!filtered.length" class="sc-note">No scripts match these filters.</p>
        </template>
        <div v-else class="sc-narrow" role="listbox" aria-label="Scripts">
          <template v-for="[label, list] in groups" :key="label">
            <div class="sc-group">{{ label }} · {{ list.length }}</div>
            <button
              v-for="row in list"
              :key="String(row.id)"
              type="button"
              class="nr"
              role="option"
              :data-id="row.id"
              :aria-selected="selectedId === Number(row.id)"
              @click="openScript(row)"
              @contextmenu="contextMenu($event, row)"
            >
              <span class="sc-name">{{ row.name }}</span>
              <span class="nr-count"><i class="sc-dot" :class="row.deployments === undefined ? '' : Number(row.deployed) > 0 ? 'on' : 'off'" />{{ row.deployments ?? "" }}</span>
              <span class="nr-id">{{ row.scriptid }}</span>
            </button>
          </template>
          <p v-if="!filtered.length" class="sc-note">No scripts match these filters.</p>
        </div>
      </section>
      <!-- Editor (script mode only). -->
      <ScriptEditor
        v-if="mode === 'script' && selected"
        :key="`${environment}|${selected.id}`"
        class="sc-editor"
        :script="selected"
        :environment="environment"
        :request="request"
        :open-record="openRecord"
        @error="error = $event"
      />
      <!-- Side: the same panel in both modes. -->
      <aside class="sc-side" aria-label="Selected script">
        <div v-if="mode === 'table'" class="sc-side-head">
          <template v-if="selected">
            <strong :title="String(selected.name)">{{ selected.name }}</strong>
            <span>#{{ selected.id }}{{ selected.scriptfile ? ` · ${selected.scriptfile}` : "" }}</span>
            <div class="sc-side-actions">
              <button type="button" class="sc-btn sc-outline" @click="openScript()"><Icon name="code" :size="13" />Open script <kbd>Ctrl ↵</kbd></button>
              <button type="button" class="sc-btn" title="Open in NetSuite" @click="openRecord('script', selected.id)"><Icon name="external" :size="13" />NetSuite</button>
            </div>
          </template>
          <p v-else class="sc-note">Select a script to see its logs.</p>
        </div>
        <div v-else-if="selected" class="sc-side-deps">
          <div class="sc-side-title"><strong>Deployments</strong><span>{{ selectedDeployments.length }}</span></div>
          <p v-if="deploymentsLoading.includes(Number(selected.id)) && !deployments[Number(selected.id)]" class="sc-note">Reading deployments…</p>
          <p v-else-if="!selectedDeployments.length" class="sc-note">No deployments.</p>
          <div
            v-for="d in selectedDeployments"
            :key="String(d.primarykey)"
            class="sc-side-dep"
            @contextmenu="contextMenu($event, selected, d)"
          >
            <div class="sc-side-dep-text">
              <span class="sc-mono sc-strong" :title="String(d.scriptid)">{{ d.scriptid }}</span>
              <span class="sc-meta"><span class="sc-state" :class="{ off: !deployed(d) }"><i class="sc-dot" :class="deployed(d) ? 'on' : 'off'" />{{ deployed(d) ? "Deployed" : "Off" }}</span> · {{ statusLabel(d.status) }} · {{ levelLabel(d.loglevel) }}{{ recordBound(selected.scripttype) && d.recordtype ? ` · ${recordLabel(String(d.recordtype))}` : "" }}</span>
            </div>
            <ScriptDeploymentActions
              :deployment="d"
              :script-type="String(selected.scripttype)"
              :environment="environment"
              :request="request"
              :open-record="openRecord"
              :open-page="openPage"
              @error="error = $event"
              @ran="logs?.reload()"
            />
          </div>
        </div>
        <ScriptLogs
          ref="logs"
          class="sc-logs"
          :environment="environment"
          :request="request"
          :script-id="selected ? Number(selected.id) : null"
          :deployments="selectedDeployments"
        />
      </aside>
    </div>
    <footer class="sc-foot">
      <template v-if="mode === 'table'">
        <kbd>/</kbd> search <kbd>↑</kbd><kbd>↓</kbd> move <kbd>→</kbd> deployments <kbd>Ctrl</kbd><kbd>↵</kbd> open script <kbd>C</kbd> copy script ID <kbd>Alt</kbd><kbd>L</kbd> logs
      </template>
      <template v-else>
        <kbd>Esc</kbd> back to table <kbd>↑</kbd><kbd>↓</kbd> script <kbd>Ctrl</kbd><kbd>S</kbd> save <kbd>Alt</kbd><kbd>H</kbd> history <kbd>Alt</kbd><kbd>L</kbd> logs
      </template>
      <span class="sc-space" />
      <span v-if="notice" class="sc-notice" role="status">{{ notice }}</span>
      <span v-else>{{ filtered.length }} of {{ scripts.length }} scripts</span>
    </footer>
    <div v-if="menu" class="select-popover scripts-menu" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button type="button" role="menuitem" @click="copy(menu.row.id, 'Internal ID')"><Icon name="copy" :size="13" />Copy internal ID <span>{{ menu.row.id }}</span></button>
      <button type="button" role="menuitem" @click="copy(menu.row.scriptid, 'Script ID')"><Icon name="copy" :size="13" />Copy script ID</button>
      <template v-if="menu.deployment">
        <button type="button" role="menuitem" @click="copy(menu.deployment.scriptid, 'Deployment script ID')"><Icon name="copy" :size="13" />Copy deployment script ID</button>
        <button type="button" role="menuitem" @click="copy(menu.deployment.primarykey, 'Deployment internal ID')"><Icon name="copy" :size="13" />Copy deployment internal ID <span>{{ menu.deployment.primarykey }}</span></button>
      </template>
      <button v-if="menu.row.fileid" type="button" role="menuitem" @click="menu = null; emit('edit-file', { id: Number(menu!.row.fileid), name: String(menu!.row.scriptfile || 'Script file') })">
        <Icon name="folder-open" :size="13" />Show in File Cabinet
      </button>
    </div>
  </section>
</template>

<style scoped>
.ns-scripts {
  --sc-strong: #273f50;
  --sc-muted: #5d7381;
  --sc-faint: #8296a2;
  --sc-line: #e3eaee;
  --sc-mono: "Cascadia Code", Consolas, monospace;
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-columns: minmax(0, 1fr);
  color: #455968;
  font-size: 12.5px;
  container-type: inline-size;
}
.sc-bar {
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sc-line);
}
.sc-title {
  flex: none;
  color: var(--sc-strong);
  font-weight: 600;
}
.scripts-search {
  display: flex;
  flex: 0 1 260px;
  align-items: center;
  gap: 7px;
  min-width: 140px;
  height: 28px;
  padding: 0 6px 0 9px;
  border: 1px solid #dbe5eb;
  border-radius: 8px;
  background: #fbfcfd;
  color: var(--sc-faint);
}
.scripts-search:focus-within {
  border-color: #7b97a7;
}
.scripts-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--sc-strong);
  font: inherit;
  outline: none;
}
kbd {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  color: var(--sc-muted);
  font: 10.5px/1 var(--sc-mono);
}
.sc-types {
  display: flex;
  flex: 1;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.sc-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--sc-line);
  border-radius: 7px;
  background: none;
  color: var(--sc-muted);
  font-size: 11.5px;
  white-space: nowrap;
}
.sc-chip b {
  color: var(--sc-faint);
  font-weight: 500;
}
.sc-chip:hover {
  background: #eef3f6;
}
.sc-chip[aria-pressed="true"] {
  border-color: transparent;
  background: #e4edf2;
  color: var(--sc-strong);
}
.sc-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  color: #455968;
  font-size: 12px;
  white-space: nowrap;
}
.sc-btn:hover:not(:disabled) {
  background: #eef3f6;
}
.sc-btn:disabled {
  opacity: 0.5;
}
.sc-outline {
  border-color: #d3dee5;
  background: #fbfcfd;
}
.sc-icon,
.sc-x {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: none;
  color: #6f8998;
}
.sc-icon:hover,
.sc-x:hover {
  background: #eef3f6;
}
.sc-x {
  width: 20px;
  height: 20px;
  vertical-align: middle;
}
.sc-record {
  position: relative;
  flex: none;
}
.sc-record-menu {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  right: 0;
  width: 300px;
  max-height: 360px;
  padding: 6px;
  overflow: auto;
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
}
.sc-record-field {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin-bottom: 4px;
  padding: 0 8px;
  border: 1.5px solid #7b97a7;
  border-radius: 8px;
  background: #fff;
  color: var(--sc-faint);
}
.sc-record-field input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--sc-strong);
  font: inherit;
  outline: none;
}
.sc-record-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 8px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--sc-strong);
  text-align: left;
}
.sc-record-row:hover,
.sc-record-row:focus-visible {
  background: #e4edf2;
}
.sc-record-row span {
  overflow: hidden;
  font: 12px var(--sc-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-record-row b {
  grid-column: 2;
  align-self: center;
  color: var(--sc-faint);
  font-weight: 500;
  font-size: 11px;
}
.sc-error {
  grid-row: 2;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--sc-line);
  background: #f8eeea;
  color: #8c4637;
  white-space: pre-wrap;
}
.sc-body {
  grid-row: 3;
  display: grid;
  grid-template-columns: minmax(0, 1fr) min(380px, 36%);
  min-height: 0;
}
.ns-scripts.script .sc-body {
  grid-template-columns: min(270px, 24%) minmax(0, 1fr) min(370px, 32%);
}
.scripts-list {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--sc-line);
}
.ns-scripts.script .scripts-list {
  grid-template-rows: minmax(0, 1fr);
}
.sc-cols {
  display: grid;
  grid-template-columns: 24px minmax(0, 1.6fr) 92px minmax(0, 1.5fr) minmax(0, 1.2fr) minmax(0, 0.8fr) 60px;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
}
@container (max-width: 980px) {
  .sc-cols {
    grid-template-columns: 24px minmax(0, 1.6fr) 92px minmax(0, 1.5fr) 0 0 56px;
  }
  .sc-cols > :nth-child(5),
  .sc-cols > :nth-child(6) {
    visibility: hidden;
  }
}
.sc-head {
  height: 32px;
  border-bottom: 1px solid var(--sc-line);
  background: #f1f5f7;
}
.sc-head button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--sc-muted);
  font-size: 11.5px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}
.sc-head button.sorted {
  color: var(--sc-strong);
}
.sc-rows {
  min-height: 0;
  overflow-y: auto;
}
.sc-row {
  height: 38px;
  border-bottom: 1px solid #edf2f4;
  cursor: default;
  outline: none;
}
.sc-row:hover {
  background: #eef3f6;
}
.sc-row[aria-selected="true"] {
  background: #e4edf2;
}
.sc-row:focus-visible {
  box-shadow: inset 0 0 0 2px #7b97a766;
}
.sc-chev {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #6f8998;
}
.sc-chev:hover {
  background: #dfe9ee;
}
.sc-chev :deep(svg) {
  transition: transform 140ms ease-out;
}
.sc-row.open .sc-chev :deep(svg) {
  transform: rotate(90deg);
}
.sc-name {
  overflow: hidden;
  color: var(--sc-strong);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-muted {
  overflow: hidden;
  color: var(--sc-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-mono {
  overflow: hidden;
  color: var(--sc-muted);
  font: 11.5px var(--sc-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-strong {
  color: var(--sc-strong);
}
.sc-count {
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.sc-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: transparent;
}
.sc-dot.on {
  background: #4f7d5f;
}
.sc-dot.off {
  background: #c5d1d8;
}
.sc-sub {
  padding: 2px 12px 6px 46px;
  border-bottom: 1px solid var(--sc-line);
  background: #f2f6f8;
}
.sc-dcols {
  display: grid;
  /* The deployment ID keeps priority; actions take only what they show. */
  grid-template-columns: minmax(150px, 2fr) 88px 100px 72px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}
.sc-dhead {
  height: 26px;
  color: var(--sc-faint);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.sc-drow {
  min-height: 34px;
  border-radius: 7px;
  font-size: 12px;
}
.sc-drow:hover {
  background: #e9f0f4;
}
.sc-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #4f7d5f;
  white-space: nowrap;
}
.sc-state.off {
  color: var(--sc-faint);
}
.sc-note {
  margin: 0;
  padding: 10px 12px;
  color: var(--sc-muted);
}
.sc-bad {
  color: #8c4637;
}
.sc-narrow {
  min-height: 0;
  padding: 6px;
  overflow: auto;
}
.sc-group {
  padding: 8px 8px 4px;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.nr {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1px 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  text-align: left;
}
.nr:hover {
  background: #eef3f6;
}
.nr[aria-selected="true"] {
  background: #e4edf2;
}
.nr-id {
  grid-column: 1;
  overflow: hidden;
  color: var(--sc-faint);
  font: 11px var(--sc-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nr-count {
  display: flex;
  grid-row: 1 / 3;
  grid-column: 2;
  align-items: center;
  gap: 5px;
  color: var(--sc-faint);
  font-size: 11px;
}
.sc-editor {
  border-right: 1px solid var(--sc-line);
  animation: sc-fade 140ms ease-out;
}
@keyframes sc-fade {
  from {
    opacity: 0;
  }
}
.sc-side {
  display: grid;
  /* Deployments take what they need, at most 45%; the logs get the rest. */
  grid-template-rows: fit-content(45%) minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.sc-side-head {
  display: grid;
  gap: 2px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--sc-line);
}
.sc-side-head strong {
  overflow: hidden;
  color: var(--sc-strong);
  font-size: 13.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-side-head > span {
  overflow: hidden;
  color: var(--sc-faint);
  font: 11px var(--sc-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-side-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.sc-side-deps {
  min-height: 0;
  padding: 10px 8px 8px;
  overflow: auto;
  border-bottom: 1px solid var(--sc-line);
}
.sc-side-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 4px;
}
.sc-side-title strong {
  color: var(--sc-strong);
}
.sc-side-title span {
  color: var(--sc-faint);
  font-size: 11.5px;
}
.sc-side-dep {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 5px 4px 5px 6px;
  border-radius: 7px;
}
.sc-side-dep:hover {
  background: #eef3f6;
}
.sc-side-dep-text {
  display: grid;
  min-width: 0;
}
.sc-meta {
  overflow: hidden;
  color: var(--sc-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-meta .sc-state {
  font-size: 11px;
}
.sc-logs {
  min-height: 0;
}
.sc-foot {
  grid-row: 4;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 30px;
  padding: 0 12px;
  overflow: hidden;
  border-top: 1px solid var(--sc-line);
  color: var(--sc-faint);
  font-size: 11.5px;
  white-space: nowrap;
}
.sc-space {
  flex: 1;
}
.sc-notice {
  color: #4f7d5f;
}
.scripts-menu {
  position: fixed;
  z-index: 260;
  display: grid;
  min-width: 240px;
  padding: 4px;
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
}
.scripts-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--sc-strong);
  font-size: 12.5px;
  text-align: left;
}
.scripts-menu button:hover,
.scripts-menu button:focus-visible {
  background: #e4edf2;
}
.scripts-menu button :deep(svg) {
  color: #6f8998;
}
.scripts-menu button span {
  margin-left: auto;
  color: var(--sc-faint);
  font: 11px var(--sc-mono);
}
@media (prefers-reduced-motion: reduce) {
  .sc-editor {
    animation: none;
  }
  .sc-chev :deep(svg) {
    transition: none;
  }
}
</style>
