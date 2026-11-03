<script setup lang="ts" generic="T extends { path: string; name: string }">
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
const props = defineProps<{ rows: T[]; resetKey: string }>();
defineSlots<{
  default(props: { row: T; index: number }): unknown;
  empty(): unknown;
}>();
const viewport = ref<HTMLElement>();
const top = ref(0),
  height = ref(600),
  rowHeight = ref(40),
  focused = ref<string>();
const canWindow = ref(true);
const windowed = computed(() => props.rows.length > 50 && canWindow.value);
const sizes = shallowRef(new Map<string, number>());
const indices = computed(
  () => new Map(props.rows.map((row, index) => [row.path, index])),
);
const offsets = computed(() => {
  const result = [0];
  for (const row of props.rows) {
    const key = row.path;
    result.push(
      result[result.length - 1]! + (sizes.value.get(key) ?? rowHeight.value),
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
  const count = props.rows.length;
  const start = windowed.value
    ? Math.max(0, indexAt(offsets.value, top.value) - 6)
    : 0;
  const end = windowed.value
    ? Math.min(count, indexAt(offsets.value, top.value + height.value) + 7)
    : count;
  const mounted = new Set(
    Array.from({ length: end - start }, (_, i) => start + i),
  );
  const pin =
    !windowed.value || focused.value === undefined
      ? undefined
      : indices.value.get(focused.value);
  if (pin !== undefined) mounted.add(pin);
  const result: { key: string; index?: number; gap?: number }[] = [];
  let previous = 0;
  for (const index of [...mounted].sort((a, b) => a - b)) {
    if (index > previous)
      result.push({
        key: `gap:${previous}`,
        gap: offsets.value[index]! - offsets.value[previous]!,
      });
    result.push({ key: `record:${props.rows[index]!.path}`, index });
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
  if (viewport.value && !restoring) {
    if (
      viewport.value.clientWidth !== width ||
      viewport.value.clientHeight !== height.value
    ) {
      measure();
      return;
    }
    top.value = viewport.value.scrollTop;
  }
}
function scrollTo(position: number) {
  if (!viewport.value) return;
  restoring = false;
  viewport.value.scrollTop = Math.max(0, position);
  readScroll();
}
let width = 0;
let fitRows: T[] | undefined,
  fitWidth = 0,
  fitFont = "",
  fits = false;
const canvas = document.createElement("canvas");
function fitsOneLine(body: HTMLElement) {
  // Leave native horizontal focus scrolling intact in narrow custom sizes.
  if (body.scrollWidth > body.clientWidth) return false;
  const name = body.querySelector<HTMLElement>(".project-name");
  if (!name) return false;
  const style = getComputedStyle(name),
    icon = name.querySelector("svg");
  const available =
    name.clientWidth -
    (icon ? parseFloat(getComputedStyle(icon).width) : 0) -
    (parseFloat(style.columnGap) || 0) -
    1;
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (fitRows !== props.rows || fitWidth !== available || fitFont !== font) {
    fitRows = props.rows;
    fitWidth = available;
    fitFont = font;
    const context = canvas.getContext("2d");
    if (!context) return (fits = false);
    context.font = font;
    // Keep the native full list if a name might wrap. This avoids estimated
    // scroll extents and changing the appearance of long project names.
    fits =
      !parseFloat(style.letterSpacing) &&
      !parseFloat(style.wordSpacing) &&
      props.rows.every(
        (row) =>
          !/[\r\n\t\f]/.test(row.name) &&
          context.measureText(row.name).width <= available,
      );
  }
  return fits;
}
function measure() {
  const body = viewport.value;
  if (!body?.clientHeight) return;
  const records = Array.from(
    body.querySelectorAll<HTMLElement>("[data-project-key]"),
  );
  const nextObserved = new Set<Element>(records);
  for (const row of observed)
    if (!nextObserved.has(row)) observer?.unobserve(row);
  for (const row of nextObserved)
    if (!observed.has(row)) observer?.observe(row);
  observed = nextObserved;
  // Names may wrap. Keep measured layout heights, never screen pixels scaled
  // by the canvas; remeasure visible rows and invalidate stale widths.
  const eligible = fitsOneLine(body);
  const base =
    eligible && records[0]
      ? parseFloat(getComputedStyle(records[0]).height) || 40
      : 40;
  const next =
    (eligible && !canWindow.value) ||
    base !== rowHeight.value ||
    body.clientWidth !== width
      ? new Map<string, number>()
      : new Map([...sizes.value].filter(([key]) => indices.value.has(key)));
  width = body.clientWidth;
  let changed = next.size !== sizes.value.size;
  for (const row of records) {
    const size = parseFloat(getComputedStyle(row).height);
    const key = row.dataset.projectKey!;
    if (size > 0 && Math.abs((next.get(key) ?? base) - size) > 0.01) {
      next.set(key, size);
      changed = true;
    }
  }
  canWindow.value = eligible;
  if (
    changed ||
    height.value !== body.clientHeight ||
    rowHeight.value !== base
  ) {
    restoring = true;
    height.value = body.clientHeight;
    rowHeight.value = base;
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
    const key = previous.rows[index]?.path;
    const nextIndex = key === undefined ? undefined : indices.value.get(key);
    const atBottom =
      top.value > 0 &&
      top.value + previous.height >= previous.offsets.at(-1)! - 1;
    const position =
      next.reset !== previous.reset
        ? 0
        : atBottom
          ? Math.max(0, next.offsets.at(-1)! - next.height)
          : nextIndex !== undefined
            ? next.offsets[nextIndex]! +
              Math.min(
                top.value - previous.offsets[index]!,
                Math.max(
                  0,
                  next.offsets[nextIndex + 1]! - next.offsets[nextIndex]! - 1,
                ),
              )
            : (next.offsets[
                Math.min(index, Math.max(0, next.rows.length - 1))
              ] ?? 0);
    restoring = true;
    // A second measurement can arrive before the DOM scroll is restored.
    // Its offsets already describe the new list, so retain the pending target.
    top.value = position;
    const request = ++version;
    void nextTick(() => {
      if (request === version) scrollTo(position);
    });
  },
);
const focusable = (record: HTMLElement) =>
  [
    record,
    ...Array.from(
      record.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
      ),
    ),
  ].filter(
    (element) =>
      !element.matches(":disabled") && element.getClientRects().length > 0,
  );
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
  focused.value = row.path;
  await nextTick();
  const body = viewport.value;
  const record = Array.from(
    body?.querySelectorAll<HTMLElement>("[data-project-key]") ?? [],
  ).find((record) => record.dataset.projectKey === focused.value);
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
  if (!windowed.value) return;
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const target = event.target as HTMLElement;
  if (!viewport.value?.contains(target)) {
    enteringBackwards = event.shiftKey;
    return;
  }
  const record = target.closest<HTMLElement>("[data-project-key]");
  if (!record) return;
  const controls = focusable(record),
    current = controls.indexOf(target);
  if (
    current < 0 ||
    (event.shiftKey ? current > 0 : current < controls.length - 1)
  )
    return;
  const index = indices.value.get(record.dataset.projectKey!);
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
    "[data-project-key]",
  );
  if (!record) return;
  focused.value = record.dataset.projectKey;
  if (!windowed.value || enteringBackwards === undefined) return;
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
  void document.fonts.ready.then(() => {
    if (viewport.value?.isConnected) {
      fitRows = undefined;
      measure();
    }
  });
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
    class="project-rows"
    :data-windowed="windowed"
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
    <slot v-if="!rows.length" name="empty" />
  </div>
</template>
<style scoped>
.project-rows {
  overflow-anchor: none;
}
</style>
