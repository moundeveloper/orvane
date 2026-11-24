<script setup lang="ts">
// "Continue with another model": the session menu turns into this model list
// (UI Maker continue-with-another-model, round r3). Both CLIs' models, a
// search field, ↑ ↓ ↵ Esc, and a footer that says where the draft opens
// before anything is created. The model the session uses now is disabled.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { agentNames, type AgentProvider } from "../agentSessions";

export type ContinueChoice = { provider: AgentProvider; model: string; label: string };
const props = defineProps<{
  options: Record<AgentProvider, { value: string; label: string }[]>;
  /** The source's provider and model: shown as "this session", not pickable. */
  current?: { provider: AgentProvider; model: string };
  /** Where the draft opens: beside the chat, or in the pinned panel. */
  place: "beside" | "panel";
  /** The draft's own model pill: picking changes the draft, nothing opens. */
  change?: boolean;
}>();
const emit = defineEmits<{ pick: [choice: ContinueChoice]; close: [] }>();

const query = ref("");
const search = ref<HTMLInputElement>();
const list = ref<HTMLElement>();
const order: AgentProvider[] = ["codex", "claude"];
const rows = computed(() => {
  const q = query.value.trim().toLowerCase();
  return order.flatMap((provider) =>
    props.options[provider]
      .filter((option) => !q || `${option.label} ${agentNames[provider]}`.toLowerCase().includes(q))
      .map((option) => ({
        provider,
        model: option.value,
        label: option.label,
        current: !props.change && props.current?.provider === provider && props.current.model === option.value,
      })),
  );
});
const at = ref(0);
const firstFree = () => Math.max(0, rows.value.findIndex((row) => !row.current));
watch(query, () => (at.value = firstFree()));
watch(
  () => rows.value.length,
  () => {
    if (at.value >= rows.value.length) at.value = firstFree();
  },
);
function move(step: number) {
  const n = rows.value.length;
  if (!n) return;
  let i = at.value;
  for (let tries = 0; tries < n; tries++) {
    i = (i + step + n) % n;
    if (!rows.value[i]!.current) break;
  }
  at.value = i;
  void nextTick(() => list.value?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" }));
}
function pick(index = at.value) {
  const row = rows.value[index];
  if (!row || row.current) return;
  emit("pick", { provider: row.provider, model: row.model, label: row.label });
}
function key(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    pick();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  } else if (event.key === "Tab") emit("close");
}
onMounted(() => {
  at.value = firstFree();
  search.value?.focus({ preventScroll: true });
});
</script>

<template>
  <div class="cs-continue select-popover" role="dialog" aria-label="Continue with another model" @keydown="key">
    <label class="cs-continue-search">
      <Icon name="search" :size="13" />
      <input ref="search" v-model="query" type="text" autocomplete="off" placeholder="Find a model"
        aria-label="Find a model" role="combobox" aria-expanded="true" aria-controls="cs-continue-models" />
      <kbd>Esc</kbd>
    </label>
    <div id="cs-continue-models" ref="list" class="cs-continue-list" role="listbox" aria-label="Models">
      <template v-for="(row, index) in rows" :key="row.provider + ':' + row.model">
        <p v-if="index === 0 || rows[index - 1]!.provider !== row.provider" class="cs-continue-group">
          <span class="cs-prov" :class="row.provider">{{ agentNames[row.provider] }}</span>
        </p>
        <button type="button" role="option" tabindex="-1" :aria-selected="index === at"
          :aria-disabled="row.current || undefined" :data-highlighted="index === at"
          @pointermove="!row.current && (at = index)" @click="pick(index)">
          <span>{{ row.label }}</span>
          <small v-if="row.current">this session</small>
        </button>
      </template>
      <p v-if="!rows.length" class="cs-continue-empty" role="status">No model matches “{{ query }}”</p>
    </div>
    <div v-if="!change" class="cs-continue-dest">
      <Icon :name="place === 'beside' ? 'columns' : 'panel-right'" :size="14" />
      <span>{{ place === "beside" ? "Opens beside this chat" : "Opens in this panel" }}
        <em>{{ place === "beside" ? "Draft only. Nothing is sent until you press Enter." : "Draft only. This session stays in the list." }}</em></span>
    </div>
    <div class="cs-continue-keys">
      <span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> {{ change ? "use model" : "open draft" }}</span>
    </div>
  </div>
</template>

<style scoped>
.cs-continue {
  display: flex;
  flex-direction: column;
  width: 300px;
  max-width: calc(100cqw - 16px);
  max-height: 420px;
  padding: 0;
  overflow: hidden;
  border: 1px solid #d3dee5;
  border-radius: 9px;
  background: #fbfcfd;
  box-shadow: 0 2px 6px #263f5510, 0 14px 34px #263f5524;
}
.cs-continue-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 10px;
  border-bottom: 1px solid #e3eaee;
  color: #8296a2;
}
.cs-continue-search input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: none;
  color: #273f50;
  font-size: 12.5px;
}
.cs-continue-search input::placeholder {
  color: #8296a2;
}
.cs-continue-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px;
}
.cs-continue-group {
  margin: 6px 8px 3px;
  font-size: 11px;
  font-weight: 600;
  color: #5d7381;
}
.cs-prov {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.cs-prov::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9db0bc;
}
.cs-prov.codex::before {
  border-radius: 1.5px;
  background: #8a9fae;
}
.cs-continue-list > button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #455968;
  font-size: 12.5px;
  text-align: left;
}
.cs-continue-list > button[data-highlighted="true"] {
  background: #dde8ee;
  color: #273f50;
}
.cs-continue-list > button[aria-disabled="true"] {
  color: #8296a2;
  cursor: default;
}
.cs-continue-list small {
  margin-left: auto;
  font-size: 11px;
  color: #8296a2;
}
.cs-continue-empty {
  margin: 0;
  padding: 10px 8px;
  font-size: 12px;
  color: #8296a2;
}
.cs-continue-dest {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid #e3eaee;
  font-size: 12px;
  color: #455968;
}
.cs-continue-dest :deep(svg) {
  flex: none;
  color: #6f8998;
}
.cs-continue-dest em {
  display: block;
  font-style: normal;
  font-size: 11px;
  color: #8296a2;
}
.cs-continue-keys {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px 8px;
  font-size: 11px;
  color: #8296a2;
}
.cs-continue-dest + .cs-continue-keys {
  padding-top: 0;
}
.cs-continue-list + .cs-continue-keys {
  padding-top: 8px;
  border-top: 1px solid #e3eaee;
}
.cs-continue-keys span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
</style>
