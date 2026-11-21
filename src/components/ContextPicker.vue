<script setup lang="ts">
// Files and folders for an "@" mention in an agent composer. The composer
// keeps focus and drives the list with the arrow keys, Tab and Enter.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { api, type FileEntry } from "./files/explorer";

const props = defineProps<{ query: string; base?: string }>();
const emit = defineEmits<{ pick: [entry: FileEntry] }>();

const items = ref<FileEntry[]>([]);
const active = ref(0);
const busy = ref(false);
const list = ref<HTMLElement>();
let roots: { home: string; places: { path: string }[] } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let ticket = 0;

const absolute = (text: string) => /^(?:[a-z]:[\\/]|\\\\)/i.test(text);
const parentOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "") || path;
const byKind = (a: FileEntry, b: FileEntry) =>
  Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name);

async function lookup(query: string): Promise<FileEntry[]> {
  // A typed path browses that folder, filtered by the part after the last
  // separator.
  if (absolute(query)) {
    const folder = /[\\/]$/.test(query) ? query : parentOf(query) + "\\";
    const name = /[\\/]$/.test(query) ? "" : query.slice(folder.length).toLowerCase();
    const { entries } = await api<{ entries: FileEntry[] }>("list", { path: folder });
    return entries
      .filter((entry) => !entry.hidden && entry.name.toLowerCase().startsWith(name))
      .sort(byKind)
      .slice(0, 40);
  }
  if (!query) {
    if (!props.base) return [];
    const { entries } = await api<{ entries: FileEntry[] }>("list", { path: props.base });
    return entries.filter((entry) => !entry.hidden).sort(byKind).slice(0, 40);
  }
  // Same search as Ctrl+K, starting in the session folder.
  roots ??= await api<{ home: string; places: { path: string }[] }>("roots");
  const order = [
    ...(props.base ? [props.base] : []),
    ...roots.places.map((place) => place.path).filter((path) => path !== roots!.home),
    roots.home,
  ];
  const { entries } = await api<{ entries: FileEntry[] }>("search", {
    paths: [...new Set(order)],
    query,
    budget: 1500,
    limit: 40,
  });
  return entries;
}

watch(
  () => [props.query, props.base] as const,
  ([query]) => {
    clearTimeout(timer);
    const id = ++ticket;
    busy.value = true;
    timer = setTimeout(
      () => {
        lookup(query)
          .then((found) => {
            if (id !== ticket) return;
            items.value = found;
            active.value = 0;
          })
          .catch(() => id === ticket && (items.value = []))
          .finally(() => id === ticket && (busy.value = false));
      },
      query ? 140 : 0,
    );
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

// Where a result sits, shown relative to the session folder when inside it.
function where(entry: FileEntry) {
  const folder = parentOf(entry.path);
  const base = props.base?.replace(/[\\/]+$/, "");
  if (base && folder.toLowerCase() === base.toLowerCase()) return "";
  if (base && folder.toLowerCase().startsWith(base.toLowerCase() + "\\"))
    return folder.slice(base.length + 1);
  return folder;
}
const empty = computed(() =>
  busy.value
    ? "Searching…"
    : props.query
      ? "No matching files or folders"
      : props.base
        ? "This folder is empty"
        : "Type a name or a path",
);

function move(step: number) {
  if (!items.value.length) return;
  active.value = (active.value + step + items.value.length) % items.value.length;
  list.value
    ?.querySelector(`[data-index="${active.value}"]`)
    ?.scrollIntoView({ block: "nearest" });
}
function pick(index = active.value) {
  const entry = items.value[index];
  if (entry) emit("pick", entry);
  return Boolean(entry);
}
defineExpose({ move, pick, hasItems: computed(() => items.value.length > 0) });
</script>

<template>
  <div class="context-picker" role="listbox" aria-label="Add context" @pointerdown.prevent>
    <div class="context-picker-head">
      <span>{{ query ? "Files and folders" : "Session folder" }}</span>
      <span class="keys"><kbd>Tab</kbd> add</span>
    </div>
    <div ref="list" class="context-picker-list">
      <button
        v-for="(entry, index) in items"
        :key="entry.path"
        type="button"
        role="option"
        tabindex="-1"
        :data-index="index"
        :aria-selected="index === active"
        :title="entry.path"
        @pointerenter="active = index"
        @click="pick(index)"
      >
        <Icon :name="entry.dir ? 'folder' : 'file'" :size="14" />
        <span class="name">{{ entry.name }}</span>
        <span class="where">{{ where(entry) }}</span>
      </button>
      <p v-if="!items.length" class="context-picker-empty">{{ empty }}</p>
    </div>
  </div>
</template>

<style scoped>
.context-picker {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% + 6px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  max-height: 260px;
  border: 1px solid #d3dee5;
  border-radius: 9px;
  background: #fbfcfd;
  box-shadow:
    0 1px 2px #263f5514,
    0 10px 28px #263f5524;
  font-size: 12.5px;
  overflow: hidden;
  animation: context-picker-in 120ms ease-out;
}
@keyframes context-picker-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}
.context-picker-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-bottom: 1px solid #e3eaee;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.context-picker-head span:first-child {
  flex: 1;
}
.keys {
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}
.keys kbd {
  margin-right: 3px;
}
.context-picker-list {
  overflow: auto;
  padding: 4px;
}
.context-picker-list button {
  display: grid;
  grid-template-columns: 14px auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #455968;
  text-align: left;
}
.context-picker-list button[aria-selected="true"] {
  background: #e4edf2;
  color: #273f50;
}
.context-picker-list button :deep(svg) {
  color: #6f8998;
}
.name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.where {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  color: #8296a2;
  font-size: 11.5px;
}
.context-picker-empty {
  margin: 0;
  padding: 10px;
  color: #8296a2;
}
@media (prefers-reduced-motion: reduce) {
  .context-picker {
    animation: none;
  }
}
</style>
