<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
type Row = Record<string, any>;
const props = defineProps<{
  environment: string;
  request: (op: string, args?: Row) => Promise<Row>;
}>();
const emit = defineEmits<{ close: []; insert: [string] }>();
const tables = ref<Row[]>([]),
  query = ref(""),
  detailFilter = ref(""),
  selected = ref<Row | null>(null),
  detail = ref<Row | null>(null),
  tab = ref<"fields" | "joins">("fields"),
  busy = ref(false),
  error = ref("");
const filtered = computed(() =>
  tables.value
    .filter((t) =>
      `${t.id} ${t.label}`.toLowerCase().includes(query.value.toLowerCase()),
    )
    .slice(0, 300),
);
const entries = computed(() =>
  (detail.value
    ? tab.value === "fields"
      ? detail.value.fields || []
      : detail.value.joins || []
    : []
  ).filter((entry: Row) =>
    `${entry.id} ${entry.label || ""}`
      .toLowerCase()
      .includes(detailFilter.value.toLowerCase()),
  ),
);
let sequence = 0;
async function load() {
  const token = ++sequence;
  busy.value = true;
  error.value = "";
  try {
    const data = await props.request("tables");
    if (token === sequence)
      tables.value = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];
  } catch (e) {
    if (token === sequence)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === sequence) busy.value = false;
  }
}
async function selectTable(table: Row) {
  const token = ++sequence;
  selected.value = table;
  detail.value = null;
  detailFilter.value = "";
  tab.value = "fields";
  busy.value = true;
  error.value = "";
  try {
    const data = await props.request("table-detail", {
      table: String(table.id),
    });
    if (token === sequence) detail.value = data.data || data;
  } catch (e) {
    if (token === sequence)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === sequence) busy.value = false;
  }
}
watch(
  () => props.environment,
  () => {
    selected.value = null;
    detail.value = null;
    tables.value = [];
    void load();
  },
);
onMounted(load);
</script>
<template>
  <aside class="schema-panel" aria-label="SuiteQL schema">
    <div class="schema-heading">
      <strong>Record catalog</strong
      ><button
        class="icon-button"
        aria-label="Refresh tables"
        :disabled="busy"
        @click="load"
      >
        <Icon name="refresh" :size="14" /></button
      ><button
        class="icon-button"
        aria-label="Close schema"
        @click="emit('close')"
      >
        <Icon name="close" :size="14" />
      </button>
    </div>
    <p v-if="error" class="schema-error" role="alert">{{ error }}</p>
    <template v-if="!selected"
      ><input
        v-model="query"
        aria-label="Search tables"
        placeholder="Search tables"
      />
      <p v-if="busy" class="schema-hint">Loading tables…</p>
      <div v-else class="schema-list">
        <button
          v-for="table in filtered"
          :key="table.id"
          @click="selectTable(table)"
        >
          <strong>{{ table.label || table.id }}</strong
          ><small>{{ table.id }}</small>
        </button>
        <p v-if="!filtered.length" class="schema-hint">No tables found.</p>
      </div></template
    ><template v-else
      ><div class="schema-selected">
        <button
          @click="
            selected = null;
            detail = null;
          "
        >
          <Icon name="back" :size="13" /> Tables</button
        ><strong>{{ selected.label || selected.id }}</strong
        ><button
          title="Insert table name"
          @click="emit('insert', String(selected.id))"
        >
          Insert
        </button>
      </div>
      <div class="schema-tabs">
        <button :class="{ active: tab === 'fields' }" @click="tab = 'fields'">
          Fields</button
        ><button :class="{ active: tab === 'joins' }" @click="tab = 'joins'">
          Joins
        </button>
      </div>
      <input
        v-model="detailFilter"
        :aria-label="`Search ${tab}`"
        :placeholder="`Search ${tab}`"
      />
      <p v-if="busy" class="schema-hint">Loading details…</p>
      <div v-else class="schema-list">
        <button
          v-for="entry in entries"
          :key="entry.id"
          @click="emit('insert', String(entry.id))"
        >
          <strong>{{ entry.label || entry.id }}</strong
          ><small
            >{{ entry.id
            }}<template v-if="entry.dataType">
              · {{ entry.dataType }}</template
            ></small
          >
        </button>
        <p v-if="!entries.length" class="schema-hint">
          No {{ tab }} available.
        </p>
      </div></template
    >
  </aside>
</template>
<style scoped>
.schema-panel {
  width: 260px;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #dce5e9;
  min-height: 0;
  background: #f8fafb;
}
.schema-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px;
}
.schema-heading strong {
  margin-right: auto;
}
.schema-panel input {
  margin: 0 10px 8px;
  padding: 8px;
  border: 0;
  background: #edf3f6;
  border-radius: 5px;
  min-width: 0;
}
.schema-list {
  overflow: auto;
  flex: 1;
}
.schema-list button {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 12px;
  text-align: left;
  color: #455968;
  border-bottom: 1px solid #e6edef;
}
.schema-list button:hover {
  background: #eaf1f4;
}
.schema-list small {
  color: #718591;
}
.schema-selected {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  flex-wrap: wrap;
}
.schema-selected button {
  color: #547589;
}
.schema-selected strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.schema-tabs {
  display: flex;
  border-bottom: 1px solid #dce5e9;
}
.schema-tabs button {
  flex: 1;
  padding: 9px;
  color: #657b89;
}
.schema-tabs button.active {
  border-bottom: 2px solid #6f8998;
  color: #344d5b;
}
.schema-hint,
.schema-error {
  padding: 10px 12px;
  color: #657b89;
}
.schema-error {
  color: #9b3835;
}
</style>
