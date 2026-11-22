<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { captureLink, CAPTURE_TEXT_LIMIT, type InboxCapture } from "../inbox";
import { imageSource } from "../imageDrop";
import Icon from "./Icon.vue";

export type CaptureDestination = "note" | "notes" | "calendar" | "image" | "discard";

const props = defineProps<{
  captures: InboxCapture[];
  busy: boolean;
  editable: boolean;
  desktop: boolean;
  message: string;
}>();
const draft = defineModel<string>("draft", { required: true });
const emit = defineEmits<{
  close: [];
  save: [];
  "paste-image": [file: File];
  clipboard: [];
  move: [capture: InboxCapture, destination: CaptureDestination];
}>();

const dialog = ref<HTMLDialogElement>();
const list = ref<HTMLElement>();
onMounted(() => dialog.value?.showModal());

function paste(event: ClipboardEvent) {
  const image = Array.from(event.clipboardData?.files ?? []).find((file) =>
    file.type.startsWith("image/"),
  );
  if (!image) return;
  event.preventDefault();
  emit("paste-image", image);
}

// ---- Triage: rows grouped by day, the selected one open with its actions ----
const selectedId = ref(props.captures[0]?.id ?? "");
watch(
  () => props.captures.map((c) => c.id),
  (ids, before) => {
    // A new capture arrives at the top and becomes the selected one.
    if (ids[0] && !before?.includes(ids[0])) {
      selectedId.value = ids[0];
      return;
    }
    if (ids.includes(selectedId.value)) return;
    // The selected capture was sorted: count it and move on to its neighbour.
    if (before?.includes(selectedId.value) && pending === selectedId.value) countSorted();
    pending = "";
    const at = Math.max(0, (before ?? []).indexOf(selectedId.value));
    selectedId.value = ids[Math.min(at, ids.length - 1)] ?? "";
  },
);
const selected = computed(() => props.captures.find((c) => c.id === selectedId.value));

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
function dayLabel(at: number) {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : dayFormat.format(day);
}
const groups = computed(() => {
  const out: { label: string; items: InboxCapture[] }[] = [];
  for (const capture of props.captures) {
    const label = dayLabel(capture.capturedAt);
    const last = out.at(-1);
    if (last?.label === label) last.items.push(capture);
    else out.push({ label, items: [capture] });
  }
  return out;
});
function summary(capture: InboxCapture) {
  if (capture.kind === "image") return { title: "Clipboard image", detail: "" };
  const url = captureLink(capture.value);
  if (url)
    return {
      title: (url.pathname + url.search).replace(/^\/$/, "") || url.hostname,
      detail: url.hostname,
    };
  const [first = "", ...rest] = capture.value.trim().split(/\r?\n/);
  return { title: first.slice(0, 200), detail: rest.find((line) => line.trim())?.trim().slice(0, 120) ?? "" };
}

type Action = { key: string; label: string; icon: string; run: () => void; primary?: boolean; danger?: boolean };
function actionsFor(capture: InboxCapture): Action[] {
  const move = (destination: CaptureDestination) => () => {
    pending = capture.id;
    emit("move", capture, destination);
  };
  const discard: Action = { key: "D", label: "Discard capture", icon: "trash", run: move("discard"), danger: true };
  if (capture.kind === "image")
    return [{ key: "P", label: "Place on canvas", icon: "image", run: move("image"), primary: true }, discard];
  const url = captureLink(capture.value);
  return [
    ...(url ? [{ key: "O", label: "Open in Browser", icon: "globe", run: () => openLink(url.href), primary: true }] : []),
    { key: "N", label: "Sticky note", icon: "pin", run: move("note"), primary: !url },
    { key: "S", label: "Send to Notes", icon: "file", run: move("notes") },
    { key: "C", label: "Calendar today", icon: "calendar", run: move("calendar") },
    discard,
  ];
}
function openLink(href: string) {
  window.dispatchEvent(new CustomEvent("orvane:open-link", { detail: { link: { kind: "page", target: href } } }));
  dialog.value?.close();
}

// "Sorted today" counts captures moved out of the inbox, per day.
const SORTED_KEY = "orvane.inbox-sorted.v1";
const todayKey = () => new Date().toDateString();
function readSorted() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORTED_KEY) || "{}");
    return saved?.day === todayKey() && Number.isFinite(saved.count) ? Number(saved.count) : 0;
  } catch {
    return 0;
  }
}
const sortedToday = ref(readSorted());
let pending = "";
function countSorted() {
  sortedToday.value = readSorted() + 1;
  try {
    localStorage.setItem(SORTED_KEY, JSON.stringify({ day: todayKey(), count: sortedToday.value }));
  } catch {}
}
const progress = computed(() => {
  const total = sortedToday.value + props.captures.length;
  return total ? Math.round((sortedToday.value / total) * 100) : 0;
});

function select(id: string) {
  selectedId.value = id;
  void nextTick(() =>
    list.value?.querySelector<HTMLElement>(`[data-capture="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }),
  );
}
function step(delta: number) {
  const ids = props.captures.map((c) => c.id);
  if (!ids.length) return;
  const at = ids.indexOf(selectedId.value);
  select(ids[Math.max(0, Math.min(ids.length - 1, at < 0 ? 0 : at + delta))]!);
}
// Keys act on the selected capture; typing in the capture field is left alone.
function key(event: KeyboardEvent) {
  event.stopPropagation();
  if ((event.target as Element).closest("input,textarea,[contenteditable]")) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const k = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (k === "J" || k === "ArrowDown") (event.preventDefault(), step(1));
  else if (k === "K" || k === "ArrowUp") (event.preventDefault(), step(-1));
  else if (selected.value && !props.busy && props.editable) {
    const action = actionsFor(selected.value).find((a) => a.key === k);
    if (action) (event.preventDefault(), action.run());
  }
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="workspace-inbox"
      aria-labelledby="inbox-title"
      @close="emit('close')"
      @keydown="key"
      @wheel.stop
    >
      <header class="inbox-header">
        <h2 id="inbox-title">Workspace inbox</h2>
        <span class="inbox-count">{{ captures.length ? `${captures.length} to sort` : "" }}</span>
        <span class="inbox-progress" :title="`${sortedToday} sorted today`">
          {{ sortedToday }} sorted today<i :style="{ '--done': progress + '%' }" />
        </span>
        <button type="button" class="icon-button" aria-label="Close inbox" @click="dialog?.close()">
          <Icon name="close" />
        </button>
      </header>
      <form class="inbox-compose" @submit.prevent="emit('save')">
        <label for="inbox-draft">New capture</label>
        <textarea
          id="inbox-draft"
          v-model="draft"
          autofocus
          rows="3"
          :maxlength="CAPTURE_TEXT_LIMIT"
          :readonly="busy || !editable"
          placeholder="Type a note or paste text, a link, or an image"
          @paste.stop="paste"
        ></textarea>
        <div class="inbox-actions">
          <button type="submit" class="subtle-button" :disabled="busy || !editable || !draft.trim()">
            <Icon name="plus" :size="14" />Save capture
          </button>
          <button
            v-if="desktop"
            type="button"
            class="subtle-button"
            :disabled="busy || !editable"
            @click="emit('clipboard')"
          >
            Capture clipboard
          </button>
        </div>
      </form>
      <p v-if="message" class="inbox-feedback" role="status">{{ message }}</p>
      <p v-if="!editable" class="inbox-feedback">Capture and triage are available in the editing window.</p>
      <p v-if="!captures.length" class="inbox-feedback">No captures yet.</p>
      <div v-else ref="list" class="inbox-triage" tabindex="0" aria-label="Captures to sort">
        <template v-for="group in groups" :key="group.label">
          <div class="inbox-day">{{ group.label }}</div>
          <ul class="inbox-captures" :aria-label="`Captures from ${group.label}`">
            <li
              v-for="capture in group.items"
              :key="capture.id"
              :data-capture="capture.id"
              :class="{ open: capture.id === selectedId }"
              :aria-current="capture.id === selectedId || undefined"
            >
              <button type="button" class="inbox-row" @click="select(capture.id)">
                <img v-if="capture.kind === 'image'" class="inbox-thumb" :src="imageSource(capture.value)" alt="" />
                <span v-else class="inbox-kind"
                  ><Icon :name="captureLink(capture.value) ? 'link' : 'text'" :size="13"
                /></span>
                <span class="inbox-title"
                  >{{ summary(capture).title
                  }}<span v-if="summary(capture).detail"> · {{ summary(capture).detail }}</span></span
                >
                <time :datetime="new Date(capture.capturedAt).toISOString()">{{
                  timeFormat.format(capture.capturedAt)
                }}</time>
              </button>
              <template v-if="capture.id === selectedId">
                <img
                  v-if="capture.kind === 'image'"
                  class="inbox-preview-image"
                  :src="imageSource(capture.value)"
                  alt="Captured clipboard image"
                  loading="lazy"
                />
                <p v-else class="inbox-preview">{{ capture.value }}</p>
                <div class="inbox-acts">
                  <button
                    v-for="action in actionsFor(capture)"
                    :key="action.key"
                    type="button"
                    :class="{ primary: action.primary, danger: action.danger }"
                    :aria-label="action.label"
                    :aria-keyshortcuts="action.key"
                    :title="`${action.label} (${action.key})`"
                    :disabled="busy || !editable"
                    @click="action.run()"
                  >
                    <Icon :name="action.icon" :size="13" /><span v-if="!action.danger">{{ action.label }}</span
                    ><kbd>{{ action.key }}</kbd>
                  </button>
                </div>
              </template>
            </li>
          </ul>
        </template>
      </div>
      <footer v-if="captures.length" class="inbox-foot">
        <span>J K move · O N S C P D act</span><span>Esc close</span>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.workspace-inbox {
  width: min(560px, calc(100vw - 40px));
  max-height: calc(100dvh - 70px);
  padding: 20px;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid rgb(68 92 106 / 19%);
  border-radius: 14px;
  background: #f5f8fa;
  color: #243b49;
  font: inherit;
  box-shadow: 0 22px 60px rgb(26 43 55 / 22%);
}
.workspace-inbox::backdrop {
  background: rgb(49 68 81 / 22%);
  backdrop-filter: blur(4px);
}
.inbox-header,
.inbox-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.inbox-header h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 620;
}
.inbox-count {
  flex: 1;
  color: #8296a2;
  font-size: 12px;
}
.inbox-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8296a2;
  font-size: 11.5px;
}
.inbox-progress i {
  position: relative;
  width: 70px;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: #e1e9ee;
}
.inbox-progress i::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--done);
  border-radius: 2px;
  background: #6f8998;
}
.inbox-compose {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}
.inbox-compose label {
  font-size: 12px;
  font-weight: 600;
}
.inbox-compose textarea {
  width: 100%;
  min-height: 76px;
  max-height: 240px;
  padding: 9px 10px;
  resize: vertical;
  border: 1px solid #c5d2d9;
  border-radius: 7px;
  background: #fff;
  color: inherit;
  font: inherit;
}
.inbox-actions {
  flex-wrap: wrap;
}
.inbox-feedback {
  font-size: 12px;
  color: #526b79;
}
.inbox-triage {
  margin: 14px -8px 0;
  outline: none;
}
.inbox-day {
  padding: 8px 8px 3px;
  color: #8ea1ac;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.inbox-captures {
  margin: 0;
  padding: 0;
  list-style: none;
}
.inbox-captures li {
  border: 1px solid transparent;
  border-radius: 9px;
}
.inbox-captures li.open {
  margin: 2px 0 6px;
  border-color: #9fb6c3;
  background: #fbfcfd;
  box-shadow: 0 0 0 3px #6f89981a;
}
.inbox-triage:focus-visible li.open {
  border-color: #6f8998;
}
.inbox-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 38px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #273f50;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
li:not(.open) .inbox-row:hover {
  background: #eef3f6;
}
.inbox-kind {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid #dde6eb;
  border-radius: 7px;
  background: #fbfcfd;
  color: #365f78;
}
.inbox-thumb {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  object-fit: cover;
}
.inbox-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inbox-title span {
  color: #8296a2;
}
.inbox-row time {
  color: #8296a2;
  font: 11px "Cascadia Code", Consolas, monospace;
}
.inbox-preview {
  max-height: 180px;
  margin: 0 12px 0 43px;
  padding: 9px 11px;
  overflow: auto;
  border-radius: 7px;
  background: #f1f5f8;
  color: #455968;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.inbox-preview-image {
  display: block;
  max-width: calc(100% - 55px);
  max-height: 200px;
  margin: 0 12px 0 43px;
  border-radius: 6px;
}
.inbox-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px 12px 43px;
}
.inbox-acts button {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid #d6e0e6;
  border-radius: 6px;
  background: #fbfcfd;
  color: #273f50;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.inbox-acts button:hover:not(:disabled) {
  background: #eef3f6;
}
.inbox-acts button.primary {
  border-color: #365f78;
  background: #365f78;
  color: #fff;
}
.inbox-acts button.primary:hover:not(:disabled) {
  background: #2f556c;
}
.inbox-acts button.danger {
  margin-left: auto;
  color: #9a5a49;
}
.inbox-acts button:disabled {
  opacity: 0.55;
  cursor: default;
}
.inbox-acts kbd {
  padding: 0 4px;
  border: 1px solid currentColor;
  border-radius: 3px;
  color: inherit;
  font: 10px "Cascadia Code", Consolas, monospace;
  opacity: 0.7;
}
.inbox-foot {
  display: flex;
  justify-content: space-between;
  margin: 8px -20px -20px;
  padding: 9px 20px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
</style>
