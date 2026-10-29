<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

defineProps<{
  modelValue: string | null;
  fallback?: string;
  removable?: boolean;
  title?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string | null): void;
}>();

const open = ref(false);
const rootEl = ref<HTMLElement>();

const ICONS = [
  "📄",
  "📝",
  "📚",
  "💡",
  "ℹ️",
  "🎯",
  "✅",
  "⚠️",
  "📌",
  "🗂",
  "🧠",
  "🚀",
  "⭐",
  "🔥",
  "🌱",
  "🏠",
  "💼",
  "🧪",
  "🎨",
  "🎵",
  "❤️",
  "☕",
  "🛠",
  "📊",
  "🗓",
  "✈️",
];

function choose(icon: string | null) {
  emit("update:modelValue", icon);
  open.value = false;
}

function onPointerDown(e: PointerEvent) {
  if (rootEl.value?.contains(e.target as Node)) return;
  open.value = false;
}

onMounted(() => window.addEventListener("pointerdown", onPointerDown));
onBeforeUnmount(() => window.removeEventListener("pointerdown", onPointerDown));
</script>

<template>
  <span ref="rootEl" class="icon-picker">
    <button
      class="icon-trigger"
      :aria-label="title ?? 'Change icon'"
      @click.stop="open = !open"
    >
      <slot>
        <span v-if="modelValue || fallback" class="icon-value">{{
          modelValue ?? fallback
        }}</span>
        <span v-else class="icon-placeholder">＋ Add icon</span>
      </slot>
    </button>
    <div v-if="open" class="icon-popover">
      <button
        v-for="icon in ICONS"
        :key="icon"
        class="icon-option"
        :class="{ active: modelValue === icon }"
        @click="choose(icon)"
      >
        {{ icon }}
      </button>
      <button v-if="removable" class="icon-option remove" @click="choose(null)">
        ✕
      </button>
    </div>
  </span>
</template>

<style scoped>
.icon-picker {
  position: relative;
  display: inline-flex;
}
.icon-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
}
.icon-trigger:hover {
  background: var(--notes-bg-hover);
}
.icon-value {
  line-height: 1;
}
.icon-placeholder {
  color: var(--notes-text-faint);
  font-size: 13px;
}
.icon-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 1000;
  display: grid;
  grid-template-columns: repeat(8, 34px);
  gap: 2px;
  padding: 8px;
  background: var(--notes-bg-modal);
  border-radius: 8px;
  box-shadow: var(--notes-shadow);
}
.icon-option {
  width: 34px;
  height: 34px;
  border-radius: 4px;
  font-size: 20px;
  line-height: 1;
}
.icon-option:hover,
.icon-option.active {
  background: var(--notes-bg-hover);
}
.icon-option.remove {
  color: var(--notes-text-faint);
  font-size: 14px;
}
</style>
