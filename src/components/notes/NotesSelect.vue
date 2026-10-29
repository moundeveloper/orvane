<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../CustomSelect.vue";
const props = defineProps<{
  modelValue?: unknown;
  options: Record<string, unknown>[];
  optionLabel?: string;
  optionValue?: string;
  placeholder?: string;
}>();
defineEmits<{ "update:modelValue": [value: string] }>();
const options = computed(() =>
  props.options.map((option) => ({
    label: String(option[props.optionLabel || "label"] ?? ""),
    value: String(option[props.optionValue || "value"] ?? ""),
  })),
);
</script>
<template>
  <CustomSelect
    :model-value="String(modelValue ?? '')"
    :options="options"
    :placeholder="placeholder"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>
