<script setup lang="ts">
// Batch rename: find & replace (optionally a regular expression) or a
// numbered pattern, with a live preview of every new name.
import { computed, nextTick, onMounted, ref } from "vue";
import Icon from "../Icon.vue";
import type { FileEntry } from "./explorer";

const props = defineProps<{ items: FileEntry[] }>();
const emit = defineEmits<{ apply: [{ path: string; name: string }[]]; cancel: [] }>();
const mode = ref<"replace" | "number">("replace");
const find = ref("");
const replace = ref("");
const regex = ref(false);
const matchCase = ref(false);
const pattern = ref("File {n}");
const start = ref(1);
const pad = ref(2);
const keepExt = ref(true);
const first = ref<HTMLInputElement>();
onMounted(() => void nextTick(() => first.value?.focus()));
const INVALID = /[\\/:*?"<>|\0]/;
function split(name: string, dir: boolean) {
  const dot = dir ? -1 : name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" };
}
const regexError = ref("");
const preview = computed(() => {
  regexError.value = "";
  let matcher: RegExp | null = null;
  if (mode.value === "replace" && find.value) {
    try {
      const source = regex.value ? find.value : find.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      matcher = new RegExp(source, matchCase.value ? "g" : "gi");
    } catch (e) {
      regexError.value = e instanceof Error ? e.message : String(e);
    }
  }
  const rows = props.items.map((item, index) => {
    let name = item.name;
    if (mode.value === "replace") {
      if (matcher) {
        const { stem, ext } = split(item.name, item.dir);
        name = keepExt.value ? stem.replace(matcher, replace.value) + ext : item.name.replace(matcher, replace.value);
      }
    } else {
      const n = String(start.value + index).padStart(Math.max(0, pad.value), "0");
      const { ext } = split(item.name, item.dir);
      name = pattern.value.replace(/\{n\}/g, n).replace(/\{name\}/g, split(item.name, item.dir).stem) + (keepExt.value ? ext : "");
    }
    return { item, name: name.trim(), problem: "" };
  });
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.name.toLowerCase(), (seen.get(row.name.toLowerCase()) ?? 0) + 1);
  for (const row of rows) {
    if (!row.name) row.problem = "Empty name";
    else if (INVALID.test(row.name)) row.problem = "Invalid character";
    else if (seen.get(row.name.toLowerCase())! > 1) row.problem = "Duplicate";
  }
  return rows;
});
const changes = computed(() => preview.value.filter((r) => r.name !== r.item.name));
const blocked = computed(() => !!regexError.value || preview.value.some((r) => r.problem) || !changes.value.length);
function apply() {
  if (blocked.value) return;
  emit("apply", changes.value.map((r) => ({ path: r.item.path, name: r.name })));
}
function keys(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === "Escape") emit("cancel");
  else if (event.key === "Enter" && (event.target as Element).tagName === "INPUT" && (event.target as HTMLInputElement).type !== "checkbox") {
    event.preventDefault();
    apply();
  }
}
</script>
<template>
  <div class="br-backdrop" @pointerdown.self="emit('cancel')">
    <div class="br-dialog" role="dialog" aria-modal="true" aria-label="Rename items" @keydown="keys">
      <div class="br-head">
        <strong>Rename {{ items.length }} item{{ items.length === 1 ? "" : "s" }}</strong>
        <div class="br-seg">
          <button :aria-pressed="mode === 'replace'" @click="mode = 'replace'">Find &amp; replace</button
          ><button :aria-pressed="mode === 'number'" @click="mode = 'number'">Numbered</button>
        </div>
      </div>
      <div v-if="mode === 'replace'" class="br-fields">
        <label>Find<input ref="first" v-model="find" spellcheck="false" /></label>
        <label>Replace with<input v-model="replace" spellcheck="false" :placeholder="regex ? '$1 refers to a group' : ''" /></label>
        <div class="br-checks">
          <label><input v-model="regex" type="checkbox" />Regular expression</label>
          <label><input v-model="matchCase" type="checkbox" />Match case</label>
          <label><input v-model="keepExt" type="checkbox" />Leave extensions</label>
        </div>
        <p v-if="regexError" class="br-error">{{ regexError }}</p>
      </div>
      <div v-else class="br-fields">
        <label>Pattern<input ref="first" v-model="pattern" spellcheck="false" /></label>
        <p class="br-hint">{n} is the number, {name} the current name.</p>
        <div class="br-row">
          <label>Start at<input v-model.number="start" type="number" min="0" /></label>
          <label>Digits<input v-model.number="pad" type="number" min="0" max="8" /></label>
          <label class="br-check"><input v-model="keepExt" type="checkbox" />Keep extensions</label>
        </div>
      </div>
      <div class="br-preview-head"><span>Current name</span><span>New name</span></div>
      <div class="br-preview">
        <div v-for="row in preview" :key="row.item.path" class="br-line" :class="{ same: row.name === row.item.name, bad: row.problem }">
          <span :title="row.item.name">{{ row.item.name }}</span>
          <Icon name="forward" :size="11" />
          <span :title="row.problem || row.name">{{ row.name || "—" }}<em v-if="row.problem"> · {{ row.problem }}</em></span>
        </div>
      </div>
      <div class="br-actions">
        <span class="br-hint">{{ changes.length }} will change</span>
        <button @click="emit('cancel')">Cancel</button>
        <button class="primary" :disabled="blocked" @click="apply">Rename</button>
      </div>
    </div>
  </div>
</template>
<style scoped>
.br-backdrop {
  position: absolute;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: #e9edf099;
}
.br-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(620px, calc(100% - 32px));
  max-height: calc(100% - 40px);
  padding: 16px;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 12px 32px #425c6b33;
  color: #455968;
  font-size: 12px;
}
.br-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.br-head strong {
  color: #2f4856;
  font-size: 13px;
}
.br-seg {
  display: flex;
  padding: 2px;
  border-radius: 5px;
  background: #edf3f6;
}
.br-seg button {
  padding: 4px 10px;
  border-radius: 4px;
  background: none;
  color: #547589;
  font-size: 12px;
}
.br-seg button[aria-pressed="true"] {
  background: #fff;
  box-shadow: 0 1px 2px #425c6b26;
  color: #2f4856;
}
.br-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.br-fields > label,
.br-row > label:not(.br-check) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #718591;
}
.br-fields input:not([type="checkbox"]) {
  padding: 6px 8px;
  border: 0;
  border-radius: 5px;
  background: #edf3f6;
  color: #2f4856;
  font: inherit;
  outline: none;
}
.br-fields input:focus:not([type="checkbox"]) {
  box-shadow: inset 0 -1px #7895a5;
}
.br-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.br-row input[type="number"] {
  width: 80px;
}
.br-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}
.br-checks label,
.br-check {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
}
.br-hint {
  margin: 0;
  color: #8798a3;
  font-size: 11px;
}
.br-error {
  margin: 0;
  color: #a5603d;
}
.br-preview-head,
.br-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
}
.br-preview-head {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  padding: 0 10px 4px;
  border-bottom: 1px solid #e2eaee;
  color: #718591;
  font-weight: 600;
}
.br-preview {
  max-height: 240px;
  min-height: 60px;
  overflow: auto;
}
.br-line {
  padding: 4px 10px;
  border-bottom: 1px solid #f0f4f6;
}
.br-line span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.br-line span:last-child {
  color: #2f4856;
  font-weight: 600;
}
.br-line.same span:last-child {
  color: #8798a3;
  font-weight: 400;
}
.br-line.bad span:last-child {
  color: #a5503d;
}
.br-line em {
  font-style: normal;
  font-weight: 400;
}
.br-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.br-actions .br-hint {
  margin-right: auto;
}
.br-actions button {
  padding: 6px 12px;
  border-radius: 5px;
  background: #e7edf0;
  color: #455968;
}
.br-actions button.primary {
  background: #4f7b93;
  color: #fff;
}
.br-actions button:disabled {
  opacity: 0.45;
}
</style>
