<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import type { AgentActivity } from "../agentSessions";

// title: "Run activity" for a live run; transcripts list a reply's tool
// calls under their own title, closed until opened.
const props = withDefaults(
  defineProps<{ items: AgentActivity[]; title?: string; collapsed?: boolean }>(),
  { title: "Run activity", collapsed: false },
);

const kinds: Record<AgentActivity["kind"], string> = {
  mcp: "MCP",
  tool: "Tool",
  command: "Shell",
  reasoning: "Model",
  search: "Search",
  changes: "Files",
};
const states: Record<AgentActivity["status"], string> = {
  running: "In progress",
  completed: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
};
// Tool, MCP and shell labels are identifiers or commands: set them in mono.
const mono = new Set<AgentActivity["kind"]>(["mcp", "command", "tool", "search"]);
const current = computed(() =>
  props.items.find((item) => item.status === "running"),
);
const finished = computed(
  () => props.items.filter((item) => item.status !== "running").length,
);
const progress = computed(() =>
  props.items.length ? (finished.value / props.items.length) * 100 : 0,
);

// Steps that recorded input or output open in place to show them.
const open = reactive(new Set<string>());
const hasDetails = (item: AgentActivity) =>
  Boolean(item.output || (item.input && Object.keys(item.input).length));
function toggle(id: string) {
  if (open.has(id)) open.delete(id);
  else open.add(id);
}
function duration(item: AgentActivity) {
  if (!item.startedAt || !item.endedAt) return "";
  const seconds = Math.max(0, item.endedAt - item.startedAt) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
// Edits show their change as a diff instead of the tool's confirmation.
function diff(item: AgentActivity) {
  const input = item.input;
  if (item.status !== "completed" || !input) return null;
  if (input.old_string === undefined || input.new_string === undefined)
    return null;
  return [
    ...input.old_string.split("\n").map((text) => ({ text, add: false })),
    ...input.new_string.split("\n").map((text) => ({ text, add: true })),
  ];
}
const copied = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copy(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  copied.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = ""), 1200);
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
const inputText = (item: AgentActivity) =>
  Object.entries(item.input ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
</script>

<template>
  <details class="run-activity" :class="{ live: current }" :open="!collapsed">
    <summary>
      <strong>{{ title }}</strong>
      <span class="count"
        >{{ current ? `${finished + 1} of ${items.length}` : items.length }}</span
      >
      <span v-if="current" class="now">{{ current.label }}</span>
    </summary>
    <div class="progress" aria-hidden="true">
      <i :style="{ width: `${progress}%` }" />
    </div>
    <ol :aria-label="title">
      <li
        v-for="item in items"
        :key="item.id"
        :class="{ open: open.has(item.id) }"
      >
        <component
          :is="hasDetails(item) ? 'button' : 'div'"
          class="row"
          :type="hasDetails(item) ? 'button' : undefined"
          :aria-expanded="hasDetails(item) ? open.has(item.id) : undefined"
          @click="hasDetails(item) && toggle(item.id)"
        >
          <svg
            class="chev"
            :class="{ none: !hasDetails(item) }"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
          <span class="kind">{{ kinds[item.kind] }}</span>
          <strong
            :class="{
              mono: mono.has(item.kind),
              shimmer: item.status === 'running',
            }"
            >{{ item.label }}</strong
          >
          <span class="dur">{{ duration(item) }}</span>
          <span class="state" :class="`is-${item.status}`">
            <template v-if="item.status === 'completed'">
              <svg class="tick" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
              <span class="sr-only">{{ states.completed }}</span>
            </template>
            <template v-else>
              <i v-if="item.status === 'running'" class="spin" />
              <svg
                v-else
                class="cross"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M7 7l10 10M17 7L7 17" />
              </svg>
              {{ states[item.status] }}
            </template>
          </span>
        </component>
        <p v-if="item.summary">{{ item.summary }}</p>
        <div
          v-if="hasDetails(item) && open.has(item.id)"
          class="detail"
        >
          <section v-if="item.input && Object.keys(item.input).length">
            <h4>
              <span>Input</span>
              <button type="button" @click="copy(`${item.id}:in`, inputText(item))">
                {{ copied === `${item.id}:in` ? "Copied" : "Copy" }}
              </button>
            </h4>
            <dl>
              <template v-for="(value, key) in item.input" :key="key">
                <dt>{{ key }}</dt>
                <dd>{{ value }}</dd>
              </template>
            </dl>
          </section>
          <section v-if="diff(item) || item.output">
            <h4>
              <span>Output</span>
              <button
                type="button"
                @click="
                  copy(
                    `${item.id}:out`,
                    diff(item)
                      ?.map((line) => (line.add ? '+' : '-') + line.text)
                      .join('\n') ??
                      item.output ??
                      '',
                  )
                "
              >
                {{ copied === `${item.id}:out` ? "Copied" : "Copy" }}
              </button>
            </h4>
            <pre v-if="diff(item)"><span
              v-for="(line, index) in diff(item)"
              :key="index"
              :class="line.add ? 'add' : 'del'"
            >{{ (line.add ? "+" : "-") + line.text }}</span></pre>
            <pre v-else :class="{ err: item.status === 'failed' }">{{
              item.output
            }}</pre>
          </section>
        </div>
      </li>
    </ol>
  </details>
</template>

<style scoped>
.run-activity {
  flex: none;
  min-width: 0;
  border: 1px solid #dbe5ea;
  border-radius: 9px;
  background: #f2f6f8;
  font-size: 12px;
  overflow: hidden;
}
summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 7px 10px;
  cursor: pointer;
  list-style: none;
}
summary::-webkit-details-marker {
  display: none;
}
summary:hover {
  background: #ebf1f4;
}
summary strong {
  font-weight: 600;
  color: #273f50;
}
.count {
  color: #5d7381;
}
.now {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #365f78;
  font-family: var(--font-mono, "Cascadia Code", Consolas, monospace);
  font-size: 11.5px;
}
.progress {
  position: relative;
  height: 2px;
  background: #dfe8ed;
  overflow: hidden;
}
.progress i {
  position: absolute;
  inset: 0 auto 0 0;
  background: #6f8998;
  transition: width 200ms ease-out;
}
.live .progress::after {
  content: "";
  position: absolute;
  inset: 0;
  width: 30%;
  background: linear-gradient(90deg, transparent, #9fb6c3, transparent);
  animation: sweep 1.4s ease-in-out infinite;
}
@keyframes sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}
ol {
  display: grid;
  margin: 0;
  padding: 4px 10px 8px;
  list-style: none;
}
li {
  padding: 1px 0;
  border-top: 1px solid #e3eaee;
}
.row {
  display: grid;
  grid-template-columns: 12px 46px minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  width: 100%;
  min-height: 26px;
  margin: 0;
  padding: 4px 4px 4px 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
button.row {
  cursor: pointer;
}
button.row:hover {
  background: #e9f0f3;
}
.chev {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: #8aa0ad;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 140ms ease-out;
}
.chev.none {
  visibility: hidden;
}
li.open .chev {
  transform: rotate(90deg);
}
.dur {
  font-size: 11px;
  color: #8296a2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tick,
.cross {
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.tick {
  width: 14px;
  height: 14px;
  color: #4f7d5f;
}
/* Drawn once when the step finishes. */
.tick path {
  stroke-dasharray: 20;
  stroke-dashoffset: 20;
  animation: draw 260ms ease-out 100ms forwards;
}
@keyframes draw {
  to {
    stroke-dashoffset: 0;
  }
}
.cross {
  width: 12px;
  height: 12px;
}
.detail {
  display: grid;
  gap: 10px;
  margin: 2px 4px 7px 20px;
  padding: 10px 12px;
  border: 1px solid #dde6eb;
  border-radius: 8px;
  background: #fbfcfd;
  animation: fade 160ms ease-out;
}
.detail section {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.detail h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #7a8f9b;
}
.detail h4 span {
  flex: 1;
}
.detail h4 button {
  padding: 0;
  border: 0;
  background: transparent;
  color: #6f8998;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  cursor: pointer;
}
.detail h4 button:hover {
  background: transparent;
  color: #365f78;
}
dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 3px 12px;
  margin: 0;
}
dt {
  color: #5d7381;
}
dd {
  margin: 0;
  max-height: 120px;
  overflow: auto;
  color: #273f50;
  font-family: var(--font-mono, "Cascadia Code", Consolas, monospace);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: #eef3f6;
  color: #30495a;
  font: 11.5px/1.55 var(--font-mono, "Cascadia Code", Consolas, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre.err {
  background: #f7ece8;
  color: #6f3528;
}
pre .add,
pre .del {
  display: block;
}
pre .add {
  background: #e3efe6;
  color: #3f6b4f;
}
pre .del {
  background: #f6e6e1;
  color: #7b3b2d;
}
li:first-child {
  border-top: 0;
}
li:last-child {
  animation: fade 160ms ease-out;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
.kind {
  font-size: 10.5px;
  font-weight: 600;
  color: #7a8f9b;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
li strong {
  min-width: 0;
  overflow-wrap: anywhere;
  color: #273f50;
  font-weight: 520;
}
li strong.mono {
  font-family: var(--font-mono, "Cascadia Code", Consolas, monospace);
  font-size: 11.5px;
  font-weight: 450;
}
.shimmer {
  background: linear-gradient(
      90deg,
      #273f50 0%,
      #273f50 40%,
      #b4cad6 50%,
      #273f50 60%,
      #273f50 100%
    )
    0 0 / 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: shimmer 1.8s linear infinite;
}
@keyframes shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -150% 0;
  }
}
.state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #5d7381;
  white-space: nowrap;
}
.state.is-running {
  color: #365f78;
}
.state.is-failed,
.state.is-interrupted {
  color: #8c4637;
}
.spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid #bfd0da;
  border-top-color: #365f78;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
li > p {
  margin: 0 0 4px 66px;
  color: #5d7381;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
@media (prefers-reduced-motion: reduce) {
  .run-activity *,
  .run-activity *::after,
  .run-activity::after {
    animation: none !important;
    transition: none !important;
  }
  .tick path {
    stroke-dashoffset: 0;
  }
  .shimmer {
    -webkit-text-fill-color: currentColor;
    background: none;
    color: #365f78;
  }
}
</style>
