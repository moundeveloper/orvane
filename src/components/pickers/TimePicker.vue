<script setup lang="ts">
// Orvane's time picker (HH:MM, 24-hour): hour and minute columns in a
// popover. Clicking a minute (or Enter) finishes; Clear removes the time.
import { computed, nextTick, ref, useAttrs } from "vue";
import Icon from "../Icon.vue";
import { usePopover } from "./usePopover";

defineOptions({ inheritAttrs: false });
const props = defineProps<{ modelValue?: string; placeholder?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string]; change: [value: string] }>();
const attrs = useAttrs();
const trigger = ref<HTMLButtonElement>();
const popover = ref<HTMLDivElement>();
const { open, style, show, close } = usePopover(trigger, popover, 268);

const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
const parts = computed(() => {
  const [h, m] = (props.modelValue || "").split(":");
  return { h: h ?? "", m: m ?? "" };
});
// While open, the choice being made (committed on each click).
const hour = ref("");
const minute = ref("");
function set(value: string) {
  emit("update:modelValue", value);
  emit("change", value);
}
async function toggle() {
  hour.value = parts.value.h;
  minute.value = parts.value.m;
  show();
  if (!open.value) return;
  await nextTick();
  // Start at the current choice, or around now.
  const now = new Date();
  for (const [col, value] of [
    ["h", hour.value || String(now.getHours()).padStart(2, "0")],
    ["m", minute.value || "00"],
  ] as const)
    popover.value
      ?.querySelector<HTMLElement>(`[data-col="${col}"] [data-value="${value}"]`)
      ?.scrollIntoView({ block: "center" });
}
function pickHour(h: string) {
  hour.value = h;
  minute.value ||= "00";
  set(`${hour.value}:${minute.value}`);
}
function pickMinute(m: string) {
  minute.value = m;
  hour.value ||= String(new Date().getHours()).padStart(2, "0");
  set(`${hour.value}:${minute.value}`);
  close(true);
}
function clear() {
  hour.value = minute.value = "";
  set("");
  close(true);
}
function nowTime() {
  const now = new Date();
  set(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  close(true);
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape" || e.key === "Enter") {
    e.stopPropagation();
    e.preventDefault();
    close(true);
  }
}
</script>

<template>
  <button
    ref="trigger"
    v-bind="attrs"
    type="button"
    class="picker-trigger"
    :class="{ empty: !modelValue }"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click.stop="toggle"
    @keydown.down.prevent="!open && toggle()"
  >
    <Icon name="clock" :size="12" /><span>{{ modelValue || placeholder || "--:--" }}</span>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      class="select-popover picker-popover picker-time"
      role="dialog"
      :aria-label="String(attrs['aria-label'] || 'Choose a time')"
      tabindex="-1"
      :style="style"
      @pointerdown.stop
      @keydown.stop="key"
      @wheel.stop
    >
      <div class="picker-columns">
        <div class="picker-col" data-col="h" role="listbox" aria-label="Hour">
          <button
            v-for="h in hours"
            :key="h"
            type="button"
            role="option"
            :data-value="h"
            :aria-selected="hour === h"
            @click="pickHour(h)"
          >
            {{ h }}
          </button>
        </div>
        <div class="picker-col" data-col="m" role="listbox" aria-label="Minute">
          <button
            v-for="m in minutes"
            :key="m"
            type="button"
            role="option"
            :data-value="m"
            :aria-selected="minute === m"
            @click="pickMinute(m)"
          >
            {{ m }}
          </button>
        </div>
      </div>
      <div class="picker-foot">
        <button type="button" @click="clear">Clear</button>
        <button type="button" @click="nowTime">Now</button>
      </div>
    </div>
  </Teleport>
</template>
