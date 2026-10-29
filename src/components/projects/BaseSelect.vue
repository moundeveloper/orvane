<script setup lang="ts">
import CustomSelect from "../CustomSelect.vue";
import type { SelectOption } from "./types";
defineProps<{
  modelValue: string;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}>();
defineEmits<{ "update:modelValue": [value: string] }>();
</script>
<template>
  <CustomSelect
    :model-value="modelValue"
    :options="options"
    :placeholder="placeholder"
    :disabled="disabled"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>
