<script setup lang="ts" generic="T extends { key: string }">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  watch,
} from "vue";

const props = defineProps<{
  items: T[];
  resetKey: string;
  pinnedKey?: string;
  columns: number;
}>();
defineSlots<{
  default(props: { item: T; index: number }): unknown;
  sizing(): unknown;
}>();
const body = ref<HTMLTableSectionElement>();
const top = ref(0),
  height = ref(600),
  rowHeight = ref(29),
  headerHeight = ref(29);
let viewport: HTMLElement | null = null;
let observer: ResizeObserver | undefined;
let measuredRow: HTMLElement | null = null;
const windowed = computed(() => props.items.length > 100);
const range = computed(() => {
  const count = props.items.length;
  if (!windowed.value) return { start: 0, end: count };
  const visible = Math.ceil(height.value / rowHeight.value) + 16;
  const start = Math.max(
    0,
    Math.min(
      count - visible,
      Math.floor(
        Math.max(0, top.value - headerHeight.value) / rowHeight.value,
      ) - 8,
    ),
  );
  return { start, end: Math.min(count, start + visible) };
});
const segments = computed(() => {
  const { start, end } = range.value;
  const indices = Array.from({ length: end - start }, (_, i) => start + i);
  const pinned = props.pinnedKey
    ? props.items.findIndex((item) => item.key === props.pinnedKey)
    : -1;
  if (pinned >= 0 && (pinned < start || pinned >= end)) indices.push(pinned);
  indices.sort((a, b) => a - b);
  const result: (
    | { key: string; index: number; gap?: never }
    | { key: string; gap: number; index?: never }
  )[] = [];
  let previous = 0;
  for (const index of indices) {
    if (index > previous)
      result.push({
        key: `gap:${previous}`,
        gap: (index - previous) * rowHeight.value,
      });
    result.push({ key: props.items[index]!.key, index });
    previous = index + 1;
  }
  if (previous < props.items.length)
    result.push({
      key: `gap:${previous}`,
      gap: (props.items.length - previous) * rowHeight.value,
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
  if (!viewport?.clientHeight) return; // A hidden split retains its previous window.
  height.value = viewport.clientHeight;
  const header = body.value?.parentElement?.querySelector("thead");
  if (header)
    headerHeight.value =
      parseFloat(getComputedStyle(header).height) || headerHeight.value;
  const rows = Array.from(
    body.value?.querySelectorAll<HTMLElement>("tr[data-key]") ?? [],
  ).filter((row) => !row.querySelector("input"));
  const row = rows[1] ?? rows[0] ?? null;
  if (row && row !== measuredRow) {
    if (measuredRow) observer?.unobserve(measuredRow);
    measuredRow = row;
    observer?.observe(row);
  }
  if (row) {
    let size = parseFloat(getComputedStyle(row).height);
    const next = row.nextElementSibling as HTMLElement | null;
    if (size > 0 && next?.hasAttribute("data-key")) {
      const bounds = row.getBoundingClientRect();
      const scale = bounds.height / size;
      // Collapsed table borders overlap. Measure row advance, not border-box
      // height, and cancel the canvas scale so spacers use layout pixels.
      if (scale > 0)
        size = (next.getBoundingClientRect().top - bounds.top) / scale;
    }
    if (size > 0 && Math.abs(size - rowHeight.value) > 0.01)
      rowHeight.value = size;
  }
}
watch(
  () => [props.items, props.resetKey] as const,
  ([items, reset], [previous, previousReset]) => {
    if (!viewport) return;
    if (reset !== previousReset) {
      scrollTo(0);
      return;
    }
    // Keep the first visible record in place across refreshes and renames.
    const index = Math.max(0, Math.floor(top.value / rowHeight.value));
    const anchor = previous[index]?.key;
    const next = anchor ? items.findIndex((item) => item.key === anchor) : -1;
    if (next >= 0)
      scrollTo(next * rowHeight.value + (top.value % rowHeight.value));
    else scrollTo(0);
  },
);
onMounted(() => {
  viewport = body.value?.closest<HTMLElement>(".fc-content") ?? null;
  viewport?.addEventListener("scroll", readScroll, { passive: true });
  observer = new ResizeObserver(measure);
  if (viewport) observer.observe(viewport);
  measure();
  readScroll();
});
onUpdated(measure);
onBeforeUnmount(() => {
  observer?.disconnect();
  viewport?.removeEventListener("scroll", readScroll);
});
defineExpose({
  reveal(key: string) {
    if (!viewport) return;
    const index = props.items.findIndex((item) => item.key === key);
    if (index < 0) return;
    const position = index * rowHeight.value;
    if (position < top.value) scrollTo(position);
    else if (
      position + rowHeight.value >
      top.value + height.value - headerHeight.value
    )
      scrollTo(position + rowHeight.value - height.value + headerHeight.value);
    void nextTick(measure);
  },
});
</script>

<template>
  <tbody ref="body">
    <tr v-if="windowed" class="windowed-table-sizing" aria-hidden="true">
      <slot name="sizing" />
    </tr>
    <template v-for="segment in segments" :key="segment.key">
      <tr
        v-if="segment.gap !== undefined"
        class="windowed-table-spacer"
        aria-hidden="true"
      >
        <td :colspan="columns" :style="{ height: `${segment.gap}px` }" />
      </tr>
      <slot v-else :item="items[segment.index]!" :index="segment.index" />
    </template>
  </tbody>
</template>

<style scoped>
.windowed-table-sizing {
  visibility: collapse;
}
.windowed-table-spacer > td {
  padding: 0 !important;
  border: 0 !important;
  line-height: 0;
}
</style>
