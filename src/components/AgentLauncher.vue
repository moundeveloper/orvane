<script setup lang="ts">
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { agentNames, type AgentProvider, type AgentRun } from "../agentSessions";
import { agentRequest } from "../exposition";
import type { CanvasApp } from "../model";
import { harness } from "../agentHarness";
import CustomSelect from "./CustomSelect.vue";
import Icon from "./Icon.vue";
import SessionChat from "./SessionChat.vue";
import type { AgentDraft } from "../agentNavigation";
import SessionList from "./SessionList.vue";
import type { AgentSession } from "../exposition";

const props = defineProps<{
  apps: CanvasApp[];
  anchor?: HTMLElement;
  popovers?: HTMLElement;
}>();
const emit = defineEmits<{
  close: [];
  /** Dock this session's chat on the right side of the window. */
  pin: [key: string];
  "pin-draft": [draft: AgentDraft];
  /** Open this session in an Agent sessions app. */
  open: [key: string];
  /** A task started here: Agent sessions follows its live run. */
  started: [run: AgentRun];
}>();
/** New task starts a session; Sessions picks one and chats with it here. */
const mode = ref<"new" | "sessions">("new");
/** The highlighted session; its chat shows under the list. */
const chosen = ref<AgentSession | null>(null);
const sessionCount = ref(0);
const list = ref<{ key(event: KeyboardEvent): void; focusRows(): void }>();
/** The session list folded away (remembered), so the chat gets the room. */
const LIST_KEY = "orvane.agent-launcher.list-collapsed";
const listCollapsed = ref((() => {
  try {
    return localStorage.getItem(LIST_KEY) === "1";
  } catch {
    return false;
  }
})());
watch(listCollapsed, (value) => {
  try {
    localStorage.setItem(LIST_KEY, value ? "1" : "0");
  } catch {
    /* only a convenience */
  }
});
const searchField = () => panel.value?.querySelector<HTMLInputElement>(".session-search input");
const chat = ref<{ focus(): void }>();
/** Agent sessions loads on demand: focus its composer once it is there
 * (unless the user has moved on: another tab, or typing in another field). */
let focusWatch: MutationObserver | undefined;
/** The dock's height (folder card, pictures, composer): the New task box
 * follows it as the draft grows. */
const composeHeight = ref(190);
let composeWatch: MutationObserver | undefined;
let composeSize: ResizeObserver | undefined;
let measured: Element | null = null;
function watchCompose() {
  const root = panel.value;
  if (!root || composeWatch) return;
  const follow = () => {
    const compose = root.querySelector(".launcher-new .cs-compose");
    if (compose === measured) return;
    composeSize?.disconnect();
    measured = compose;
    if (!compose) return;
    composeSize = new ResizeObserver(() => {
      const height = (compose as HTMLElement).offsetHeight;
      if (height) composeHeight.value = height;
    });
    composeSize.observe(compose);
  };
  composeWatch = new MutationObserver(follow);
  composeWatch.observe(root, { childList: true, subtree: true });
  follow();
}
function focusNew() {
  focusWatch?.disconnect();
  const root = panel.value;
  if (!root) return;
  const attempt = () => {
    if (mode.value !== "new") return true;
    const field = root.querySelector<HTMLTextAreaElement>('.launcher-new textarea[aria-label="Message"]');
    if (!field) return false;
    const active = document.activeElement;
    const typingElsewhere = active instanceof HTMLElement && !root.contains(active)
      && (active.isContentEditable || active.matches("input, textarea, select, iframe, webview"));
    if (!typingElsewhere) field.focus({ preventScroll: true });
    return true;
  };
  if (attempt()) return;
  focusWatch = new MutationObserver(() => {
    if (attempt()) focusWatch?.disconnect();
  });
  focusWatch.observe(root, { childList: true, subtree: true });
}
watch(mode, async (value) => {
  await nextTick();
  if (value === "sessions") searchField()?.focus({ preventScroll: true });
  if (value === "new") focusNew();
});
/** Enter or a click: go to the session's composer. */
async function openChosen(session: AgentSession) {
  chosen.value = session;
  await nextTick();
  chat.value?.focus();
}
/** ↑ ↓ Enter reach the list from anywhere in the launcher but a text field. */
function sessionsKey(event: KeyboardEvent) {
  if (mode.value !== "sessions" || event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("textarea, input, button:not(.session-row)")) return;
  if (target?.closest(".session-list")) return;
  list.value?.key(event);
}
/** Ctrl+Shift+J pins the draft (New task) or the chat shown (Sessions). */
function pinChosen() {
  if (mode.value === "new") {
    const value = latest.value ?? newDraft.value;
    if (!value) return false;
    emit("pin-draft", value);
    latest.value = { ...value, text: "" };
    return true;
  }
  if (mode.value !== "sessions" || !chosen.value) return false;
  emit("pin", chosen.value.key);
  return true;
}
defineExpose({ pinChosen });
/** Esc in the chat's composer returns to the list. */
function leaveChat() {
  if (listCollapsed.value) searchField()?.focus({ preventScroll: true });
  else list.value?.focusRows();
}
const preferencesKey = "orvane.agent-launcher.v1";
type Preferences = {
  provider?: AgentProvider;
  models?: Partial<Record<AgentProvider, string>>;
  draft?: string;
};
function preferences(): Preferences {
  try {
    return JSON.parse(localStorage.getItem(preferencesKey) ?? "{}") || {};
  } catch {
    return {};
  }
}
const saved = preferences();
const provider = ref<AgentProvider>(
  saved.provider === "claude" ? "claude" : "codex",
);
const models = ref(saved.models ?? {});
const surveying = ref("");
const error = ref("");
const panel = ref<HTMLElement>();
/** The draft handed to the composer (on open and on a provider switch);
 * `latest` follows what the composer holds now. */
const newDraft = ref<AgentDraft | null>(null);
const latest = ref<AgentDraft | null>(null);
const previous =
  document.activeElement instanceof HTMLElement ? document.activeElement : null;
let restoreFocus = false;
const providerOptions = Object.entries(agentNames).map(([value, label]) => ({
  value,
  label,
}));
function draftFor(kind: AgentProvider, text: string, folder: string, paths: string[] = []): AgentDraft {
  return {
    provider: kind,
    folder,
    text,
    paths,
    model: models.value[kind] ?? "",
    // The default edit mode from Agent sessions → Settings.
    mode: harness.settings.defaultModes?.[kind] ?? "",
    effort: "",
  };
}
/** Another provider keeps the text, folder and attachments. */
function chooseProvider(value: string) {
  const kind: AgentProvider = value === "claude" ? "claude" : "codex";
  if (kind === provider.value) return;
  const now = latest.value ?? newDraft.value;
  provider.value = kind;
  newDraft.value = draftFor(kind, now?.text ?? "", now?.folder || surveying.value, now?.paths ?? []);
  latest.value = null;
  void nextTick(focusNew);
}
/** Sent: as soon as the draft's run starts, Agent sessions takes it over and
 * shows it working (steps, the DNA loader). The session key comes later,
 * once the CLI has written the session; it is the fallback. */
let handedOver = false;
async function handOver(runId: string) {
  if (handedOver) return;
  handedOver = true;
  if (latest.value) latest.value = { ...latest.value, text: "", runId: undefined };
  const run = await agentRequest<AgentRun | null>("inspect-run", { id: runId }).catch(() => null);
  if (run) emit("started", run);
  else handedOver = false;
}
function trackDraft(value: AgentDraft) {
  latest.value = value;
  if (value.model !== undefined) models.value[value.provider] = value.model;
  if (value.runId && mode.value === "new") void handOver(value.runId);
}
function started(key: string) {
  if (mode.value !== "new" || handedOver) return;
  handedOver = true;
  if (latest.value) latest.value = { ...latest.value, text: "" };
  emit("open", key);
}
function showError(cause: unknown) {
  error.value =
    cause instanceof Error ? cause.message : "Could not prepare the task.";
}
function storePreferences() {
  const now = latest.value ?? newDraft.value;
  localStorage.setItem(
    preferencesKey,
    JSON.stringify({
      provider: provider.value,
      models: models.value,
      draft: now ? now.text : saved.draft ?? "",
    }),
  );
}
function close() {
  restoreFocus = true;
  emit("close");
}
function dismiss() {
  emit("close");
}
function dismissOnFrameFocus() {
  if (document.activeElement instanceof HTMLIFrameElement) dismiss();
}
function outside(event: PointerEvent) {
  if (event.button !== 0) return;
  const path = event.composedPath();
  if (
    [panel.value, props.popovers, props.anchor].some(
      (element) => element && path.includes(element),
    )
  )
    return;
  // The composer's menus (model, effort, account) and picture peek are
  // teleported to the body: they still belong to the launcher.
  if (path.some((node) => node instanceof Element && node.matches(".select-popover, .image-peek")))
    return;
  dismiss();
}
onMounted(async () => {
  watchCompose();
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("orvane:guest-pointer-down", dismiss);
  window.addEventListener("blur", dismissOnFrameFocus);
  try {
    surveying.value = (
      await agentRequest<{ surveying: string }>("launcher")
    ).surveying;
    newDraft.value = draftFor(provider.value, saved.draft ?? "", surveying.value);
    await nextTick();
    focusNew();
  } catch (cause) {
    showError(cause);
  }
});
onBeforeUnmount(() => {
  focusWatch?.disconnect();
  composeWatch?.disconnect();
  composeSize?.disconnect();
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("orvane:guest-pointer-down", dismiss);
  window.removeEventListener("blur", dismissOnFrameFocus);
  storePreferences();
  if (restoreFocus && previous?.isConnected)
    previous.focus({ preventScroll: true });
});
</script>

<template>
  <section
    ref="panel"
    id="agent-launcher"
    class="agent-launcher floating-panel workspace-frost"
    role="dialog"
    tabindex="-1"
    aria-label="AI launcher"
    @keydown.esc.stop.prevent="close"
  >
    <header>
      <Icon name="ai" :size="16" />
      <div class="launcher-tabs" role="tablist" aria-label="AI launcher">
        <button type="button" role="tab" :aria-selected="mode === 'new'" @click="mode = 'new'">New task</button>
        <button type="button" role="tab" :aria-selected="mode === 'sessions'" @click="mode = 'sessions'">Sessions{{ sessionCount ? ` · ${sessionCount}` : "" }}</button>
      </div>
      <span class="launcher-space"></span>
      <template v-if="mode === 'new'">
        <CustomSelect
          class="launcher-provider"
          :model-value="provider"
          aria-label="Provider"
          :options="providerOptions"
          trigger-icon="bot"
          :teleport-to="popovers"
          @update:model-value="chooseProvider"
        />
        <button type="button" class="launcher-icon" aria-label="Pin new session"
          data-tip="Pin new session · Ctrl+Shift+J" :disabled="!newDraft" @click="pinChosen()">
          <Icon name="pin" :size="15" />
        </button>
      </template>
      <template v-if="mode === 'sessions'">
        <button type="button" class="launcher-icon" aria-label="Pin to side" data-tip="Pin to side · Ctrl+Shift+J" :disabled="!chosen" @click="chosen && emit('pin', chosen.key)">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 2.5 13.5 6l-2.5 1-2.5 3 .5 2.5L4 7.5 6.5 8l3-2.5z" /><path d="M5.5 10.5 2.5 13.5" /></svg>
        </button>
        <button type="button" class="launcher-icon" aria-label="Open in Agent sessions" data-tip="Open in Agent sessions" :disabled="!chosen" @click="chosen && emit('open', chosen.key)">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" /></svg>
        </button>
      </template>
      <button
        type="button"
        aria-label="Close AI launcher"
        @click="close"
      >
        <Icon name="close" :size="15" />
      </button>
    </header>
    <div v-show="mode === 'sessions'" class="launcher-sessions" @keydown="sessionsKey">
      <SessionList
        ref="list"
        class="launcher-list"
        :collapsed="listCollapsed"
        @select="chosen = $event"
        @pick="openChosen"
        @count="sessionCount = $event"
        @expand="listCollapsed = false"
      >
        <template #actions>
          <button
            type="button"
            class="launcher-icon launcher-fold"
            :class="{ folded: listCollapsed }"
            :aria-expanded="!listCollapsed"
            :aria-label="listCollapsed ? 'Show sessions' : 'Hide sessions'"
            :data-tip="listCollapsed ? 'Show sessions' : 'Hide sessions'"
            @click="listCollapsed = !listCollapsed"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" /></svg>
          </button>
        </template>
      </SessionList>
      <SessionChat v-if="mode === 'sessions' && chosen" ref="chat" class="launcher-chat" :session-key="chosen.key" place="launcher" @leave="leaveChat" />
      <footer class="launcher-keys">
        <kbd>↑</kbd><kbd>↓</kbd> session <kbd>Enter</kbd> open <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>J</kbd> pin
        <span class="launcher-space"></span><kbd>Esc</kbd> close
      </footer>
    </div>
    <!-- New task is the Agent sessions composer itself (a draft pane): the same
         round Send, picture paste, slash menu and mode pills as every chat box. -->
    <div v-if="mode === 'new'" class="launcher-new">
      <SessionChat
        v-if="newDraft"
        class="launcher-new-chat"
        :style="{ height: `${composeHeight}px` }"
        session-key=""
        :initial-draft="newDraft"
        place="launcher-new"
        @leave="panel?.focus({ preventScroll: true })"
        @draft-state="trackDraft"
        @session-key="started"
      />
      <p v-else-if="error" class="agent-error" role="alert">{{ error }}</p>
      <p v-else class="launcher-preparing" role="status">Preparing Surveying…</p>
      <footer class="launcher-keys">
        <kbd>Enter</kbd> start <kbd>Ctrl</kbd><kbd>V</kbd> paste picture <kbd>/</kbd> skills <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>J</kbd> pin
        <span class="launcher-space"></span><kbd>Esc</kbd> close
      </footer>
    </div>
  </section>
</template>

<style scoped>
.agent-launcher.floating-panel {
  --agent-launcher-bottom: calc(var(--dock-bottom) + var(--dock-height) + 10px);
  position: fixed;
  z-index: 210;
  inset: auto 0 var(--agent-launcher-bottom);
  margin-inline: auto;
  padding: 0;
  width: min(650px, calc(100vw - 32px));
  max-height: min(78dvh, calc(100dvh - var(--agent-launcher-bottom) - 54px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  color: #455968;
  border: 1px solid #ffffffde;
  border-radius: 15px;
  box-shadow:
    0 26px 56px #263f5530,
    0 5px 15px #263f551a;
}
.agent-launcher:focus {
  outline: none;
}
.agent-launcher-enter-active {
  transition:
    opacity 170ms ease-out,
    transform 170ms ease-out;
}
.agent-launcher-leave-active {
  pointer-events: none;
  transition:
    opacity 135ms ease-in,
    transform 135ms ease-in;
}
.agent-launcher-enter-from,
.agent-launcher-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
header {
  padding: 9px 13px;
  border-bottom: 1px solid #e1e8ec;
  font-size: 13px;
}
.launcher-space {
  flex: 1;
}
.launcher-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: #e8eff3;
}
.launcher-tabs button {
  border: 0;
  height: 24px;
  padding: 0 10px;
  border-radius: 5px;
  color: #5d7381;
  font-size: 12px;
}
.launcher-tabs button[aria-selected="true"] {
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5512;
  color: #273f50;
}
/* The provider sits in the header: the composer below has the model, effort
   and edit mode, exactly as in Agent sessions. */
header :deep(.launcher-provider) {
  flex: none;
  width: auto;
  height: 26px;
  padding: 0 9px;
  gap: 8px;
  border-radius: 7px;
  font-size: 12px;
}
.launcher-sessions {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: min(600px, 70dvh);
}
.launcher-list {
  flex: none;
  max-height: 42%;
}
.launcher-list .launcher-icon {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: #6f8998;
}
.launcher-list .launcher-icon:hover {
  background: #e4edf2;
}
/* The chevron turns over when the list folds. */
.launcher-fold svg {
  transition: transform 160ms ease-out;
}
.launcher-fold.folded svg {
  transform: rotate(180deg);
}
.launcher-chat {
  flex: 1;
  margin-top: 4px;
  border-top: 1px solid #e3eaee;
}
/* New task: only the Agent sessions dock (folder card and composer). The
   launcher header already names the task, so the chat's own header and the
   empty conversation stay out. Agent sessions keeps its own layout (tiles,
   the dock pinned to the bottom); the box is as tall as the dock measures. */
.launcher-new {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden auto;
}
.launcher-new-chat {
  flex: none;
  min-height: 0;
}
.launcher-new-chat :deep(.agent-sessions-app) {
  background: transparent;
}
.launcher-new-chat :deep(.cs-session-header),
.launcher-new-chat :deep(.cs-chat) {
  display: none;
}
.launcher-new-chat :deep(.cs-compose) {
  padding: 12px 12px 10px;
}
.launcher-new-chat :deep(.cs-dock) {
  max-height: min(52dvh, 440px);
}
.launcher-preparing,
.agent-error {
  margin: 0;
  padding: 18px 14px;
  font-size: 12px;
  color: #5d7381;
}
.agent-error {
  color: #80432c;
}
/* Switching tabs fades the new one in. */
.launcher-sessions,
.launcher-new {
  animation: launcher-tab-in 150ms ease-out;
}
@keyframes launcher-tab-in {
  from {
    opacity: 0;
  }
}
header .launcher-icon {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  color: #6f8998;
}
header .launcher-icon:hover:not(:disabled) {
  background: #eef3f6;
}
.launcher-icon svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.launcher-keys {
  flex: none;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11.5px;
}
.launcher-keys kbd {
  display: inline-grid;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  place-items: center;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  color: #5d7381;
  font: 10.5px/1 "Cascadia Code", Consolas, monospace;
}
header > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid #d5e0e5;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
}
header > button:hover {
  background: #e5edf2;
}
header button:disabled {
  opacity: 0.5;
}
header button:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .agent-launcher-enter-active,
  .agent-launcher-leave-active,
  .launcher-fold svg {
    transition: none;
  }
  .launcher-sessions,
  .launcher-new {
    animation: none;
  }
}
</style>
