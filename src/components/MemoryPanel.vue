<script setup lang="ts">
// Header → Memory: Orvane memory (server/workspace-memory.ts), the owner's
// preferences and usual procedures that every connected AI reads. AI-saved
// entries stay unreviewed until approved here; turned-off ones are kept but
// hidden from the AI.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";

interface Entry { source: "ai" | "user"; reviewed: boolean; disabled?: boolean; updatedAt: number }
interface Note extends Entry { id: string; text: string }
interface Procedure extends Entry { name: string; description: string; steps: string[] }
interface Memory { notes: Note[]; procedures: Procedure[] }
type Kind = "note" | "procedure";

const emit = defineEmits<{ count: [number] }>();

async function api(body: Record<string, unknown>): Promise<Memory> {
  const response = await fetch("/__orvane/workspace-memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: "Memory is not available." }));
  if (!response.ok) throw Error(data.error || "Memory could not do that.");
  return data as Memory;
}

const memory = ref<Memory>({ notes: [], procedures: [] });
const loaded = ref(false);
const error = ref("");
const tab = ref<Kind>("note");
const pendingOf = (m: Memory) =>
  m.notes.filter((n) => !n.reviewed && !n.disabled).length + m.procedures.filter((p) => !p.reviewed && !p.disabled).length;
function show(m: Memory) {
  memory.value = m;
  emit("count", pendingOf(m));
}
async function refresh() {
  try {
    show(await api({ action: "read" }));
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loaded.value = true;
  }
}
// Live while open: an AI can save while you look.
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (document.visibilityState === "visible" && !editing.value) void refresh();
  }, 4000);
});
onBeforeUnmount(() => clearInterval(timer));

const entries = computed<(Note | Procedure)[]>(() => (tab.value === "note" ? memory.value.notes : memory.value.procedures));
const keyOf = (entry: Note | Procedure) => ("id" in entry ? entry.id : entry.name);
const label = (entry: Note | Procedure) => ("name" in entry ? entry.name : "note");
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const editing = ref<{ kind: Kind; key?: string } | null>(null);
const form = ref({ text: "", name: "", description: "", steps: "" });
const formError = ref("");
const firstField = ref<HTMLInputElement | HTMLTextAreaElement>();
function startNew() {
  editing.value = { kind: tab.value };
  form.value = { text: "", name: "", description: "", steps: "" };
  formError.value = "";
  void nextTick(() => firstField.value?.focus());
}
function startEdit(entry: Note | Procedure) {
  editing.value = { kind: tab.value, key: keyOf(entry) };
  form.value =
    "id" in entry
      ? { text: entry.text, name: "", description: "", steps: "" }
      : { text: "", name: entry.name, description: entry.description, steps: entry.steps.join("\n") };
  formError.value = "";
  void nextTick(() => firstField.value?.focus());
}
async function submit() {
  const e = editing.value;
  if (!e) return;
  try {
    show(
      e.kind === "note"
        ? await api({ action: "save-note", text: form.value.text, ...(e.key ? { id: e.key } : {}) })
        : await api({
            action: "save-procedure",
            name: form.value.name,
            description: form.value.description,
            steps: form.value.steps.split("\n").map((s) => s.trim()).filter(Boolean),
            ...(e.key ? { previousName: e.key } : {}),
          }),
    );
    editing.value = null;
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err);
  }
}
// Delete asks for a second click on the same button.
const confirming = ref("");
async function act(action: "approve" | "disable" | "remove", entry: Note | Procedure, value?: boolean) {
  const id = `${tab.value}:${keyOf(entry)}`;
  if (action === "remove" && confirming.value !== id) {
    confirming.value = id;
    return;
  }
  confirming.value = "";
  try {
    show(await api({ action, kind: tab.value, key: keyOf(entry), ...(value === undefined ? {} : { value }) }));
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
const kinds: { kind: Kind; label: string }[] = [
  { kind: "note", label: "Notes" },
  { kind: "procedure", label: "Procedures" },
];
</script>

<template>
  <div class="memory">
    <p class="memory-help">
      What AIs remember about how you use Orvane, shared by every AI connected
      to it. Entries an AI saved stay <strong>unreviewed</strong> until you
      approve them.
    </p>
    <div class="memory-tabs" role="group" aria-label="Memory sections">
      <button
        v-for="k in kinds"
        :key="k.kind"
        type="button"
        :aria-pressed="tab === k.kind"
        @click="tab = k.kind; editing = null"
      >
        {{ k.label }} · {{ k.kind === "note" ? memory.notes.length : memory.procedures.length }}
      </button>
    </div>
    <div class="memory-head">
      <button v-if="!(editing && !editing.key)" type="button" class="memory-add" @click="startNew">
        <Icon name="plus" :size="12" />New {{ tab }}
      </button>
    </div>

    <form v-if="editing" class="memory-form" @submit.prevent="submit" @keydown.esc.stop="editing = null">
      <p class="memory-form-title">{{ editing.key ? "Edit" : "New" }} {{ editing.kind }}</p>
      <textarea v-if="editing.kind === 'note'" ref="firstField" v-model="form.text" aria-label="Note" rows="3" maxlength="300"
        placeholder="One fact or preference"></textarea>
      <template v-else>
        <input ref="firstField" v-model="form.name" aria-label="Name" maxlength="60" placeholder="Name" />
        <input v-model="form.description" aria-label="Description" maxlength="200" placeholder="When to use it" />
        <textarea v-model="form.steps" aria-label="Steps" rows="6" placeholder="One step per line"></textarea>
      </template>
      <p v-if="formError" class="memory-error" role="alert">{{ formError }}</p>
      <div class="memory-actions">
        <button type="submit" class="memory-primary">Save</button>
        <button type="button" @click="editing = null">Cancel</button>
      </div>
    </form>

    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <p v-if="loaded && !entries.length && !editing" class="memory-empty">No {{ tab }}s yet.</p>
    <ul v-else class="memory-list">
      <li v-for="entry in entries" :key="keyOf(entry)" :class="{ off: entry.disabled }">
        <div class="memory-main">
          <div class="memory-title">
            <strong v-if="'name' in entry">{{ entry.name }}</strong>
            <span v-else class="memory-text">{{ entry.text }}</span>
            <span v-if="entry.disabled" class="memory-badge">Off</span>
            <span v-else-if="!entry.reviewed" class="memory-badge warn">Unreviewed</span>
          </div>
          <span v-if="'description' in entry" class="memory-sub">{{ entry.description }}</span>
          <ol v-if="'steps' in entry" class="memory-steps">
            <li v-for="(step, index) in entry.steps" :key="index">{{ step }}</li>
          </ol>
          <span class="memory-sub">{{ entry.source === "ai" ? "Saved by AI" : "Yours" }} · {{ day(entry.updatedAt) }}</span>
          <button v-if="!entry.reviewed" type="button" class="memory-approve" :aria-label="`Approve ${label(entry)}`"
            @click="act('approve', entry)"><Icon name="check" :size="12" />Approve</button>
        </div>
        <div class="memory-buttons">
          <button type="button" class="memory-icon" :aria-label="`Edit ${label(entry)}`" data-tip="Edit" @click="startEdit(entry)">
            <Icon name="edit" :size="13" /></button>
          <button type="button" class="memory-icon"
            :aria-label="entry.disabled ? `Turn on ${label(entry)}` : `Turn off ${label(entry)}`"
            :aria-pressed="!entry.disabled" :data-tip="entry.disabled ? 'Turn on' : 'Turn off'"
            @click="act('disable', entry, !entry.disabled)"><Icon :name="entry.disabled ? 'eye' : 'mute'" :size="13" /></button>
          <button type="button" class="memory-icon" :class="{ danger: confirming === `${tab}:${keyOf(entry)}` }"
            :aria-label="confirming === `${tab}:${keyOf(entry)}` ? 'Click again to delete' : `Delete ${label(entry)}`"
            :data-tip="confirming === `${tab}:${keyOf(entry)}` ? 'Click again to delete' : 'Delete'"
            @click="act('remove', entry)"
            @blur="confirming === `${tab}:${keyOf(entry)}` && (confirming = '')"><Icon name="trash" :size="13" /></button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* The Browser's site memory tokens, so both memory views look alike. */
.memory {
  --accent: #6e91a6; --surface: #f8fafb; --line: #d5e1e8; --low: #f1f5f7; --hover: #e1eaf0;
  --ink: #425b6c; --sub: #6c8594; --faint: #96aab6; --soft: rgb(121 151 170 / 17%);
  display: flex; flex-direction: column; gap: 10px; color: var(--ink);
}
.memory-help { margin: 0; color: var(--faint); font-size: 11px; line-height: 1.6; }
.memory-help strong { color: var(--sub); font-weight: 600; }
.memory-tabs { display: flex; gap: 4px; padding: 4px; border-radius: 8px; background: var(--low); }
.memory-tabs button { flex: 1; height: 28px; border-radius: 6px; color: var(--sub); font-size: 11px; }
.memory-tabs button[aria-pressed="true"] { background: var(--surface); box-shadow: 0 1px 3px rgb(64 92 111 / 7%); color: var(--ink); }
.memory-head { display: flex; justify-content: flex-end; min-height: 24px; border-bottom: 1px solid var(--soft); padding-bottom: 4px; }
.memory-add { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 6px; color: var(--sub); font-size: 11px; }
.memory-add:hover, .memory-add:focus-visible { background: var(--hover); color: var(--ink); }
.memory-form { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; }
.memory-form input, .memory-form textarea {
  box-sizing: border-box; width: 100%; min-height: 32px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px;
  background: var(--low); color: var(--ink); font: inherit; font-size: 12px; resize: vertical;
}
.memory-form ::placeholder { color: var(--sub); }
.memory-form-title { margin: 0; color: var(--sub); font-size: 11px; font-weight: 600; }
.memory-actions { display: flex; gap: 6px; }
.memory-actions button { height: 26px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); font-size: 12px; }
.memory-actions .memory-primary { border-color: var(--accent); background: var(--accent); color: #fff; }
.memory-error { margin: 0; color: #9a4b45; font-size: 11px; line-height: 1.5; }
.memory-empty { margin: 0; color: var(--faint); font-size: 12px; }
.memory-list { margin: 0; padding: 0; list-style: none; }
.memory-list > li { display: flex; align-items: flex-start; gap: 6px; padding: 8px 2px; border-bottom: 1px solid var(--soft); }
.memory-list > li:last-child { border-bottom: 0; }
.memory-list > li.off .memory-main { opacity: 0.55; }
.memory-main { display: flex; flex: 1; flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; font-size: 12px; }
.memory-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.memory-title strong { color: var(--ink); font-weight: 600; }
.memory-text { color: var(--ink); line-height: 1.45; }
.memory-sub { color: var(--faint); font-size: 11px; line-height: 1.45; }
.memory-badge { padding: 0 6px; border: 1px solid var(--line); border-radius: 9px; color: var(--sub); font-size: 10px; line-height: 16px; }
.memory-badge.warn { border-color: #d9c38f; color: #8a6d2c; }
.memory-steps { margin: 2px 0; padding-left: 18px; color: var(--sub); font-size: 11px; line-height: 1.5; }
.memory-approve { display: inline-flex; align-items: center; gap: 4px; height: 24px; margin-top: 3px; padding: 0 9px; border-radius: 6px; background: var(--accent); color: #fff; font-size: 11px; }
.memory-buttons { display: flex; flex: none; align-items: center; gap: 2px; }
.memory-icon { display: grid; flex: none; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--sub); }
.memory-icon:hover, .memory-icon:focus-visible { background: var(--hover); color: var(--ink); }
.memory-icon.danger { color: #9a4b45; }
</style>
