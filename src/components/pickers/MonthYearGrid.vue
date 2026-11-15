<script setup lang="ts">
// Pick a month quickly: change the year with the arrows, click a month.
import { ref, watch } from "vue";
import Icon from "../Icon.vue";
import { monthName } from "../../calendar";

const props = defineProps<{ year: number; month: number }>();
const emit = defineEmits<{ pick: [year: number, month: number] }>();
const shownYear = ref(props.year);
watch(
  () => props.year,
  (year) => (shownYear.value = year),
);
const now = new Date();
</script>

<template>
  <div class="picker-months">
    <div class="picker-head">
      <button type="button" class="picker-nav" aria-label="Previous year" @click="shownYear--">
        <Icon name="back" :size="13" />
      </button>
      <span class="picker-title">{{ shownYear }}</span>
      <button type="button" class="picker-nav" aria-label="Next year" @click="shownYear++">
        <Icon name="forward" :size="13" />
      </button>
    </div>
    <div class="picker-month-grid">
      <button
        v-for="m in 12"
        :key="m"
        type="button"
        class="picker-month"
        :class="{
          selected: shownYear === year && m - 1 === month,
          current: shownYear === now.getFullYear() && m - 1 === now.getMonth(),
        }"
        :aria-pressed="shownYear === year && m - 1 === month"
        @click="emit('pick', shownYear, m - 1)"
      >
        {{ monthName(shownYear, m - 1, "short") }}
      </button>
    </div>
  </div>
</template>
