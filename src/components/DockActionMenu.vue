<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { CanvasApp } from "../model";
import Icon from "./Icon.vue";

// The dock tab's right-click menu: type to filter, arrows and Enter to run,
// and each action's key while the menu is open.
export type DockAction =
  | { kind: "rename" | "duplicate" | "manage" | "archive" | "trash" }
  | { kind: "group"; groupId?: string };

const props = defineProps<{
  app: CanvasApp;
  groups: { id: string; name: string }[];
}>();
const emit = defineEmits<{ action: [action: DockAction]; close: [] }>();

interface Item {
  id: string;
  label: string;
  icon: string;
  keys?: string;
  section: string;
  danger?: boolean;
  run: () => void;
}
const query = ref("");
const choosingGroup = ref(false);
const active = ref(0);
const name = computed(() => props.app.name || "Untitled");

const actions = computed<Item[]>(() => [
  { id: "rename", label: "Rename", icon: "edit", keys: "F2", section: name.value, run: () => emit("action", { kind: "rename" }) },
  { id: "duplicate", label: "Duplicate", icon: "copy", keys: "Ctrl D", section: name.value, run: () => emit("action", { kind: "duplicate" }) },
  {
    id: "group",
    label: "Move to group…",
    icon: "layers",
    keys: "Ctrl G",
    section: name.value,
    run: () => {
      choosingGroup.value = true;
      query.value = "";
      active.value = 0;
      focusSearch();
    },
  },
  { id: "manage", label: "Manage app…", icon: "settings", keys: "Ctrl M", section: "App", run: () => emit("action", { kind: "manage" }) },
  { id: "archive", label: "Archive", icon: "archive", section: "App", run: () => emit("action", { kind: "archive" }) },
  { id: "trash", label: "Move to trash", icon: "trash", section: "App", danger: true, run: () => emit("action", { kind: "trash" }) },
]);
const groupItems = computed<Item[]>(() => [
  ...props.groups.map((group) => ({
    id: `group:${group.id}`,
    label: group.name || "Untitled group",
    icon: props.app.groupId === group.id ? "check" : "layers",
    section: "Move to group",
    run: () => emit("action", { kind: "group", groupId: group.id }),
  })),
  ...(props.app.groupId
    ? [{ id: "group:none", label: "No group", icon: "close", section: "Move to group", run: () => emit("action", { kind: "group" }) }]
    : []),
]);
const items = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (choosingGroup.value ? groupItems.value : actions.value).filter((item) =>
    words.every((word) => item.label.toLowerCase().includes(word)),
  );
});
const sections = computed(() => {
  const out: { name: string; items: { item: Item; index: number }[] }[] = [];
  items.value.forEach((item, index) => {
    const last = out.at(-1);
    if (last?.name === item.section) last.items.push({ item, index });
    else out.push({ name: item.section, items: [{ item, index }] });
  });
  return out;
});

const search = ref<HTMLInputElement>();
const root = ref<HTMLElement>();
function focusSearch() {
  void nextTick(() => search.value?.focus({ preventScroll: true }));
}
function key(event: KeyboardEvent) {
  const count = items.value.length;
  const run = (id: string) => {
    event.preventDefault();
    event.stopPropagation();
    actions.value.find((item) => item.id === id)?.run();
  };
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count) active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
  } else if (event.key === "Enter") {
    event.preventDefault();
    items.value[active.value]?.run();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (choosingGroup.value) {
      choosingGroup.value = false;
      query.value = "";
      active.value = 0;
    } else emit("close");
  } else if (event.key === "Backspace" && choosingGroup.value && !query.value) {
    event.preventDefault();
    choosingGroup.value = false;
    active.value = 0;
  } else if (event.key === "F2") run("rename");
  else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    const id = { d: "duplicate", g: "group", m: "manage" }[event.key.toLowerCase()];
    if (id) run(id);
  }
}
// Outside presses close it, including one inside an embedded Browser page.
function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) emit("close");
}
const guest = () => emit("close");
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("orvane:guest-pointer-down", guest);
  focusSearch();
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("orvane:guest-pointer-down", guest);
});
</script>

<template>
  <section ref="root" class="dock-context floating-panel dock-actions" aria-label="App quick actions" @keydown="key" @pointerdown.stop>
    <label class="da-search">
      <Icon :name="choosingGroup ? 'layers' : 'search'" :size="13" />
      <input
        ref="search"
        v-model="query"
        :aria-label="choosingGroup ? 'Search groups' : 'Search actions'"
        :placeholder="choosingGroup ? 'Move to group…' : 'Search actions…'"
        @input="active = 0"
      />
    </label>
    <div role="menu" :aria-label="choosingGroup ? 'Groups' : `${name} actions`">
      <template v-for="section in sections" :key="section.name">
        <div class="da-section">{{ section.name }}</div>
        <button
          v-for="{ item, index } in section.items"
          :key="item.id"
          type="button"
          role="menuitem"
          tabindex="-1"
          :class="{ on: index === active, danger: item.danger }"
          @pointerenter="active = index"
          @click="item.run()"
        >
          <Icon :name="item.icon" :size="13" /><span>{{ item.label }}</span><kbd v-if="item.keys">{{ item.keys }}</kbd>
        </button>
      </template>
      <p v-if="!items.length" class="da-empty">
        {{ choosingGroup && !groups.length ? "No groups yet. Create one from Groups." : "No matching action" }}
      </p>
    </div>
    <footer class="da-foot">
      <span>{{ choosingGroup ? "Backspace back" : "↑↓ choose · Enter run" }}</span><span>Esc close</span>
    </footer>
  </section>
</template>

<style scoped>
.dock-actions {
  width: 250px;
  padding: 5px;
  border-radius: 9px;
  font-size: 12.5px;
}
.da-search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  margin-bottom: 3px;
  padding: 0 8px;
  border-bottom: 1px solid #e3eaee;
  color: #8296a2;
}
.da-search input {
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
  outline: none;
}
.da-section {
  overflow: hidden;
  padding: 6px 8px 3px;
  color: #8ea1ac;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.dock-actions button {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 29px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #455968;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dock-actions button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dock-actions button.on {
  background: #e7eef2;
  color: #273f50;
}
.dock-actions button.danger {
  color: #9a5a49;
}
kbd {
  padding: 1px 5px;
  border: 1px solid #dce5ea;
  border-radius: 4px;
  background: #f4f7f9;
  color: #8296a2;
  font: 10.5px "Cascadia Code", Consolas, monospace;
}
.da-empty {
  margin: 0;
  padding: 8px;
  color: #8296a2;
}
.da-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  padding: 6px 8px 2px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
</style>
<style>
/* Workspace palette (see "Workspace palettes" in style.css). */
html.orvane-themed :is(.da-search, .da-foot) {
  border-color: var(--shell-line);
}
html.orvane-themed :is(.da-search, .da-section, .da-empty, .da-foot) {
  color: var(--shell-faint);
}
html.orvane-themed .da-search input {
  color: var(--shell-strong);
}
html.orvane-themed .dock-actions button:not(.danger) {
  color: var(--shell-text);
}
html.orvane-themed .dock-actions button:hover {
  background: var(--shell-hover);
}
html.orvane-themed .dock-actions button.on {
  background: var(--shell-selected);
  color: var(--shell-strong);
}
html.orvane-themed .dock-actions kbd {
  border-color: var(--shell-line);
  background: var(--shell-field);
  color: var(--shell-faint);
}
</style>
