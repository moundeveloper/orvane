<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { AgentMessage, AgentToolCall } from "../exposition";
import Icon from "./Icon.vue";

// One session at a glance: what was asked, what the agent researched, which
// approvals were given, which files it touched, what failed and when it
// answered. Built from the transcript plus the saved run logs' approvals.
export interface SessionApproval {
  tool: string;
  allowed: boolean;
  at: string;
}
type Kind = "you" | "read" | "ask" | "edit" | "fail" | "done";
interface TimelineEvent {
  id: string;
  kind: Kind;
  at: number;
  title: string;
  detail?: string;
  meta?: string;
  aside?: string;
  files?: string[];
}

const props = defineProps<{
  messages: AgentMessage[];
  approvals: SessionApproval[];
  base?: string;
  agent?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const filter = ref<"all" | "files" | "approvals">("all");
const root = ref<HTMLElement>();

const research = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|web_search|NotebookRead)$/;
const writes = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/;
const commands = /^(Bash|PowerShell|shell|exec_command|local_shell_call)$/;
const filePath = (tool: AgentToolCall) =>
  tool.input?.file_path || tool.input?.path || tool.input?.notebook_path || "";
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
function seconds(ms: number) {
  if (!(ms > 0)) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.replace(/[#*`>]/g, "").trim();

function toolEvents(message: AgentMessage, at: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let group: AgentToolCall[] = [];
  let groupKind: "read" | "edit" | "command" | "other" | null = null;
  const flush = () => {
    if (!group.length || !groupKind) return;
    const first = group[0]!;
    const start = group.find((tool) => tool.startedAt)?.startedAt ?? at;
    const end = Math.max(...group.map((tool) => tool.endedAt ?? 0));
    const took = seconds(end - start);
    if (groupKind === "edit") {
      const files = [...new Set(group.map(filePath).filter(Boolean))];
      const created = group.every((tool) => tool.name === "Write");
      events.push({
        id: first.id,
        kind: "edit",
        at: start,
        title: `${created ? "Created" : "Changed"} ${plural(files.length || group.length, "file")}`,
        files,
        meta: [...new Set(group.map((tool) => tool.name))].join(" · "),
        aside: took,
      });
    } else if (groupKind === "read") {
      const web = group.filter((tool) => /Web|web_search/.test(tool.name)).length;
      events.push({
        id: first.id,
        kind: "read",
        at: start,
        title: `Researched ${plural(group.length, "source")}`,
        meta: web ? `Web · ${plural(web, "page")} · ${plural(group.length - web, "file")}` : "Files and searches",
        aside: took,
      });
    } else
      events.push({
        id: first.id,
        kind: "read",
        at: start,
        title:
          groupKind === "command"
            ? group.length === 1 && first.input?.description
              ? first.input.description
              : `Ran ${plural(group.length, "command")}`
            : group.length === 1
              ? `Used ${first.name.replace(/^mcp__([^]+?)__/, "$1 / ")}`
              : `Used ${plural(group.length, "tool")}`,
        aside: took,
      });
    group = [];
    groupKind = null;
  };
  for (const tool of message.tools) {
    if (tool.status === "failed") {
      flush();
      events.push({
        id: tool.id,
        kind: "fail",
        at: tool.startedAt ?? at,
        title: `${tool.name.replace(/^mcp__([^]+?)__/, "$1 / ")} failed`,
        detail: tool.output ? firstLine(tool.output).slice(0, 160) : undefined,
      });
      continue;
    }
    const kind = writes.test(tool.name)
      ? "edit"
      : research.test(tool.name)
        ? "read"
        : commands.test(tool.name)
          ? "command"
          : "other";
    if (kind !== groupKind) flush();
    groupKind = kind;
    group.push(tool);
  }
  flush();
  return events;
}

const events = computed(() => {
  const list: TimelineEvent[] = [];
  for (const message of props.messages) {
    const at = Date.parse(message.at) || 0;
    if (message.role === "user") {
      if (!message.text.trim()) continue;
      const [title, ...rest] = message.text.trim().split("\n");
      list.push({
        id: message.id,
        kind: "you",
        at,
        title: title!.slice(0, 140),
        detail: rest.join(" ").trim().slice(0, 160) || undefined,
      });
      continue;
    }
    list.push(...toolEvents(message, at));
    if (message.text.trim())
      list.push({
        id: `${message.id}:answer`,
        kind: "done",
        at,
        title: "Answered",
        detail: firstLine(message.text).slice(0, 160),
      });
  }
  for (const [index, approval] of props.approvals.entries())
    list.push({
      id: `approval:${index}`,
      kind: "ask",
      at: Date.parse(approval.at) || 0,
      title: approval.allowed ? `Allowed ${approval.tool}` : `Denied ${approval.tool}`,
      meta: approval.allowed ? "Approval · allowed once" : "Approval · denied",
    });
  // Stable by time; events without a time keep transcript order.
  return list
    .map((event, order) => ({ event, order }))
    .sort((a, b) => (a.event.at && b.event.at ? a.event.at - b.event.at : 0) || a.order - b.order)
    .map(({ event }) => event);
});
const shown = computed(() =>
  events.value.filter((event) =>
    filter.value === "files"
      ? event.kind === "edit"
      : filter.value === "approvals"
        ? event.kind === "ask"
        : true,
  ),
);
const summary = computed(() => {
  const times = events.value.map((event) => event.at).filter(Boolean);
  const span = times.length ? Math.max(...times) - Math.min(...times) : 0;
  const first = times.length ? new Date(Math.min(...times)) : null;
  const day = first
    ? first.toDateString() === new Date().toDateString()
      ? "Today"
      : first.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : "";
  return [day, plural(events.value.length, "step"), seconds(span)].filter(Boolean).join(" · ");
});
const clock = (at: number) =>
  at ? new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "";
const icons: Record<Kind, string> = {
  you: "text",
  read: "search",
  ask: "alert",
  edit: "edit",
  fail: "close",
  done: "check",
};

function open(path: string) {
  const target = /^([a-z]:[\\/]|[\\/])/i.test(path) || !props.base ? path : `${props.base}/${path}`;
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: { link: { kind: "file", target, label: baseName(path) } },
    }),
  );
}
function key(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  }
}
onMounted(() => root.value?.focus({ preventScroll: true }));
</script>

<template>
  <section ref="root" class="tl" aria-label="Session timeline" tabindex="-1" @keydown="key">
    <header class="tl-head">
      <strong>Session timeline</strong>
      <span class="tl-sum">{{ summary }}</span>
      <span class="tl-grow" />
      <div class="tl-seg" role="group" aria-label="Show">
        <button
          v-for="option in (['all', 'files', 'approvals'] as const)"
          :key="option"
          type="button"
          :aria-pressed="filter === option"
          @click="filter = option"
        >
          {{ option === "all" ? "All" : option === "files" ? "Files" : "Approvals" }}
        </button>
      </div>
      <button type="button" class="tl-close" aria-label="Close timeline" title="Close (Esc)" @click="emit('close')">
        <Icon name="close" :size="13" />
      </button>
    </header>
    <ol v-if="shown.length" class="tl-list">
      <li
        v-for="(event, index) in shown"
        :key="event.id"
        :class="[event.kind, { now: filter === 'all' && index === shown.length - 1 }]"
      >
        <time>{{ clock(event.at) }}</time>
        <span class="tl-ic"><Icon :name="icons[event.kind]" :size="11" /></span>
        <div class="tl-card">
          <h4>{{ event.title }}</h4>
          <p v-if="event.detail">{{ event.detail }}</p>
          <div v-if="event.meta || event.aside" class="tl-row">
            <span>{{ event.meta }}</span><b>{{ event.aside }}</b>
          </div>
          <div v-if="event.files?.length" class="tl-files">
            <button v-for="file in event.files" :key="file" type="button" :title="file" @click="open(file)">
              {{ baseName(file) }}
            </button>
          </div>
        </div>
      </li>
    </ol>
    <p v-else class="tl-empty">
      {{ filter === "files" ? "No files changed in this session." : filter === "approvals" ? "No approvals in this session." : "Nothing to show yet." }}
    </p>
  </section>
</template>

<style scoped>
.tl {
  padding: 14px 16px 18px;
  outline: none;
}
.tl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
}
.tl-head strong {
  color: #273f50;
  font-weight: 600;
  font-size: 13px;
}
.tl-sum {
  color: #8296a2;
  font-size: 12px;
}
.tl-grow {
  flex: 1;
}
.tl-seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: #e8eff3;
}
.tl-seg button {
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #5d7381;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.tl-seg button[aria-pressed="true"] {
  background: #fbfcfd;
  color: #273f50;
  box-shadow: 0 1px 2px #263f5512;
}
.tl-close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #6f8998;
  cursor: pointer;
}
.tl-close:hover {
  background: #e7eef2;
  color: #273f50;
}
.tl-seg button:focus-visible,
.tl-close:focus-visible,
.tl-files button:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
.tl-list {
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
}
.tl-list::before {
  content: "";
  position: absolute;
  left: 58px;
  top: 12px;
  bottom: 12px;
  width: 1px;
  background: #dbe5ea;
}
.tl-list li {
  display: grid;
  grid-template-columns: 40px 22px minmax(0, 1fr);
  gap: 0 14px;
  align-items: start;
  padding: 4px 0;
}
.tl-list time {
  padding-top: 7px;
  color: #8296a2;
  font: 11.5px "Cascadia Code", Consolas, monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.tl-ic {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-top: 4px;
  border-radius: 50%;
  color: #fff;
}
.you .tl-ic { background: #8ea3b0; }
.read .tl-ic { background: #6f8998; }
.edit .tl-ic { background: #4f7d5f; }
.ask .tl-ic { background: #b08a4a; }
.fail .tl-ic { background: #a0624f; }
.done .tl-ic { background: #365f78; }
.tl-card {
  min-width: 0;
  padding: 7px 11px;
  border: 1px solid #dde6eb;
  border-radius: 8px;
  background: #fbfcfd;
}
.tl-card h4 {
  margin: 0;
  overflow: hidden;
  color: #273f50;
  font-size: 12.5px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-card p {
  margin: 2px 0 0;
  overflow: hidden;
  color: #8296a2;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #8296a2;
  font-size: 11.5px;
}
.tl-row b {
  color: #455968;
  font-weight: 500;
}
.tl-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.tl-files button {
  height: 20px;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: #e6eef3;
  color: #385d76;
  font: 11px/20px "Cascadia Code", Consolas, monospace;
  cursor: pointer;
}
.tl-files button:hover {
  background: #dae6ed;
}
.ask .tl-card {
  border-color: #e7d9bd;
  background: #fcfaf5;
}
.now .tl-card {
  border-color: #9fb6c3;
  box-shadow: 0 0 0 3px #6f89981a;
}
.tl-empty {
  margin: 0;
  padding: 18px 0;
  color: #8296a2;
  font-size: 12px;
  text-align: center;
}
</style>
