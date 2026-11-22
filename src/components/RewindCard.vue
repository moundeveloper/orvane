<script setup lang="ts">
// Rewind to the checkpoint taken before one of your messages: the files the
// turn and later work changed, and how much to restore. Enter restores files
// and chat, C the chat only, F the files only.
import { computed, nextTick, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { agentRequest } from "../exposition";

export interface SessionCheckpoint {
  runId: string;
  commit: string;
  at: string;
  message: string;
  folder: string;
}
export type RewindMode = "both" | "chat" | "files";
interface CheckpointFile {
  path: string;
  status: "A" | "M" | "D";
  add: number;
  del: number;
}
const props = defineProps<{
  checkpoint: SessionCheckpoint;
  sessionId: string;
  provider: string;
  /** Claude can also go back in the conversation. */
  canChat: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{ restore: [mode: RewindMode]; close: [] }>();
const files = ref<CheckpointFile[]>([]);
const more = ref(0);
const loading = ref(true);
const error = ref("");
const card = ref<HTMLElement>();
const when = computed(() =>
  new Date(props.checkpoint.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
);
const firstLine = computed(() => props.checkpoint.message.trim().split(/\r?\n/, 1)[0]!.slice(0, 90));
const labels = { A: "added", M: "changed", D: "deleted" } as const;

onMounted(async () => {
  await nextTick();
  card.value?.focus({ preventScroll: true });
  try {
    const preview = await agentRequest<{ files: CheckpointFile[]; more: number }>("checkpoint-preview", {
      sessionId: props.sessionId,
      commit: props.checkpoint.commit,
      provider: props.provider,
    });
    files.value = preview.files;
    more.value = preview.more;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "The checkpoint could not be read.";
  } finally {
    loading.value = false;
  }
});
const nothing = computed(() => !loading.value && !error.value && !files.value.length);
function choose(mode: RewindMode) {
  if (props.busy) return;
  if (mode !== "files" && !props.canChat) return;
  if (mode !== "chat" && (loading.value || error.value)) return;
  emit("restore", mode);
}
function key(event: KeyboardEvent) {
  if ((event.target as HTMLElement).closest("button") && event.key === "Enter") return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const map: Record<string, RewindMode> = { Enter: props.canChat ? "both" : "files", c: "chat", f: "files" };
  const mode = map[event.key.length === 1 ? event.key.toLowerCase() : event.key];
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  } else if (mode) {
    event.preventDefault();
    choose(mode);
  }
}
</script>

<template>
  <section
    ref="card"
    class="rewind-card"
    role="dialog"
    aria-label="Rewind to checkpoint"
    tabindex="-1"
    @keydown="key"
  >
    <header>
      <Icon name="undo" :size="14" />
      <strong>Rewind to {{ when }}</strong>
      <span class="rewind-before" :title="checkpoint.message">before “{{ firstLine }}”</span>
      <button type="button" class="rewind-x" aria-label="Close" @click="emit('close')">
        <Icon name="close" :size="12" />
      </button>
    </header>
    <p v-if="loading" class="rewind-note">Reading the checkpoint…</p>
    <p v-else-if="error" class="rewind-note rewind-error" role="alert">{{ error }}</p>
    <p v-else-if="nothing" class="rewind-note">The files are the same as at this checkpoint.</p>
    <ul v-else class="rewind-files">
      <li v-for="file in files" :key="file.path" :title="file.path">
        <span class="rewind-status" :class="file.status" :aria-label="labels[file.status]">{{ file.status }}</span>
        <span class="rewind-path">{{ file.path }}</span>
        <span class="rewind-count"
          ><b v-if="file.add">+{{ file.add }}</b><i v-if="file.del">−{{ file.del }}</i></span
        >
      </li>
      <li v-if="more" class="rewind-more">and {{ more }} more</li>
    </ul>
    <div class="rewind-actions">
      <button
        v-if="canChat"
        type="button"
        class="rewind-btn rewind-primary"
        :disabled="busy || loading || !!error"
        @click="choose('both')"
      >
        Restore files and chat <kbd>Enter</kbd>
      </button>
      <button v-if="canChat" type="button" class="rewind-btn" :disabled="busy" @click="choose('chat')">
        Chat only <kbd>C</kbd>
      </button>
      <button
        type="button"
        class="rewind-btn"
        :class="{ 'rewind-primary': !canChat }"
        :disabled="busy || loading || !!error || nothing"
        @click="choose('files')"
      >
        Files only <kbd>{{ canChat ? "F" : "Enter" }}</kbd>
      </button>
    </div>
    <p class="rewind-foot">
      The current files are saved as a checkpoint first.
      <template v-if="canChat">Chat restore continues from that point as a new branch.</template>
      <template v-else>Codex can't go back in the conversation.</template>
    </p>
  </section>
</template>

<style scoped>
.rewind-card {
  padding: 8px 10px 9px;
  border: 1px solid #d3dee5;
  border-radius: 9px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5512;
  color: #455968;
  font-size: 12px;
  outline: none;
}
.rewind-card:focus-visible {
  border-color: #9fb7c5;
}
header {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
header strong {
  flex: none;
  color: #273f50;
  font-weight: 600;
}
.rewind-before {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #7a8f9b;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rewind-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #7a8f9b;
}
.rewind-x:hover {
  background: #e4edf2;
}
.rewind-note {
  margin: 6px 0 0;
  color: #7a8f9b;
}
.rewind-error {
  color: #a0624f;
}
.rewind-files {
  max-height: 132px;
  margin: 6px 0 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.rewind-files li {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 22px;
}
.rewind-status {
  width: 14px;
  color: #6f8998;
  font: 600 10.5px "Cascadia Code", Consolas, monospace;
  text-align: center;
}
.rewind-status.A {
  color: #4f7f6a;
}
.rewind-status.D {
  color: #a0624f;
}
.rewind-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font: 11.5px "Cascadia Code", Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rewind-count {
  display: flex;
  gap: 5px;
  font: 11px "Cascadia Code", Consolas, monospace;
}
.rewind-count b {
  color: #4f7f6a;
  font-weight: 500;
}
.rewind-count i {
  color: #a0624f;
  font-style: normal;
}
.rewind-more {
  color: #7a8f9b;
}
.rewind-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.rewind-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid #d3dee5;
  border-radius: 6px;
  background: transparent;
  color: #455968;
  font: inherit;
  font-size: 11.5px;
}
.rewind-btn:hover {
  background: #e4edf2;
}
.rewind-btn:disabled {
  opacity: 0.5;
}
.rewind-primary {
  border-color: #bacfd9;
  background: #dce9ef;
  color: #273f50;
}
.rewind-foot {
  margin: 7px 0 0;
  color: #8296a2;
  font-size: 11px;
}
</style>
