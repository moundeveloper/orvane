<script setup lang="ts">
// Orvane's date picker (YYYY-MM-DD): a month of days, with the month name
// opening a quick month/year grid. Today and Clear in the footer.
import { computed, ref, useAttrs } from "vue";
import Icon from "../Icon.vue";
import MonthYearGrid from "./MonthYearGrid.vue";
import { usePopover } from "./usePopover";
import { dayKey, monthDays, monthName, parseDay, weekdayLabels } from "../../calendar";

defineOptions({ inheritAttrs: false });
const props = defineProps<{ modelValue?: string; placeholder?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string]; change: [value: string] }>();
const attrs = useAttrs();
const trigger = ref<HTMLButtonElement>();
const popover = ref<HTMLDivElement>();
const { open, style, show, close } = usePopover(trigger, popover, 300);

const valid = computed(() => /^\d{4}-\d{2}-\d{2}$/.test(props.modelValue || ""));
const label = computed(() =>
  valid.value
    ? parseDay(props.modelValue!).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : props.placeholder || "Choose a date",
);
const shown = ref(new Date());
const choosingMonth = ref(false);
const today = computed(() => dayKey(new Date()));
const days = computed(() => monthDays(shown.value));
function toggle() {
  const at = valid.value ? parseDay(props.modelValue!) : new Date();
  shown.value = new Date(at.getFullYear(), at.getMonth(), 1);
  choosingMonth.value = false;
  show();
}
function shift(by: number) {
  shown.value = new Date(shown.value.getFullYear(), shown.value.getMonth() + by, 1);
}
function pick(key: string) {
  emit("update:modelValue", key);
  emit("change", key);
  close(true);
}
function pickMonth(year: number, month: number) {
  shown.value = new Date(year, month, 1);
  choosingMonth.value = false;
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    if (choosingMonth.value) choosingMonth.value = false;
    else close(true);
  }
}
</script>

<template>
  <button
    ref="trigger"
    v-bind="attrs"
    type="button"
    class="picker-trigger"
    :class="{ empty: !valid }"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click.stop="toggle"
  >
    <Icon name="calendar" :size="12" /><span>{{ label }}</span>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      class="select-popover picker-popover picker-date"
      role="dialog"
      :aria-label="String(attrs['aria-label'] || 'Choose a date')"
      tabindex="-1"
      :style="style"
      @pointerdown.stop
      @keydown.stop="key"
      @wheel.stop
    >
      <MonthYearGrid
        v-if="choosingMonth"
        :year="shown.getFullYear()"
        :month="shown.getMonth()"
        @pick="pickMonth"
      />
      <template v-else>
        <div class="picker-head">
          <button type="button" class="picker-nav" aria-label="Previous month" @click="shift(-1)">
            <Icon name="back" :size="13" />
          </button>
          <button
            type="button"
            class="picker-title picker-title-button"
            aria-label="Choose month and year"
            @click="choosingMonth = true"
          >
            {{ monthName(shown.getFullYear(), shown.getMonth()) }} {{ shown.getFullYear() }}
            <Icon name="down" :size="11" />
          </button>
          <button type="button" class="picker-nav" aria-label="Next month" @click="shift(1)">
            <Icon name="forward" :size="13" />
          </button>
        </div>
        <div class="picker-days">
          <span v-for="(d, i) in weekdayLabels" :key="i" class="picker-weekday" aria-hidden="true">{{ d }}</span>
          <button
            v-for="d in days"
            :key="d.key"
            type="button"
            class="picker-day"
            :class="{ outside: d.outside, today: d.key === today, selected: d.key === modelValue }"
            :aria-pressed="d.key === modelValue"
            :aria-label="parseDay(d.key).toLocaleDateString(undefined, { dateStyle: 'full' })"
            @click="pick(d.key)"
          >
            {{ d.date }}
          </button>
        </div>
      </template>
      <div class="picker-foot">
        <button
          type="button"
          @click="
            emit('update:modelValue', '');
            emit('change', '');
            close(true);
          "
        >
          Clear
        </button>
        <button type="button" @click="pick(today)">Today</button>
      </div>
    </div>
  </Teleport>
</template>
