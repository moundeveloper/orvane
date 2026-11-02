<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  onUpdated,
  ref,
} from "vue";
import Icon from "./Icon.vue";
type Row = Record<string, any>;
type Crumb = { id: number; name: string };
type Entry = {
  key: string;
  depth: number;
  path: Crumb[];
  folder?: Row;
  open?: boolean;
  hint?: string;
};
const props = defineProps<{
  folders: Row[];
  children: Record<number, Row[]>;
  expanded: number[];
  path: Crumb[];
  selected?: number;
  filter: string;
  loading: number[];
}>();
const emit = defineEmits<{ toggle: [Row]; navigate: [Crumb[]] }>();
const entries = computed(() => {
  const result: Entry[] = [];
  const expanded = new Set(props.expanded),
    loading = new Set(props.loading);
  const filter = props.filter.toLowerCase();
  function visit(folders: Row[], path: Crumb[], depth: number) {
    for (const folder of folders) {
      const id = Number(folder.id),
        open = expanded.has(id);
      if (
        filter &&
        !open &&
        !`${folder.name} ${folder.id}`.toLowerCase().includes(filter)
      )
        continue;
      const next = [...path, { id, name: String(folder.name) }];
      const key = next.map((crumb) => crumb.id).join("/");
      result.push({ key, folder, path: next, depth, open });
      if (!open) continue;
      if (loading.has(id))
        result.push({
          key: `${key}:hint`,
          path: next,
          depth: depth + 1,
          hint: "Loading…",
        });
      else if (!props.children[id]?.length)
        result.push({
          key: `${key}:hint`,
          path: next,
          depth: depth + 1,
          hint: "No subfolders",
        });
      else visit(props.children[id]!, next, depth + 1);
    }
  }
  visit(props.folders, props.path, 0);
  return result;
});
const tree = ref<HTMLElement>(),
  probes = ref<HTMLElement>();
const top = ref(0),
  height = ref(600),
  folderHeight = ref(27),
  hintHeights = ref<Record<string, number>>({});
const focused = ref<string>();
let viewport: HTMLElement | null = null;
let observer: ResizeObserver | undefined;
let enteringBackwards: boolean | undefined;
const hintKey = (entry: Entry) => `${entry.depth}:${entry.hint}`;
const hintProbes = computed(() => [
  ...new Map(
    entries.value
      .filter((entry) => entry.hint)
      .map((entry) => [hintKey(entry), entry]),
  ).values(),
]);
function trackEntry(event: KeyboardEvent) {
  enteringBackwards =
    event.key === "Tab" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !tree.value?.contains(event.target as Node)
      ? event.shiftKey
      : undefined;
}
function clearEntry() {
  enteringBackwards = undefined;
}
function focusRow(entry: Entry) {
  focused.value = entry.key;
  if (enteringBackwards === undefined) return;
  const backwards = enteringBackwards;
  clearEntry();
  const folders = entries.value.filter((entry) => entry.folder);
  const target = backwards ? folders.at(-1) : folders[0];
  if (target) void focusEntry(target, backwards);
}
const offsets = computed(() => {
  const result = [0];
  for (const entry of entries.value)
    result.push(
      result[result.length - 1]! +
        (entry.folder
          ? folderHeight.value
          : (hintHeights.value[hintKey(entry)] ?? 45)),
    );
  return result;
});
function indexAt(position: number) {
  const offsetsValue = offsets.value;
  let low = 0,
    high = entries.value.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsetsValue[mid + 1]! <= position) low = mid + 1;
    else high = mid;
  }
  return low;
}
const segments = computed(() => {
  const count = entries.value.length;
  const start =
    count > 100 ? Math.max(0, indexAt(Math.max(0, top.value)) - 8) : 0;
  const end =
    count > 100
      ? Math.min(count, indexAt(top.value + height.value) + 9)
      : count;
  const indices = Array.from(
    { length: Math.max(0, end - start) },
    (_, i) => start + i,
  );
  const pin = entries.value.findIndex((entry) => entry.key === focused.value);
  if (pin >= 0 && !indices.includes(pin)) indices.push(pin);
  indices.sort((a, b) => a - b);
  const result: { key: string; entry?: Entry; gap?: number }[] = [];
  let previous = 0;
  for (const index of indices) {
    if (index > previous)
      result.push({
        key: `gap:${previous}`,
        gap: offsets.value[index]! - offsets.value[previous]!,
      });
    const entry = entries.value[index]!;
    result.push({ key: entry.key, entry });
    previous = index + 1;
  }
  if (previous < count)
    result.push({
      key: `gap:${previous}`,
      gap: offsets.value[count]! - offsets.value[previous]!,
    });
  return result;
});
// Rectangles include the canvas transform; scroll offsets and spacers use layout pixels.
function treeOffset() {
  if (!tree.value || !viewport) return 0;
  const bounds = viewport.getBoundingClientRect();
  const scale = bounds.height / viewport.offsetHeight;
  return (
    (tree.value.getBoundingClientRect().top - bounds.top) / (scale || 1) +
    viewport.scrollTop -
    viewport.clientTop
  );
}
function readScroll() {
  if (viewport) top.value = viewport.scrollTop - treeOffset();
}
function measure() {
  if (!viewport?.clientHeight || !probes.value) return;
  height.value = viewport.clientHeight;
  const folder = probes.value.firstElementChild as HTMLElement;
  if (folder?.offsetHeight)
    folderHeight.value = parseFloat(getComputedStyle(folder).height);
  const measured: Record<string, number> = {};
  for (const hint of probes.value.querySelectorAll<HTMLElement>(
    "[data-hint-probe]",
  )) {
    if (hint.offsetHeight)
      measured[hint.dataset.hintProbe!] = parseFloat(
        getComputedStyle(hint).height,
      );
  }
  if (JSON.stringify(measured) !== JSON.stringify(hintHeights.value))
    hintHeights.value = measured;
  readScroll();
}
async function tab(event: KeyboardEvent, entry: Entry, name: boolean) {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const folders = entries.value.filter((entry) => entry.folder);
  const index = folders.findIndex((candidate) => candidate.key === entry.key);
  const position = index * 2 + Number(name) + (event.shiftKey ? -1 : 1);
  if (position < 0 || position >= folders.length * 2) return; // Native Tab leaves the tree.
  event.preventDefault();
  await focusEntry(folders[Math.floor(position / 2)]!, Boolean(position % 2));
}
async function focusEntry(target: Entry, name: boolean) {
  focused.value = target.key;
  await nextTick();
  const row = Array.from(
    tree.value?.querySelectorAll<HTMLElement>("[data-folder-key]") ?? [],
  ).find((row) => row.dataset.folderKey === target.key);
  const button = row?.querySelector<HTMLButtonElement>(
    name ? ".folder-tree-name" : ".folder-tree-toggle",
  );
  if (!button || !viewport) return;
  const rowIndex = entries.value.indexOf(target),
    offset = treeOffset();
  const start = offset + offsets.value[rowIndex]!,
    end = offset + offsets.value[rowIndex + 1]!;
  if (start < viewport.scrollTop) viewport.scrollTop = start;
  else if (end > viewport.scrollTop + viewport.clientHeight)
    viewport.scrollTop = end - viewport.clientHeight;
  readScroll();
  button.focus({ preventScroll: true });
}
onMounted(() => {
  viewport = tree.value?.closest<HTMLElement>(".fc-sidebar") ?? null;
  viewport?.addEventListener("scroll", readScroll, { passive: true });
  viewport?.addEventListener("keydown", trackEntry, true);
  viewport?.addEventListener("pointerdown", clearEntry, true);
  observer = new ResizeObserver(measure);
  if (viewport) observer.observe(viewport);
  if (tree.value?.parentElement) observer.observe(tree.value.parentElement);
  if (probes.value) observer.observe(probes.value);
  measure();
});
onUpdated(measure);
onBeforeUnmount(() => {
  observer?.disconnect();
  viewport?.removeEventListener("scroll", readScroll);
  viewport?.removeEventListener("keydown", trackEntry, true);
  viewport?.removeEventListener("pointerdown", clearEntry, true);
});
</script>
<template>
  <div
    ref="tree"
    class="folder-tree"
    @focusout="
      (event) => {
        if (!tree?.contains(event.relatedTarget as Node)) focused = undefined;
      }
    "
  >
    <div ref="probes" class="folder-tree-probes" aria-hidden="true" inert>
      <div class="folder-tree-row">
        <span class="folder-tree-toggle"></span
        ><span class="folder-tree-name">Folder</span>
      </div>
      <div
        v-for="entry in hintProbes"
        :key="hintKey(entry)"
        class="folder-tree-entry"
        :data-hint-probe="hintKey(entry)"
        :style="{ marginLeft: `${entry.depth * 16}px` }"
      >
        <p class="folder-tree-hint">{{ entry.hint }}</p>
      </div>
    </div>
    <template v-for="segment in segments" :key="segment.key">
      <div
        v-if="segment.gap !== undefined"
        aria-hidden="true"
        :style="{ height: `${segment.gap}px` }"
      />
      <div
        v-else-if="segment.entry"
        class="folder-tree-entry"
        :style="{ marginLeft: `${segment.entry.depth * 16}px` }"
      >
        <div
          v-if="segment.entry.folder"
          class="folder-tree-row"
          :data-folder-key="segment.key"
          :class="{ selected: Number(segment.entry.folder.id) === selected }"
          @focusin="focusRow(segment.entry)"
        >
          <button
            class="folder-tree-toggle"
            :aria-label="`${segment.entry.open ? 'Collapse' : 'Expand'} ${segment.entry.folder.name}`"
            @click="emit('toggle', segment.entry.folder)"
            @keydown="tab($event, segment.entry, false)"
          >
            <Icon :name="segment.entry.open ? 'down' : 'right'" :size="12" />
          </button>
          <button
            class="folder-tree-name"
            @click="emit('navigate', segment.entry.path)"
            @keydown="tab($event, segment.entry, true)"
          >
            <Icon
              :name="segment.entry.open ? 'folder-open' : 'folder'"
              :size="13"
            /><span>{{ segment.entry.folder.name }}</span
            ><small v-if="Number(segment.entry.folder.numfolderfiles) > 0">{{
              segment.entry.folder.numfolderfiles
            }}</small>
          </button>
        </div>
        <p v-else class="folder-tree-hint">{{ segment.entry.hint }}</p>
      </div>
    </template>
  </div>
</template>
<style scoped>
.folder-tree-row {
  display: flex;
  align-items: center;
  border-radius: 4px;
  color: #526b7a;
}
.folder-tree-row:hover {
  background: #eaf1f4;
}
.folder-tree-row.selected {
  background: #dfeaf0;
  color: #344f5e;
}
.folder-tree-toggle {
  flex: none;
  display: grid;
  place-items: center;
  width: 23px;
  height: 27px;
  padding: 0;
  color: inherit;
}
.folder-tree-name {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1;
  text-align: left;
  padding: 6px 4px;
  color: inherit;
}
.folder-tree-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-tree-name small {
  margin-left: auto;
  padding: 0 5px;
  border-radius: 8px;
  background: #e3ecf0;
  color: #718591;
  font-size: 10px;
}
.folder-tree {
  position: relative;
  overflow-anchor: none;
}
.folder-tree-entry {
  display: flow-root;
}
.folder-tree-probes {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
  width: 100%;
}
.folder-tree-hint {
  color: #718591;
  font-size: 11px;
  padding: 5px 8px;
}
</style>
