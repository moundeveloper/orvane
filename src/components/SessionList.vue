<script setup lang="ts">
// Claude Code and Codex sessions to pick from, running ones first (AI
// launcher Sessions tab, pinned panel switcher). ↑ ↓ move the selection,
// Enter (or a click) opens the selected session. The search field filters by
// title and folder; / jumps to it. The host can fold the rows away
// (collapsed), leaving the search field.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { agentNames, type AgentRunSummary } from "../agentSessions";
import { agentRequest, type AgentSession } from "../exposition";
import DnaLoader from "./DnaLoader.vue";

const props = defineProps<{ current?: string; limit?: number; collapsed?: boolean }>();
const emit = defineEmits<{
  /** Enter or a click on a row. */
  pick: [session: AgentSession];
  /** The highlighted row changed (arrows, or the first load). */
  select: [session: AgentSession];
  count: [count: number];
  /** Typing a search while folded asks the host to unfold the rows. */
  expand: [];
}>();
const query = ref("");
const search = ref<HTMLInputElement>();
const sessions = ref<AgentSession[]>([]);
const runs = ref<AgentRunSummary[]>([]);
const error = ref("");
const loaded = ref(false);
const selectedKey = ref(props.current ?? "");
const now = ref(Date.now());

async function load() {
  try {
    const data = await agentRequest<{ sessions: AgentSession[]; runs: AgentRunSummary[] }>("sessions");
    sessions.value = data.sessions;
    runs.value = data.runs;
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loaded.value = true;
    now.value = Date.now();
  }
}
const runOf = (s: AgentSession) =>
  runs.value.find((r) => r.sessionId === s.sessionId && (r.status === "running" || r.status === "stopping"));
const rows = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (s: AgentSession) => {
    const text = `${s.title} ${s.project}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const all = sessions.value.filter(matches).map((s) => ({ session: s, run: runOf(s) }));
  const running = all.filter((r) => r.run).sort((a, b) => Number(!!b.run!.awaitingApproval) - Number(!!a.run!.awaitingApproval));
  // A search looks through every session, not only the latest.
  const recent = all
    .filter((r) => !r.run)
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt)
    .slice(0, words.length ? 50 : props.limit ?? 8);
  return { running, recent, flat: [...running, ...recent] };
});
const selectedIndex = computed(() => rows.value.flat.findIndex((row) => row.session.key === selectedKey.value));
watch(
  () => rows.value.flat,
  (flat) => {
    if (!query.value.trim()) emit("count", flat.length);
    // Keep a selection: the current session, else the first row.
    if (flat.length && selectedIndex.value < 0) {
      selectedKey.value = flat[0]!.session.key;
      emit("select", flat[0]!.session);
    }
  },
);
const ago = (time: number) => {
  const minutes = Math.round((now.value - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return hours < 48 ? "yesterday" : new Date(time).toLocaleDateString();
};
/** How long the run has been working: "4m", "1h 5m", or "" just started. */
const working = (run: AgentRunSummary) => {
  if (!run.startedAt) return "";
  const minutes = Math.floor((now.value - run.startedAt) / 60_000);
  if (minutes < 1) return "";
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const folder = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
function move(step: number) {
  const flat = rows.value.flat;
  if (!flat.length) return;
  const from = selectedIndex.value < 0 ? (step > 0 ? -1 : 0) : selectedIndex.value;
  const next = flat[(from + step + flat.length) % flat.length]!.session;
  selectedKey.value = next.key;
  emit("select", next);
  void Promise.resolve().then(() =>
    root.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
  );
}
function key(event: KeyboardEvent) {
  if (event.key === "/" && event.target !== search.value) {
    event.preventDefault();
    search.value?.focus();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    const row = rows.value.flat[selectedIndex.value];
    if (!row) return;
    event.preventDefault();
    emit("pick", row.session);
  }
}
function click(session: AgentSession) {
  if (selectedKey.value !== session.key) {
    selectedKey.value = session.key;
    emit("select", session);
  }
  emit("pick", session);
}
function searchKey(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape" && query.value) {
    // The first Esc clears the search; the next one reaches the host.
    event.preventDefault();
    event.stopPropagation();
    query.value = "";
  }
}
watch(query, (value) => {
  if (value.trim() && props.collapsed) emit("expand");
  // The selection follows the best match.
  const first = rows.value.flat[0];
  if (value.trim() && first && selectedKey.value !== first.session.key) {
    selectedKey.value = first.session.key;
    emit("select", first.session);
  }
});
const root = ref<HTMLElement>();
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
});
onBeforeUnmount(() => clearInterval(timer));
defineExpose({ key, focusRows: () => root.value?.querySelector<HTMLElement>(".session-rows")?.focus({ preventScroll: true }) });
</script>

<template>
  <div ref="root" class="session-list" @keydown="key">
    <div class="session-search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
      <input
        ref="search"
        v-model="query"
        type="text"
        spellcheck="false"
        aria-label="Search sessions"
        placeholder="Search sessions"
        @keydown="searchKey"
      />
      <kbd v-if="!query" aria-hidden="true">/</kbd>
      <slot name="actions" />
    </div>
    <Transition name="session-rows">
    <div v-show="!collapsed" class="session-rows" role="listbox" aria-label="Agent sessions" tabindex="0">
    <p v-if="error" class="session-error" role="alert">{{ error }}</p>
    <p v-else-if="loaded && !rows.flat.length" class="session-empty">{{ query.trim() ? "No session matches." : "No sessions yet. Start one with New task." }}</p>
    <template v-for="group in [{ label: 'Running', items: rows.running }, { label: 'Recent', items: rows.recent }]" :key="group.label">
      <div v-if="group.items.length" class="session-label">{{ group.label }}</div>
      <button
        v-for="row in group.items"
        :key="row.session.key"
        type="button"
        role="option"
        class="session-row"
        tabindex="-1"
        :aria-selected="row.session.key === selectedKey"
        :aria-current="row.session.key === current ? 'true' : undefined"
        @click="click(row.session)"
      >
        <span class="session-provider" :class="row.session.provider ?? 'claude'" :title="agentNames[row.session.provider ?? 'claude']">
          {{ (row.session.provider ?? "claude") === "claude" ? "C" : "X" }}
        </span>
        <span class="session-title"><b>{{ row.session.title || "Untitled session" }}</b><span>{{ folder(row.session.project) }}</span></span>
        <span v-if="row.run?.awaitingApproval" class="session-state waiting">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.5M8 11h.01" /></svg>waiting for you
        </span>
        <span v-else-if="row.run" class="session-state working">
          <DnaLoader />working{{ working(row.run) ? ` · ${working(row.run)}` : "" }}
        </span>
        <span v-else class="session-state">{{ ago(row.session.updatedAt) }}</span>
      </button>
    </template>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  min-height: 0;
  flex-direction: column;
  padding: 8px 8px 4px;
}
.session-rows {
  display: grid;
  min-height: 0;
  align-content: start;
  overflow: auto;
  outline: none;
}
.session-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  height: 30px;
  margin: 0 0 4px;
  padding: 0 4px 0 8px;
  border-radius: 7px;
  color: #8296a2;
  transition: background-color 140ms ease-out;
}
.session-search:focus-within {
  background: #eef3f6;
}
.session-search > svg {
  width: 14px;
  height: 14px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}
.session-search input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: #273f50;
  font: inherit;
  font-size: 12.5px;
}
/* The row highlights instead of the app-wide focused-field underline. */
.session-search input:focus {
  background: transparent !important;
  box-shadow: none !important;
}
.session-search input::placeholder {
  color: #8296a2;
}
.session-search kbd {
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
/* Rows fold away and come back with a short fade (no animated height). */
.session-rows-enter-active {
  transition: opacity 160ms ease-out, transform 160ms ease-out;
}
.session-rows-leave-active {
  transition: opacity 110ms ease-in;
}
.session-rows-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.session-rows-leave-to {
  opacity: 0;
}
.session-label {
  padding: 4px 6px;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.session-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  height: 34px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #455968;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.session-row {
  transition: background-color 120ms ease-out;
}
.session-row:hover {
  background: #eef3f6;
}
.session-row[aria-selected="true"] {
  background: #e4edf2;
}
.session-provider {
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 6px;
  background: #c2754f;
  color: #fff;
  font: 600 10px "Cascadia Code", Consolas, monospace;
}
.session-provider.codex {
  background: #3c4a55;
}
.session-title {
  display: flex;
  min-width: 0;
  gap: 7px;
  align-items: baseline;
}
.session-title b {
  overflow: hidden;
  color: #273f50;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-title span {
  color: #8296a2;
  font: 11px "Cascadia Code", Consolas, monospace;
  white-space: nowrap;
}
.session-state {
  display: flex;
  gap: 6px;
  align-items: center;
  color: #8296a2;
  font-size: 11.5px;
  white-space: nowrap;
}
.session-state.working {
  color: #365f78;
}
.session-state.waiting {
  color: #b08a4a;
}
.session-state svg {
  width: 14px;
  height: 14px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.session-empty,
.session-error {
  margin: 6px;
  color: #8296a2;
  font-size: 12px;
}
.session-error {
  color: #9a4b45;
}
@media (prefers-reduced-motion: reduce) {
  .session-rows-enter-active,
  .session-rows-leave-active,
  .session-row,
  .session-search {
    transition: none;
  }
}
</style>
