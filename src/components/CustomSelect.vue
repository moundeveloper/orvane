<script setup lang="ts" generic="T extends string">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useAttrs,
  useSlots,
  watch,
  type VNode,
} from "vue";
import Icon from "./Icon.vue";
import { vMotion } from "../motion";
defineOptions({ inheritAttrs: false });
interface Option {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: string;
}
const props = defineProps<{
  modelValue?: T;
  options?: Option[];
  placeholder?: string;
  searchLabel?: string;
  inline?: boolean;
  teleportTo?: HTMLElement;
  preferAbove?: boolean;
  triggerIcon?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: T]; change: [] }>();
const attrs = useAttrs(),
  trigger = ref<HTMLButtonElement>(),
  menu = ref<HTMLDivElement>(),
  listbox = ref<HTMLDivElement>(),
  search = ref<HTMLInputElement>(),
  query = ref(""),
  open = ref(false),
  highlighted = ref(0);
const slots = useSlots();
function collect(nodes: VNode[]): Option[] {
  return nodes.flatMap((n) =>
    n.type === "option"
      ? [
          {
            value: String(n.props?.value ?? ""),
            label: Array.isArray(n.children)
              ? n.children
                  .map((c) =>
                    typeof c === "object" && c
                      ? "children" in c
                        ? c.children
                        : ""
                      : c,
                  )
                  .join("")
              : String(n.children ?? ""),
            disabled:
              n.props?.disabled !== undefined && n.props.disabled !== false,
          },
        ]
      : Array.isArray(n.children)
        ? collect(n.children as VNode[])
        : [],
  );
}
const options = computed(
  () => props.options || collect(slots.default?.() || []),
);
const visibleOptions = computed(() => {
  const term = query.value.trim().toLowerCase();
  return term
    ? options.value.filter((o) => o.label.toLowerCase().includes(term))
    : options.value;
});
const position = ref({
  left: "0px",
  top: "0px",
  bottom: "auto",
  width: "180px",
  maxHeight: "240px",
  fontSize: "11px",
  zoom: "1",
});
const label = computed(
  () =>
    options.value.find((o) => o.value === props.modelValue)?.label ||
    props.placeholder ||
    "Choose…",
);
const id = `select-${crypto.randomUUID()}`;
function place() {
  if (!trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  placed = r;
  // The list lives outside the canvas: zoom it by the trigger's on-screen
  // scale so it matches the app at any canvas zoom. CSS zoom also scales
  // left/top, so those are given in unzoomed pixels.
  const scale = r.width / (trigger.value.offsetWidth || r.width) || 1;
  const height =
    Math.min(248, options.value.length * 32 + (props.searchLabel ? 46 : 10)) *
    scale;
  const below = innerHeight - r.bottom;
  // Under the trigger, as wide as it, but only its part inside the window
  // (a wide trigger can run past the edge when zoomed in).
  const minWidth = 150 * scale;
  const start = Math.max(8, r.left);
  const width = Math.max(minWidth, Math.min(r.right, innerWidth - 8) - start);
  const left = Math.max(8, Math.min(start, innerWidth - 8 - width));
  const above = props.preferAbove && r.top >= Math.min(height, 96 * scale) + 12;
  const available = props.preferAbove
    ? above
      ? r.top
      : below
    : Math.max(below, r.top);
  const top =
    below < height && r.top > below && !props.preferAbove
      ? Math.max(8, r.top - height - 5 * scale)
      : r.bottom + 5 * scale;
  position.value = {
    left: left / scale + "px",
    top: above ? "auto" : top / scale + "px",
    bottom: above ? (innerHeight - r.top) / scale + 5 + "px" : "auto",
    width: width / scale + "px",
    maxHeight:
      Math.max(
        props.preferAbove ? 28 : 80,
        Math.min(248, (available - 16) / scale),
      ) + "px",
    fontSize: "11px",
    zoom: String(scale),
  };
}
// Follow the trigger while open: the canvas can pan or zoom under it.
let placed: DOMRect | undefined,
  follow = 0;
function track() {
  follow = 0;
  if (!open.value || !trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  if (
    !r.width ||
    r.bottom < 0 ||
    r.top > innerHeight ||
    r.right < 0 ||
    r.left > innerWidth
  ) {
    open.value = false;
    return;
  }
  if (
    !placed ||
    r.left !== placed.left ||
    r.top !== placed.top ||
    r.width !== placed.width
  )
    place();
  follow = requestAnimationFrame(track);
}
watch(open, (now) => {
  cancelAnimationFrame(follow);
  if (now) follow = requestAnimationFrame(track);
});
function show() {
  if (open.value) {
    open.value = false;
    return;
  }
  if (!props.inline) place();
  query.value = "";
  open.value = true;
  highlighted.value = Math.max(
    0,
    options.value.findIndex((o) => o.value === props.modelValue),
  );
  nextTick(() =>
    (search.value || listbox.value)?.focus({ preventScroll: true }),
  );
}
function choose(index: number) {
  const option = visibleOptions.value[index];
  if (!option || option.disabled) return;
  emit("update:modelValue", option.value as T);
  emit("change");
  open.value = false;
  trigger.value?.focus({ preventScroll: true });
}
function filter(event: Event) {
  query.value = (event.target as HTMLInputElement).value;
  highlighted.value = visibleOptions.value.findIndex(
    (option) => !option.disabled,
  );
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (!open.value) return;
    e.preventDefault();
    e.stopPropagation();
    open.value = false;
    trigger.value?.focus();
    return;
  }
  if (e.key === "Tab") {
    open.value = false;
    return;
  }
  if (
    search.value &&
    e.target === search.value &&
    !["ArrowDown", "ArrowUp", "Enter"].includes(e.key)
  )
    return;
  if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(e.key)) {
    e.preventDefault();
    if (!open.value) {
      show();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      choose(highlighted.value);
      return;
    }
    const length = visibleOptions.value.length;
    if (!length) return;
    highlighted.value =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? length - 1
          : (highlighted.value + (e.key === "ArrowDown" ? 1 : -1) + length) %
            length;
    nextTick(() =>
      menu.value
        ?.querySelector<HTMLElement>("[data-highlighted=true]")
        ?.scrollIntoView({ block: "nearest" }),
    );
  } else if (e.key.length === 1) {
    const found = options.value.findIndex((o) =>
      o.label.toLowerCase().startsWith(e.key.toLowerCase()),
    );
    if (found >= 0) highlighted.value = found;
  }
}
function outside(e: PointerEvent) {
  // Middle-drag pans the canvas: the list follows instead of closing.
  if (e.button === 1) return;
  if (
    !trigger.value?.contains(e.target as Node) &&
    !menu.value?.contains(e.target as Node)
  )
    open.value = false;
}
function dismiss() {
  open.value = false;
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", dismiss);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", dismiss);
  cancelAnimationFrame(follow);
});
</script>
<template>
  <button
    ref="trigger"
    v-bind="attrs"
    class="select-trigger"
    type="button"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? id : undefined"
    @click.stop="show"
    @keydown.stop="key"
  >
    <span v-if="triggerIcon" class="select-trigger-icon-label"
      ><Icon :name="triggerIcon" :size="13" /><span>{{ label }}</span></span
    >
    <span v-else>{{ label }}</span
    ><Icon name="down" :size="12" />
  </button>
  <Teleport :to="teleportTo || 'body'" :disabled="inline"
    ><div
      v-if="open"
      ref="menu"
      class="select-popover"
      v-motion="{ kind: 'popover' }"
      :style="inline ? undefined : position"
      @pointerdown.stop
      @keydown.stop="key"
      @wheel.stop
    >
      <input
        v-if="searchLabel"
        ref="search"
        type="text"
        role="combobox"
        class="select-search"
        autocomplete="off"
        :aria-label="searchLabel"
        :placeholder="searchLabel"
        aria-autocomplete="list"
        aria-expanded="true"
        :aria-controls="id"
        :aria-activedescendant="
          visibleOptions[highlighted] ? `${id}-${highlighted}` : undefined
        "
        :value="query"
        @input="filter"
      />
      <div
        v-if="searchLabel && !visibleOptions.length"
        class="select-no-results"
        role="status"
      >
        No matches
      </div>
      <div
        :id="id"
        ref="listbox"
        class="select-options"
        role="listbox"
        tabindex="-1"
        :aria-label="String(attrs['aria-label'] || 'Options')"
        :aria-activedescendant="
          !searchLabel && visibleOptions[highlighted]
            ? `${id}-${highlighted}`
            : undefined
        "
      >
        <button
          v-for="(option, index) in visibleOptions"
          :id="`${id}-${index}`"
          :key="option.value"
          type="button"
          role="option"
          :tabindex="inline || searchLabel ? -1 : undefined"
          :aria-selected="option.value === modelValue"
          :disabled="option.disabled"
          :data-highlighted="highlighted === index"
          @pointermove="highlighted = index"
          @click="choose(index)"
        >
          <Icon v-if="option.icon" :name="option.icon" :size="14" />
          <span>{{ option.label }}</span
          ><Icon v-if="option.value === modelValue" name="check" :size="12" />
        </button>
      </div></div
  ></Teleport>
</template>
