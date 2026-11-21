<script setup lang="ts">
// The "/" menu of an agent composer: skills, session commands and saved
// prompts. Like the "@" picker, the composer keeps focus and drives it with
// the arrow keys, Tab and Enter.
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";

export interface SlashEntry {
  kind: "skill" | "command" | "prompt";
  name: string;
  description: string;
  text?: string;
}
const props = defineProps<{ query: string; items: SlashEntry[]; loading?: boolean }>();
const emit = defineEmits<{ pick: [entry: SlashEntry] }>();

const sections: { kind: SlashEntry["kind"]; title: string }[] = [
  { kind: "skill", title: "Skills" },
  { kind: "command", title: "Session" },
  { kind: "prompt", title: "Saved prompts" },
];
// Names that start with the query come first, then any other match.
const matches = computed(() => {
  const query = props.query.toLowerCase();
  const score = (entry: SlashEntry) =>
    entry.name.toLowerCase().startsWith(query)
      ? 0
      : entry.name.toLowerCase().includes(query)
        ? 1
        : entry.description.toLowerCase().includes(query)
          ? 2
          : 3;
  return props.items
    .map((entry) => ({ entry, rank: score(entry) }))
    .filter((item) => item.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name))
    .map((item) => item.entry);
});
const groups = computed(() =>
  sections
    .map((section) => ({ ...section, entries: matches.value.filter((e) => e.kind === section.kind) }))
    .filter((group) => group.entries.length),
);
// Keyboard order follows the sections as shown.
const ordered = computed(() => groups.value.flatMap((group) => group.entries));
const active = ref(0);
const list = ref<HTMLElement>();
watch(ordered, () => (active.value = 0));
const skills = computed(() => props.items.filter((e) => e.kind === "skill").length);

function move(step: number) {
  const count = ordered.value.length;
  if (!count) return;
  active.value = (active.value + step + count) % count;
  list.value?.querySelector(`[data-index="${active.value}"]`)?.scrollIntoView({ block: "nearest" });
}
function pick(index = active.value) {
  const entry = ordered.value[index];
  if (entry) emit("pick", entry);
  return Boolean(entry);
}
defineExpose({ move, pick });
const iconOf = { skill: "ai", command: "terminal", prompt: "file" } as const;
</script>

<template>
  <div class="slash-menu" role="listbox" aria-label="Skills and prompts" @pointerdown.prevent>
    <div ref="list" class="slash-list">
      <template v-for="group in groups" :key="group.kind">
        <div class="slash-section">{{ group.title }}</div>
        <button
          v-for="entry in group.entries"
          :key="group.kind + entry.name"
          type="button"
          role="option"
          tabindex="-1"
          :data-index="ordered.indexOf(entry)"
          :aria-selected="ordered.indexOf(entry) === active"
          :title="entry.text || entry.description"
          @pointerenter="active = ordered.indexOf(entry)"
          @click="pick(ordered.indexOf(entry))"
        >
          <Icon :name="iconOf[entry.kind]" :size="14" />
          <span class="name">/{{ entry.name }}</span>
          <span class="desc">{{ entry.kind === "prompt" ? entry.text : entry.description }}</span>
        </button>
      </template>
      <p v-if="!ordered.length" class="slash-empty">
        {{ loading ? "Reading skills…" : query ? "No matching skills or prompts" : "No skills or saved prompts yet" }}
      </p>
    </div>
    <div class="slash-foot">
      <span>{{ skills === 1 ? "1 skill" : `${skills} skills` }} from the skills folders</span>
      <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
      <span><kbd>Tab</kbd> insert</span>
    </div>
  </div>
</template>

<style scoped>
.slash-menu {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% + 6px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  max-height: 300px;
  border: 1px solid #d3dee5;
  border-radius: 9px;
  background: #fbfcfd;
  box-shadow:
    0 1px 2px #263f5514,
    0 10px 28px #263f5524;
  font-size: 12.5px;
  overflow: hidden;
  animation: slash-in 120ms ease-out;
}
@keyframes slash-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}
.slash-list {
  overflow: auto;
  padding: 4px;
}
.slash-section {
  padding: 6px 8px 3px;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.slash-list button {
  display: grid;
  grid-template-columns: 14px auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #455968;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.slash-list button[aria-selected="true"] {
  background: #e7eef2;
  color: #273f50;
}
.name {
  font-family: var(--cs-mono, "Cascadia Code", Consolas, monospace);
  font-size: 12px;
  color: #273f50;
}
.desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8296a2;
}
.slash-empty {
  margin: 0;
  padding: 10px;
  color: #8296a2;
}
.slash-foot {
  display: flex;
  gap: 14px;
  height: 28px;
  align-items: center;
  padding: 0 10px;
  border-top: 1px solid #e3eaee;
  color: #8296a2;
  font-size: 11px;
}
.slash-foot span:first-child {
  flex: 1;
}
kbd {
  margin-right: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .slash-menu {
    animation: none;
  }
}
</style>
