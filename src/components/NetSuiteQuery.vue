<script lang="ts">
export type QueryFile = { id: string; name: string; sql: string };
</script>
<script setup lang="ts">
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  ref,
  watch,
} from "vue";
import SuiteQLEditor from "./SuiteQLEditor.vue";
import SuiteQLSchema from "./SuiteQLSchema.vue";
import { format as formatSql } from "sql-formatter";
import type { SuiteQLTracePlan } from "../suiteqlTrace";
import Icon from "./Icon.vue";
import type { Block } from "../model";
import { uid } from "../model";

defineOptions({ name: "NetSuiteQuery" });
type Row = Record<string, any>;
const props = defineProps<{
  block: Block;
  environment: string;
  request: (op: string, args?: Record<string, unknown>) => Promise<Row>;
  openRecord: (kind: string, id: unknown) => unknown;
  files: QueryFile[];
  stateKey: string;
}>();
const files = computed(() => props.files);
function readState(): Record<string, any> {
  try {
    return JSON.parse(props.block.value) || {};
  } catch {
    return {};
  }
}
function initialQueryTabs() {
  const state = readState(),
    saved = state.queryTabs?.[props.stateKey],
    open = saved ? saved.open : state.openQueryTabs,
    active = saved ? saved.active : state.activeQueryTab;
  const ids = Array.isArray(open)
    ? open.filter(
        (id: unknown) =>
          typeof id === "string" && files.value.some((f) => f.id === id),
      )
    : [];
  return {
    ids: ids.length ? [...new Set<string>(ids)] : [files.value[0]!.id],
    active,
  };
}
const initialTabs = initialQueryTabs(),
  openQueryTabs = ref<string[]>(initialTabs.ids),
  activeFile = ref(
    openQueryTabs.value.includes(initialTabs.active)
      ? initialTabs.active
      : openQueryTabs.value[0]!,
  );
const openedQueryFiles = computed(() =>
  openQueryTabs.value
    .map((id) => files.value.find((f) => f.id === id))
    .filter((f): f is QueryFile => !!f),
);
watch(
  [openQueryTabs, activeFile],
  () => {
    const state = readState();
    props.block.value = JSON.stringify({
      ...state,
      queryTabs: {
        ...(state.queryTabs || {}),
        [props.stateKey]: {
          open: openQueryTabs.value,
          active: activeFile.value,
        },
      },
    });
  },
  { deep: true },
);
watch(
  () => files.value.map((f) => f.id),
  (ids) => {
    // Another view may have deleted a query this one has open.
    if (!ids.length) return;
    const open = openQueryTabs.value.filter((id) => ids.includes(id));
    if (open.length !== openQueryTabs.value.length)
      openQueryTabs.value = open.length ? open : [ids[0]!];
    if (!ids.includes(activeFile.value))
      activeFile.value = openQueryTabs.value[0]!;
  },
);
function openQuery(id: string) {
  if (!openQueryTabs.value.includes(id)) openQueryTabs.value.push(id);
  activeFile.value = id;
}
function closeQueryTab(id: string) {
  if (openQueryTabs.value.length < 2 || busy.value) return;
  const index = openQueryTabs.value.indexOf(id);
  if (index < 0) return;
  openQueryTabs.value.splice(index, 1);
  if (activeFile.value === id)
    activeFile.value = openQueryTabs.value[Math.max(0, index - 1)]!;
}
const currentFile = computed(() =>
  files.value.find((f) => f.id === activeFile.value)!,
);
const busy = ref(false),
  error = ref(""),
  active = ref(true);
const savedResults = new Map<
  string,
  {
    rows: Row[];
    total: number;
    offset: number;
    sql: string;
    hasResult: boolean;
    limit: number | null;
  }
>();
const traceResults = new Map<string, SuiteQLTracePlan>();
const suiteqlEditor = ref<InstanceType<typeof SuiteQLEditor>>(),
  queryMain = ref<HTMLElement>(),
  queryEditorHeight = ref<number>();
let editorDrag: { y: number; height: number; scale: number } | undefined;
function startEditorResize(event: PointerEvent) {
  const host = queryMain.value,
    editor = host?.querySelector<HTMLElement>(".suiteql-editor");
  if (!host || !editor) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  editorDrag = {
    y: event.clientY,
    height: editor.offsetHeight,
    scale: host.getBoundingClientRect().height / host.offsetHeight || 1,
  };
}
function moveEditorResize(event: PointerEvent) {
  if (!editorDrag || !queryMain.value) return;
  queryEditorHeight.value = Math.round(
    Math.max(
      100,
      Math.min(
        queryMain.value.clientHeight - 160,
        editorDrag.height + (event.clientY - editorDrag.y) / editorDrag.scale,
      ),
    ),
  );
}
function editorResizeKey(event: KeyboardEvent) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  event.stopPropagation();
  const host = queryMain.value;
  if (!host) return;
  const height =
    queryEditorHeight.value ||
    host.querySelector<HTMLElement>(".suiteql-editor")?.offsetHeight ||
    180;
  queryEditorHeight.value = Math.max(
    100,
    Math.min(
      host.clientHeight - 160,
      height + (event.key === "ArrowUp" ? -16 : 16),
    ),
  );
}
const tracePlan = ref<SuiteQLTracePlan | null>(null),
  bottomTab = ref<"results" | "trace">("results");
const queryLimit = ref<number | null>(1000),
  executedLimit = ref<number | null>(1000),
  customLimit = ref("");
const resultLimit = computed(() =>
  executedLimit.value === null
    ? total.value
    : Math.min(total.value, executedLimit.value),
);
function setCustomLimit() {
  const value = Number(customLimit.value);
  if (Number.isSafeInteger(value) && value > 0 && value <= 1000000) {
    queryLimit.value = value;
    feedback.value = "";
  } else feedback.value = "Enter a row limit between 1 and 1,000,000.";
}
const schemaOpen = ref(false),
  resultFilter = ref(""),
  fileFilter = ref(""),
  sortColumn = ref(""),
  sortDescending = ref(false),
  feedback = ref("");
const results = ref<Row[]>([]),
  total = ref(0),
  offset = ref(0),
  executedSql = ref(""),
  hasResult = ref(false);
const queryFiles = computed(() =>
  files.value.filter((f) =>
    f.name.toLowerCase().includes(fileFilter.value.toLowerCase()),
  ),
);
const filteredResults = computed(() => {
  const text = resultFilter.value.trim().toLowerCase();
  const items = text
    ? results.value.filter((row) =>
        Object.values(row).some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(text),
        ),
      )
    : [...results.value];
  if (sortColumn.value)
    items.sort(
      (a, b) =>
        String(a[sortColumn.value] ?? "").localeCompare(
          String(b[sortColumn.value] ?? ""),
          undefined,
          { numeric: true },
        ) * (sortDescending.value ? -1 : 1),
    );
  return items;
});
// Only rows near the viewport are rendered; spacers keep the scroll height.
const resultBody = ref<HTMLElement>(),
  resultScroll = ref(0),
  resultHeight = ref(400),
  rowHeight = ref(32);
let resultObserver: ResizeObserver | undefined;
watch(resultBody, (body) => {
  resultObserver?.disconnect();
  if (!body) return;
  resultObserver = new ResizeObserver(() => {
    resultHeight.value = body.clientHeight || 400;
    const row = body.querySelector<HTMLElement>(".ns-result-row");
    if (row?.offsetHeight) rowHeight.value = row.offsetHeight;
  });
  resultObserver.observe(body);
});
onBeforeUnmount(() => resultObserver?.disconnect());
watch([filteredResults, resultBody], () => {
  resultScroll.value = 0;
  if (resultBody.value) resultBody.value.scrollTop = 0;
});
const visibleRows = computed(() => {
  const all = filteredResults.value,
    height = rowHeight.value,
    start = Math.max(0, Math.floor(resultScroll.value / height) - 10),
    end = Math.min(
      all.length,
      start + Math.ceil(resultHeight.value / height) + 20,
    );
  return {
    start,
    rows: all.slice(start, end),
    before: start * height,
    after: (all.length - end) * height,
  };
});
function sortResults(col: string) {
  if (sortColumn.value === col) sortDescending.value = !sortDescending.value;
  else {
    sortColumn.value = col;
    sortDescending.value = false;
  }
}
// Autocomplete schema: catalog table names plus the fields of tables the
// current query references, loaded on demand like Magic NetSuite's editor.
const catalogTables = ref<Record<string, string[]>>({}),
  tableFields = ref<Record<string, Record<string, string[]>>>({}),
  loadingTables = new Set<string>();
let catalogEnvironment = "";
const editorSchema = computed(() => ({
  ...catalogTables.value,
  ...(tableFields.value[props.environment] || {}),
}));
async function loadCatalog() {
  const environment = props.environment;
  if (!environment || catalogEnvironment === environment) return;
  catalogEnvironment = environment;
  try {
    const data = await props.request("tables");
    const list: Row[] = Array.isArray(data.data) ? data.data : [];
    if (props.environment === environment)
      catalogTables.value = Object.fromEntries(
        list
          .filter((t) => typeof t.id === "string")
          .map((t) => [String(t.id).toLowerCase(), []]),
      );
  } catch {
    catalogEnvironment = "";
  }
}
let referenceTimer: ReturnType<typeof setTimeout> | undefined;
function loadReferencedTables() {
  clearTimeout(referenceTimer);
  referenceTimer = setTimeout(() => {
    const environment = props.environment,
      known = (tableFields.value[environment] ||= {}),
      names = [
        ...new Set(
          [
            ...(currentFile.value?.sql || "").matchAll(
              /\b(?:from|join)\s+([a-z][a-z0-9_]*)/gi,
            ),
          ].map((m) => m[1]!.toLowerCase()),
        ),
      ].filter(
        (name) =>
          !known[name] &&
          !loadingTables.has(`${environment}:${name}`) &&
          (!Object.keys(catalogTables.value).length ||
            name in catalogTables.value),
      );
    for (const name of names.slice(0, 6)) {
      const key = `${environment}:${name}`;
      loadingTables.add(key);
      props
        .request("table-detail", { table: name })
        .then((data) => {
          const fields = (((data.data || data) as Row).fields || []) as Row[];
          tableFields.value[environment]![name] = fields
            .filter((f) => f.isColumn !== false && typeof f.id === "string")
            .map((f) => String(f.id));
        })
        .catch(() => {})
        .finally(() => loadingTables.delete(key));
    }
  }, 400);
}
watch(
  () => [active.value, props.environment, currentFile.value?.sql],
  () => {
    if (!active.value || !props.environment) return;
    void loadCatalog();
    loadReferencedTables();
  },
  { immediate: true },
);
const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    "",
  );
function formatQuery() {
  try {
    suiteqlEditor.value?.replace(
      formatSql(currentFile.value.sql, { language: "sql" }),
    );
    feedback.value = "";
  } catch (e) {
    feedback.value = message(e);
  }
}
async function copyResults(format: "json" | "csv") {
  try {
    const data =
      format === "json"
        ? JSON.stringify(filteredResults.value, null, 2)
        : csvText();
    await navigator.clipboard.writeText(data);
    feedback.value = "Copied to clipboard.";
  } catch {
    feedback.value = "Could not copy to clipboard.";
  }
}
function clearResults() {
  hasResult.value = false;
  results.value = [];
  total.value = 0;
  savedResults.delete(activeFile.value);
}
const columns = computed(() =>
  Array.from(new Set(results.value.flatMap((row) => Object.keys(row)))),
);
let generation = 0;
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
async function runTrace() {
  if (!props.environment || busy.value || !currentFile.value.sql.trim()) return;
  const environment = props.environment,
    file = activeFile.value,
    request = generation,
    sql = currentFile.value.sql;
  busy.value = true;
  error.value = "";
  bottomTab.value = "trace";
  try {
    const { createSuiteQLTracePlan } = await import("../suiteqlTrace");
    const plan = createSuiteQLTracePlan(sql);
    tracePlan.value = plan;
    for (const stage of plan.stages) {
      if (
        generation !== request ||
        props.environment !== environment ||
        activeFile.value !== file
      )
        return;
      if (!stage.executable) continue;
      stage.status = "running";
      try {
        const data = await props.request("query", {
          sql: stage.sql,
          offset: 0,
        });
        stage.rows = rows(data.rows).slice(
          0,
          stage.kind === "final" ? 100 : 25,
        );
        stage.columns = stage.rows.length ? Object.keys(stage.rows[0]!) : [];
        stage.rowCount = Number(data.totalCount ?? stage.rows.length);
        stage.status = "success";
      } catch (e) {
        stage.status = "error";
        stage.error = message(e);
      }
    }
  } catch (e) {
    if (generation === request) error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function runQuery(page?: number) {
  bottomTab.value = "results";
  const query = page === undefined ? currentFile.value.sql : executedSql.value;
  const limit = page === undefined ? queryLimit.value : executedLimit.value;
  const requestedOffset = page ?? 0;
  const data = await call("query", { sql: query, offset: requestedOffset });
  if (data) {
    executedSql.value = query;
    executedLimit.value = limit;
    results.value = rows(data.rows).slice(
      0,
      limit === null ? undefined : Math.max(0, limit - requestedOffset),
    );
    total.value = Number(data.totalCount || 0);
    offset.value = Number(data.offset || 0);
    hasResult.value = true;
  }
}
function newQuery() {
  const f = { id: uid(), name: "Untitled query", sql: "" };
  files.value.push(f);
  openQuery(f.id);
}
function removeQuery() {
  if (files.value.length === 1) return;
  const id = activeFile.value,
    index = files.value.findIndex((f) => f.id === id);
  if (index >= 0) files.value.splice(index, 1);
  suiteqlEditor.value?.forget(id);
  openQueryTabs.value = openQueryTabs.value.filter((item) => item !== id);
  if (!openQueryTabs.value.length) openQueryTabs.value.push(files.value[0]!.id);
  activeFile.value = openQueryTabs.value[0]!;
  savedResults.delete(id);
  traceResults.delete(id);
}
function csvText() {
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    columns.value.map(escape).join(","),
    ...filteredResults.value.map((r) =>
      columns.value.map((c) => escape(r[c])).join(","),
    ),
  ].join("\r\n");
}
function downloadCsv() {
  const url = URL.createObjectURL(
    new Blob([csvText()], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "suiteql-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}
watch(
  () => props.environment,
  () => {
    generation++;
    error.value = "";
    savedResults.clear();
    traceResults.clear();
    tracePlan.value = null;
    bottomTab.value = "results";
    results.value = [];
    total.value = 0;
    offset.value = 0;
    executedSql.value = "";
    resultFilter.value = "";
    sortColumn.value = "";
    hasResult.value = false;
  },
);
watch(
  activeFile,
  (id, previous) => {
    generation++;
    if (
      previous &&
      tracePlan.value &&
      files.value.some((f) => f.id === previous)
    )
      traceResults.set(previous, tracePlan.value);
    tracePlan.value = traceResults.get(id) || null;
    bottomTab.value = "results";
    if (previous && files.value.some((f) => f.id === previous))
      savedResults.set(previous, {
        rows: results.value,
        total: total.value,
        offset: offset.value,
        sql: executedSql.value,
        hasResult: hasResult.value,
        limit: executedLimit.value,
      });
    const saved = savedResults.get(id);
    results.value = saved?.rows || [];
    total.value = saved?.total || 0;
    offset.value = saved?.offset || 0;
    executedSql.value = saved?.sql || "";
    hasResult.value = saved?.hasResult || false;
    executedLimit.value = saved?.limit ?? (saved ? null : 1000);
    resultFilter.value = "";
    sortColumn.value = "";
  },
  { flush: "sync" },
);
onActivated(() => (active.value = true));
onDeactivated(() => (active.value = false));
</script>
<template>
  <div class="ns-query-view">
    <p v-if="error" class="ns-error" role="alert">{{ error }}</p>
    <section class="ns-query">
      <aside class="ns-query-list">
        <div class="ns-list-heading"><strong>Actions</strong></div>
        <button
          class="ns-query-action"
          :disabled="busy || !currentFile.sql.trim()"
          @click="runQuery()"
        >
          <Icon name="play" :size="13" />
          {{ busy ? "Running…" : "Run query" }}
          <small>Ctrl+Enter</small></button
        ><button
          class="ns-query-action"
          :disabled="busy || !currentFile.sql.trim()"
          @click="runTrace"
        >
          <Icon name="workflow" :size="13" /> Trace query</button
        ><button class="ns-query-action" @click="schemaOpen = !schemaOpen">
          <Icon name="list" :size="13" />
          {{ schemaOpen ? "Hide schema" : "Browse schema" }}
        </button>
        <div class="ns-list-heading ns-files-heading">
          <strong>Query files</strong
          ><button class="subtle-button" @click="newQuery">New</button>
        </div>
        <input
          v-model="fileFilter"
          class="ns-file-filter"
          aria-label="Search query files"
          placeholder="Search files"
        /><button
          v-for="f in queryFiles"
          :key="f.id"
          :class="{ active: f.id === activeFile }"
          :disabled="busy"
          @click="openQuery(f.id)"
        >
          {{ f.name || "Untitled query" }}
        </button>
      </aside>
      <div
        ref="queryMain"
        class="ns-query-main"
        :style="
          queryEditorHeight
            ? { '--suiteql-editor-height': `${queryEditorHeight}px` }
            : undefined
        "
      >
        <div class="ns-query-tabs" role="tablist">
          <div
            v-for="f in openedQueryFiles"
            :key="f.id"
            class="ns-query-tab"
            :class="{ active: f.id === activeFile }"
            @mousedown.middle.prevent="closeQueryTab(f.id)"
          >
            <button
              role="tab"
              :aria-selected="f.id === activeFile"
              :disabled="busy"
              @click="activeFile = f.id"
            >
              {{ f.name || "Untitled query" }}
            </button>
            <button
              v-if="openedQueryFiles.length > 1"
              :aria-label="`Close ${f.name || 'Untitled query'} tab`"
              :disabled="busy"
              @click="closeQueryTab(f.id)"
            >
              <Icon name="close" :size="12" />
            </button>
          </div>
          <button aria-label="New query tab" :disabled="busy" @click="newQuery">
            <Icon name="plus" :size="14" />
          </button>
        </div>
        <div class="ns-query-toolbar">
          <input
            v-model="currentFile.name"
            aria-label="Query name"
            placeholder="Untitled query"
          /><button class="subtle-button" @click="formatQuery">Format</button
          ><button
            class="subtle-button"
            :disabled="busy || !currentFile.sql.trim()"
            @click="runTrace"
          >
            Trace</button
          ><button class="subtle-button" @click="schemaOpen = !schemaOpen">
            Schema</button
          ><button
            class="subtle-button"
            :disabled="files.length === 1 || busy"
            @click="removeQuery"
          >
            Delete query</button
          ><button
            class="subtle-button ns-primary"
            :disabled="busy || !currentFile.sql.trim()"
            @click="runQuery()"
          >
            {{ busy ? "Running…" : "Run query" }}
          </button>
        </div>
        <div class="ns-query-limits">
          <span>Limit</span
          ><button
            v-for="amount in [25, 100, 1000, 5000]"
            :key="amount"
            :class="{ active: queryLimit === amount }"
            @click="queryLimit = amount"
          >
            {{ amount >= 1000 ? amount / 1000 + "K" : amount }}</button
          ><button
            :class="{ active: queryLimit === null }"
            @click="queryLimit = null"
          >
            All (paged)</button
          ><input
            v-model="customLimit"
            inputmode="numeric"
            aria-label="Custom row limit"
            placeholder="Custom"
            @keydown.enter.prevent="setCustomLimit"
            @blur="customLimit && setCustomLimit()"
          />
        </div>
        <p v-if="feedback" class="ns-query-feedback" role="status">
          {{ feedback }}
        </p>
        <SuiteQLEditor
          ref="suiteqlEditor"
          v-model="currentFile.sql"
          :doc-id="currentFile.id"
          :readonly="busy"
          :schema="editorSchema"
          :default-table="
            /\bfrom\s+([a-z][a-z0-9_]*)/i
              .exec(currentFile.sql)?.[1]
              ?.toLowerCase()
          "
          @run="runQuery()"
        />
        <div
          class="ns-editor-splitter"
          role="separator"
          tabindex="0"
          aria-label="Resize query editor"
          aria-orientation="horizontal"
          @pointerdown.stop="startEditorResize"
          @pointermove.stop="moveEditorResize"
          @pointerup.stop="editorDrag = undefined"
          @pointercancel.stop="editorDrag = undefined"
          @keydown="editorResizeKey"
        ></div>
        <div class="ns-results">
          <div class="ns-results-title">
            <div class="ns-bottom-tabs">
              <button
                :class="{ active: bottomTab === 'results' }"
                @click="bottomTab = 'results'"
              >
                Results</button
              ><button
                :class="{ active: bottomTab === 'trace' }"
                @click="bottomTab = 'trace'"
              >
                Execution trace
              </button>
            </div>
            <span v-if="bottomTab === 'results' && hasResult"
              >{{ resultLimit }} of {{ total }} rows ·
              {{ offset + (results.length ? 1 : 0) }}–{{
                offset + results.length
              }}</span
            ><button
              v-if="bottomTab === 'results' && hasResult"
              class="subtle-button"
              :disabled="!results.length"
              @click="copyResults('json')"
            >
              Copy JSON</button
            ><button
              v-if="bottomTab === 'results' && hasResult"
              class="subtle-button"
              :disabled="!results.length"
              @click="copyResults('csv')"
            >
              Copy CSV</button
            ><button
              v-if="bottomTab === 'results' && hasResult"
              class="subtle-button"
              :disabled="!results.length"
              @click="downloadCsv"
            >
              Export page CSV</button
            ><button
              v-if="bottomTab === 'results' && hasResult"
              class="subtle-button"
              @click="clearResults"
            >
              Clear</button
            ><button
              v-if="bottomTab === 'results' && hasResult"
              class="subtle-button"
              :disabled="busy || offset === 0"
              @click="runQuery(Math.max(0, offset - 100))"
            >
              Previous</button
            ><button
              v-if="bottomTab === 'results' && hasResult"
              class="subtle-button"
              :disabled="busy || offset + 100 >= resultLimit"
              @click="runQuery(offset + 100)"
            >
              Next
            </button>
          </div>
          <div v-if="bottomTab === 'trace'" class="ns-trace">
            <p
              v-for="warning in tracePlan?.warnings || []"
              :key="warning"
              class="ns-trace-note"
            >
              {{ warning }}
            </p>
            <p v-if="!tracePlan" class="ns-trace-note">
              Trace a query to inspect its stages.
            </p>
            <details
              v-for="stage in tracePlan?.stages || []"
              :key="stage.id"
              :open="stage.status === 'error'"
            >
              <summary>
                <strong>{{ stage.title }}</strong
                ><span
                  >{{ stage.status
                  }}<template v-if="stage.rowCount !== null">
                    · {{ stage.rowCount }} rows</template
                  ></span
                >
              </summary>
              <p>{{ stage.description }}</p>
              <p v-if="stage.note">{{ stage.note }}</p>
              <pre>{{ stage.sql }}</pre>
              <p v-if="stage.error" class="ns-error">{{ stage.error }}</p>
              <pre v-if="stage.rows.length">{{
                JSON.stringify(stage.rows, null, 2)
              }}</pre>
            </details>
          </div>
          <template v-else
            ><input
              v-if="hasResult && results.length"
              v-model="resultFilter"
              class="ns-result-filter"
              placeholder="Filter current page"
              aria-label="Filter results"
            />
            <div v-if="hasResult && results.length" class="ns-result-scroll">
              <div
                class="ns-result-grid"
                :style="{
                  minWidth: `${columns.length * 150}px`,
                  gridTemplateColumns: `repeat(${columns.length}, minmax(150px, 1fr))`,
                }"
              >
                <div class="ns-result-head">
                  <button
                    v-for="col in columns"
                    :key="col"
                    @click="sortResults(col)"
                  >
                    {{ col
                    }}{{
                      sortColumn === col ? (sortDescending ? " ↓" : " ↑") : ""
                    }}
                  </button>
                </div>
                <div
                  ref="resultBody"
                  class="ns-result-body"
                  @scroll.passive="resultScroll = ($event.target as HTMLElement).scrollTop"
                >
                  <div
                    v-if="visibleRows.before"
                    class="ns-result-spacer"
                    :style="{ height: visibleRows.before + 'px' }"
                  />
                  <div
                    v-for="(row, i) in visibleRows.rows"
                    :key="visibleRows.start + i"
                    class="ns-result-row"
                  >
                    <span v-for="col in columns" :key="col">{{
                      row[col]
                    }}</span>
                  </div>
                  <div
                    v-if="visibleRows.after"
                    class="ns-result-spacer"
                    :style="{ height: visibleRows.after + 'px' }"
                  />
                </div>
              </div>
            </div>
            <p v-else class="ns-empty">
              {{
                hasResult
                  ? "The query returned no rows."
                  : "Run a query to see its results. Ctrl+Enter also runs it."
              }}
            </p></template
          >
        </div>
      </div>
      <SuiteQLSchema
        v-if="schemaOpen"
        :environment="environment"
        :request="request"
        @close="schemaOpen = false"
        @insert="suiteqlEditor?.insert($event)"
      />
    </section>
  </div>
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
.ns-query-view,
.ns-query {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ns-query {
  flex-direction: row;
}
.ns-query-toolbar input {
  border: 0;
  border-bottom: 1px solid #cbd9df;
  background: #eef3f5;
  padding: 8px;
  color: inherit;
  min-width: 0;
}
.ns-query-list button:hover {
  background: #eaf1f4;
}
.ns-bottom-tabs {
  display: flex;
  gap: 10px;
  margin-right: auto;
}
.ns-bottom-tabs button {
  padding: 6px 0;
  color: #657b89;
  border-bottom: 2px solid transparent;
}
.ns-bottom-tabs button.active {
  color: #344d5b;
  border-color: #6f8998;
}
.ns-trace {
  overflow: auto;
  padding: 0 12px 12px;
}
.ns-trace details {
  border-bottom: 1px solid #dce5e9;
  padding: 10px;
}
.ns-trace summary {
  cursor: pointer;
}
.ns-trace summary span {
  float: right;
  color: #657b89;
}
.ns-trace p {
  margin: 8px 0;
  color: #657b89;
}
.ns-trace pre {
  overflow: auto;
  white-space: pre-wrap;
  background: #edf3f6;
  padding: 10px;
  font:
    12px/1.5 Consolas,
    monospace;
}
.ns-trace-note {
  color: #657b89;
}
.ns-query-tabs {
  display: flex;
  gap: 2px;
  padding: 6px 10px 0;
  overflow-x: auto;
  border-bottom: 1px solid #dce5e9;
}
.ns-query-tabs button {
  padding: 8px 10px;
  white-space: nowrap;
  color: #657b89;
  border-radius: 5px 5px 0 0;
}
.ns-query-tab {
  display: flex;
  align-items: center;
  border-radius: 4px 4px 0 0;
}
.ns-query-tab.active {
  background: #e7eff3;
  box-shadow: inset 0 -2px #7895a5;
}
.ns-query-tab button {
  background: transparent;
}
.ns-query-tab button:last-child:not(:first-child) {
  padding: 4px 5px;
}
.ns-query-tab button:hover {
  background: #dce8ed;
}
.ns-query-list .ns-query-action {
  display: flex;
  gap: 6px;
  align-items: center;
  background: #eaf1f4;
  margin-bottom: 4px;
}
.ns-query-action small {
  margin-left: auto;
  color: #718591;
}
.ns-files-heading {
  margin-top: 20px;
}
.ns-file-filter,
.ns-result-filter {
  border: 0;
  background: #edf3f6;
  padding: 8px;
  color: inherit;
  min-width: 0;
}
.ns-file-filter {
  width: 100%;
  margin-bottom: 5px;
}
.ns-result-filter {
  margin: 0 12px 8px;
  max-width: 200px;
}
.ns-query-limits {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 12px 8px;
  color: #718591;
}
.ns-query-limits button {
  padding: 4px 8px;
  border-radius: 4px;
  color: #607583;
}
.ns-query-limits button.active {
  background: #dce9ef;
  color: #344f5e;
}
.ns-query-limits input {
  width: 72px;
  padding: 4px 6px;
  border: 0;
  background: #edf3f6;
  color: inherit;
}
.ns-editor-splitter {
  flex: none;
  height: 6px;
  cursor: row-resize;
  background: #e3edf1;
  touch-action: none;
}
.ns-editor-splitter:hover,
.ns-editor-splitter:focus-visible {
  background: #aac3d0;
}
.ns-query-feedback {
  padding: 0 12px 6px;
  color: #657b89;
}
.ns-result-head button {
  text-align: left;
  color: inherit;
  font-weight: 600;
  padding: 8px 12px;
  border-bottom: 1px solid #e0e9ec;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-query-list {
  width: 180px;
  flex-shrink: 0;
  border-right: 1px solid #dce5e9;
  overflow: auto;
  padding: 12px;
}
.ns-list-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.ns-query-list > button {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: none;
  color: inherit;
  padding: 9px;
  border-radius: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.ns-query-list > button.active {
  background: #e2edf2;
  font-weight: 600;
}
.ns-query-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ns-query-toolbar {
  display: flex;
  gap: 8px;
  padding: 12px;
}
.ns-query-toolbar input {
  flex: 1;
}
.ns-primary {
  background: #dce9ef;
}
.ns-query-main textarea {
  height: 35%;
  min-height: 100px;
  resize: vertical;
  border: 0;
  border-top: 1px solid #dce5e9;
  border-bottom: 1px solid #dce5e9;
  outline-color: #718e9e;
  background: #f0f5f7;
  color: #344d5b;
  padding: 14px;
  font:
    12px/1.6 Consolas,
    monospace;
}
.ns-results {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ns-results-title {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
}
.ns-results-title strong {
  margin-right: auto;
}
.ns-results-title span {
  color: #657b89;
}
.ns-result-scroll {
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  min-height: 0;
}
.ns-result-grid {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.ns-result-head,
.ns-result-row {
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1/-1;
}
.ns-result-head {
  background: #f1f5f7;
  color: #657b89;
  font-weight: 600;
  padding-right: 8px;
}
.ns-result-body {
  grid-column: 1/-1;
  overflow-y: scroll;
  scrollbar-gutter: stable;
  display: grid;
  grid-template-columns: subgrid;
  align-content: start;
}
.ns-result-spacer {
  grid-column: 1/-1;
}
.ns-result-head span,
.ns-result-row span {
  padding: 8px 12px;
  border-bottom: 1px solid #e0e9ec;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
@media (max-width: 650px) {
  .ns-query-list {
    width: 120px;
  }
  .ns-results-title {
    flex-wrap: wrap;
  }
}
</style>
