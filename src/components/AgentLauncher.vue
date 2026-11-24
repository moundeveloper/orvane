<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  agentNames,
  agentPermissions,
  type AgentProvider,
  type AgentRun,
} from "../agentSessions";
import { agentRequest } from "../exposition";
import { flatten, type CanvasApp } from "../model";
import { harness } from "../agentHarness";
import {
  api,
  baseName,
  DRAG_MIME,
  parentOf,
  type FileEntry,
  type Roots,
} from "./files/explorer";
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
  started: [run: AgentRun];
  starting: [active: boolean];
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
watch(mode, async (value) => {
  await nextTick();
  if (value === "sessions") searchField()?.focus({ preventScroll: true });
  if (value === "new") prompt.value?.focus({ preventScroll: true });
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
/** Ctrl+Shift+J while the Sessions tab shows a chat pins that chat. */
function pinChosen() {
  if (mode.value === "new") {
    if (busy.value || !surveying.value) return false;
    emit("pin-draft", { provider: provider.value, folder: folder.value || surveying.value,
      text: draft.value, paths: paths.value, model: model.value.trim() });
    draft.value = "";
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
  folders?: string[];
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
const recent = ref(saved.folders ?? []);
const draft = ref(saved.draft ?? "");
const surveying = ref("");
const folder = ref("");
const customFolder = ref("");
const directory = ref("");
const entries = ref<FileEntry[]>([]);
const browsing = ref(false);
const attaching = ref(false);
const paths = ref<string[]>([]);
const attachment = ref("");
const busy = ref(false);
const error = ref("");
const panel = ref<HTMLElement>();
const prompt = ref<HTMLTextAreaElement>();
const attachmentInput = ref<HTMLInputElement>();
const customModel = ref(false);
const modelCatalogues = ref<
  Partial<Record<AgentProvider, { value: string; label: string }[]>>
>({});
const previous =
  document.activeElement instanceof HTMLElement ? document.activeElement : null;
let browseSequence = 0;
let disposed = false;
let restoreFocus = false;
const model = computed({
  get: () => models.value[provider.value] ?? "",
  set: (value: string) => {
    models.value[provider.value] = value;
  },
});
const providerOptions = Object.entries(agentNames).map(([value, label]) => ({
  value,
  label,
}));
const modelOptions = computed(() => {
  const listed = modelCatalogues.value[provider.value];
  const options = listed?.length
    ? listed
    : provider.value === "claude"
      ? ["sonnet", "opus", "haiku", "fable"].map((value) => ({
          value,
          label: value[0]!.toUpperCase() + value.slice(1),
        }))
      : [];
  return [
    ...(options.some((option) => option.value === "")
      ? []
      : [{ value: "", label: "Provider default" }]),
    ...options,
    ...(model.value && !options.some((option) => option.value === model.value)
      ? [{ value: model.value, label: model.value }]
      : []),
    { value: "?", label: "Enter model ID…" },
  ];
});
function chooseModel(value: string) {
  customModel.value = value === "?";
  if (value !== "?") model.value = value;
}
const pinned = computed(() => {
  const folders = new Set<string>();
  for (const app of props.apps) {
    if (app.archived || app.deleted) continue;
    for (const block of flatten(app.blocks)) {
      if (block.kind !== "files") continue;
      try {
        const state = JSON.parse(block.value || "{}");
        for (const path of state.pins ?? [])
          if (typeof path === "string") folders.add(path);
        for (const pane of state.panes ?? [])
          if (typeof pane.path === "string") folders.add(pane.path);
      } catch {
        /* An empty explorer contributes no folders. */
      }
    }
  }
  return [...folders];
});
const folderOptions = computed(() => [
  { value: "", label: "Surveying", icon: "folder" },
  ...[...new Set([...recent.value, ...pinned.value, folder.value])]
    .filter((path) => path && path !== "?")
    .map((path) => ({
      value: path,
      label: baseName(path) || path,
      icon: "folder",
    })),
  { value: "?", label: "Choose a folder…", icon: "folder-open" },
]);
function chooseFolder(value: string) {
  if (value === "?") {
    browsing.value = true;
    customFolder.value = folder.value;
    void browse(folder.value || undefined);
  } else {
    folder.value = value;
    closeBrowse();
  }
}
function closeBrowse() {
  browsing.value = false;
  browseSequence++;
}
async function browse(path?: string) {
  const sequence = ++browseSequence;
  error.value = "";
  try {
    const target = path || (await api<Roots>("roots")).home;
    const data = await api<{ entries: FileEntry[] }>("list", { path: target });
    if (sequence !== browseSequence) return;
    directory.value = target;
    entries.value = data.entries.filter((entry) => entry.dir && !entry.hidden);
  } catch (cause) {
    if (sequence === browseSequence) showError(cause);
  }
}
function useFolder(path: string) {
  if (!path.trim()) return;
  folder.value = path.trim();
  closeBrowse();
}
function addPaths(items: string[]) {
  paths.value = [
    ...new Set([
      ...paths.value,
      ...items.map((path) => path.trim()).filter(Boolean),
    ]),
  ].slice(0, 20);
}
function drop(event: DragEvent) {
  const files = event.dataTransfer?.getData(DRAG_MIME);
  if (!files) return;
  try {
    const { paths: dropped } = JSON.parse(files);
    if (Array.isArray(dropped))
      addPaths(dropped.filter((path) => typeof path === "string"));
  } catch {
    /* Ignore drag data from other apps. */
  }
}
function showError(cause: unknown) {
  error.value =
    cause instanceof Error ? cause.message : "Could not start the task.";
}
function storePreferences() {
  localStorage.setItem(
    preferencesKey,
    JSON.stringify({
      provider: provider.value,
      models: models.value,
      folders: recent.value,
      draft: draft.value,
    }),
  );
}
async function start() {
  if (busy.value || !draft.value.trim() || !surveying.value) return;
  busy.value = true;
  emit("starting", true);
  error.value = "";
  try {
    const message = paths.value.length
      ? `${draft.value}\n\nLocal attachments:\n${paths.value.map((path) => JSON.stringify(path)).join("\n")}`
      : draft.value;
    const run = await agentRequest<AgentRun>("start", {
      message,
      target: {
        provider: provider.value,
        folder: folder.value || undefined,
        model: model.value.trim() || undefined,
        // The default edit mode from Agent sessions → Settings.
        ...(harness.settings.defaultModes?.[provider.value] ? { mode: harness.settings.defaultModes[provider.value] } : {}),
      },
    });
    if (folder.value)
      recent.value = [...new Set([folder.value, ...recent.value])].slice(0, 8);
    draft.value = "";
    if (!disposed) emit("started", run);
  } catch (cause) {
    if (!disposed) showError(cause);
  } finally {
    busy.value = false;
    emit("starting", false);
  }
}
function close() {
  if (busy.value) return;
  restoreFocus = true;
  emit("close");
}
function dismiss() {
  if (!busy.value) emit("close");
}
function dismissOnFrameFocus() {
  if (document.activeElement instanceof HTMLIFrameElement) dismiss();
}
function outside(event: PointerEvent) {
  if (event.button !== 0) return;
  const path = event.composedPath();
  if (
    ![panel.value, props.popovers, props.anchor].some(
      (element) => element && path.includes(element),
    )
  )
    dismiss();
}
async function toggleAttachments(open = !attaching.value) {
  attaching.value = open;
  if (open) {
    await nextTick();
    attachmentInput.value?.focus({ preventScroll: true });
  }
}
function promptKey(event: KeyboardEvent) {
  if (event.isComposing || busy.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    panel.value?.focus({ preventScroll: true });
  } else if (
    event.key === "@" &&
    /(?:^|\s)$/.test(draft.value.slice(0, prompt.value?.selectionStart ?? 0))
  ) {
    event.preventDefault();
    void toggleAttachments(true);
  } else if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    event.preventDefault();
    if (!event.repeat) void start();
  }
}
watch(
  provider,
  (kind) => {
    customModel.value = false;
    if (!modelCatalogues.value[kind]) {
      void agentRequest<{ models: { value: string; label: string }[] }>(
        "models",
        { provider: kind },
      )
        .then(({ models: listed }) => {
          modelCatalogues.value[kind] = listed;
        })
        .catch(() => {});
    }
  },
  { immediate: true },
);
onMounted(async () => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("orvane:guest-pointer-down", dismiss);
  window.addEventListener("blur", dismissOnFrameFocus);
  await nextTick();
  prompt.value?.focus({ preventScroll: true });
  try {
    surveying.value = (
      await agentRequest<{ surveying: string }>("launcher")
    ).surveying;
  } catch (cause) {
    showError(cause);
  }
});
onBeforeUnmount(() => {
  disposed = true;
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
    @dragover.prevent
    @drop.prevent="drop"
  >
    <header>
      <Icon name="ai" :size="16" />
      <div class="launcher-tabs" role="tablist" aria-label="AI launcher">
        <button type="button" role="tab" :aria-selected="mode === 'new'" @click="mode = 'new'">New task</button>
        <button type="button" role="tab" :aria-selected="mode === 'sessions'" @click="mode = 'sessions'">Sessions{{ sessionCount ? ` · ${sessionCount}` : "" }}</button>
      </div>
      <span class="launcher-space"></span>
      <button v-if="mode === 'new'" type="button" class="launcher-icon" aria-label="Pin new session"
        data-tip="Pin new session · Ctrl+Shift+J" :disabled="busy || !surveying" @click="pinChosen()">
        <Icon name="pin" :size="15" />
      </button>
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
        :disabled="busy"
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
    <form v-if="mode === 'new'" @submit.prevent="start">
      <div class="agent-composer">
        <textarea
          ref="prompt"
          v-model="draft"
          rows="2"
          maxlength="12000"
          aria-label="Task prompt"
          aria-keyshortcuts="Enter Shift+Enter Escape"
          placeholder="What should the agent work on?"
          :readonly="busy"
          @keydown="promptKey"
        />
        <div class="agent-context">
          <button
            type="button"
            class="attach-trigger"
            aria-label="Add context"
            :aria-expanded="attaching"
            :disabled="busy"
            @click="toggleAttachments()"
          >
            <Icon name="attachment" :size="13" />Add context <kbd>@</kbd>
          </button>
          <ul
            v-if="paths.length"
            class="attachments"
            aria-label="Local attachments"
          >
            <li v-for="path in paths" :key="path">
              <span :title="path">{{ baseName(path) }}</span>
              <button
                type="button"
                :disabled="busy"
                :aria-label="`Remove ${baseName(path)}`"
                @click="paths = paths.filter((item) => item !== path)"
              >
                <Icon name="close" :size="12" />
              </button>
            </li>
          </ul>
        </div>
        <div v-if="attaching" class="agent-row">
          <input
            ref="attachmentInput"
            v-model="attachment"
            aria-label="Attachment path"
            placeholder="Path to a local file or folder"
            :disabled="busy"
            @keydown.enter.prevent="
              addPaths([attachment]);
              attachment = '';
            "
          />
          <button
            type="button"
            :disabled="busy || !attachment.trim()"
            @click="
              addPaths([attachment]);
              attachment = '';
            "
          >
            Add path
          </button>
        </div>
        <div class="agent-controls">
          <CustomSelect
            v-model="provider"
            aria-label="Provider"
            :options="providerOptions"
            trigger-icon="bot"
            prefer-above
            :teleport-to="popovers"
            :disabled="busy"
          />
          <CustomSelect
            :model-value="model"
            aria-label="Model"
            :options="modelOptions"
            search-label="Find a model"
            trigger-icon="cpu"
            prefer-above
            :teleport-to="popovers"
            :disabled="busy"
            @update:model-value="chooseModel"
          />
          <CustomSelect
            :model-value="folder"
            aria-label="Working folder"
            :options="folderOptions"
            search-label="Find a folder"
            trigger-icon="folder"
            prefer-above
            :teleport-to="popovers"
            :disabled="busy"
            @update:model-value="chooseFolder"
          />
          <button
            class="agent-start"
            type="submit"
            aria-label="Start task"
            :title="busy ? 'Starting…' : 'Start task'"
            :disabled="busy || !draft.trim() || !surveying"
          >
            <Icon name="up" :size="16" />
          </button>
        </div>
        <input
          v-if="customModel"
          v-model="model"
          aria-label="Model ID"
          placeholder="Model ID"
          :disabled="busy"
        />
        <div v-if="browsing" class="agent-picker">
          <div class="agent-row">
            <input
              v-model="customFolder"
              aria-label="Folder path"
              placeholder="Absolute folder path"
              @keydown.enter.prevent="useFolder(customFolder)"
            />
            <button
              type="button"
              :disabled="!customFolder.trim()"
              @click="useFolder(customFolder)"
            >
              Use path
            </button>
          </div>
          <div v-if="directory" class="agent-row">
            <button
              type="button"
              :disabled="!parentOf(directory)"
              @click="browse(parentOf(directory) ?? undefined)"
            >
              Up
            </button>
            <span :title="directory">{{ directory }}</span>
            <button type="button" @click="useFolder(directory)">
              Use folder
            </button>
          </div>
          <div class="agent-folders">
            <button
              v-for="entry in entries"
              :key="entry.path"
              type="button"
              @click="browse(entry.path)"
            >
              <Icon name="folder" :size="14" />{{ entry.name }}
            </button>
          </div>
        </div>
      </div>
      <p v-if="error" class="agent-error" role="alert">{{ error }}</p>
      <footer>
        <div class="agent-destination">
          <span :title="folder || surveying">{{
            folder || surveying || "Preparing Surveying…"
          }}</span
          ><small>{{ agentPermissions[provider] }}</small>
        </div>
      </footer>
    </form>
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
.agent-launcher .agent-composer,
.agent-launcher .agent-composer:has(> textarea:focus) {
  background: transparent;
}
header,
footer,
.agent-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
header {
  padding: 9px 13px;
  border-bottom: 1px solid #e1e8ec;
  font-size: 13px;
}
header strong {
  flex: 1;
  font-weight: 600;
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
/* Switching tabs fades the new one in. */
.launcher-sessions,
form {
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
form {
  display: grid;
  gap: 10px;
  padding: 12px;
  overflow: auto;
}
input {
  width: 100%;
  min-width: 0;
  padding: 8px 9px;
  font: inherit;
  color: inherit;
  border: 1px solid #d4dfe6;
  border-radius: 7px;
  background: #fbfcfd;
}
.agent-composer > textarea {
  min-height: 61px;
  max-height: 30vh;
}
.agent-controls {
  display: grid;
  gap: 8px;
  align-items: center;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.2fr) minmax(0, 1fr) auto;
}
small {
  color: #526976;
}
.agent-controls :deep(.select-trigger) {
  width: 100%;
  min-width: 0;
  gap: 12px;
  min-height: 30px;
}
button {
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
button:hover {
  background: #e5edf2;
}
button:disabled {
  opacity: 0.5;
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
.agent-start {
  width: 30px;
  height: 30px;
  padding: 0;
  color: #273f50;
  background: #dce9ef;
  border-color: #bacfd9;
}
.agent-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.attach-trigger {
  border-color: transparent;
  background: transparent;
  padding-inline: 4px 6px;
}
.attach-trigger kbd {
  font: inherit;
  font-size: 10px;
  padding-inline: 3px;
  border: 1px solid #bcd0db;
  border-radius: 3px;
}
.agent-destination {
  display: grid;
  gap: 2px;
  flex: 1;
  min-width: 0;
  font-size: 12px;
}
.agent-destination > span,
.agent-row > span,
.attachments span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-row > span {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}
.agent-picker {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.agent-folders {
  display: grid;
  gap: 3px;
  max-height: 110px;
  overflow: auto;
  align-content: start;
}
.agent-folders button {
  justify-content: flex-start;
}
.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.attachments li {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding-left: 6px;
  border-radius: 5px;
  background: #e6eef3;
}
.attachments button {
  border: 0;
  padding: 4px;
}
.agent-error {
  margin: 0;
  color: #80432c;
  font-size: 12px;
}
@media (max-width: 460px) {
  .agent-controls {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .agent-controls :deep(.select-trigger:nth-child(3)) {
    grid-column: 1 / 3;
  }
  .agent-controls .agent-start {
    grid-column: 3;
    grid-row: 2;
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-launcher-enter-active,
  .agent-launcher-leave-active,
  .launcher-fold svg {
    transition: none;
  }
  .launcher-sessions,
  form {
    animation: none;
  }
}
</style>
