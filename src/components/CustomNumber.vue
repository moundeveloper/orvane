<script setup lang="ts">
import { computed, ref, useAttrs, watch } from "vue";
import Icon from "./Icon.vue";
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
  }>(),
  { step: 1 },
);
const emit = defineEmits<{
  "update:modelValue": [value: number];
  change: [value: number];
}>();
const attrs = useAttrs(),
  draft = ref(String(props.modelValue)),
  focused = ref(false);
const input = ref<HTMLInputElement>();
const parse = () => {
  const text = draft.value.trim().replace(",", ".");
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text))
    return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
};
const current = computed(() => parse() ?? props.modelValue);
const clamp = (value: number) =>
  Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, value));
function publish(value: number) {
  if (props.disabled || !Number.isFinite(value)) return;
  const next = clamp(value);
  draft.value = String(next);
  if (next !== props.modelValue) {
    emit("update:modelValue", next);
    emit("change", next);
  }
}
function commit() {
  const value = parse();
  if (value === undefined) draft.value = String(props.modelValue);
  else publish(value);
}
function adjust(direction: number, multiplier = 1) {
  const value = clamp(current.value) + direction * props.step * multiplier;
  if (Number.isFinite(value)) publish(Number(value.toFixed(10)));
}
function stepPointerDown(event: PointerEvent) {
  if (event.button === 0) {
    event.preventDefault();
    event.stopPropagation();
  }
}
function key(event: KeyboardEvent) {
  if (
    [
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      "Enter",
      "Escape",
    ].includes(event.key)
  ) {
    event.stopPropagation();
    if (
      (event.key === "Home" && props.min === undefined) ||
      (event.key === "End" && props.max === undefined)
    )
      return;
    event.preventDefault();
    if (event.key === "ArrowUp" || event.key === "PageUp")
      adjust(1, event.key === "PageUp" ? 10 : event.shiftKey ? 10 : 1);
    else if (event.key === "ArrowDown" || event.key === "PageDown")
      adjust(-1, event.key === "PageDown" ? 10 : event.shiftKey ? 10 : 1);
    else if (event.key === "Home") publish(props.min!);
    else if (event.key === "End") publish(props.max!);
    else if (event.key === "Enter") commit();
    else draft.value = String(props.modelValue);
  }
}
watch(
  () => props.modelValue,
  (value, previous) => {
    if (!focused.value || draft.value === String(previous))
      draft.value = String(value);
  },
);
const name = computed(() => String(attrs["aria-label"] || "value"));
</script>
<template>
  <div class="number-field" :class="{ 'number-field-disabled': disabled }">
    <input
      ref="input"
      v-bind="attrs"
      type="text"
      inputmode="decimal"
      role="spinbutton"
      autocomplete="off"
      spellcheck="false"
      :value="draft"
      :disabled="disabled"
      :aria-valuenow="current"
      :aria-valuemin="min"
      :aria-valuemax="max"
      @focus="focused = true"
      @input="draft = ($event.target as HTMLInputElement).value"
      @blur="
        commit();
        focused = false;
      "
      @change="commit"
      @keydown="key"
    />
    <div class="number-stepper">
      <button
        type="button"
        :aria-label="`Decrease ${name}`"
        :disabled="disabled || current <= (min ?? -Infinity)"
        @pointerdown="stepPointerDown"
        @click.stop.prevent="adjust(-1)"
      >
        <Icon name="minus" :size="12" />
      </button>
      <button
        type="button"
        :aria-label="`Increase ${name}`"
        :disabled="disabled || current >= (max ?? Infinity)"
        @pointerdown="stepPointerDown"
        @click.stop.prevent="adjust(1)"
      >
        <Icon name="plus" :size="12" />
      </button>
    </div>
  </div>
</template>
