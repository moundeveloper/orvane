<script setup lang="ts" generic="T extends { key: string }">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  onUpdated,
  ref,
  watch,
} from "vue";
const props = defineProps<{
  items: T[];
  resetKey: string;
  pinnedKey?: string;
}>();
defineSlots<{ default(props: { item: T; index: number }): unknown }>();
const host = ref<HTMLElement>();
const columns = ref(1),
  tileHeight = ref(91),
  gap = ref(8),
  padding = ref(10);
const top = ref(0),
  height = ref(600),
  pinnedExtra = ref(0);
let viewport: HTMLElement | null = null;
let observer: ResizeObserver | undefined;
let measuredTiles = new Set<HTMLElement>();
let layoutVersion = 0;
const windowed = computed(() => props.items.length > 100);
const rowCount = computed(() => Math.ceil(props.items.length / columns.value));
const pinnedIndex = computed(() =>
  props.items.findIndex((item) => item.key === props.pinnedKey),
);
const pinnedRow = computed(() =>
  pinnedIndex.value < 0 ? -1 : Math.floor(pinnedIndex.value / columns.value),
);
const stride = computed(() => tileHeight.value + gap.value);
function rowTop(row: number) {
  return (
    row * stride.value +
    (pinnedRow.value >= 0 && row > pinnedRow.value ? pinnedExtra.value : 0)
  );
}
function rowAt(position: number) {
  let low = 0,
    high = rowCount.value;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rowTop(mid + 1) <= position) low = mid + 1;
    else high = mid;
  }
  return Math.min(Math.max(0, rowCount.value - 1), low);
}
const segments = computed(() => {
  const count = rowCount.value;
  const start = windowed.value
    ? Math.max(0, rowAt(top.value - padding.value) - 2)
    : 0;
  const end = windowed.value
    ? Math.min(count, rowAt(top.value + height.value - padding.value) + 3)
    : count;
  const rows = Array.from({ length: end - start }, (_, i) => start + i);
  if (pinnedRow.value >= 0 && !rows.includes(pinnedRow.value))
    rows.push(pinnedRow.value);
  rows.sort((a, b) => a - b);
  const result: { key: string; gap?: number; index?: number }[] = [];
  let previous = 0;
  for (const row of rows) {
    // Each spacer is one native CSS grid row. Its adjacent grid gap supplies
    // the final gap of the omitted rows, including a taller rename row.
    if (row > previous)
      result.push({
        key: `gap:${previous}`,
        gap: rowTop(row) - rowTop(previous) - gap.value,
      });
    for (
      let index = row * columns.value;
      index < Math.min(props.items.length, (row + 1) * columns.value);
      index++
    ) {
      result.push({ key: `item:${props.items[index]!.key}`, index });
    }
    previous = row + 1;
  }
  if (previous < count)
    result.push({
      key: `gap:${previous}`,
      gap: rowTop(count) - rowTop(previous) - gap.value,
    });
  return result;
});
function readScroll() {
  if (viewport) top.value = viewport.scrollTop;
}
function scrollTo(value: number) {
  if (!viewport) return;
  viewport.scrollTop = Math.max(0, value);
  readScroll();
}
function measure() {
  if (!viewport?.clientHeight) return; // Preserve the last window in hidden tabs.
  const atBottom =
    top.value > 0 &&
    top.value + height.value >=
      padding.value * 2 + rowTop(rowCount.value) - gap.value - 1;
  const css = getComputedStyle(viewport);
  const nextColumns = css.gridTemplateColumns.split(/\s+/).length;
  const anchor = rowAt(top.value - padding.value) * columns.value;
  const within =
    top.value - padding.value - rowTop(Math.floor(anchor / columns.value));
  height.value = viewport.clientHeight;
  gap.value = parseFloat(css.rowGap) || 0;
  padding.value = parseFloat(css.paddingTop) || 0;
  const changedColumns = nextColumns !== columns.value;
  columns.value = nextColumns;
  const tiles = Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-grid-index]"),
  );
  const regular = tiles.find(
    (tile) =>
      !tile.querySelector("input") &&
      Math.floor(Number(tile.dataset.gridIndex) / columns.value) !==
        pinnedRow.value,
  );
  if (regular) {
    const measured = parseFloat(getComputedStyle(regular).height);
    if (measured > 0) tileHeight.value = measured;
  }
  const pinned = tiles.find(
    (tile) =>
      Number(tile.dataset.gridIndex) === pinnedIndex.value &&
      tile.querySelector("input"),
  );
  const nextMeasured = new Set(
    [regular, pinned].filter((tile): tile is HTMLElement => !!tile),
  );
  for (const tile of measuredTiles)
    if (!nextMeasured.has(tile)) observer?.unobserve(tile);
  for (const tile of nextMeasured)
    if (!measuredTiles.has(tile)) observer?.observe(tile);
  measuredTiles = nextMeasured;
  pinnedExtra.value = pinned
    ? Math.max(
        0,
        parseFloat(getComputedStyle(pinned).height) - tileHeight.value,
      )
    : 0;
  if (changedColumns && windowed.value && top.value > padding.value) {
    const position =
      padding.value + rowTop(Math.floor(anchor / columns.value)) + within;
    const version = ++layoutVersion;
    // A narrower grid can need more scroll range than the old spacers supply.
    // Restore the logical anchor after the new rows/spacers have been mounted.
    void nextTick(() => {
      if (version === layoutVersion)
        scrollTo(atBottom ? (viewport?.scrollHeight ?? position) : position);
    });
  } else readScroll();
}
watch(
  () => props.pinnedKey,
  () => {
    pinnedExtra.value = 0;
  },
);
watch(
  () => [props.items, props.resetKey] as const,
  ([items, reset], [previous, previousReset]) => {
    if (!viewport) return;
    if (reset !== previousReset) {
      scrollTo(0);
      return;
    }
    const index = rowAt(top.value - padding.value) * columns.value;
    const key = previous[index]?.key;
    const next = key ? items.findIndex((item) => item.key === key) : -1;
    if (next >= 0)
      scrollTo(padding.value + rowTop(Math.floor(next / columns.value)));
    else scrollTo(0);
  },
);
onMounted(() => {
  viewport = host.value?.closest<HTMLElement>(".fc-content") ?? null;
  viewport?.addEventListener("scroll", readScroll, { passive: true });
  observer = new ResizeObserver(measure);
  if (viewport) observer.observe(viewport);
  measure();
});
onUpdated(measure);
onBeforeUnmount(() => {
  layoutVersion++;
  measuredTiles.clear();
  observer?.disconnect();
  viewport?.removeEventListener("scroll", readScroll);
});
defineExpose({
  reveal(key: string) {
    const index = props.items.findIndex((item) => item.key === key);
    if (index < 0 || !viewport) return;
    const row = Math.floor(index / columns.value);
    const start = padding.value + rowTop(row),
      end = padding.value + rowTop(row + 1) - gap.value;
    if (start < top.value) scrollTo(start);
    else if (end > top.value + height.value) scrollTo(end - height.value);
    void nextTick(() =>
      viewport
        ?.querySelector<HTMLElement>(`[data-grid-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  },
});
</script>
<template>
  <div ref="host" class="windowed-grid">
    <template v-for="segment in segments" :key="segment.key">
      <div
        v-if="segment.gap !== undefined"
        class="windowed-grid-spacer"
        aria-hidden="true"
        :style="{ height: `${segment.gap}px` }"
      />
      <slot v-else :item="items[segment.index!]!" :index="segment.index!" />
    </template>
  </div>
</template>
<style scoped>
.windowed-grid {
  display: contents;
}
.windowed-grid-spacer {
  grid-column: 1 / -1;
}
</style>
