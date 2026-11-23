<script setup lang="ts">
import { computed, ref } from "vue";
import type { AgentActivity } from "../agentSessions";

// While a run works, its steps read as a short story: a headline per step,
// one muted line of detail and the files it touched. The head (loader, state
// and elapsed time) comes from the caller.
const props = defineProps<{
  items: AgentActivity[];
  /** Session folder, for relative file paths. */
  base?: string;
  /** What the run is doing when no step is running, e.g. "Preparing request". */
  status?: string;
}>();

interface Step {
  id: string;
  status: AgentActivity["status"];
  title: string;
  mono: boolean;
  detail: string;
  files: { path: string; label: string }[];
}

const verbs: Record<string, [string, string]> = {
  Read: ["Reading", "Read"],
  Edit: ["Editing", "Edited"],
  MultiEdit: ["Editing", "Edited"],
  NotebookEdit: ["Editing", "Edited"],
  Write: ["Writing", "Wrote"],
  Grep: ["Searching for", "Searched for"],
  Glob: ["Finding files matching", "Found files matching"],
  WebFetch: ["Reading", "Read"],
  WebSearch: ["Searching the web for", "Searched the web for"],
  TodoWrite: ["Updating the plan", "Updated the plan"],
};
const firstLine = (text = "") => text.trim().split("\n", 1)[0]!.trim();
const clip = (text: string, limit = 200) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
function resolve(path: string) {
  const text = path.trim().replace(/\//g, "\\");
  if (/^(?:[a-z]:\\|\\\\)/i.test(text) || !props.base) return text;
  const parts = props.base.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const part of text.replace(/^\.\\/, "").split(/\\+/)) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("\\");
}
function host(url = "") {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describe(item: AgentActivity): Step {
  const input = item.input ?? {};
  const done = item.status !== "running";
  const verb = verbs[item.label]?.[done ? 1 : 0];
  const step: Step = {
    id: item.id,
    status: item.status,
    title: item.label,
    mono: false,
    detail: "",
    files: [],
  };
  const file = input.file_path || input.notebook_path;
  if (file) {
    const line = input.offset && /^\d+$/.test(input.offset) ? `:${input.offset}` : "";
    step.files.push({ path: resolve(file), label: baseName(file) + line });
  }
  if (item.kind === "reasoning") {
    const summary = (item.summary ?? "").replace(/\*\*/g, "").trim();
    step.title = clip(firstLine(summary).replace(/:$/, ""), 120) || "Thinking";
    step.detail = clip(summary.slice(firstLine(summary).length).trim().replace(/\s+/g, " "));
  } else if (item.kind === "command") {
    step.title = input.description
      ? clip(firstLine(input.description), 120)
      : done
        ? "Ran a command"
        : "Running a command";
    step.detail = clip(firstLine(input.command));
  } else if (item.kind === "mcp") {
    step.title = item.label;
    step.mono = true;
  } else if (item.kind === "changes") {
    step.title = done ? "Changed files" : "Changing files";
    for (const row of (input.files ?? "").split("\n")) {
      const path = row.replace(/^\S+\s+/, "").trim();
      if (path) step.files.push({ path: resolve(path), label: baseName(path) });
    }
  } else if (item.label === "Task" || item.label === "Agent") {
    step.title = input.description
      ? clip(firstLine(input.description), 120)
      : done
        ? "Ran a subagent"
        : "Running a subagent";
  } else if (verb && file) {
    step.title = `${verb} ${baseName(file)}`;
  } else if (verb && input.pattern) {
    step.title = `${verb} “${clip(input.pattern, 60)}”`;
    if (input.path) step.detail = clip(input.path);
  } else if (verb && input.url) {
    step.title = `${verb} ${host(input.url)}`;
  } else if (verb && input.query) {
    step.title = `${verb} “${clip(input.query, 80)}”`;
  } else if (item.kind === "search" && input.query) {
    step.title = `${done ? "Searched the web for" : "Searching the web for"} “${clip(input.query, 80)}”`;
  } else if (verb && !Object.keys(input).length) {
    step.title = verb;
  } else {
    step.mono = item.kind === "tool";
  }
  if (item.status === "failed" && item.output)
    step.detail = clip(firstLine(item.output));
  else if (!step.detail && item.summary && item.kind !== "reasoning")
    step.detail = clip(firstLine(item.summary));
  return step;
}

const steps = computed(() => {
  const list = props.items.map(describe);
  if (props.status && !props.items.some((item) => item.status === "running"))
    list.push({ id: "status", status: "running", title: props.status, mono: false, detail: "", files: [] });
  return list;
});
// Long runs show their latest steps; the rest open on request.
const shown = 6;
const all = ref(false);
const hidden = computed(() => (all.value ? 0 : Math.max(0, steps.value.length - shown)));
const visible = computed(() => steps.value.slice(hidden.value));

function open(path: string) {
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: { link: { kind: "file", target: path, label: baseName(path) } },
    }),
  );
}
</script>

<template>
  <section class="trail" aria-label="Run steps">
    <div class="trail-head"><slot name="head" /></div>
    <button v-if="hidden" type="button" class="trail-more" @click="all = true">
      {{ hidden === 1 ? "1 earlier step" : `${hidden} earlier steps` }}
    </button>
    <ol>
      <li
        v-for="step in visible"
        :key="step.id"
        class="trail-step"
        :class="`is-${step.status}`"
      >
        <span class="dot" aria-hidden="true" />
        <div class="body">
          <h4 :class="{ mono: step.mono, shimmer: step.status === 'running' }">
            {{ step.title }}
          </h4>
          <p v-if="step.detail">{{ step.detail }}</p>
          <div v-if="step.files.length" class="chips">
            <button
              v-for="file in step.files"
              :key="file.path + file.label"
              type="button"
              class="chip"
              :title="`Show ${file.path} in Orvane`"
              @click="open(file.path)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 3h8l4 4v14H6z" />
                <path d="M14 3v4h4" />
              </svg>
              {{ file.label }}
            </button>
          </div>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.trail {
  display: grid;
  gap: 2px;
  min-width: 0;
  animation: trail-fade 160ms ease-out;
}
.trail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-bottom: 4px;
}
.trail-more {
  justify-self: start;
  margin: 0 0 2px 30px;
  padding: 2px 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #6f8998;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.trail-more:hover {
  background: #e7eef2;
  color: #365f78;
}
.trail-more:focus-visible,
.chip:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
ol {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.trail-step {
  position: relative;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 10px;
  padding: 5px 0;
}
/* The rail joins each dot to the next step's dot. */
.trail-step::before {
  content: "";
  position: absolute;
  left: 9.5px;
  top: 21px;
  bottom: -6px;
  width: 1px;
  background: #d3dee5;
}
.trail-step:last-child::before {
  background: linear-gradient(#d3dee5, transparent);
}
.dot {
  justify-self: center;
  margin-top: 5px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #fbfcfd;
  border: 1.5px solid #b6c7d1;
  box-sizing: border-box;
}
.is-completed .dot {
  background: #6f8998;
  border-color: #6f8998;
}
.is-running .dot {
  border-color: #365f78;
  box-shadow: 0 0 0 4px #365f781a;
}
.is-failed .dot {
  border-color: #b5524b;
  background: #f6e3e1;
}
.body {
  min-width: 0;
}
h4 {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  color: #455968;
}
.is-running h4 {
  color: #273f50;
}
.is-failed h4 {
  color: #8d3f39;
}
h4.mono {
  font-family: var(--cs-mono, "Cascadia Code", Consolas, monospace);
  font-size: 12px;
}
p {
  margin: 2px 0 0;
  max-width: 62ch;
  overflow-wrap: anywhere;
  font-size: 12.5px;
  line-height: 1.5;
  color: #8296a2;
}
.is-running p {
  color: #5d7381;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: #e6eef3;
  color: #385d76;
  font: 11.5px/1 var(--cs-mono, "Cascadia Code", Consolas, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.chip:hover {
  background: #dae6ed;
}
.chip svg {
  flex: none;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.shimmer {
  background: linear-gradient(90deg, #273f50 0 40%, #b4cad6 50%, #273f50 60% 100%) 0 0 / 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: trail-shimmer 1.8s linear infinite;
}
@keyframes trail-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -150% 0;
  }
}
@keyframes trail-fade {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .trail {
    animation: none;
  }
  .shimmer {
    animation: none;
    background: none;
    -webkit-text-fill-color: currentColor;
  }
}
</style>
