<script setup lang="ts">
// The source of a continued session, at the top of its draft (UI Maker
// continue-with-another-model, round r3). Rows come straight from the source
// transcript; "Read transcript" lists every turn and opens the source there.
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
import type { AgentQuote } from "../agentHarness";
import { agentNames, type AgentProvider } from "../agentSessions";

const props = defineProps<{ quote: AgentQuote; to: AgentProvider }>();
const emit = defineEmits<{ open: [messageId?: string] }>();
const origin = computed(() => props.quote.origin!);
const open = ref(false);
const when = computed(() => {
  const value = origin.value.updatedAt;
  if (!value) return "";
  const d = new Date(value),
    midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return d >= midnight
    ? `today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
});
const meta = computed(() =>
  [agentNames[origin.value.provider], origin.value.model, `${origin.value.turns.length} turns`, when.value]
    .filter(Boolean)
    .join(" · "),
);
const clock = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.valueOf()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
</script>

<template>
  <section class="cs-ref" aria-label="Continues from">
    <div class="cs-ref-head">
      <span class="cs-ref-icon"><Icon name="agent-sessions" :size="15" /></span>
      <div>
        <strong :title="quote.source">{{ quote.source }}</strong>
        <span>{{ meta }}</span>
      </div>
      <button type="button" class="cs-ref-btn" title="Open source (Ctrl+Alt+O)" @click="emit('open')">
        <Icon name="external" :size="13" />Open
      </button>
    </div>
    <dl>
      <div v-if="origin.asked"><dt>Asked</dt><dd>{{ origin.asked }}</dd></div>
      <div v-if="origin.reply"><dt>Last reply</dt><dd>{{ origin.reply }}</dd></div>
      <div v-if="origin.changed.length">
        <dt>Changed</dt>
        <dd class="cs-ref-files"><span v-for="path in origin.changed" :key="path" :title="path">{{ fileName(path) }}</span></dd>
      </div>
      <div v-if="origin.open"><dt>Open</dt><dd class="cs-ref-open">{{ origin.open }}</dd></div>
    </dl>
    <div class="cs-ref-foot">
      <span>Taken from the transcript. {{ agentNames[to] }} gets all of it.</span>
      <button type="button" class="cs-ref-link" :aria-expanded="open" @click="open = !open">
        Read transcript <Icon name="down" :size="12" />
      </button>
    </div>
    <ol v-if="open" class="cs-ref-turns">
      <li v-for="turn in origin.turns" :key="turn.id">
        <button type="button" @click="emit('open', turn.id)">
          <time>{{ clock(turn.at) }}</time>
          <b>{{ turn.role === "user" ? "You" : agentNames[origin.provider] }}</b>
          <span>{{ turn.line }}</span>
          <small v-if="turn.tools">{{ turn.tools }} {{ turn.tools === 1 ? "tool" : "tools" }}</small>
        </button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.cs-ref {
  border: 1px solid #dbe5eb;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f550d;
  animation: cs-ref-in 180ms ease-out;
}
@keyframes cs-ref-in {
  from {
    opacity: 0;
  }
}
.cs-ref-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 12px;
}
.cs-ref-icon {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: #e7eef3;
  color: #6f8998;
}
.cs-ref-head > div {
  flex: 1;
  min-width: 0;
  display: grid;
}
.cs-ref-head strong {
  overflow: hidden;
  color: #273f50;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-ref-head span {
  overflow: hidden;
  color: #8296a2;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-ref-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid #dbe5eb;
  border-radius: 6px;
  background: #fbfcfd;
  color: #455968;
  font-size: 12px;
}
.cs-ref-btn:hover {
  background: #eef3f6;
}
.cs-ref dl {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 10px 12px;
  border-top: 1px solid #e3eaee;
}
.cs-ref dl > div {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}
.cs-ref dt {
  flex: 0 0 66px;
  padding-top: 1px;
  color: #8296a2;
  font-size: 11.5px;
}
.cs-ref dd {
  flex: 1 1 220px;
  min-width: 0;
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  color: #455968;
  font-size: 12.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.cs-ref dd.cs-ref-open {
  color: #273f50;
}
.cs-ref dd.cs-ref-open::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin: 0 7px 1px 0;
  border-radius: 50%;
  background: #b08a4a;
}
.cs-ref dd.cs-ref-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.cs-ref-files span {
  display: inline-flex;
  align-items: center;
  height: 21px;
  padding: 0 7px;
  border-radius: 6px;
  background: #e6eef3;
  color: #385d76;
  font: 11px "Cascadia Code", Consolas, monospace;
  white-space: nowrap;
}
.cs-ref-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11.5px;
}
.cs-ref-foot > span {
  flex: 1;
  min-width: 0;
}
.cs-ref-link {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #385d76;
  font-size: 11.5px;
}
.cs-ref-link:hover {
  background: #eef3f6;
}
.cs-ref-link :deep(svg) {
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.cs-ref-link[aria-expanded="true"] :deep(svg) {
  transform: rotate(180deg);
}
.cs-ref-turns {
  display: grid;
  max-height: 200px;
  margin: 0;
  padding: 4px;
  overflow: auto;
  border-top: 1px solid #e3eaee;
  list-style: none;
  animation: cs-ref-in 160ms ease-out;
}
.cs-ref-turns button {
  display: grid;
  grid-template-columns: 40px 76px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #455968;
  font-size: 12px;
  text-align: left;
}
.cs-ref-turns button:hover,
.cs-ref-turns button:focus-visible {
  background: #eef3f6;
  outline: none;
}
.cs-ref-turns time {
  color: #8296a2;
  font: 10.5px "Cascadia Code", Consolas, monospace;
}
.cs-ref-turns b {
  overflow: hidden;
  color: #273f50;
  font-size: 11.5px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-ref-turns span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-ref-turns small {
  color: #8296a2;
  font-size: 11px;
}
@media (prefers-reduced-motion: reduce) {
  .cs-ref,
  .cs-ref-turns,
  .cs-ref-link :deep(svg) {
    animation: none;
    transition: none;
  }
}
</style>
