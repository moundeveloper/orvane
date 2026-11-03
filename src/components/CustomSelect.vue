<script setup lang="ts" generic="T extends string">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useAttrs,
  useSlots,
  type VNode,
} from "vue";
import Icon from "./Icon.vue";
import { vMotion } from "../motion";
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  modelValue?: T;
  options?: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: T]; change: [] }>();
const attrs = useAttrs(),
  trigger = ref<HTMLButtonElement>(),
  menu = ref<HTMLDivElement>(),
  open = ref(false),
  highlighted = ref(0);
const slots = useSlots();
function collect(
  nodes: VNode[],
): { value: string; label: string; disabled?: boolean }[] {
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
const position = ref({
  left: "0px",
  top: "0px",
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
  // The list lives outside the canvas: zoom it by the trigger's on-screen
  // scale so it matches the app at any canvas zoom. CSS zoom also scales
  // left/top, so those are given in unzoomed pixels.
  const scale = r.width / (trigger.value.offsetWidth || r.width) || 1;
  const height = Math.min(248, options.value.length * 32 + 10) * scale;
  const below = innerHeight - r.bottom;
  const left = Math.max(8, Math.min(innerWidth - r.width - 8, r.left));
  const top =
    below < height && r.top > below
      ? Math.max(8, r.top - height - 5 * scale)
      : r.bottom + 5 * scale;
  position.value = {
    left: left / scale + "px",
    top: top / scale + "px",
    width: Math.max(150, trigger.value.offsetWidth) + "px",
    maxHeight:
      Math.max(80, Math.min(248, (Math.max(below, r.top) - 16) / scale)) + "px",
    fontSize: "11px",
    zoom: String(scale),
  };
}
function show() {
  if (open.value) {
    open.value = false;
    return;
  }
  place();
  open.value = true;
  highlighted.value = Math.max(
    0,
    options.value.findIndex((o) => o.value === props.modelValue),
  );
  nextTick(() => menu.value?.focus({ preventScroll: true }));
}
function choose(index: number) {
  const option = options.value[index];
  if (!option || option.disabled) return;
  emit("update:modelValue", option.value as T);
  emit("change");
  open.value = false;
  trigger.value?.focus({ preventScroll: true });
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    open.value = false;
    trigger.value?.focus();
    return;
  }
  if (e.key === "Tab") {
    open.value = false;
    return;
  }
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
    const length = options.value.length;
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
  window.addEventListener("wheel", dismiss, { passive: true });
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", dismiss);
  window.removeEventListener("wheel", dismiss);
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
    <span>{{ label }}</span
    ><Icon name="down" :size="12" />
  </button>
  <Teleport to="body"
    ><div
      v-if="open"
      :id="id"
      ref="menu"
      class="select-popover"
      v-motion="{ kind: 'popover' }"
      role="listbox"
      tabindex="-1"
      :aria-label="String(attrs['aria-label'] || 'Options')"
      :style="position"
      :aria-activedescendant="`${id}-${highlighted}`"
      @pointerdown.stop
      @keydown.stop="key"
      @wheel.stop
    >
      <button
        v-for="(option, index) in options"
        :id="`${id}-${index}`"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        :disabled="option.disabled"
        :data-highlighted="highlighted === index"
        @pointermove="highlighted = index"
        @click="choose(index)"
      >
        <span>{{ option.label }}</span
        ><Icon v-if="option.value === modelValue" name="check" :size="12" />
      </button></div
  ></Teleport>
</template>
