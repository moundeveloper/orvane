<script lang="ts">
/** Drag data type for a step dragged from the library onto the board. */
export const stepMime = "application/x-orvane-step";
</script>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { ActionKind, Rule, Workspace } from "../model";
import Icon from "./Icon.vue";

// The right-hand library of steps for the action graph: search with "/",
// groups of Favourites, Actions, Workflows and Reusable actions, drag a step
// onto the board or press Enter to add it after the selected node.
export interface StepEntry {
  key: string;
  label: string;
  description: string;
  icon: string;
  action: ActionKind;
  preset?: Partial<Rule>;
}

const props = defineProps<{
  actions: { value: ActionKind; label: string }[];
  workspace: Workspace;
}>();
const emit = defineEmits<{ add: [entry: StepEntry] }>();

const descriptions: Record<ActionKind, [string, string]> = {
  "add-item": ["Append a new item to a list", "list"],
  clear: ["Empty a text field", "minus"],
  increment: ["Add a number to a counter", "counter"],
  toggle: ["Flip a checkbox", "checkbox"],
  "set-text": ["Write into a field or label", "text"],
  emit: ["Press another component's button", "button"],
  custom: ["Run a reusable code or flow node", "code"],
  "workspace-action": ["Run a workflow and use its result", "workflow"],
  navigate: ["Bring an app into view", "forward"],
  "open-view": ["Open an app's settings or graph", "external"],
  "read-field": ["Pass a component's value on", "eye"],
  message: ["Show a short notice", "info"],
};

const groups = computed(() => {
  const actions: StepEntry[] = props.actions.map((item) => ({
    key: `action:${item.value}`,
    label: item.label,
    description: descriptions[item.value][0],
    icon: descriptions[item.value][1],
    action: item.value,
  }));
  const workflows: StepEntry[] = (props.workspace.actions || []).map((item) => ({
    key: `workflow:${item.id}`,
    label: item.name || "Untitled workflow",
    description: item.inputs.length ? `Inputs: ${item.inputs.join(", ")}` : `${item.rules.length} steps`,
    icon: "workflow",
    action: "workspace-action",
    preset: { nodeId: item.id },
  }));
  const reusable: StepEntry[] = props.workspace.customNodes.map((item) => ({
    key: `node:${item.id}`,
    label: item.name || "Untitled node",
    description: item.rules?.length ? `Grouped flow · ${item.rules.length} steps` : "Code node",
    icon: item.rules?.length ? "layers" : "code",
    action: "custom",
    preset: { nodeId: item.id },
  }));
  const all = [...actions, ...workflows, ...reusable];
  return [
    { id: "favourites", label: "Favourites", items: all.filter((item) => favourites.value.includes(item.key)) },
    { id: "actions", label: "Actions", items: actions },
    { id: "workflows", label: "Workflows", items: workflows },
    { id: "reusable", label: "Reusable actions", items: reusable },
  ];
});

const favouritesKey = "orvane.step-favourites.v1";
function readFavourites() {
  try {
    const saved = JSON.parse(localStorage.getItem(favouritesKey) || "[]");
    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}
const favourites = ref<string[]>(readFavourites());
function toggleFavourite(key: string) {
  favourites.value = favourites.value.includes(key)
    ? favourites.value.filter((item) => item !== key)
    : [...favourites.value, key];
  try {
    localStorage.setItem(favouritesKey, JSON.stringify(favourites.value));
  } catch {}
}

const query = ref("");
const closed = ref<Set<string>>(new Set());
function toggleGroup(id: string) {
  const next = new Set(closed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  closed.value = next;
}
const shown = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return groups.value
    .map((group) => ({
      ...group,
      items: words.length
        ? group.items.filter((item) =>
            words.every((word) => `${item.label} ${item.description}`.toLowerCase().includes(word)),
          )
        : group.items,
    }))
    .filter((group) => group.items.length || (!words.length && group.id !== "favourites"));
});
// While searching, every match is listed once; otherwise open groups list theirs.
const flat = computed(() => {
  const seen = new Set<string>();
  const list: StepEntry[] = [];
  for (const group of shown.value) {
    if (!query.value.trim() && closed.value.has(group.id)) continue;
    for (const item of group.items)
      if (!seen.has(item.key)) {
        seen.add(item.key);
        list.push(item);
      }
  }
  return list;
});
const active = ref(0);
watch(query, () => (active.value = 0));
const activeKey = computed(() => flat.value[active.value]?.key);
const isOpen = (id: string) => !!query.value.trim() || !closed.value.has(id);
const firstOf = (group: { id: string; items: StepEntry[] }, item: StepEntry) =>
  !query.value.trim() || shown.value.find((g) => g.items.some((i) => i.key === item.key))?.id === group.id;

const search = ref<HTMLInputElement>();
const list = ref<HTMLElement>();
function focusSearch() {
  search.value?.focus({ preventScroll: true });
  search.value?.select();
}
function key(event: KeyboardEvent) {
  const count = flat.value.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!count) return;
    active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    void nextTick(() =>
      list.value?.querySelector<HTMLElement>(".sl-item.on")?.scrollIntoView({ block: "nearest" }),
    );
  } else if (event.key === "Enter") {
    event.preventDefault();
    const item = flat.value[active.value];
    if (item) emit("add", item);
  } else if (event.key === "Escape" && query.value) {
    event.preventDefault();
    event.stopPropagation();
    query.value = "";
  }
}
function drag(event: DragEvent, item: StepEntry) {
  event.dataTransfer?.setData(stepMime, item.key);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}
function find(key: string) {
  return groups.value.flatMap((group) => group.items).find((item) => item.key === key);
}
defineExpose({ focusSearch, find });
</script>

<template>
  <aside class="step-library" aria-label="Step library" @keydown="key">
    <label class="sl-search">
      <Icon name="search" :size="13" />
      <input ref="search" v-model="query" aria-label="Search steps" placeholder="Add a step…" />
      <kbd>/</kbd>
    </label>
    <div ref="list" class="sl-groups" role="list" aria-label="Steps">
      <template v-for="group in shown" :key="group.id">
        <button
          type="button"
          class="sl-group"
          :class="{ open: isOpen(group.id) }"
          :aria-expanded="isOpen(group.id)"
          tabindex="-1"
          @click="toggleGroup(group.id)"
        >
          <Icon name="right" :size="10" />{{ group.label }}<b>{{ group.items.length }}</b>
        </button>
        <template v-if="isOpen(group.id)">
          <div
            v-for="item in group.items.filter((entry) => firstOf(group, entry))"
            :key="group.id + item.key"
            class="sl-item"
            :class="{ on: item.key === activeKey }"
            role="listitem"
            :aria-label="item.label"
            :aria-current="item.key === activeKey || undefined"
            draggable="true"
            :title="`${item.label}: drag onto the board, or click to add`"
            @dragstart="drag($event, item)"
            @pointerenter="active = flat.findIndex((entry) => entry.key === item.key)"
            @click="emit('add', item)"
          >
            <span class="sl-ico"><Icon :name="item.icon" :size="14" /></span>
            <div>
              <strong>{{ item.label }}</strong><span>{{ item.description }}</span>
            </div>
            <button
              type="button"
              class="sl-star"
              :class="{ on: favourites.includes(item.key) }"
              :aria-label="favourites.includes(item.key) ? `Remove ${item.label} from favourites` : `Add ${item.label} to favourites`"
              :aria-pressed="favourites.includes(item.key)"
              tabindex="-1"
              @click.stop="toggleFavourite(item.key)"
            >
              <Icon name="star" :size="13" />
            </button>
          </div>
        </template>
      </template>
      <p v-if="!flat.length && query.trim()" class="sl-empty">No matching step</p>
    </div>
    <footer class="sl-foot">Drag onto the board, or Enter to add after the selection</footer>
  </aside>
</template>

<style scoped>
.step-library {
  display: flex;
  flex-direction: column;
  width: 260px;
  min-height: 0;
  border-left: 1px solid #dce6ec;
  background: #f7f9fa;
}
.sl-search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  margin: 10px;
  padding: 0 9px;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  color: #8296a2;
}
.sl-search:focus-within {
  border-color: #9fb6c3;
}
.step-library .sl-search input {
  flex: 1;
  min-width: 0;
  height: auto;
  padding: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
  color: #273f50;
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.sl-search kbd {
  padding: 1px 5px;
  border: 1px solid #d6e0e6;
  border-radius: 4px;
  font: 10.5px "Cascadia Code", Consolas, monospace;
}
.sl-groups {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 8px;
}
.sl-group {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding: 0 6px;
  border: 0;
  background: transparent;
  color: #7a8f9b;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
}
.sl-group :deep(svg) {
  transition: transform 120ms ease-out;
}
.sl-group.open :deep(svg) {
  transform: rotate(90deg);
}
.sl-group b {
  margin-left: auto;
  font-weight: 500;
  letter-spacing: 0;
}
.sl-item {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 9px;
  padding: 6px;
  border-radius: 8px;
  cursor: grab;
}
.sl-item.on {
  background: #e4edf2;
}
.sl-ico {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid #dde6eb;
  border-radius: 8px;
  background: #fbfcfd;
  color: #365f78;
}
.sl-item div strong {
  display: block;
  overflow: hidden;
  color: #273f50;
  font-size: 12.5px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-item div span {
  display: block;
  overflow: hidden;
  color: #8296a2;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-star {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #b6c6cf;
  cursor: pointer;
}
.sl-star:hover {
  color: #6f8998;
}
.sl-star.on {
  color: #6f8998;
}
.sl-star.on :deep(svg) {
  fill: currentColor;
}
.sl-empty {
  margin: 0;
  padding: 12px 8px;
  color: #8296a2;
  font-size: 12px;
}
.sl-foot {
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
@media (prefers-reduced-motion: reduce) {
  .sl-group :deep(svg) {
    transition: none;
  }
}
</style>
