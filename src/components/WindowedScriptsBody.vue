<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  onUpdated,
  ref,
  shallowRef,
  watch,
} from "vue";
type Row = Record<string, any>;
const props = defineProps<{
  rows: Row[];
  expanded: number[];
  resetKey: string;
}>();
defineSlots<{ default(props: { row: Row; index: number }): unknown }>();
const viewport = ref<HTMLElement>();
const top = ref(0),
  height = ref(600),
  rowHeight = ref(38),
  focused = ref<string>();
const sizes = shallowRef(new Map<string, number>());
const expandedKeys = computed(() => new Set(props.expanded.map(String)));
const indices = computed(
  () => new Map(props.rows.map((row, index) => [String(row.id), index])),
);
const expandedIndices = computed(() =>
  props.rows.flatMap((row, index) =>
    expandedKeys.value.has(String(row.id)) ? [index] : [],
  ),
);
const offsets = computed(() => {
  const result = [0];
  for (const row of props.rows) {
    const key = String(row.id);
    result.push(
      result[result.length - 1]! +
        (expandedKeys.value.has(key)
          ? (sizes.value.get(key) ?? rowHeight.value)
          : rowHeight.value),
    );
  }
  return result;
});
function indexAt(positions: number[], position: number) {
  let low = 0,
    high = positions.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (positions[mid + 1]! <= position) low = mid + 1;
    else high = mid;
  }
  return Math.min(Math.max(0, positions.length - 2), low);
}
const segments = computed(() => {
  const count = props.rows.length,
    windowed = count > 100;
  const start = windowed
    ? Math.max(0, indexAt(offsets.value, top.value) - 8)
    : 0;
  const end = windowed
    ? Math.min(count, indexAt(offsets.value, top.value + height.value) + 9)
    : count;
  const mounted = new Set(
    Array.from({ length: end - start }, (_, i) => start + i),
  );
  // Keep expanded panels intact: previews, inner log scroll and native controls
  // should not be reconstructed when the surrounding collapsed list scrolls.
  for (const index of expandedIndices.value) mounted.add(index);
  const pin =
    focused.value === undefined ? undefined : indices.value.get(focused.value);
  if (pin !== undefined) mounted.add(pin);
  const result: { key: string; index?: number; gap?: number }[] = [];
  let previous = 0;
  for (const index of [...mounted].sort((a, b) => a - b)) {
    if (index > previous)
      result.push({
        key: `gap:${previous}`,
        gap: offsets.value[index]! - offsets.value[previous]!,
      });
    result.push({ key: `record:${props.rows[index]!.id}`, index });
    previous = index + 1;
  }
  if (previous < count)
    result.push({
      key: `gap:${previous}`,
      gap: offsets.value[count]! - offsets.value[previous]!,
    });
  return result;
});
let observer: ResizeObserver | undefined;
let observed = new Set<Element>();
let version = 0;
let enteringBackwards: boolean | undefined;
let restoring = false;
let entryFrame = 0;
function readScroll() {
  if (viewport.value && !restoring) top.value = viewport.value.scrollTop;
}
function scrollTo(position: number) {
  if (!viewport.value) return;
  restoring = false;
  viewport.value.scrollTop = Math.max(0, position);
  readScroll();
}
function measure() {
  const body = viewport.value;
  if (!body?.clientHeight) return;
  const measuredHeight = body.clientHeight;
  const header = body.querySelector<HTMLElement>(".script-row");
  const measuredRow = header
    ? parseFloat(getComputedStyle(header).height) || rowHeight.value
    : rowHeight.value;
  const records = Array.from(
    body.querySelectorAll<HTMLElement>("[data-script-key]"),
  );
  const expanded = records.filter((row) =>
    expandedKeys.value.has(row.dataset.scriptKey!),
  );
  const nextObserved = new Set<Element>([
    ...(header ? [header] : []),
    ...expanded,
  ]);
  for (const row of observed)
    if (!nextObserved.has(row)) observer?.unobserve(row);
  for (const row of nextObserved)
    if (!observed.has(row)) observer?.observe(row);
  observed = nextObserved;
  const next = new Map(
    [...sizes.value].filter(([key]) => indices.value.has(key)),
  );
  let changed = next.size !== sizes.value.size;
  for (const row of expanded) {
    const size = parseFloat(getComputedStyle(row).height);
    if (size > 0 && next.get(row.dataset.scriptKey!) !== size) {
      next.set(row.dataset.scriptKey!, size);
      changed = true;
    }
  }
  if (
    changed ||
    measuredHeight !== height.value ||
    measuredRow !== rowHeight.value
  ) {
    // Keep pre-layout coordinates until the anchor is restored. Native scroll
    // clamping after an expanded panel shrinks must not be applied twice.
    restoring = true;
    height.value = measuredHeight;
    rowHeight.value = measuredRow;
    if (changed) sizes.value = next;
  } else readScroll();
}
watch(
  () => ({
    rows: props.rows,
    offsets: offsets.value,
    reset: props.resetKey,
    height: height.value,
  }),
  (next, previous) => {
    const index = indexAt(previous.offsets, top.value);
    const key = previous.rows[index]?.id;
    const nextIndex =
      key === undefined ? undefined : indices.value.get(String(key));
    const atBottom =
      top.value > 0 &&
      top.value + previous.height >= previous.offsets.at(-1)! - 1;
    const position =
      next.reset !== previous.reset
        ? 0
        : atBottom
          ? Math.max(0, next.offsets.at(-1)! - next.height)
          : nextIndex !== undefined
            ? next.offsets[nextIndex]! + top.value - previous.offsets[index]!
            : 0;
    restoring = true;
    const request = ++version;
    void nextTick(() => {
      if (request === version) scrollTo(position);
    });
  },
);
const focusable = (record: HTMLElement) =>
  Array.from(
    record.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
function revealControl(body: HTMLElement, control: HTMLElement) {
  const bounds = body.getBoundingClientRect(),
    scale = bounds.height / body.offsetHeight || 1;
  const button = control.getBoundingClientRect();
  const start = (button.top - bounds.top) / scale,
    end = (button.bottom - bounds.top) / scale;
  if (start < 0) scrollTo(body.scrollTop + start);
  else if (end > body.clientHeight)
    scrollTo(body.scrollTop + end - body.clientHeight);
}
async function focusRecord(index: number, last: boolean, nativeEntry = false) {
  const row = props.rows[index];
  if (!row) return;
  focused.value = String(row.id);
  await nextTick();
  const body = viewport.value;
  const record = Array.from(
    body?.querySelectorAll<HTMLElement>("[data-script-key]") ?? [],
  ).find((record) => record.dataset.scriptKey === focused.value);
  if (!record || !body) return;
  const controls = focusable(record),
    control = last ? controls.at(-1) : controls[0];
  if (!control) return;
  revealControl(body, control);
  control.focus({ preventScroll: true });
  if (nativeEntry) {
    cancelAnimationFrame(entryFrame);
    // Native Tab can finish scrolling its original focus target after focusin.
    // Recheck the redirected target before painting, without moving the canvas.
    entryFrame = requestAnimationFrame(() => {
      entryFrame = 0;
      if (document.activeElement === control && body.isConnected)
        revealControl(body, control);
    });
  }
}
function keydown(event: KeyboardEvent) {
  enteringBackwards = undefined;
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const target = event.target as HTMLElement;
  if (!viewport.value?.contains(target)) {
    enteringBackwards = event.shiftKey;
    return;
  }
  const record = target.closest<HTMLElement>("[data-script-key]");
  if (!record) return;
  const controls = focusable(record),
    current = controls.indexOf(target);
  if (
    current < 0 ||
    (event.shiftKey ? current > 0 : current < controls.length - 1)
  )
    return;
  const index = indices.value.get(record.dataset.scriptKey!);
  if (index === undefined) return;
  const next = index + (event.shiftKey ? -1 : 1);
  if (next < 0 || next >= props.rows.length) return; // Native Tab exits the list.
  event.preventDefault();
  void focusRecord(next, event.shiftKey);
}
function clearEntry() {
  enteringBackwards = undefined;
}
function focusin(event: FocusEvent) {
  const record = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-script-key]",
  );
  if (!record) return;
  focused.value = record.dataset.scriptKey;
  if (enteringBackwards === undefined) return;
  const backwards = enteringBackwards;
  clearEntry();
  void focusRecord(backwards ? props.rows.length - 1 : 0, backwards, true);
}
onMounted(() => {
  observer = new ResizeObserver(measure);
  if (viewport.value) observer.observe(viewport.value);
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("pointerdown", clearEntry, true);
  measure();
});
onUpdated(measure);
onBeforeUnmount(() => {
  version++;
  cancelAnimationFrame(entryFrame);
  observer?.disconnect();
  observed.clear();
  document.removeEventListener("keydown", keydown, true);
  document.removeEventListener("pointerdown", clearEntry, true);
});
</script>
<template>
  <div
    ref="viewport"
    class="windowed-scripts-body"
    @scroll.passive="readScroll"
    @focusin="focusin"
    @focusout="
      (event) => {
        if (!viewport?.contains(event.relatedTarget as Node))
          focused = undefined;
      }
    "
  >
    <template v-for="segment in segments" :key="segment.key">
      <div
        v-if="segment.gap !== undefined"
        aria-hidden="true"
        :style="{ height: `${segment.gap}px` }"
      />
      <slot v-else :row="rows[segment.index!]!" :index="segment.index!" />
    </template>
  </div>
</template>
<style scoped>
.windowed-scripts-body {
  overflow-anchor: none;
}
</style>
