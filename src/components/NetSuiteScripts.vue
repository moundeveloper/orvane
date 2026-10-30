<script setup lang="ts">
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from "vue";
import Icon from "./Icon.vue";
import type { Block } from "../model";

defineOptions({ name: "NetSuiteScripts" });
type Row = Record<string, any>;
const props = defineProps<{
  block: Block;
  environment: string;
  request: (op: string, args?: Record<string, unknown>) => Promise<Row>;
  openRecord: (kind: string, id: unknown) => unknown;
  status?: string;
}>();
const emit = defineEmits<{
  "edit-file": [file: { id: number; name: string }];
}>();
const busy = ref(false),
  error = ref(""),
  scripts = ref<Row[]>([]),
  expandedScripts = ref<number[]>([]),
  deployments = ref<Record<number, Row[]>>({}),
  scriptLoading = ref<number[]>([]),
  scriptErrors = ref<Record<number, string>>({}),
  scriptLogs = ref<Record<number, Row[]>>({}),
  scriptLogCounts = ref<Record<number, number>>({}),
  scriptLogsLoading = ref<number[]>([]),
  scriptFile = ref<Row | null>(null),
  scriptFileOwner = ref<number | null>(null);
const search = ref(""),
  scriptTypesSelected = ref<string[]>([]),
  scriptTypeMenu = ref(false),
  scriptTypeAnchor = ref<HTMLElement>(),
  scriptOrder = ref("name"),
  scriptDescending = ref(false),
  active = ref(true);
const filteredScripts = computed(() =>
  scripts.value
    .filter(
      (row) =>
        (!scriptTypesSelected.value.length ||
          scriptTypesSelected.value.includes(String(row.scripttype))) &&
        Object.values(row).some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(search.value.toLowerCase()),
        ),
    )
    .sort(
      (a, b) =>
        String(a[scriptOrder.value] ?? "").localeCompare(
          String(b[scriptOrder.value] ?? ""),
          undefined,
          { numeric: true },
        ) * (scriptDescending.value ? -1 : 1),
    ),
);
const scriptTypes = computed(() =>
  Array.from(
    new Set(
      scripts.value.map((row) => String(row.scripttype || "")).filter(Boolean),
    ),
  ).sort(),
);
function sortScripts(field: string) {
  if (scriptOrder.value === field)
    scriptDescending.value = !scriptDescending.value;
  else {
    scriptOrder.value = field;
    scriptDescending.value = false;
  }
}
function dismissScriptTypes(event: PointerEvent) {
  if (!scriptTypeAnchor.value?.contains(event.target as Node))
    scriptTypeMenu.value = false;
}
function escapeScriptTypes(event: KeyboardEvent) {
  if (event.key === "Escape") scriptTypeMenu.value = false;
}
const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    "",
  );
let generation = 0,
  autoLoadKey = "";
async function call(
  operation: string,
  args: Record<string, unknown> = {},
): Promise<Row | undefined> {
  if (!props.environment || busy.value) return;
  const request = generation;
  busy.value = true;
  error.value = "";
  try {
    const data = await props.request(operation, args);
    return request === generation ? data : undefined;
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    busy.value = false;
  }
}
function rows(data: unknown): Row[] {
  return Array.isArray(data) ? data : [];
}
async function loadScripts() {
  const data = await call("scripts");
  if (data) {
    scripts.value = rows(data.rows);
    deployments.value = {};
    expandedScripts.value = [];
    scriptErrors.value = {};
  }
}
async function toggleScript(row: Row) {
  const id = Number(row.id);
  if (expandedScripts.value.includes(id)) {
    expandedScripts.value = expandedScripts.value.filter((x) => x !== id);
    return;
  }
  expandedScripts.value = [...expandedScripts.value, id];
  if (
    deployments.value[id] ||
    scriptLoading.value.includes(id) ||
    !props.environment
  )
    return;
  const request = generation;
  scriptLoading.value = [...scriptLoading.value, id];
  delete scriptErrors.value[id];
  try {
    const data = await props.request("deployments", { id });
    if (request === generation) deployments.value[id] = rows(data.rows);
  } catch (e) {
    if (request === generation) scriptErrors.value[id] = message(e);
  } finally {
    if (request === generation)
      scriptLoading.value = scriptLoading.value.filter((x) => x !== id);
  }
}
async function loadScriptLogs(row: Row) {
  const id = Number(row.id);
  if (!props.environment || scriptLogsLoading.value.includes(id)) return;
  const request = generation;
  scriptLogsLoading.value = [...scriptLogsLoading.value, id];
  delete scriptErrors.value[id];
  try {
    const data = await props.request("script-logs", { id });
    if (request === generation) {
      scriptLogs.value[id] = rows(data.rows);
      scriptLogCounts.value[id] = Number(data.totalCount || 0);
    }
  } catch (e) {
    if (request === generation) scriptErrors.value[id] = message(e);
  } finally {
    if (request === generation)
      scriptLogsLoading.value = scriptLogsLoading.value.filter((x) => x !== id);
  }
}
function editScriptFile(row: Row) {
  emit("edit-file", {
    id: Number(row.fileid),
    name: String(row.scriptfile || "Script file"),
  });
}
async function showScriptFile(row: Row) {
  const data = await call("file", { id: Number(row.fileid) });
  if (data) {
    scriptFile.value = data;
    scriptFileOwner.value = Number(row.id);
  }
}
async function copyScript(value: unknown) {
  try {
    await navigator.clipboard.writeText(String(value ?? ""));
  } catch {
    error.value = "Could not copy to clipboard.";
  }
}
watch(
  () => props.environment,
  () => {
    generation++;
    error.value = "";
    scripts.value = [];
    deployments.value = {};
    expandedScripts.value = [];
    scriptLoading.value = [];
    scriptErrors.value = {};
    scriptLogs.value = {};
    scriptLogCounts.value = {};
    scriptLogsLoading.value = [];
    scriptTypesSelected.value = [];
    scriptFile.value = null;
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
    if (
      status === "ready" &&
      previous &&
      previous !== "ready" &&
      error.value &&
      props.environment &&
      active.value &&
      !busy.value
    ) {
      error.value = "";
      autoLoadKey = props.environment;
      void loadScripts();
    }
  },
);
onActivated(() => (active.value = true));
onDeactivated(() => (active.value = false));
onMounted(() => {
  document.addEventListener("pointerdown", dismissScriptTypes, true);
  document.addEventListener("keydown", escapeScriptTypes);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", dismissScriptTypes, true);
  document.removeEventListener("keydown", escapeScriptTypes);
});
</script>
<template>
  <section class="ns-panel">
    <p v-if="error" class="ns-error" role="alert">{{ error }}</p>
    <div class="ns-toolbar">
      <div>
        <h2>Scripts</h2>
        <p>Browse scripts and their deployments.</p>
      </div>
      <input
        v-model="search"
        placeholder="Filter scripts"
        aria-label="Filter scripts"
      />
      <div ref="scriptTypeAnchor" class="ns-type-filter">
        <button
          class="ns-type-trigger"
          :aria-expanded="scriptTypeMenu"
          aria-label="Filter script types"
          @click="scriptTypeMenu = !scriptTypeMenu"
        >
          {{
            scriptTypesSelected.length
              ? `${scriptTypesSelected.length} script types`
              : "All script types"
          }}
          <Icon name="down" :size="12" />
        </button>
        <div v-if="scriptTypeMenu" class="ns-type-menu">
          <label v-for="type in scriptTypes" :key="type"
            ><input
              v-model="scriptTypesSelected"
              type="checkbox"
              :value="type"
            />
            {{ type }}</label
          ><button
            v-if="scriptTypesSelected.length"
            @click="scriptTypesSelected = []"
          >
            Clear
          </button>
        </div>
      </div>
      <button class="subtle-button" :disabled="busy" @click="loadScripts">
        {{ busy ? "Loading…" : "Load scripts" }}
      </button>
    </div>
    <div class="ns-scroll">
      <div class="ns-table scripts-table">
        <div class="ns-table-head">
          <button
            v-for="column in [
              { label: 'Name', key: 'name' },
              { label: 'Internal ID', key: 'id' },
              { label: 'Script file', key: 'scriptfile' },
              { label: 'Owner', key: 'owner' },
              { label: 'Script ID', key: 'scriptid' },
              { label: 'Type', key: 'scripttype' },
            ]"
            :key="column.key"
            @click="sortScripts(column.key)"
          >
            {{ column.label
            }}{{
              scriptOrder === column.key ? (scriptDescending ? " ↓" : " ↑") : ""
            }}
          </button>
        </div>
        <div class="ns-script-body">
          <div
            v-for="row in filteredScripts"
            :key="String(row.id)"
            class="ns-record"
          >
            <button class="ns-table-row script-row" @click="toggleScript(row)">
              <span
                >{{ expandedScripts.includes(Number(row.id)) ? "−" : "+" }}
                {{ row.name }}</span
              ><span>{{ row.id }}</span
              ><span>{{ row.scriptfile }}</span
              ><span>{{ row.owner }}</span
              ><span>{{ row.scriptid }}</span
              ><span>{{ row.scripttype }}</span>
            </button>
            <div
              v-if="expandedScripts.includes(Number(row.id))"
              class="ns-deployments"
            >
              <div class="ns-deployments-title">
                <strong>Deployments</strong>
                <div class="ns-script-actions">
                  <button class="subtle-button" @click="copyScript(row.id)">
                    Copy internal ID</button
                  ><button
                    class="subtle-button"
                    @click="copyScript(row.scriptid)"
                  >
                    Copy script ID</button
                  ><button
                    class="subtle-button"
                    :disabled="scriptLogsLoading.includes(Number(row.id))"
                    @click="loadScriptLogs(row)"
                  >
                    Execution logs</button
                  ><button
                    v-if="row.fileid"
                    class="subtle-button"
                    @click="showScriptFile(row)"
                  >
                    View script file</button
                  ><button
                    v-if="row.fileid"
                    class="subtle-button"
                    @click="editScriptFile(row)"
                  >
                    Edit script file</button
                  ><button
                    class="subtle-button"
                    @click="openRecord('script', row.id)"
                  >
                    Open in NetSuite
                  </button>
                </div>
              </div>
              <div v-if="scriptLogs[Number(row.id)]" class="ns-script-logs">
                <div>
                  <strong>Execution logs</strong
                  ><span
                    >{{ scriptLogCounts[Number(row.id)] }} total · showing first
                    {{ scriptLogs[Number(row.id)]?.length }}</span
                  ><button
                    class="subtle-button"
                    @click="delete scriptLogs[Number(row.id)]"
                  >
                    Close
                  </button>
                </div>
                <p v-if="!scriptLogs[Number(row.id)]?.length">No logs found.</p>
                <div
                  v-for="log in scriptLogs[Number(row.id)]"
                  :key="String(log.internalid)"
                  class="ns-log-row"
                >
                  <span>{{ log.date }} {{ log.time }}</span
                  ><strong>{{ log.type }} · {{ log.title }}</strong
                  ><span>{{ log.detail }}</span>
                </div>
              </div>
              <div
                v-if="scriptFile && scriptFileOwner === Number(row.id)"
                class="ns-script-preview"
              >
                <div>
                  <strong>{{ scriptFile.name }}</strong
                  ><button class="subtle-button" @click="scriptFile = null">
                    Close
                  </button>
                </div>
                <pre v-if="!scriptFile.binary">{{ scriptFile.content }}</pre>
                <p v-else>Binary file cannot be previewed.</p>
              </div>
              <p v-if="scriptLoading.includes(Number(row.id))">
                Loading deployments…
              </p>
              <p v-else-if="scriptErrors[Number(row.id)]" class="ns-error">
                {{ scriptErrors[Number(row.id)] }}
              </p>
              <p v-else-if="!deployments[Number(row.id)]?.length">
                No deployments found.
              </p>
              <div
                v-for="d in deployments[Number(row.id)] || []"
                :key="String(d.primarykey)"
                class="ns-deployment"
              >
                <button
                  class="ns-record-link"
                  @click="openRecord('deployment', d.primarykey)"
                >
                  {{ d.scriptid }}
                </button>
                <span
                  >{{ d.status }} · {{ d.recordtype || "All records" }} ·
                  {{
                    d.isdeployed === "T" || d.isdeployed === true
                      ? "Deployed"
                      : "Not deployed"
                  }}
                  · {{ d.loglevel || "—" }}</span
                >
              </div>
            </div>
          </div>
        </div>
      </div>
      <p v-if="!scripts.length" class="ns-empty">No scripts found.</p>
      <p v-else-if="!filteredScripts.length" class="ns-empty">
        No scripts match this filter.
      </p>
    </div>
  </section>
</template>
<style scoped>
.ns-empty {
  color: #627783;
  margin: 18px;
}
.ns-error {
  color: #9b3835;
  margin: 10px 16px;
  white-space: pre-wrap;
}
.ns-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ns-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
}
.ns-toolbar div {
  margin-right: auto;
}
.ns-toolbar input {
  width: 200px;
}
.ns-toolbar :deep(.select-trigger) {
  width: 200px;
  flex: none;
}
.ns-toolbar h2 {
  font-size: 15px;
  margin: 0 0 4px;
}
.ns-toolbar p {
  margin: 0;
  color: #657b89;
}
.ns-toolbar input {
  border: 0;
  border-bottom: 1px solid #cbd9df;
  background: #eef3f5;
  padding: 8px;
  color: inherit;
  min-width: 0;
}
.ns-scroll {
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 16px 16px;
}
.ns-table {
  min-width: 650px;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.ns-type-filter {
  position: relative;
  width: 200px;
  flex: none;
}
.ns-type-trigger {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  border: 0;
  border-radius: 4px;
  background: #e7eef2;
  padding: 8px 9px;
  text-align: left;
}
.ns-type-menu {
  position: absolute;
  z-index: 15;
  top: calc(100% + 4px);
  left: 0;
  width: 100%;
  max-height: 240px;
  overflow: auto;
  padding: 6px;
  background: #f7f9fa;
  box-shadow: 0 8px 20px #425c6b24;
  border: 1px solid #d9e3e8;
}
.ns-type-menu label {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px;
  cursor: pointer;
}
.ns-type-menu button {
  color: #547589;
  padding: 7px;
}
.ns-table-head button {
  text-align: left;
  color: inherit;
  font-weight: inherit;
}
.ns-script-body {
  overflow-y: scroll;
  scrollbar-gutter: stable;
  min-height: 0;
}
.ns-table-head {
  padding-right: 18px !important;
}
.ns-table-head,
.ns-table-row {
  display: grid;
  grid-template-columns: 1.7fr 0.7fr 1.3fr 1fr 1.5fr 1fr;
  gap: 12px;
  align-items: center;
}
.ns-table-head {
  color: #657b89;
  font-weight: 600;
  padding: 9px 10px;
  border-bottom: 1px solid #d7e1e6;
}
.ns-table-row {
  width: 100%;
  text-align: left;
  color: inherit;
  border: 0;
  border-bottom: 1px solid #e4ebee;
  background: none;
  padding: 11px 10px;
  cursor: pointer;
}
.ns-table-row:hover {
  background: #eaf1f4;
}
.ns-table-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-deployments {
  padding: 12px 20px 14px;
  background: #edf3f6;
}
.ns-script-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ns-script-logs {
  margin: 10px 0;
  padding: 10px;
  background: #f8fafb;
  max-height: 280px;
  overflow: auto;
}
.ns-script-logs > div:first-child {
  display: flex;
  gap: 10px;
  align-items: center;
}
.ns-script-logs > div:first-child span {
  color: #657b89;
  margin-right: auto;
}
.ns-log-row {
  display: grid;
  grid-template-columns: 140px 1fr 2fr;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #e0e9ec;
  overflow-wrap: anywhere;
}
.ns-script-preview {
  margin: 10px 0;
  background: #f8fafb;
  padding: 10px;
}
.ns-script-preview > div {
  display: flex;
  justify-content: space-between;
}
.ns-script-preview pre {
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  font:
    12px/1.5 Consolas,
    monospace;
}
.ns-deployments-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ns-record-link {
  border: 0;
  padding: 0;
  background: none;
  color: #547589;
  cursor: pointer;
}
.ns-record-link:hover {
  text-decoration: underline;
}
.ns-deployments p {
  color: #657b89;
}
.ns-deployment {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #dce6ea;
}
.ns-deployment span {
  color: #657b89;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
@media (max-width: 650px) {
  .ns-toolbar {
    flex-wrap: wrap;
  }
  .ns-toolbar div {
    width: 100%;
  }
}
</style>
