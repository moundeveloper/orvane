<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { usePopover } from "./pickers/usePopover";
import { hostMode } from "../hostMode";

// Hover actions on a session message: Copy, and "…" for a searchable menu.
export type MessageAction = "copy" | "reuse" | "fork" | "notes" | "prompt";
const props = defineProps<{ canFork?: boolean; user?: boolean }>();
const emit = defineEmits<{ action: [action: MessageAction] }>();

const all = computed(() =>
  [
    { id: "copy" as const, label: "Copy as Markdown", icon: "copy" },
    { id: "reuse" as const, label: props.user ? "Send again" : "Quote in composer", icon: "text" },
    ...(props.canFork ? [{ id: "fork" as const, label: "Fork session", icon: "git" }] : []),
    // Notes live on the desktop canvas, not on the Orvane Host page.
    ...(hostMode ? [] : [{ id: "notes" as const, label: "Send to Notes", icon: "file" }]),
    { id: "prompt" as const, label: "Save as prompt", icon: "plus" },
  ],
);
const query = ref("");
const active = ref(0);
const items = computed(() =>
  all.value.filter((item) => item.label.toLowerCase().includes(query.value.trim().toLowerCase())),
);
const trigger = ref<HTMLButtonElement>();
const popover = ref<HTMLElement>();
const search = ref<HTMLInputElement>();
const { open, style, show, close } = usePopover(trigger, popover, 220);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

function run(action: MessageAction) {
  close(true);
  emit("action", action);
  if (action === "copy") {
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1200);
  }
}
function toggle() {
  query.value = "";
  active.value = 0;
  show();
  if (open.value) void nextTick(() => search.value?.focus({ preventScroll: true }));
}
function menuKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = items.value.length;
    if (count) active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
  } else if (event.key === "Enter") {
    event.preventDefault();
    const item = items.value[active.value];
    if (item) run(item.id);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }
}
const guestDown = () => open.value && close();
onMounted(() => window.addEventListener("orvane:guest-pointer-down", guestDown));
onBeforeUnmount(() => {
  window.removeEventListener("orvane:guest-pointer-down", guestDown);
  clearTimeout(copiedTimer);
});
</script>

<template>
  <span class="msg-actions" :class="{ pinned: open }">
    <button type="button" class="ma-btn" :aria-label="copied ? 'Copied' : 'Copy message'" :title="copied ? 'Copied' : 'Copy'" @click="run('copy')">
      <Icon :name="copied ? 'check' : 'copy'" :size="13" />
    </button>
    <button
      ref="trigger"
      type="button"
      class="ma-btn"
      aria-label="Message actions"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >
      <Icon name="more" :size="13" />
    </button>
  </span>
  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      class="select-popover ma-menu"
      role="menu"
      aria-label="Message actions"
      :style="style"
      @keydown="menuKey"
    >
      <input
        ref="search"
        v-model="query"
        class="ma-search"
        aria-label="Search actions"
        placeholder="Search actions…"
        @input="active = 0"
      />
      <button
        v-for="(item, index) in items"
        :key="item.id"
        type="button"
        role="menuitem"
        tabindex="-1"
        :class="{ on: index === active }"
        @pointerenter="active = index"
        @click="run(item.id)"
      >
        <Icon :name="item.icon" :size="13" /><span>{{ item.label }}</span>
      </button>
      <p v-if="!items.length" class="ma-empty">No matching action</p>
    </div>
  </Teleport>
</template>

<style scoped>
.msg-actions {
  display: inline-flex;
  gap: 1px;
  margin-left: 4px;
  opacity: 0;
  transition: opacity 120ms ease-out;
}
.msg-actions.pinned,
.msg-actions:focus-within {
  opacity: 1;
}
.ma-btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #6f8998;
  cursor: pointer;
}
.ma-btn:hover,
.ma-btn[aria-expanded="true"] {
  background: #e7eef2;
  color: #273f50;
}
.ma-btn:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
.ma-menu {
  position: fixed;
  z-index: 9000;
  display: grid;
  width: 15em;
  padding: 0.35em;
  font-size: 12px;
}
.ma-search {
  height: 2.3em;
  margin-bottom: 0.3em;
  padding: 0 0.6em;
  border: 0;
  border-bottom: 1px solid #e3eaee;
  background: transparent;
  color: #273f50;
  font: inherit;
  outline: none;
}
.ma-menu > button {
  display: grid;
  grid-template-columns: 1.2em minmax(0, 1fr);
  align-items: center;
  gap: 0.6em;
  height: 2.3em;
  padding: 0 0.6em;
  border: 0;
  border-radius: 0.45em;
  background: transparent;
  color: #455968;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ma-menu > button.on {
  background: #e7eef2;
  color: #273f50;
}
.ma-empty {
  margin: 0;
  padding: 0.6em;
  color: #8296a2;
}
@media (prefers-reduced-motion: reduce) {
  .msg-actions {
    transition: none;
  }
}
</style>
