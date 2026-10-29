<script setup lang="ts">
import { useNotesPortal } from "../portal";
import { computed, inject, onBeforeUnmount, ref } from "vue";
import { useNotesWorkspace } from "../stores/workspace";
import { uid } from "../db";
import type {
  DbFilter,
  DbProperty,
  DbSort,
  DbView,
  FilterOp,
  Page,
  PropertyType,
} from "../types";
import MSelect from "../NotesSelect.vue";

const props = defineProps<{ page: Page }>();
const ws = useNotesWorkspace();
const navigatePage = inject<(id: string) => void>("navigatePage")!;

const activeViewId = ref(props.page.dbSchema!.views[0]?.id ?? "");
const showFilters = ref(false);
const showSorts = ref(false);
const rowMenu = ref<{ id: string; x: number; y: number } | null>(null);
const portal = useNotesPortal();
const draggedRowId = ref<string | null>(null);
const rowDrop = ref<{ id: string; side: "before" | "after" } | null>(null);

const schema = computed(() => props.page.dbSchema!);
const view = computed<DbView>(
  () =>
    schema.value.views.find((v) => v.id === activeViewId.value) ??
    schema.value.views[0]!,
);
const properties = computed(() => schema.value.properties);
const tableMinWidth = computed(() => 36 + 240 + properties.value.length * 190);
const canReorderRows = computed(() => view.value.sorts.length === 0);
const propertyOptions = computed(() => [
  { label: "Title", value: "title" },
  ...properties.value.map((property) => ({
    label: property.name,
    value: property.id,
  })),
]);

const records = computed<Page[]>(() => {
  let recs = ws.activePages.filter((p) => p.parentId === props.page.id);
  recs = recs.filter((r) => passesFilters(r));
  recs = applySorts(recs);
  return recs;
});

// ---- filtering / sorting ----

function valOf(rec: Page, propId: string): unknown {
  if (propId === "title") return rec.title;
  return rec.values?.[propId];
}

function passesFilters(rec: Page): boolean {
  const filters = view.value.filters;
  if (!filters.length) return true;
  const results = filters.map((f) => passOne(rec, f));
  return view.value.filterMode === "or"
    ? results.some(Boolean)
    : results.every(Boolean);
}

function passOne(rec: Page, f: DbFilter): boolean {
  const raw = valOf(rec, f.propertyId);
  const prop = properties.value.find((p) => p.id === f.propertyId);
  let str = "";
  if (prop?.type === "select") {
    str = prop.options?.find((o) => o.id === raw)?.name ?? "";
  } else if (prop?.type === "multiselect") {
    str = ((raw as string[]) ?? [])
      .map((id) => prop.options?.find((o) => o.id === id)?.name ?? "")
      .join(", ");
  } else {
    str = raw === undefined || raw === null ? "" : String(raw);
  }
  const q = f.value.toLowerCase();
  const s = str.toLowerCase();
  switch (f.op) {
    case "equals":
      return s === q;
    case "not_equals":
      return s !== q;
    case "contains":
      return s.includes(q);
    case "not_contains":
      return !s.includes(q);
    case "is_empty":
      return s === "" && !(raw === true);
    case "is_not_empty":
      return s !== "" || raw === true;
    case "gt":
      return Number(raw) > Number(f.value);
    case "lt":
      return Number(raw) < Number(f.value);
    default:
      return true;
  }
}

function applySorts(recs: Page[]): Page[] {
  const sorts = view.value.sorts;
  if (!sorts.length) return [...recs].sort((a, b) => a.position - b.position);
  return [...recs].sort((a, b) => {
    for (const s of sorts) {
      const prop = properties.value.find((p) => p.id === s.propertyId);
      let av = valOf(a, s.propertyId);
      let bv = valOf(b, s.propertyId);
      if (prop?.type === "select") {
        av = prop.options?.findIndex((o) => o.id === av) ?? -1;
        bv = prop.options?.findIndex((o) => o.id === bv) ?? -1;
      }
      let cmp = 0;
      if (prop?.type === "number") cmp = (Number(av) || 0) - (Number(bv) || 0);
      else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
      if (cmp !== 0) return s.direction === "asc" ? cmp : -cmp;
    }
    return a.position - b.position;
  });
}

// ---- schema mutations ----

async function saveSchema() {
  await ws.savePage(props.page);
}

const PROP_TYPES: { type: PropertyType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "multiselect", label: "Multi-select" },
  { type: "checkbox", label: "Checkbox" },
  { type: "date", label: "Date" },
  { type: "url", label: "URL" },
  { type: "email", label: "Email" },
  { type: "phone", label: "Phone" },
];
const FILTER_MODES = [
  { label: "all (AND)", value: "and" },
  { label: "any (OR)", value: "or" },
];
const SORT_DIRECTIONS = [
  { label: "Ascending", value: "asc" },
  { label: "Descending", value: "desc" },
];

async function addProperty(type: PropertyType) {
  const label =
    PROP_TYPES.find((item) => item.type === type)?.label ?? "Property";
  const property: DbProperty = {
    id: uid(),
    name: `New ${label.toLowerCase()}`,
    type,
  };
  if (type === "select" || type === "multiselect") property.options = [];
  schema.value.properties.push(property);
  await saveSchema();
}

async function addPropertyFromSelection(value: string | number | null) {
  if (typeof value === "string") await addProperty(value as PropertyType);
}

async function renameProperty(prop: DbProperty, name: string) {
  prop.name = name;
  await saveSchema();
}

async function changePropertyType(prop: DbProperty, type: PropertyType) {
  prop.type = type;
  if ((type === "select" || type === "multiselect") && !prop.options) {
    prop.options = [];
  }
  await saveSchema();
}

async function changePropertyTypeFromSelection(
  prop: DbProperty,
  value: string | number | null,
) {
  if (typeof value === "string")
    await changePropertyType(prop, value as PropertyType);
}

async function deleteProperty(prop: DbProperty) {
  schema.value.properties = schema.value.properties.filter(
    (p) => p.id !== prop.id,
  );
  await saveSchema();
}

const OPTION_COLORS = [
  "#9ca3af",
  "#3b82f6",
  "#22c55e",
  "#eab308",
  "#ef4444",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
];

async function ensureOption(prop: DbProperty, name: string): Promise<string> {
  const existing = prop.options?.find((o) => o.name === name);
  if (existing) return existing.id;
  const opt = {
    id: uid(),
    name,
    color: OPTION_COLORS[(prop.options?.length ?? 0) % OPTION_COLORS.length]!,
  };
  prop.options = [...(prop.options ?? []), opt];
  await saveSchema();
  return opt.id;
}

// ---- records ----

async function addRecord(presetPropId?: string, presetValue?: unknown) {
  const rec = await ws.createPage(props.page.id, "");
  if (presetPropId && presetValue !== undefined) {
    rec.values = { [presetPropId]: presetValue };
    await ws.savePage(rec);
  }
}

async function setValue(rec: Page, propId: string, value: unknown) {
  if (!rec.values) rec.values = {};
  rec.values[propId] = value;
  await ws.savePage(rec);
}

async function setTitle(rec: Page, title: string) {
  rec.title = title;
  await ws.savePage(rec);
}

function openRecord(rec: Page) {
  navigatePage(rec.id);
}

function closeRowMenu() {
  rowMenu.value = null;
  window.removeEventListener("click", closeRowMenu);
  window.removeEventListener("scroll", onRowMenuViewportScroll, true);
}

function onRowMenuViewportScroll(e: Event) {
  const target = e.target;
  if (target instanceof Element && target.closest(".row-menu")) return;
  closeRowMenu();
}

function openRowMenu(rec: Page, e: MouseEvent) {
  e.stopPropagation();
  closeRowMenu();
  rowMenu.value = { id: rec.id, ...portal.local(e.clientX, e.clientY) };
  setTimeout(() => {
    window.addEventListener("click", closeRowMenu);
    window.addEventListener("scroll", onRowMenuViewportScroll, true);
  });
}

async function moveRecord(rec: Page, direction: -1 | 1) {
  if (!canReorderRows.value) return;
  const siblings = ws.childrenOf(props.page.id);
  const index = siblings.findIndex((item) => item.id === rec.id);
  if (index < 0) return;
  const nextIndex = Math.max(
    0,
    Math.min(siblings.length - 1, index + direction),
  );
  if (nextIndex === index) return;
  await ws.movePage(rec.id, props.page.id, nextIndex);
  closeRowMenu();
}

function onRowDragStart(rec: Page, e: DragEvent) {
  if (!canReorderRows.value) {
    e.preventDefault();
    return;
  }
  draggedRowId.value = rec.id;
  e.dataTransfer?.setData("notes/database-row-id", rec.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onRowDragOver(rec: Page, e: DragEvent) {
  if (
    !canReorderRows.value ||
    !draggedRowId.value ||
    draggedRowId.value === rec.id
  )
    return;
  e.preventDefault();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  rowDrop.value = {
    id: rec.id,
    side: e.clientY < rect.top + rect.height / 2 ? "before" : "after",
  };
}

async function onRowDrop(rec: Page, e: DragEvent) {
  e.preventDefault();
  const movingId =
    draggedRowId.value ?? e.dataTransfer?.getData("notes/database-row-id");
  const drop = rowDrop.value;
  draggedRowId.value = null;
  rowDrop.value = null;
  if (!movingId || movingId === rec.id || !drop) return;

  const siblings = ws
    .childrenOf(props.page.id)
    .filter((item) => item.id !== movingId);
  const targetIndex = siblings.findIndex((item) => item.id === rec.id);
  if (targetIndex < 0) return;
  await ws.movePage(
    movingId,
    props.page.id,
    drop.side === "before" ? targetIndex : targetIndex + 1,
  );
}

function resetRowDrag() {
  draggedRowId.value = null;
  rowDrop.value = null;
}

async function trashRecord(rec: Page) {
  closeRowMenu();
  await ws.trashPage(rec.id);
}

onBeforeUnmount(closeRowMenu);

// ---- filters/sorts UI ----

const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: "contains", label: "contains" },
  { op: "not_contains", label: "does not contain" },
  { op: "equals", label: "equals" },
  { op: "not_equals", label: "does not equal" },
  { op: "is_empty", label: "is empty" },
  { op: "is_not_empty", label: "is not empty" },
  { op: "gt", label: "greater than" },
  { op: "lt", label: "less than" },
];

async function addFilter() {
  view.value.filters.push({
    id: uid(),
    propertyId: properties.value[0]?.id ?? "title",
    op: "contains",
    value: "",
  });
  showFilters.value = true;
  await saveSchema();
}

async function removeFilter(f: DbFilter) {
  view.value.filters = view.value.filters.filter((x) => x.id !== f.id);
  await saveSchema();
}

async function addSort() {
  view.value.sorts.push({
    id: uid(),
    propertyId: properties.value[0]?.id ?? "title",
    direction: "asc",
  });
  showSorts.value = true;
  await saveSchema();
}

async function removeSort(s: DbSort) {
  view.value.sorts = view.value.sorts.filter((x) => x.id !== s.id);
  await saveSchema();
}

// ---- board ----

const boardGroupProp = computed<DbProperty | null>(() => {
  const gid = view.value.groupBy;
  const p = properties.value.find((x) => x.id === gid && x.type === "select");
  return p ?? properties.value.find((x) => x.type === "select") ?? null;
});

const boardColumns = computed(() => {
  const prop = boardGroupProp.value;
  if (!prop) return [];
  const cols = (prop.options ?? []).map((o) => ({
    key: o.id as string | null,
    name: o.name,
    color: o.color,
    records: records.value.filter((r) => valOf(r, prop.id) === o.id),
  }));
  cols.unshift({
    key: null,
    name: "No " + prop.name.toLowerCase(),
    color: "transparent",
    records: records.value.filter((r) => !valOf(r, prop.id)),
  });
  return cols;
});

const draggedRecId = ref<string | null>(null);

async function dropOnColumn(colKey: string | null) {
  if (!draggedRecId.value || !boardGroupProp.value) return;
  const rec = ws.pages.find((p) => p.id === draggedRecId.value);
  draggedRecId.value = null;
  if (rec) await setValue(rec, boardGroupProp.value.id, colKey ?? undefined);
}

function selectOptions(prop: DbProperty) {
  return prop.options ?? [];
}

function selectCellOptions(prop: DbProperty) {
  return [{ id: "", name: "No value" }, ...selectOptions(prop)];
}

async function updateSelectValue(
  rec: Page,
  prop: DbProperty,
  value: string | number | null,
) {
  await setValue(
    rec,
    prop.id,
    typeof value === "string" && value ? value : undefined,
  );
}

async function updateFilterProperty(
  filter: DbFilter,
  value: string | number | null,
) {
  filter.propertyId = String(value ?? "title");
  await saveSchema();
}

async function updateFilterOperator(
  filter: DbFilter,
  value: string | number | null,
) {
  filter.op = String(value ?? "contains") as FilterOp;
  await saveSchema();
}

async function updateFilterMode(value: string | number | null) {
  view.value.filterMode = value === "or" ? "or" : "and";
  await saveSchema();
}

async function updateSortProperty(sort: DbSort, value: string | number | null) {
  sort.propertyId = String(value ?? "title");
  await saveSchema();
}

async function updateSortDirection(
  sort: DbSort,
  value: string | number | null,
) {
  sort.direction = value === "desc" ? "desc" : "asc";
  await saveSchema();
}

async function addNewViewOfType(type: "table" | "board" | "list") {
  const v: DbView = {
    id: uid(),
    name: type.charAt(0).toUpperCase() + type.slice(1),
    type,
    filters: [],
    filterMode: "and",
    sorts: [],
  };
  if (type === "board")
    v.groupBy = properties.value.find((p) => p.type === "select")?.id;
  schema.value.views.push(v);
  activeViewId.value = v.id;
  await saveSchema();
}
</script>

<template>
  <div class="dbv">
    <!-- view tabs + toolbar -->
    <div class="db-toolbar">
      <div class="db-tabs">
        <button
          v-for="v in schema.views"
          :key="v.id"
          class="db-tab"
          :class="{ active: v.id === view.id }"
          @click="activeViewId = v.id"
        >
          <span class="db-tab-icon">{{
            v.type === "table" ? "▦" : v.type === "board" ? "▤" : "≡"
          }}</span>
          {{ v.name }}
        </button>
        <div class="db-addview">
          <button
            class="icon-btn"
            aria-label="Add table view"
            @click="addNewViewOfType('table')"
          >
            ＋▦
          </button>
          <button
            class="icon-btn"
            aria-label="Add board view"
            @click="addNewViewOfType('board')"
          >
            ＋▤
          </button>
          <button
            class="icon-btn"
            aria-label="Add list view"
            @click="addNewViewOfType('list')"
          >
            ＋≡
          </button>
        </div>
      </div>
      <div class="db-actions">
        <MSelect
          v-if="view.type === 'table'"
          class="add-property-control"
          :model-value="null"
          :options="PROP_TYPES"
          option-label="label"
          option-value="type"
          placeholder="＋ Column"
          size="small"
          aria-label="Choose the type of column to add"
          @update:model-value="addPropertyFromSelection"
        />
        <button
          class="db-chip"
          :class="{ on: view.filters.length }"
          @click="showFilters = !showFilters"
        >
          Filter{{ view.filters.length ? ` (${view.filters.length})` : "" }}
        </button>
        <button
          class="db-chip"
          :class="{ on: view.sorts.length }"
          @click="showSorts = !showSorts"
        >
          Sort{{ view.sorts.length ? ` (${view.sorts.length})` : "" }}
        </button>
        <button class="db-new" @click="addRecord()">＋ New</button>
      </div>
    </div>

    <!-- filter editor -->
    <div v-if="showFilters" class="db-rules">
      <div v-for="f in view.filters" :key="f.id" class="db-rule">
        <MSelect
          class="rule-select"
          :model-value="f.propertyId"
          :options="propertyOptions"
          option-label="label"
          option-value="value"
          size="small"
          @update:model-value="updateFilterProperty(f, $event)"
        />
        <MSelect
          class="rule-select"
          :model-value="f.op"
          :options="FILTER_OPS"
          option-label="label"
          option-value="op"
          size="small"
          @update:model-value="updateFilterOperator(f, $event)"
        />
        <input
          v-if="!['is_empty', 'is_not_empty'].includes(f.op)"
          v-model="f.value"
          placeholder="Value"
          @change="saveSchema"
        />
        <button class="icon-btn" @click="removeFilter(f)">✕</button>
      </div>
      <div class="db-rule-foot">
        <button class="db-chip" @click="addFilter">＋ Add filter</button>
        <label v-if="view.filters.length > 1" class="db-mode">
          Match
          <MSelect
            class="mode-select"
            :model-value="view.filterMode"
            :options="FILTER_MODES"
            option-label="label"
            option-value="value"
            size="small"
            @update:model-value="updateFilterMode"
          />
        </label>
      </div>
    </div>

    <!-- sort editor -->
    <div v-if="showSorts" class="db-rules">
      <div v-for="s in view.sorts" :key="s.id" class="db-rule">
        <MSelect
          class="rule-select"
          :model-value="s.propertyId"
          :options="propertyOptions"
          option-label="label"
          option-value="value"
          size="small"
          @update:model-value="updateSortProperty(s, $event)"
        />
        <MSelect
          class="rule-select"
          :model-value="s.direction"
          :options="SORT_DIRECTIONS"
          option-label="label"
          option-value="value"
          size="small"
          @update:model-value="updateSortDirection(s, $event)"
        />
        <button class="icon-btn" @click="removeSort(s)">✕</button>
      </div>
      <div class="db-rule-foot">
        <button class="db-chip" @click="addSort">＋ Add sort</button>
      </div>
    </div>

    <!-- TABLE VIEW -->
    <div v-if="view.type === 'table'" class="db-table-wrap">
      <div class="db-table-head-scroll">
        <table class="db-table" :style="{ minWidth: tableMinWidth + 'px' }">
          <colgroup>
            <col class="col-row-control" />
            <col class="col-title-size" />
            <col
              v-for="p in properties"
              :key="p.id"
              class="col-property-size"
            />
          </colgroup>
          <thead>
            <tr>
              <th class="col-row-control" aria-label="Row number"></th>
              <th class="col-title">Title</th>
              <th v-for="p in properties" :key="p.id">
                <div class="th-inner">
                  <input
                    class="th-name"
                    :value="p.name"
                    @change="
                      renameProperty(
                        p,
                        ($event.target as HTMLInputElement).value,
                      )
                    "
                  />
                  <button
                    class="property-delete"
                    aria-label="Delete column"
                    @click="deleteProperty(p)"
                  >
                    ×
                  </button>
                </div>
                <MSelect
                  class="property-type-select"
                  :model-value="p.type"
                  :options="PROP_TYPES"
                  option-label="label"
                  option-value="type"
                  size="small"
                  :aria-label="`Change ${p.name} column type`"
                  @update:model-value="
                    changePropertyTypeFromSelection(p, $event)
                  "
                />
              </th>
            </tr>
          </thead>
        </table>
      </div>
      <div
        class="db-table-body"
        @scroll="
          ($event.currentTarget as HTMLElement).parentElement!.querySelector(
            '.db-table-head-scroll',
          )!.scrollLeft = ($event.currentTarget as HTMLElement).scrollLeft
        "
      >
        <table class="db-table" :style="{ minWidth: tableMinWidth + 'px' }">
          <colgroup>
            <col class="col-row-control" />
            <col class="col-title-size" />
            <col
              v-for="p in properties"
              :key="p.id"
              class="col-property-size"
            />
          </colgroup>
          <tbody>
            <tr
              v-for="(rec, rowIndex) in records"
              :key="rec.id"
              :class="{
                'row-drop-before':
                  rowDrop?.id === rec.id && rowDrop.side === 'before',
                'row-drop-after':
                  rowDrop?.id === rec.id && rowDrop.side === 'after',
              }"
              @dragover="onRowDragOver(rec, $event)"
              @drop="onRowDrop(rec, $event)"
            >
              <td class="col-row-control">
                <button
                  class="row-handle"
                  :class="{ disabled: !canReorderRows }"
                  :draggable="canReorderRows"
                  :aria-label="
                    canReorderRows
                      ? `Row ${rowIndex + 1}: drag to reorder or click for actions`
                      : `Row ${rowIndex + 1}: remove sorting to reorder`
                  "
                  @click="openRowMenu(rec, $event)"
                  @dragstart="onRowDragStart(rec, $event)"
                  @dragend="resetRowDrag"
                >
                  <span class="row-number">{{ rowIndex + 1 }}</span>
                  <span class="row-grip">⠿</span>
                </button>
              </td>
              <td class="col-title">
                <div class="cell-title">
                  <input
                    :value="rec.title"
                    placeholder="Untitled"
                    @change="
                      setTitle(rec, ($event.target as HTMLInputElement).value)
                    "
                  />
                  <button class="open-btn" @click="openRecord(rec)">
                    OPEN
                  </button>
                </div>
              </td>
              <td v-for="p in properties" :key="p.id">
                <!-- select -->
                <MSelect
                  v-if="p.type === 'select'"
                  class="cell-select"
                  :model-value="(rec.values?.[p.id] as string) ?? ''"
                  :options="selectCellOptions(p)"
                  option-label="name"
                  option-value="id"
                  placeholder="No value"
                  size="small"
                  @update:model-value="updateSelectValue(rec, p, $event)"
                />
                <!-- checkbox -->
                <input
                  v-else-if="p.type === 'checkbox'"
                  type="checkbox"
                  :checked="!!rec.values?.[p.id]"
                  @change="
                    setValue(
                      rec,
                      p.id,
                      ($event.target as HTMLInputElement).checked,
                    )
                  "
                />
                <!-- date -->
                <input
                  v-else-if="p.type === 'date'"
                  type="date"
                  class="cell-input"
                  :value="(rec.values?.[p.id] as string) ?? ''"
                  @change="
                    setValue(
                      rec,
                      p.id,
                      ($event.target as HTMLInputElement).value || undefined,
                    )
                  "
                />
                <!-- number -->
                <input
                  v-else-if="p.type === 'number'"
                  type="number"
                  class="cell-input"
                  :value="(rec.values?.[p.id] as number) ?? ''"
                  @change="
                    setValue(
                      rec,
                      p.id,
                      ($event.target as HTMLInputElement).value === ''
                        ? undefined
                        : Number(($event.target as HTMLInputElement).value),
                    )
                  "
                />
                <!-- multiselect: comma-separated names -->
                <input
                  v-else-if="p.type === 'multiselect'"
                  class="cell-input"
                  :value="
                    ((rec.values?.[p.id] as string[]) ?? [])
                      .map(
                        (id) =>
                          selectOptions(p).find((o) => o.id === id)?.name ?? '',
                      )
                      .join(', ')
                  "
                  placeholder="a, b, c"
                  @change="
                    async (e) => {
                      const names = (e.target as HTMLInputElement).value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                      const ids = [];
                      for (const n of names) ids.push(await ensureOption(p, n));
                      setValue(rec, p.id, ids.length ? ids : undefined);
                    }
                  "
                />
                <!-- text / url / email / phone -->
                <input
                  v-else
                  class="cell-input"
                  :value="(rec.values?.[p.id] as string) ?? ''"
                  @change="
                    setValue(
                      rec,
                      p.id,
                      ($event.target as HTMLInputElement).value || undefined,
                    )
                  "
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <button class="db-addrow" @click="addRecord()">＋ New record</button>
      <div v-if="!records.length" class="db-empty">
        No records match. Add one or adjust filters.
      </div>

      <Teleport :to="portal.target.value ?? 'body'">
        <div
          v-if="rowMenu"
          class="menu notes-portal row-menu"
          :style="{ left: rowMenu.x + 'px', top: rowMenu.y + 'px' }"
          @click.stop
        >
          <button
            class="menu-item"
            :disabled="
              !canReorderRows ||
              records.findIndex((item) => item.id === rowMenu?.id) <= 0
            "
            @click="
              moveRecord(
                records.find((item) => item.id === rowMenu?.id)!,
                -1,
              )
            "
          >
            <span class="mi-icon">↑</span> Move up
          </button>
          <button
            class="menu-item"
            :disabled="
              !canReorderRows ||
              records.findIndex((item) => item.id === rowMenu?.id) >=
                records.length - 1
            "
            @click="
              moveRecord(
                records.find((item) => item.id === rowMenu?.id)!,
                1,
              )
            "
          >
            <span class="mi-icon">↓</span> Move down
          </button>
          <div class="menu-sep" />
          <button
            class="menu-item row-delete"
            @click="
              trashRecord(records.find((item) => item.id === rowMenu?.id)!)
            "
          >
            <span class="mi-icon">🗑</span> Move to trash
          </button>
        </div>
      </Teleport>
    </div>

    <!-- BOARD VIEW -->
    <div v-else-if="view.type === 'board'" class="db-board">
      <template v-if="boardGroupProp">
        <div
          v-for="col in boardColumns"
          :key="col.key ?? '__none'"
          class="board-col"
          @dragover.prevent
          @drop="dropOnColumn(col.key)"
        >
          <div class="board-col-head">
            <span class="board-dot" :style="{ background: col.color }" />
            <span class="board-col-name">{{ col.name }}</span>
            <span class="board-count">{{ col.records.length }}</span>
          </div>
          <div
            v-for="rec in col.records"
            :key="rec.id"
            class="board-card"
            draggable="true"
            @dragstart="draggedRecId = rec.id"
            @click="openRecord(rec)"
          >
            {{ rec.title || "Untitled" }}
          </div>
          <button
            class="board-add"
            @click="addRecord(boardGroupProp.id, col.key ?? undefined)"
          >
            ＋ New
          </button>
        </div>
      </template>
      <div v-else class="db-empty">
        Board needs a Select property to group by. Add one in the table view.
      </div>
    </div>

    <!-- LIST VIEW -->
    <div v-else class="db-list">
      <button
        v-for="rec in records"
        :key="rec.id"
        class="list-row"
        @click="openRecord(rec)"
      >
        <span class="list-icon">{{ rec.icon ?? "📄" }}</span>
        <span class="notes-list-title">{{ rec.title || "Untitled" }}</span>
        <span class="list-date">{{
          new Date(rec.updatedAt).toLocaleDateString()
        }}</span>
      </button>
      <button class="db-addrow" @click="addRecord()">＋ New record</button>
    </div>
  </div>
</template>

<style scoped>
.dbv {
  margin-top: 4px;
}
.db-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--notes-border);
  padding-bottom: 6px;
  gap: 8px;
  flex-wrap: wrap;
}
.db-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
}
.db-tab {
  padding: 4px 10px;
  border-radius: 4px;
  color: var(--notes-text-secondary);
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.db-tab.active {
  color: var(--notes-text);
  background: var(--notes-bg-hover);
  font-weight: 500;
}
.db-tab-icon {
  font-size: 12px;
}
.db-addview {
  display: flex;
  opacity: 0.4;
}
.db-addview:hover {
  opacity: 1;
}
.db-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.add-property-control {
  width: 112px;
  flex: 0 0 112px;
}
.add-property-control :deep(.m-select-trigger) {
  border-color: var(--notes-border);
  background: var(--notes-bg);
  color: var(--notes-text-secondary);
}
.db-chip {
  padding: 3px 10px;
  border-radius: 12px;
  border: 1px solid var(--notes-border);
  font-size: 12px;
  color: var(--notes-text-secondary);
}
.db-chip:hover {
  background: var(--notes-bg-hover);
}
.db-chip.on {
  border-color: var(--notes-accent);
  color: var(--notes-accent);
}
.db-actions > button,
.db-addview > button {
  white-space: nowrap;
  flex-shrink: 0;
}
.db-new {
  padding: 4px 12px;
  border-radius: 5px;
  background: var(--notes-accent);
  color: white;
  font-size: 13px;
}
.db-rules {
  padding: 8px;
  border-bottom: 1px solid var(--notes-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.db-rule {
  display: flex;
  gap: 6px;
  align-items: center;
}
.db-rule input {
  padding: 4px 8px;
  border: 1px solid var(--notes-border);
  border-radius: 4px;
  background: var(--notes-bg);
  font-size: 13px;
  outline: none;
}
.rule-select {
  width: 170px;
  flex: 0 0 170px;
}
.mode-select {
  width: 120px;
  flex: 0 0 120px;
}
.rule-select :deep(.m-select-trigger),
.mode-select :deep(.m-select-trigger) {
  border-color: var(--notes-border);
  background: var(--notes-bg);
}
.db-rule-foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.db-mode {
  font-size: 12px;
  color: var(--notes-text-secondary);
  display: flex;
  gap: 6px;
  align-items: center;
}

/* table */
.db-table-wrap {
  overflow: hidden;
  padding-top: 4px;
  display: flex;
  flex-direction: column;
  max-height: 460px;
  min-height: 0;
}
.db-table-head-scroll {
  overflow: hidden;
  flex: none;
  scrollbar-gutter: stable;
}
.db-table-body {
  overflow: auto;
  min-height: 0;
  scrollbar-gutter: stable;
}
.db-table {
  border-collapse: collapse;
  width: 100%;
  table-layout: fixed;
  font-size: 14px;
}
.db-table th,
.db-table td {
  border: 1px solid var(--notes-border);
  padding: 0;
  min-width: 130px;
  vertical-align: middle;
}
.db-table th {
  background: var(--notes-bg-sidebar);
  font-weight: 500;
  color: var(--notes-text-secondary);
  position: relative;
}
.th-inner {
  display: flex;
  min-width: 0;
  align-items: center;
  padding: 2px 4px 0;
}
.th-name {
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  font-weight: 500;
  color: var(--notes-text-secondary);
  width: 100%;
  min-width: 0;
  padding: 4px;
}
.property-delete {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 3px;
  color: var(--notes-text-faint);
  opacity: 0;
}
.db-table th:hover .property-delete {
  opacity: 1;
}
.property-delete:hover {
  background: var(--notes-bg-hover);
  color: var(--notes-danger);
}
.property-type-select {
  display: block;
  width: calc(100% - 8px);
  margin: 0 4px 3px;
}
.property-type-select :deep(.m-select-trigger) {
  min-height: 22px;
  height: 22px;
  border-color: transparent;
  border-radius: 3px;
  background: transparent;
  padding: 1px 4px;
  color: var(--notes-text-faint);
  font-size: 11px;
}
.property-type-select :deep(.m-select-trigger:hover) {
  border-color: var(--notes-border);
  background: var(--notes-bg);
}
.col-row-control {
  width: 36px;
  min-width: 36px !important;
  text-align: center;
}
.col-title-size {
  width: 240px;
}
.col-property-size {
  width: 190px;
}
.col-title {
  width: 240px;
  min-width: 240px;
}
.row-handle {
  display: inline-flex;
  width: 100%;
  height: 31px;
  align-items: center;
  justify-content: center;
  color: var(--notes-text-faint);
  font-size: 11px;
  cursor: grab;
}
.row-handle:active {
  cursor: grabbing;
}
.row-handle.disabled {
  cursor: pointer;
}
.row-grip {
  display: none;
  font-size: 15px;
  line-height: 1;
}
.db-table tbody tr:hover .row-number {
  display: none;
}
.db-table tbody tr:hover .row-grip {
  display: inline;
}
.db-table tbody tr.row-drop-before {
  box-shadow: inset 0 2px 0 var(--notes-accent);
}
.db-table tbody tr.row-drop-after {
  box-shadow: inset 0 -2px 0 var(--notes-accent);
}
.row-menu {
  min-width: 180px;
}
.row-menu .menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}
.row-delete {
  color: var(--notes-danger) !important;
}
.cell-title {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  padding-right: 4px;
}
.cell-title input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  padding: 7px 8px;
  font-weight: 500;
}
.open-btn {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--notes-text-faint);
  border: 1px solid var(--notes-border);
  border-radius: 4px;
  padding: 2px 6px;
  opacity: 0;
}
tr:hover .open-btn {
  opacity: 1;
}
.open-btn:hover {
  background: var(--notes-bg-hover);
  color: var(--notes-text);
}
.cell-input {
  width: 100%;
  border: none;
  background: transparent;
  outline: none;
  padding: 7px 8px;
  font-size: 13px;
  color: var(--notes-text);
}
.cell-select {
  display: block;
  width: 100%;
}
.cell-select :deep(.m-select-trigger) {
  min-height: 31px;
  height: 31px;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 4px 8px;
  box-shadow: none;
  color: var(--notes-text);
  font-size: 13px;
}
.cell-select :deep(.m-select-trigger:hover) {
  background: var(--notes-bg-hover);
}
.db-table td > input[type="checkbox"] {
  margin: 7px 8px;
}
.db-addrow {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  color: var(--notes-text-faint);
  font-size: 13px;
  border-radius: 4px;
  margin-top: 2px;
}
.db-addrow:hover {
  background: var(--notes-bg-hover);
  color: var(--notes-text-secondary);
}
.db-empty {
  padding: 20px;
  color: var(--notes-text-faint);
  text-align: center;
  font-size: 13px;
}

/* board */
.db-board {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 14px 2px;
  align-items: flex-start;
}
.board-col {
  min-width: 240px;
  width: 240px;
  background: var(--notes-bg-sidebar);
  border-radius: 8px;
  padding: 8px;
  flex-shrink: 0;
}
.board-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 8px;
  font-size: 13px;
  font-weight: 500;
}
.board-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.board-count {
  margin-left: auto;
  color: var(--notes-text-faint);
  font-size: 12px;
}
.board-card {
  background: var(--notes-bg);
  border: 1px solid var(--notes-border);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 6px;
  font-size: 13px;
  cursor: pointer;
}
.board-card:hover {
  background: var(--notes-bg-hover);
}
.board-add {
  width: 100%;
  text-align: left;
  padding: 4px 8px;
  border-radius: 4px;
  color: var(--notes-text-faint);
  font-size: 12px;
}
.board-add:hover {
  background: var(--notes-bg-hover);
}

/* list */
.db-list {
  padding-top: 8px;
}
.list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border-radius: 4px;
  font-size: 14px;
  text-align: left;
}
.list-row:hover {
  background: var(--notes-bg-hover);
}
.notes-list-title {
  flex: 1;
}
.list-date {
  font-size: 12px;
  color: var(--notes-text-faint);
}
</style>
