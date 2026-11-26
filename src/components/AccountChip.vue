<script setup lang="ts">
// The locked account of an existing Claude chat (approved mock "Two at
// once"). The chat never moves: the menu explains the binding and starts a
// BLANK new chat on another account; nothing from this chat is copied.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import {
  accountById,
  accountLabel,
  accountReady,
  activeAccounts,
  CLAUDE_ACCOUNTS_EVENT,
  loadAccounts,
  shortFolder,
} from "../claudeAccounts";

const props = defineProps<{ profileId?: string }>();
const emit = defineEmits<{ "new-chat": [profileId: string] }>();
const chip = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const open = ref(false);
const active = ref(0);
const position = ref<Record<string, string>>({});
const account = computed(() => accountById(props.profileId));
const others = computed(() => activeAccounts().filter((a) => a.id !== (props.profileId ?? "default")));
/** Items in order: other accounts, then Claude accounts (Settings). */
const count = computed(() => others.value.length + 1);

function place() {
  const el = chip.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const scale = r.width / (el.offsetWidth || r.width) || 1;
  const width = 330;
  position.value = {
    left: Math.max(8, Math.min(r.right - width * scale, innerWidth - 8 - width * scale)) / scale + "px",
    top: (r.bottom + 6 * scale) / scale + "px",
    width: width + "px",
    zoom: String(scale),
  };
}
function focusItem(index: number) {
  void nextTick(() => menu.value?.querySelectorAll<HTMLElement>("[role=menuitem]")[index]?.focus({ preventScroll: true }));
}
function show(viaKey: boolean) {
  if (open.value) return close();
  place();
  open.value = true;
  void loadAccounts();
  active.value = 0;
  if (viaKey) focusItem(0);
  else void nextTick(() => menu.value?.focus({ preventScroll: true }));
}
function close(refocus = false) {
  open.value = false;
  if (refocus) chip.value?.focus({ preventScroll: true });
}
function run(index: number) {
  const other = others.value[index];
  if (other) {
    if (!accountReady(other)) return;
    close(true);
    emit("new-chat", other.id);
  } else if (index === others.value.length) {
    close();
    chip.value?.dispatchEvent(new CustomEvent(CLAUDE_ACCOUNTS_EVENT, { bubbles: true }));
  }
}
function menuKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") close();
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + count.value) % count.value;
    focusItem(active.value);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    run(active.value);
  } else if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && Number(event.key) <= others.value.length) {
    event.preventDefault();
    run(Number(event.key) - 1);
  }
}
function outside(event: Event) {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && (chip.value?.contains(target) || menu.value?.contains(target))) return;
  close();
}
function dismiss() {
  close();
}
function wheel(event: Event) {
  if (!(event.target instanceof Node && menu.value?.contains(event.target))) close();
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("orvane:guest-pointer-down", dismiss);
  window.addEventListener("resize", dismiss);
  window.addEventListener("wheel", wheel, { passive: true });
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("orvane:guest-pointer-down", dismiss);
  window.removeEventListener("resize", dismiss);
  window.removeEventListener("wheel", wheel);
});
</script>

<template>
  <button
    ref="chip"
    type="button"
    class="ac-chip"
    aria-haspopup="menu"
    :aria-expanded="open"
    :title="`Account of this chat: ${accountLabel(profileId)}`"
    @click="show($event.detail === 0)"
    @keydown.down.prevent="show(true)"
  >
    <i :style="{ background: account?.color ?? '#8296a2' }" />{{ accountLabel(profileId) }}{{ account?.removed ? " · removed" : "" }}<Icon name="lock" :size="11" />
  </button>
  <Teleport to="body">
    <div v-if="open" ref="menu" class="ac-menu select-popover" role="menu" aria-label="Account" tabindex="-1" :style="position" @keydown="menuKey">
      <div class="ac-head">
        <p><i :style="{ background: account?.color ?? '#8296a2' }" />{{ account && !account.removed ? `Runs on ${account.name}` : "Account removed" }}</p>
        <small v-if="account && !account.removed"
          >Resumes, queued messages, forks and checkpoints use <code>{{ shortFolder(account.folder) }}</code>. This chat stays on
          {{ account.name }}.</small
        >
        <small v-else>This chat stays readable. Start a new chat on another account.</small>
      </div>
      <p class="ac-sect">Start a new chat on</p>
      <div class="ac-list">
        <button
          v-for="(other, index) in others"
          :key="other.id"
          type="button"
          role="menuitem"
          tabindex="-1"
          class="ac-item"
          :class="{ active: index === active }"
          :aria-disabled="!accountReady(other)"
          @mouseenter="active = index"
          @click="run(index)"
        >
          <i :style="{ background: other.color }" />{{ other.name }}
          <small>{{
            !accountReady(other)
              ? other.signingIn ? "· signing in" : "· not signed in"
              : other.usage?.fiveHour ? `· 5h ${other.usage.fiveHour.used}%` : ""
          }}</small>
          <kbd v-if="index < 9">{{ index + 1 }}</kbd><span v-else />
        </button>
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="ac-item"
          :class="{ active: active === others.length }"
          @mouseenter="active = others.length"
          @click="run(others.length)"
        >
          <Icon name="settings" :size="14" />Claude accounts <small>Settings</small><span />
        </button>
      </div>
      <div class="ac-foot"><span>Blank chat; nothing from this one is copied</span><kbd>↑</kbd><kbd>↓</kbd><kbd>Esc</kbd></div>
    </div>
  </Teleport>
</template>

<style scoped>
.ac-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid #dbe5eb;
  border-radius: 7px;
  background: #fbfcfd;
  color: #273f50;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.ac-chip:hover {
  background: #eef3f6;
}
.ac-chip[aria-expanded="true"] {
  border-color: transparent;
  background: #e4edf2;
}
.ac-chip:focus-visible {
  outline: 2px solid #7b97a7;
  outline-offset: 1px;
}
.ac-chip i,
.ac-head i,
.ac-item i {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ac-chip :deep(svg) {
  color: #8296a2;
}
.ac-menu {
  position: fixed;
  padding: 0;
  overflow: hidden;
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
  color: #455968;
  font-size: 13px;
  animation: ac-in 150ms ease-out;
}
@keyframes ac-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}
.ac-head {
  padding: 10px 12px 9px;
  border-bottom: 1px solid #e3eaee;
}
.ac-head p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: #273f50;
  font-weight: 550;
}
.ac-head i {
  width: 8px;
  height: 8px;
}
.ac-head small {
  display: block;
  margin-top: 3px;
  color: #8296a2;
  font-size: 11.5px;
  line-height: 1.45;
}
.ac-head code {
  color: #5d7381;
  font: 11px "Cascadia Code", Consolas, monospace;
}
.ac-sect {
  margin: 8px 12px 2px;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.ac-list {
  padding: 2px 5px 5px;
}
.ac-item {
  display: grid;
  grid-template-columns: 16px auto 1fr auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #455968;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ac-item.active,
.ac-item:hover {
  background: #e4edf2;
}
.ac-item:focus-visible {
  outline: 2px solid #7b97a7;
  outline-offset: -2px;
}
.ac-item[aria-disabled="true"] {
  color: #8296a2;
  cursor: default;
}
.ac-item[aria-disabled="true"]:hover {
  background: none;
}
.ac-item i {
  justify-self: center;
  width: 8px;
  height: 8px;
}
.ac-item :deep(svg) {
  justify-self: center;
  color: #6f8998;
}
.ac-item small {
  color: #8296a2;
  font-size: 11px;
}
.ac-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
.ac-foot span {
  margin-right: auto;
}
kbd {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  color: #5d7381;
  font: 10.5px/1 "Cascadia Code", Consolas, monospace;
}
@media (prefers-reduced-motion: reduce) {
  .ac-menu {
    animation: none;
  }
}
</style>
