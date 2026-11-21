<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import Icon from "./Icon.vue";
import { agentRequest } from "../exposition";

// After a run: the files it created, changed or deleted. A row opens its
// diff in place with a field to ask the agent about that change.
const props = defineProps<{ runId: string; folder: string }>();
const emit = defineEmits<{ ask: [text: string, path: string] }>();

interface Change {
  path: string;
  status: "A" | "M" | "D";
  add: number;
  del: number;
}
const root = ref<string | null>(null);
const files = ref<Change[]>([]);
const ready = ref(false);
const open = ref("");
const diffs = reactive(new Map<string, { lines: string[]; truncated: boolean } | "loading" | "error">());
const questions = reactive(new Map<string, string>());

onMounted(async () => {
  try {
    const data = await agentRequest<{ root: string | null; files: Change[] }>("run-changes", { id: props.runId });
    root.value = data.root;
    files.value = data.files;
  } catch {
    files.value = [];
  }
  ready.value = true;
});

const totals = computed(() =>
  files.value.reduce((sum, file) => ({ add: sum.add + file.add, del: sum.del + file.del }), { add: 0, del: 0 }),
);
const fullPath = (file: Change) =>
  root.value ? `${root.value}\\${file.path.replace(/\//g, "\\")}` : file.path;
function split(file: Change) {
  const path = file.path.replace(/\\/g, "/");
  const at = path.lastIndexOf("/");
  return { dir: at >= 0 ? path.slice(0, at + 1) : "", name: path.slice(at + 1) };
}
// Five cells, filled in proportion to added and removed lines.
function bar(file: Change) {
  const total = file.add + file.del;
  if (!total) return Array(5).fill("");
  const add = Math.round((file.add / total) * 5);
  return Array.from({ length: 5 }, (_, i) => (i < add ? "p" : i < 5 && file.del ? "m" : ""));
}
async function toggle(file: Change) {
  if (!root.value) return show(file);
  open.value = open.value === file.path ? "" : file.path;
  if (!open.value || diffs.has(file.path)) return;
  diffs.set(file.path, "loading");
  try {
    const data = await agentRequest<{ diff: string; truncated: boolean }>("run-diff", {
      id: props.runId,
      path: file.path,
    });
    diffs.set(file.path, { lines: data.diff.split("\n"), truncated: data.truncated });
  } catch {
    diffs.set(file.path, "error");
  }
}
const lineClass = (line: string) =>
  line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "ad" : line.startsWith("-") ? "dl" : "";
function show(file: Change) {
  const target = fullPath(file);
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: { link: { kind: "file", target, label: split(file).name } },
    }),
  );
}
function openFolder() {
  const target = root.value || props.folder;
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: { link: { kind: "folder", target, label: target.split("\\").pop() || target } },
    }),
  );
}
function openGit() {
  window.dispatchEvent(new CustomEvent("orvane:open-git", { detail: { path: root.value || props.folder } }));
}
function ask(file: Change) {
  const text = questions.get(file.path)?.trim();
  if (!text) return;
  emit("ask", text, fullPath(file));
  questions.set(file.path, "");
}
</script>

<template>
  <section v-if="ready && files.length" class="files-changed" aria-label="Files changed">
    <header>
      <strong>Files changed</strong><span class="count">{{ files.length }}</span>
      <span v-if="root" class="sum"
        ><span class="p">+{{ totals.add }}</span> <span class="m">−{{ totals.del }}</span></span
      >
      <span class="grow" />
      <button type="button" class="fc-btn ghost" @click="openFolder">
        <Icon name="folder" :size="13" />Open folder
      </button>
      <button v-if="root" type="button" class="fc-btn" @click="openGit">
        <Icon name="git" :size="13" />Open in Git
      </button>
    </header>
    <ul>
      <li v-for="file in files" :key="file.path" :class="{ open: open === file.path }">
        <button
          type="button"
          class="row"
          :aria-expanded="root ? open === file.path : undefined"
          :title="fullPath(file)"
          @click="toggle(file)"
        >
          <span class="badge" :class="file.status" :aria-label="{ A: 'Added', M: 'Modified', D: 'Deleted' }[file.status]">{{
            file.status
          }}</span>
          <span class="path"><span>{{ split(file).dir }}</span>{{ split(file).name }}</span>
          <span v-if="root" class="delta"
            ><span v-if="file.add" class="p">+{{ file.add }}</span>
            <span v-if="file.del" class="m">−{{ file.del }}</span></span
          >
          <span v-if="root" class="spark" aria-hidden="true"
            ><i v-for="(cell, n) in bar(file)" :key="n" :class="cell"
          /></span>
        </button>
        <div v-if="open === file.path" class="diff">
          <p v-if="diffs.get(file.path) === 'loading'" class="note">Reading the change…</p>
          <p v-else-if="diffs.get(file.path) === 'error'" class="note">The change could not be read.</p>
          <pre v-else-if="diffs.get(file.path)"><span
            v-for="(line, n) in (diffs.get(file.path) as { lines: string[] }).lines"
            :key="n"
            :class="lineClass(line)"
          >{{ line || " " }}</span></pre>
          <footer>
            <input
              :value="questions.get(file.path) ?? ''"
              :aria-label="`Ask about the change to ${split(file).name}`"
              placeholder="Ask about this change…"
              @input="questions.set(file.path, ($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="ask(file)"
            />
            <button v-if="file.status !== 'D'" type="button" class="fc-btn" @click="show(file)">Show file</button>
          </footer>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.files-changed {
  border: 1px solid #dfe7ec;
  border-radius: 10px;
  background: #fbfcfd;
  overflow: hidden;
  animation: fc-in 160ms ease-out;
}
@keyframes fc-in {
  from {
    opacity: 0;
  }
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 12px;
  border-bottom: 1px solid #e3eaee;
  font-size: 12.5px;
}
header strong {
  color: #273f50;
  font-weight: 600;
}
.count {
  color: #8296a2;
}
.sum {
  font-family: var(--cs-mono, "Cascadia Code", Consolas, monospace);
  font-size: 11.5px;
}
.p {
  color: #3f7d57;
}
.m {
  color: #b5524b;
}
.grow {
  flex: 1;
}
.fc-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid #d8e2e8;
  border-radius: 7px;
  background: #fbfcfd;
  color: #455968;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.fc-btn.ghost {
  border-color: transparent;
  background: transparent;
}
.fc-btn:hover {
  background: #edf2f5;
}
.fc-btn:focus-visible,
.row:focus-visible,
footer input:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: -2px;
}
ul {
  margin: 0;
  padding: 4px;
  list-style: none;
}
.row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #273f50;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.row:hover,
.open .row {
  background: #eef3f6;
}
.badge {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  font: 600 10.5px/1 var(--cs-mono, "Cascadia Code", Consolas, monospace);
}
.badge.A {
  background: #e1f0e6;
  color: #3f7d57;
}
.badge.M {
  background: #e3ecf2;
  color: #365f78;
}
.badge.D {
  background: #f6e3e1;
  color: #b5524b;
}
.path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path span {
  color: #8296a2;
}
.delta {
  font-family: var(--cs-mono, "Cascadia Code", Consolas, monospace);
  font-size: 11.5px;
  white-space: nowrap;
}
.spark {
  display: flex;
  gap: 2px;
}
.spark i {
  width: 6px;
  height: 6px;
  border-radius: 1.5px;
  background: #dfe7ec;
}
.spark i.p {
  background: #5f9a74;
}
.spark i.m {
  background: #c97a73;
}
.diff {
  margin: 2px 4px 6px 35px;
  border: 1px solid #e3eaee;
  border-radius: 7px;
  overflow: hidden;
}
pre {
  max-height: 280px;
  margin: 0;
  padding: 6px 0;
  overflow: auto;
  background: #f7f9fa;
  font: 11.5px/1.55 var(--cs-mono, "Cascadia Code", Consolas, monospace);
}
pre span {
  display: block;
  padding: 0 10px;
  white-space: pre;
  color: #455968;
}
pre .ad {
  background: #e7f3ea;
  color: #2f6a45;
}
pre .dl {
  background: #f8e9e7;
  color: #94413a;
}
pre .hunk {
  color: #8296a2;
}
.note {
  margin: 0;
  padding: 10px;
  color: #8296a2;
  font-size: 12px;
}
footer {
  display: flex;
  gap: 6px;
  padding: 6px;
  border-top: 1px solid #e3eaee;
  background: #fbfcfd;
}
footer input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 9px;
  border: 1px solid #d8e2e8;
  border-radius: 7px;
  background: #fff;
  color: #273f50;
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
@media (prefers-reduced-motion: reduce) {
  .files-changed {
    animation: none;
  }
}
</style>
