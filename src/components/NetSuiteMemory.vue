<script setup lang="ts">
// What agents keep about this NetSuite account: notes and saved scripts. The
// user reviews them here; saved scripts run only once approved.
import { computed, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { accountOf, workspaceCall } from "../netsuiteWorkspace";

defineOptions({ name: "NetSuiteMemory" });
const props = defineProps<{ environment: string }>();
type Note = { id: string; text: string; source: "ai" | "user"; reviewed: boolean; disabled?: boolean };
type Script = {
  name: string;
  description: string;
  params: string[];
  code: string;
  source: "ai" | "user";
  approved: boolean;
  disabled?: boolean;
  lastOk?: number;
  lastFail?: number;
  failNote?: string;
};
const account = computed(() => accountOf(props.environment));
const notes = ref<Note[]>([]),
  scripts = ref<Script[]>([]),
  error = ref(""),
  newNote = ref(""),
  editing = ref<{ kind: "note"; id: string; text: string } | { kind: "script"; name: string; description: string; params: string; code: string } | null>(null),
  open = ref<string | null>(null);
const waiting = computed(() => notes.value.filter((n) => !n.reviewed && !n.disabled).length + scripts.value.filter((s) => !s.approved && !s.disabled).length);
async function call(action: string, body: Record<string, unknown> = {}) {
  error.value = "";
  try {
    const result = await workspaceCall(action, { account: account.value, ...body });
    if (action !== "memory") await load();
    return result;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function load() {
  const memory = await workspaceCall<{ notes: Note[]; scripts: Script[] }>("memory", { account: account.value }).catch((e) => {
    error.value = e instanceof Error ? e.message : String(e);
    return { notes: [], scripts: [] };
  });
  notes.value = memory.notes;
  scripts.value = memory.scripts;
}
async function addNote() {
  if (!newNote.value.trim()) return;
  if (await call("save-note", { text: newNote.value })) newNote.value = "";
}
async function saveEdit() {
  const item = editing.value;
  if (!item) return;
  const done =
    item.kind === "note"
      ? await call("save-note", { id: item.id, text: item.text })
      : await call("save-script", {
          previousName: item.name,
          name: item.name,
          description: item.description,
          params: item.params.split(",").map((p) => p.trim()).filter(Boolean),
          code: item.code,
        });
  if (done) editing.value = null;
}
const broken = (s: Script) => !!s.lastFail && (!s.lastOk || s.lastFail > s.lastOk);
watch(() => props.environment, () => void load());
onMounted(() => void load());
</script>
<template>
  <div class="mem-view">
    <header class="mem-head">
      <div>
        <strong>Memory</strong>
        <small>{{ account }} · what agents keep for this account<template v-if="waiting"> · {{ waiting }} waiting for your review</template></small>
      </div>
      <button class="subtle-button" aria-label="Refresh memory" @click="load"><Icon name="refresh" :size="13" /></button>
    </header>
    <p v-if="error" class="mem-error" role="alert">{{ error }}</p>
    <div class="mem-body">
      <section aria-label="Notes">
        <h3>Notes</h3>
        <form class="mem-add" @submit.prevent="addNote">
          <input v-model="newNote" maxlength="300" placeholder="Add a fact about this account (record IDs, quirks…)" aria-label="New note" />
          <button class="subtle-button" :disabled="!newNote.trim()"><Icon name="plus" :size="13" /> Add</button>
        </form>
        <p v-if="!notes.length" class="mem-muted">No notes yet.</p>
        <ul class="mem-list">
          <li v-for="note in notes" :key="note.id" :class="{ off: note.disabled }">
            <template v-if="editing?.kind === 'note' && editing.id === note.id">
              <input v-model="editing.text" maxlength="300" aria-label="Note text" @keydown.enter.prevent="saveEdit" @keydown.escape="editing = null" />
              <button class="subtle-button" @click="saveEdit">Save</button>
              <button class="subtle-button" @click="editing = null">Cancel</button>
            </template>
            <template v-else>
              <span class="mem-text">{{ note.text }}</span>
              <span v-if="!note.reviewed" class="mem-badge">from AI, unreviewed</span>
              <button v-if="!note.reviewed" class="subtle-button" @click="call('approve', { kind: 'note', key: note.id })"><Icon name="check" :size="13" /> Approve</button>
              <button class="icon-button" aria-label="Edit note" @click="editing = { kind: 'note', id: note.id, text: note.text }"><Icon name="edit" :size="13" /></button>
              <button class="icon-button" :aria-label="note.disabled ? 'Turn note on' : 'Turn note off'" @click="call('disable', { kind: 'note', key: note.id, value: !note.disabled })"><Icon :name="note.disabled ? 'eye' : 'mute'" :size="13" /></button>
              <button class="icon-button" aria-label="Delete note" @click="call('remove', { kind: 'note', key: note.id })"><Icon name="trash" :size="13" /></button>
            </template>
          </li>
        </ul>
      </section>
      <section aria-label="Saved scripts">
        <h3>Saved scripts</h3>
        <p v-if="!scripts.length" class="mem-muted">No saved scripts. Agents save reusable SuiteScript with orvane_netsuite_memory; they run only after you approve them.</p>
        <ul class="mem-list">
          <li v-for="script in scripts" :key="script.name" class="mem-script" :class="{ off: script.disabled }">
            <div class="mem-script-head">
              <button class="mem-open" :aria-expanded="open === script.name" @click="open = open === script.name ? null : script.name">
                <Icon :name="open === script.name ? 'down' : 'right'" :size="12" /><strong>{{ script.name }}</strong>
                <small>{{ script.description }}<template v-if="script.params.length"> · params: {{ script.params.join(", ") }}</template></small>
              </button>
              <span v-if="!script.approved" class="mem-badge">waiting for approval</span>
              <span v-if="broken(script)" class="mem-badge bad" :title="script.failNote">last run failed</span>
              <button v-if="!script.approved" class="subtle-button" @click="call('approve', { kind: 'script', key: script.name })"><Icon name="check" :size="13" /> Approve</button>
              <button class="icon-button" aria-label="Edit script" @click="editing = { kind: 'script', name: script.name, description: script.description, params: script.params.join(', '), code: script.code }; open = script.name"><Icon name="edit" :size="13" /></button>
              <button class="icon-button" :aria-label="script.disabled ? 'Turn script on' : 'Turn script off'" @click="call('disable', { kind: 'script', key: script.name, value: !script.disabled })"><Icon :name="script.disabled ? 'eye' : 'mute'" :size="13" /></button>
              <button class="icon-button" aria-label="Delete script" @click="call('remove', { kind: 'script', key: script.name })"><Icon name="trash" :size="13" /></button>
            </div>
            <form v-if="open === script.name && editing?.kind === 'script' && editing.name === script.name" class="mem-edit" @submit.prevent="saveEdit">
              <input v-model="editing.description" maxlength="200" aria-label="Description" />
              <input v-model="editing.params" aria-label="Parameters (comma separated)" placeholder="Parameters, comma separated" />
              <textarea v-model="editing.code" spellcheck="false" aria-label="Script code" />
              <span><button class="subtle-button">Save</button><button type="button" class="subtle-button" @click="editing = null">Cancel</button></span>
            </form>
            <pre v-else-if="open === script.name" class="mem-code">{{ script.code }}</pre>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
<style scoped>
.mem-view { height: 100%; display: flex; flex-direction: column; min-height: 0; color: #455968; font-size: 12px; }
.mem-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #e3e8eb; }
.mem-head > div { display: flex; flex-direction: column; margin-right: auto; }
.mem-head small, .mem-muted, .mem-open small { color: #7d8f9b; }
.mem-error { margin: 10px 14px; color: #a2453c; }
.mem-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 14px 14px; }
h3 { margin: 14px 0 6px; font-size: 13px; font-weight: 600; }
.mem-muted { margin: 4px 0; }
.mem-add { display: flex; gap: 6px; margin-bottom: 6px; }
input, textarea { flex: 1; min-width: 0; padding: 5px 8px; border: 1px solid #d5dde2; border-radius: 6px; background: #fff; color: inherit; font: inherit; }
textarea { min-height: 160px; font: 12px/1.5 ui-monospace, Consolas, monospace; resize: vertical; }
input:focus, textarea:focus { outline: none; border-color: #6f8998; }
.mem-list { list-style: none; margin: 0; padding: 0; }
.mem-list > li { display: flex; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 1px solid #eef1f3; }
.mem-list > li.off { opacity: 0.55; }
.mem-text { flex: 1; overflow-wrap: anywhere; }
.mem-badge { padding: 1px 6px; border-radius: 6px; background: #e9edf0; color: #6f8998; white-space: nowrap; }
.mem-badge.bad { background: #f6e6e4; color: #a2453c; }
.mem-script { flex-direction: column; align-items: stretch !important; }
.mem-script-head { display: flex; align-items: center; gap: 6px; }
.mem-open { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; padding: 2px 0; }
.mem-open small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-code { margin: 4px 0 2px; padding: 10px; border-radius: 8px; background: #eef2f4; font: 12px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.mem-edit { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.mem-edit span { display: flex; gap: 6px; }
</style>
