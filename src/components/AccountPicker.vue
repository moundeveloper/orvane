<script setup lang="ts">
// The composer's Account pill for a NEW Claude chat (approved mock
// "Account pill"): a listbox of the Claude accounts with each one's sign-in,
// 5-hour usage and folder. Picking changes only this draft; open chats keep
// their account. Keys work only inside the open list, never in text fields.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import {
  accountAction,
  accountById,
  accountDetail,
  accountReady,
  activeAccounts,
  claudeAccounts,
  CLAUDE_ACCOUNTS_EVENT,
  CLAUDE_LOGIN_EVENT,
  loadAccounts,
  shortFolder,
  type ClaudeAccount,
  type ClaudeLoginDetail,
} from "../claudeAccounts";

const props = defineProps<{ modelValue: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [id: string]; picked: [name: string] }>();
const trigger = ref<HTMLButtonElement>();
const list = ref<HTMLElement>();
const open = ref(false);
const active = ref(0);
const error = ref("");
const position = ref<Record<string, string>>({});
const id = `accounts-${crypto.randomUUID()}`;
const accounts = computed(() => activeAccounts());
const chosen = computed(() => accountById(props.modelValue));
const editable = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");

function place() {
  const el = trigger.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  // Outside the canvas: zoom by the trigger's on-screen scale, like CustomSelect.
  const scale = r.width / (el.offsetWidth || r.width) || 1;
  const width = 440;
  const left = Math.max(8, Math.min(r.left, innerWidth - 8 - width * scale));
  position.value = {
    left: left / scale + "px",
    bottom: (innerHeight - r.top) / scale + 8 + "px",
    width: width + "px",
    zoom: String(scale),
  };
}
function setActive(index: number, focus: boolean) {
  active.value = index;
  if (focus) void nextTick(() => list.value?.querySelectorAll<HTMLElement>("[role=option]")[index]?.focus({ preventScroll: true }));
}
function show(viaKey: boolean) {
  if (props.disabled) return;
  if (open.value) return close();
  error.value = "";
  place();
  open.value = true;
  void loadAccounts();
  const at = Math.max(0, accounts.value.findIndex((a) => a.id === props.modelValue));
  setActive(at, viaKey);
  if (!viaKey) void nextTick(() => list.value?.focus({ preventScroll: true }));
}
function close(refocus = false) {
  open.value = false;
  if (refocus) trigger.value?.focus({ preventScroll: true });
}
function pick(account: ClaudeAccount | undefined) {
  if (!account || !accountReady(account)) return;
  emit("update:modelValue", account.id);
  emit("picked", account.name);
  close(true);
}
async function signIn(account: ClaudeAccount) {
  error.value = "";
  try {
    const { ticket, name } = await accountAction<{ ticket: string; name: string }>("claude-profile-login", { id: account.id });
    window.dispatchEvent(new CustomEvent<ClaudeLoginDetail>(CLAUDE_LOGIN_EVENT, { detail: { ticket, name } }));
    void loadAccounts();
    close();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "The sign-in could not start.";
  }
}
function addAccount() {
  close();
  // Bubbles from the pill to the Agent sessions app it sits in, which opens Settings.
  trigger.value?.dispatchEvent(new CustomEvent(CLAUDE_ACCOUNTS_EVENT, { bubbles: true }));
}
function triggerKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    show(true);
  }
}
function listKey(event: KeyboardEvent) {
  if (editable(event.target)) return;
  const count = accounts.value.length;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") close();
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count) setActive((active.value + (event.key === "ArrowDown" ? 1 : -1) + count) % count, true);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    if (count) setActive(event.key === "Home" ? 0 : count - 1, true);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    pick(accounts.value[active.value]);
  } else if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    pick(accounts.value[Number(event.key) - 1]);
  }
}
// Outside presses close without stealing focus or the click (embedded Browser
// pages report theirs through orvane:guest-pointer-down).
function outside(event: Event) {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && (trigger.value?.contains(target) || list.value?.contains(target))) return;
  close();
}
function dismiss() {
  close();
}
function wheel(event: Event) {
  if (!(event.target instanceof Node && list.value?.contains(event.target))) close();
}
watch(() => props.disabled, (now) => now && close());
onMounted(() => {
  void loadAccounts();
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
const fiveHour = (account: ClaudeAccount) => account.usage?.fiveHour?.used;
defineExpose({ open: () => show(true), close });
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="select-trigger cs-model ap-trigger"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? id : undefined"
    :disabled="disabled"
    title="Claude account for this new chat"
    @click="show($event.detail === 0)"
    @keydown="triggerKey"
  >
    <span class="ap-label"
      ><i class="ap-dot" :style="{ background: chosen?.color ?? '#8296a2' }" />Account
      <b>{{ chosen?.name ?? (claudeAccounts.loaded ? "Choose" : "…") }}</b></span
    ><Icon name="down" :size="12" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="id"
      ref="list"
      class="select-popover ap-pop"
      role="listbox"
      aria-label="Claude account for this chat"
      tabindex="-1"
      :style="position"
      @keydown="listKey"
    >
      <header>Claude account for this chat<span>new chats only</span></header>
      <div class="ap-list">
        <button
          v-for="(account, index) in accounts"
          :key="account.id"
          type="button"
          role="option"
          tabindex="-1"
          class="ap-opt"
          :class="{ active: index === active, off: !accountReady(account) }"
          :aria-selected="account.id === modelValue"
          :aria-disabled="!accountReady(account)"
          @mouseenter="setActive(index, false)"
          @click="pick(account)"
        >
          <i class="ap-dot" :style="{ background: account.color }" />
          <span class="ap-name"><b>{{ account.name }}</b><small>{{ accountDetail(account) }}</small></span>
          <span v-if="accountReady(account)" class="ap-use" :class="{ warn: (fiveHour(account) ?? 0) >= 75 }">
            <span>5-hour <em>{{ fiveHour(account) === undefined ? "–" : `${fiveHour(account)}%` }}</em></span>
            <span class="ap-meter"><i :style="{ width: `${fiveHour(account) ?? 0}%` }" /></span>
          </span>
          <span v-else-if="!account.signingIn" class="ap-signin" role="presentation" @click.stop="signIn(account)"
            ><Icon name="terminal" :size="12" />Sign in</span
          >
          <span v-else class="ap-signin muted">Signing in…</span>
          <kbd v-if="index < 9">{{ index + 1 }}</kbd>
          <span class="ap-path"
            >{{ shortFolder(account.folder) }}<template v-if="account.running"> · {{ account.running }} running</template></span
          >
        </button>
        <button type="button" class="ap-add" tabindex="-1" @click="addAccount">
          <Icon name="plus" :size="14" />Add a Claude account<span>Settings</span>
        </button>
      </div>
      <p v-if="error || claudeAccounts.error" class="ap-error" role="alert">{{ error || claudeAccounts.error }}</p>
      <footer>
        <span>Only this new chat. Open chats keep their account.</span><kbd>↑</kbd><kbd>↓</kbd><kbd>Enter</kbd><kbd>Esc</kbd>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.ap-trigger {
  max-width: 220px !important;
}
.ap-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: #5d7381;
}
.ap-label b {
  overflow: hidden;
  color: #273f50;
  font-weight: 550;
  text-overflow: ellipsis;
}
.ap-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ap-pop {
  position: fixed;
  top: auto;
  padding: 0;
  overflow: hidden;
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
  color: #455968;
  font-size: 13px;
  animation: ap-in 150ms ease-out;
}
@keyframes ap-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}
.ap-pop header {
  display: flex;
  align-items: center;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid #e3eaee;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.ap-pop header span {
  margin-left: auto;
  color: #8296a2;
  font: 400 11px "Cascadia Code", Consolas, monospace;
  letter-spacing: 0;
  text-transform: none;
}
.ap-list {
  max-height: 320px;
  overflow: auto;
  padding: 5px;
}
.ap-opt {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) 112px 18px;
  align-items: center;
  gap: 4px 10px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ap-opt.active:not([aria-selected="true"]) {
  background: #eef3f6;
}
.ap-opt[aria-selected="true"] {
  background: #e4edf2;
}
.ap-opt:focus-visible {
  outline: 2px solid #7b97a7;
  outline-offset: -2px;
}
.ap-opt.off {
  cursor: default;
}
.ap-opt .ap-dot {
  justify-self: center;
  width: 8px;
  height: 8px;
}
.ap-name {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}
.ap-name b {
  flex: none;
  color: #273f50;
  font-weight: 550;
}
.ap-opt.off .ap-name b {
  color: #5d7381;
}
.ap-name small {
  overflow: hidden;
  color: #8296a2;
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ap-path {
  grid-column: 2;
  overflow: hidden;
  color: #8296a2;
  font: 11px "Cascadia Code", Consolas, monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ap-opt kbd {
  grid-row: 1 / 3;
  grid-column: 4;
}
.ap-use,
.ap-signin {
  grid-row: 1 / 3;
  grid-column: 3;
}
.ap-use {
  display: grid;
  gap: 3px;
}
.ap-use > span:first-child {
  display: flex;
  justify-content: space-between;
  color: #8296a2;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.ap-use em {
  color: #5d7381;
  font-style: normal;
}
.ap-meter {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: #e3eaee;
}
.ap-meter i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: #6f8998;
}
.ap-use.warn em {
  color: #8a6a33;
}
.ap-use.warn .ap-meter i {
  background: #b08a4a;
}
.ap-signin {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  color: #385d76;
  font-size: 11.5px;
  cursor: pointer;
}
.ap-signin.muted {
  border-color: transparent;
  color: #8296a2;
  cursor: default;
}
.ap-add {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #5d7381;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ap-add:hover {
  background: #eef3f6;
}
.ap-add :deep(svg) {
  color: #6f8998;
}
.ap-add span {
  margin-left: auto;
  color: #8296a2;
  font-size: 11px;
}
.ap-error {
  margin: 0 12px 6px;
  color: #a0624f;
  font-size: 11.5px;
}
.ap-pop footer {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 12px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
.ap-pop footer span {
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
  .ap-pop {
    animation: none;
  }
}
</style>
