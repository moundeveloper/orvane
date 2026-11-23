<script setup lang="ts">
// Claude Code and Codex sessions to pick from, running ones first (AI
// launcher Sessions tab, pinned panel switcher). ↑ ↓ move, Enter opens.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { agentNames, type AgentRunSummary } from "../agentSessions";
import { agentRequest, type AgentSession } from "../exposition";

const props = defineProps<{ current?: string; limit?: number }>();
const emit = defineEmits<{ pick: [session: AgentSession] }>();
const sessions = ref<AgentSession[]>([]);
const runs = ref<AgentRunSummary[]>([]);
const error = ref("");
const loaded = ref(false);
const selected = ref(0);

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
  }
}
const runOf = (s: AgentSession) =>
  runs.value.find((r) => r.sessionId === s.sessionId && (r.status === "running" || r.status === "stopping"));
const rows = computed(() => {
  const all = sessions.value.map((s) => ({ session: s, run: runOf(s) }));
  const running = all.filter((r) => r.run).sort((a, b) => Number(!!b.run!.awaitingApproval) - Number(!!a.run!.awaitingApproval));
  const recent = all.filter((r) => !r.run).sort((a, b) => b.session.updatedAt - a.session.updatedAt).slice(0, props.limit ?? 8);
  return { running, recent, flat: [...running, ...recent] };
});
const ago = (time: number) => {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return hours < 48 ? "yesterday" : new Date(time).toLocaleDateString();
};
const folder = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
function key(event: KeyboardEvent) {
  const count = rows.value.flat.length;
  if (!count) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    selected.value = (selected.value + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
  } else if (event.key === "Enter") {
    event.preventDefault();
    emit("pick", rows.value.flat[selected.value]!.session);
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
});
onBeforeUnmount(() => clearInterval(timer));
defineExpose({ key });
</script>

<template>
  <div class="session-list" role="listbox" aria-label="Agent sessions" tabindex="0" @keydown="key">
    <p v-if="error" class="session-error" role="alert">{{ error }}</p>
    <p v-else-if="loaded && !rows.flat.length" class="session-empty">No sessions yet. Start one with New task.</p>
    <template v-for="group in [{ label: 'Running', items: rows.running }, { label: 'Recent', items: rows.recent }]" :key="group.label">
      <div v-if="group.items.length" class="session-label">{{ group.label }}</div>
      <button
        v-for="row in group.items"
        :key="row.session.key"
        type="button"
        role="option"
        class="session-row"
        :aria-selected="rows.flat[selected]?.session.key === row.session.key"
        :class="{ current: row.session.key === current }"
        @click="emit('pick', row.session)"
        @mouseenter="selected = rows.flat.indexOf(row)"
      >
        <span class="session-provider" :class="row.session.provider ?? 'claude'" :title="agentNames[row.session.provider ?? 'claude']">
          {{ (row.session.provider ?? "claude") === "claude" ? "C" : "X" }}
        </span>
        <span class="session-title"><b>{{ row.session.title || "Untitled session" }}</b><span>{{ folder(row.session.project) }}</span></span>
        <span v-if="row.run?.awaitingApproval" class="session-state waiting">waiting for you</span>
        <span v-else-if="row.run" class="session-state working"><i class="session-dot"></i>working</span>
        <span v-else class="session-state">{{ ago(row.session.updatedAt) }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.session-list {
  display: grid;
  gap: 1px;
  padding: 6px 8px;
  outline: none;
}
.session-label {
  padding: 6px 6px 3px;
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
  border-radius: 6px;
  color: #455968;
  font-size: 13px;
  text-align: left;
}
.session-row[aria-selected="true"] {
  background: #e4edf2;
}
.session-row.current .session-title b::after {
  content: " ·  open";
  color: #8296a2;
  font-weight: 400;
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
}
.session-state.working {
  color: #365f78;
}
.session-state.waiting {
  color: #b08a4a;
}
.session-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #365f78;
  animation: session-pulse 1.6s ease-in-out infinite;
}
@keyframes session-pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .session-dot {
    animation: none;
  }
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
</style>
