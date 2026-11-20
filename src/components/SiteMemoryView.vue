<script setup lang="ts">
// Browser → Memory: what the AI saved about websites (routes, notes, flows;
// server/site-memory.ts). The user can search, create, edit, approve, turn
// off and delete entries. AI-written entries stay "unreviewed" until
// approved here, and flows can't run until approved.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getDomain } from "tldts";
import Icon from "./Icon.vue";

interface Health { disabled?: boolean; lastOk?: number; lastFail?: number; failures?: number; failNote?: string }
interface Route extends Health { name: string; path: string; description?: string; source: "ai" | "user"; reviewed: boolean; learnedOn?: string; updatedAt: number }
interface Note extends Health { id: string; text: string; source: "ai" | "user"; reviewed: boolean; learnedOn?: string; updatedAt: number }
interface Flow extends Health { name: string; description: string; params: string[]; steps: Record<string, unknown>[]; source: "ai" | "user"; approved: boolean; updatedAt: number }
interface Memory { site: string; routes: Route[]; notes: Note[]; flows: Flow[] }
type Kind = "route" | "note" | "flow";

const props = defineProps<{ currentUrl?: string }>();

async function api<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/__orvane/site-memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: "Site memory is not available." }));
  if (!response.ok) throw Error(data.error || "Site memory could not do that.");
  return data as T;
}

const currentSite = computed(() => {
  try {
    const url = new URL(props.currentUrl || "");
    return /^https?:$/.test(url.protocol) ? getDomain(url.hostname) || url.host : "";
  } catch {
    return "";
  }
});
const memories = ref<Memory[]>([]);
const loaded = ref(false);
const error = ref("");
const query = ref("");
const tab = ref<Kind>("route");
/** Sites to show; none chosen shows every site. */
const chosen = ref(new Set<string>());
function toggleSite(name: string) {
  const next = new Set(chosen.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  chosen.value = next;
}
async function refresh() {
  try {
    const sites = await api<{ site: string }[]>({ action: "sites" });
    memories.value = await Promise.all(sites.map(({ site }) => api<Memory>({ action: "read", site })));
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loaded.value = true;
  }
}
onMounted(refresh);
// The AI may save while the panel is open: re-read now and then (a small
// local request), never while editing or with the window hidden.
const poll = setInterval(() => {
  if (!editing.value && document.visibilityState === "visible") void refresh();
}, 4000);
onBeforeUnmount(() => clearInterval(poll));

// Each shown site is a group (the open tab's site first, even when empty, so
// something can be added to it); search narrows the groups' entries.
const sites = computed(() => {
  const names = new Set(memories.value.map((m) => m.site));
  if (currentSite.value) names.add(currentSite.value);
  return [...names].sort((a, b) => Number(b === currentSite.value) - Number(a === currentSite.value) || a.localeCompare(b));
});
const matches = (...values: (string | undefined)[]) => {
  const q = query.value.trim().toLowerCase();
  return !q || values.some((v) => v?.toLowerCase().includes(q));
};
const shown = computed(() => {
  const searching = !!query.value.trim();
  return sites.value
    .filter((name) => !chosen.value.size || chosen.value.has(name))
    .map((name) => memories.value.find((m) => m.site === name) ?? { site: name, routes: [], notes: [], flows: [] })
    .map((m) => ({
      site: m.site,
      routes: m.routes.filter((r) => matches(m.site, r.name, r.path, r.description)),
      notes: m.notes.filter((n) => matches(m.site, n.text)),
      flows: m.flows.filter((f) => matches(m.site, f.name, f.description, JSON.stringify(f.steps))),
    }))
    .filter((m) => !searching || m.routes.length + m.notes.length + m.flows.length);
});
const entries = (m: { routes: Route[]; notes: Note[]; flows: Flow[] }) =>
  tab.value === "route" ? m.routes : tab.value === "note" ? m.notes : m.flows;
const count = (kind: Kind) =>
  shown.value.reduce((n, m) => n + (kind === "route" ? m.routes : kind === "note" ? m.notes : m.flows).length, 0);
const pending = (m: Memory) =>
  m.routes.filter((r) => !r.reviewed && !r.disabled).length +
  m.notes.filter((n) => !n.reviewed && !n.disabled).length +
  m.flows.filter((f) => !f.approved && !f.disabled).length;

// ---- Editing ----
const editing = ref<{ kind: Kind; site: string; key?: string } | null>(null);
const form = ref({ name: "", path: "", description: "", text: "", params: "", steps: "" });
const formError = ref("");
const firstField = ref<HTMLInputElement | HTMLTextAreaElement>();
function startNew(siteName: string) {
  editing.value = { kind: tab.value, site: siteName };
  form.value = {
    name: "", path: "", description: "", text: "", params: "",
    steps: tab.value === "flow" ? '[\n  { "action": "navigate", "path": "/" }\n]' : "",
  };
  formError.value = "";
  void nextTick(() => firstField.value?.focus());
}
function startEdit(kind: Kind, siteName: string, entry: Route | Note | Flow) {
  editing.value = { kind, site: siteName, key: "id" in entry ? entry.id : entry.name };
  form.value = {
    name: "name" in entry ? entry.name : "",
    path: "path" in entry ? entry.path : "",
    description: "description" in entry ? entry.description ?? "" : "",
    text: "text" in entry ? entry.text : "",
    params: "params" in entry ? entry.params.join(", ") : "",
    steps: "steps" in entry ? JSON.stringify(entry.steps, null, 2) : "",
  };
  formError.value = "";
  void nextTick(() => firstField.value?.focus());
}
async function submit() {
  const edit = editing.value;
  if (!edit) return;
  try {
    const f = form.value;
    if (edit.kind === "route")
      await api({ action: "save-route", site: edit.site, name: f.name, path: f.path, ...(f.description.trim() ? { description: f.description } : {}), ...(edit.key ? { previousName: edit.key } : {}) });
    else if (edit.kind === "note")
      await api({ action: "save-note", site: edit.site, text: f.text, ...(edit.key ? { id: edit.key } : {}) });
    else {
      let steps: unknown;
      try {
        steps = JSON.parse(f.steps);
      } catch {
        throw Error("Steps must be a JSON list of steps.");
      }
      await api({
        action: "save-flow", site: edit.site, name: f.name, description: f.description,
        params: f.params.split(",").map((p) => p.trim()).filter(Boolean),
        steps, ...(edit.key ? { previousName: edit.key } : {}),
      });
    }
    editing.value = null;
    await refresh();
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  }
}

const confirming = ref("");
async function act(action: "approve" | "disable" | "remove", kind: Kind, siteName: string, key: string, value?: boolean) {
  const id = `${kind}:${siteName}:${key}`;
  if (action === "remove" && confirming.value !== id) {
    confirming.value = id;
    return;
  }
  confirming.value = "";
  try {
    await api({ action, kind, site: siteName, key, ...(value === undefined ? {} : { value }) });
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
const keyOf = (entry: Route | Note | Flow) => ("id" in entry ? entry.id : entry.name);
const day = (time?: number) => (time ? new Date(time).toLocaleDateString() : "");
const stepLine = (step: Record<string, unknown>) =>
  [step.action, step.route ?? step.path ?? step.selector ?? step.text ?? step.key ?? step.expression, step.value !== undefined ? `= ${step.value}` : ""]
    .filter((part) => part !== undefined && part !== "")
    .map(String)
    .join(" ")
    .slice(0, 120);
const kinds: { kind: Kind; label: string }[] = [
  { kind: "route", label: "Routes" },
  { kind: "note", label: "Notes" },
  { kind: "flow", label: "Flows" },
];
</script>

<template>
  <div class="memory">
    <p class="memory-help">
      What the AI learned about websites. Entries the AI wrote stay
      <strong>unreviewed</strong> until you approve them, and flows only run
      once approved. Turned-off entries are kept but hidden from the AI.
    </p>
    <div class="memory-bar">
      <input
        v-model="query"
        class="memory-search"
        aria-label="Search site memory"
        placeholder="Search"
        spellcheck="false"
      />
      <button type="button" class="memory-icon" aria-label="Refresh memory" data-tip="Refresh" @click="refresh">
        <Icon name="refresh" :size="14" />
      </button>
    </div>
    <div v-if="sites.length" class="memory-sites" role="group" aria-label="Sites to show (none chosen shows all)">
      <button
        v-for="name in sites"
        :key="name"
        type="button"
        :aria-pressed="chosen.has(name)"
        @click="toggleSite(name)"
      >
        <Icon v-if="chosen.has(name)" name="check" :size="11" />{{ name
        }}<span v-if="name === currentSite" class="memory-here">this tab</span
        ><span
          v-if="memories.find((m) => m.site === name) && pending(memories.find((m) => m.site === name)!)"
          class="memory-count"
          :aria-label="`${pending(memories.find((m) => m.site === name)!)} to review`"
          >{{ pending(memories.find((m) => m.site === name)!) }}</span
        >
      </button>
      <button v-if="chosen.size" type="button" class="memory-clear" @click="chosen = new Set()">Show all</button>
    </div>
    <div class="memory-tabs" role="group" aria-label="Memory sections">
      <button
        v-for="k in kinds"
        :key="k.kind"
        type="button"
        :aria-pressed="tab === k.kind"
        @click="tab = k.kind; editing = null"
      >
        {{ k.label }} · {{ count(k.kind) }}
      </button>
    </div>

    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <p v-if="loaded && !shown.length" class="memory-empty">
      {{ query.trim() ? "Nothing matches." : "Nothing saved yet. Open a web page to add to its site." }}
    </p>

    <section v-for="m in shown" :key="m.site" class="memory-group" :aria-label="m.site">
      <header class="memory-group-head">
        <span class="memory-group-name">{{ m.site }}</span>
        <span v-if="m.site === currentSite" class="memory-here">this tab</span>
        <button
          v-if="!(editing && editing.site === m.site && !editing.key)"
          type="button"
          class="memory-add"
          :aria-label="`New ${tab} for ${m.site}`"
          @click="startNew(m.site)"
        >
          <Icon name="plus" :size="12" />New {{ tab }}
        </button>
      </header>

      <form
        v-if="editing && editing.site === m.site && editing.kind === tab"
        class="memory-form"
        @submit.prevent="submit"
        @keydown.esc.stop="editing = null"
      >
        <p class="memory-form-title">{{ editing.key ? "Edit" : "New" }} {{ editing.kind }}</p>
        <template v-if="editing.kind === 'note'">
          <textarea ref="firstField" v-model="form.text" aria-label="Note" rows="3" maxlength="300"
            placeholder="One fact about how the site works"></textarea>
        </template>
        <template v-else>
          <input ref="firstField" v-model="form.name" aria-label="Name" maxlength="60" placeholder="Name" />
          <input v-if="editing.kind === 'route'" v-model="form.path" aria-label="Path" maxlength="500"
            placeholder="/path/on/the/site?with={param}" spellcheck="false" />
          <input v-model="form.description" aria-label="Description" maxlength="200"
            :placeholder="editing.kind === 'flow' ? 'What the flow does' : 'Description (optional)'" />
          <template v-if="editing.kind === 'flow'">
            <input v-model="form.params" aria-label="Parameters" placeholder="Parameters, comma-separated (e.g. board)" spellcheck="false" />
            <textarea v-model="form.steps" aria-label="Steps" rows="8" class="memory-code" spellcheck="false"></textarea>
            <p class="memory-hint">
              Steps are browser actions: navigate (route or path), click, hover,
              fill, select, type, press, scroll, wait, read, eval; target with
              selector or text. Use {param} for inputs.
            </p>
          </template>
        </template>
        <p v-if="formError" class="memory-error" role="alert">{{ formError }}</p>
        <div class="memory-actions">
          <button type="submit" class="memory-primary">Save</button>
          <button type="button" @click="editing = null">Cancel</button>
        </div>
      </form>

      <p v-if="!entries(m).length && !(editing && editing.site === m.site)" class="memory-empty">
        {{ query.trim() ? "Nothing matches here." : `No ${tab}s yet.` }}
      </p>
      <ul v-else class="memory-list">
        <li v-for="entry in entries(m)" :key="keyOf(entry)" :class="{ off: entry.disabled }">
          <div class="memory-main">
            <div class="memory-title">
              <strong v-if="'name' in entry">{{ entry.name }}</strong>
              <span v-else class="memory-text">{{ (entry as Note).text }}</span>
              <span v-if="entry.disabled" class="memory-badge">Off</span>
              <span v-else-if="'approved' in entry ? !entry.approved : !entry.reviewed" class="memory-badge warn"
                >{{ 'approved' in entry ? "Needs approval" : "Unreviewed" }}</span
              >
              <span v-if="entry.failures" class="memory-badge bad" :title="entry.failNote">Broken</span>
            </div>
            <code v-if="'path' in entry">{{ entry.path }}</code>
            <span v-if="'description' in entry && entry.description" class="memory-sub">{{ entry.description }}</span>
            <ol v-if="'steps' in entry" class="memory-steps">
              <li v-for="(step, index) in entry.steps" :key="index">{{ stepLine(step) }}</li>
            </ol>
            <span class="memory-sub">
              {{ entry.source === "ai" ? "Saved by AI" : "Yours" }} · {{ day(entry.updatedAt) }}
              <template v-if="entry.failures"> · {{ entry.failNote }}</template>
              <template v-else-if="'lastOk' in entry && entry.lastOk"> · worked {{ day(entry.lastOk) }}</template>
            </span>
            <button
              v-if="'approved' in entry ? !entry.approved : !entry.reviewed"
              type="button"
              class="memory-approve"
              :aria-label="`Approve ${'name' in entry ? entry.name : 'note'}`"
              @click="act('approve', tab, m.site, keyOf(entry))"
            ><Icon name="check" :size="12" />Approve</button>
          </div>
          <div class="memory-buttons">
            <button type="button" class="memory-icon" :aria-label="`Edit ${'name' in entry ? entry.name : 'note'}`" data-tip="Edit"
              @click="startEdit(tab, m.site, entry)"><Icon name="edit" :size="13" /></button>
            <button type="button" class="memory-icon"
              :aria-label="entry.disabled ? `Turn on ${'name' in entry ? entry.name : 'note'}` : `Turn off ${'name' in entry ? entry.name : 'note'}`"
              :aria-pressed="!entry.disabled"
              :data-tip="entry.disabled ? 'Turn on' : 'Turn off'"
              @click="act('disable', tab, m.site, keyOf(entry), !entry.disabled)"><Icon :name="entry.disabled ? 'eye' : 'mute'" :size="13" /></button>
            <button type="button" class="memory-icon" :class="{ danger: confirming === `${tab}:${m.site}:${keyOf(entry)}` }"
              :aria-label="confirming === `${tab}:${m.site}:${keyOf(entry)}` ? 'Click again to delete' : `Delete ${'name' in entry ? entry.name : 'note'}`"
              :data-tip="confirming === `${tab}:${m.site}:${keyOf(entry)}` ? 'Click again to delete' : 'Delete'"
              @click="act('remove', tab, m.site, keyOf(entry))"
              @blur="confirming === `${tab}:${m.site}:${keyOf(entry)}` && (confirming = '')"><Icon name="trash" :size="13" /></button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.memory {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.memory > * {
  flex: none;
}
.memory-help {
  margin: 0;
  color: var(--faint);
  font-size: 11px;
  line-height: 1.6;
}
.memory-help strong {
  color: var(--sub);
  font-weight: 600;
}
.memory-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.memory-search,
.memory-form input,
.memory-form textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--low);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  resize: vertical;
}
.memory-search::placeholder,
.memory-form ::placeholder {
  color: var(--sub);
}
.memory-code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace !important;
  font-size: 11px !important;
}
.memory-sites {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.memory-sites button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 13px;
  color: var(--sub);
  font-size: 11px;
}
.memory-sites button[aria-pressed="true"] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--ink);
}
.memory-sites .memory-clear {
  border-style: dashed;
}
.memory-here {
  color: var(--faint);
  font-size: 10px;
}
.memory-count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
.memory-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  background: var(--low);
}
.memory-tabs button {
  flex: 1;
  height: 28px;
  border-radius: 6px;
  color: var(--sub);
  font-size: 11px;
}
.memory-tabs button[aria-pressed="true"] {
  background: var(--surface);
  box-shadow: 0 1px 3px rgb(64 92 111 / 7%);
  color: var(--ink);
}
.memory-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.memory-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  border-bottom: 1px solid var(--soft);
}
.memory-group-name {
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
}
.memory-add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  margin-left: auto;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--sub);
  font-size: 11px;
}
.memory-add:hover,
.memory-add:focus-visible {
  background: var(--hover);
  color: var(--ink);
}
.memory-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.memory-form-title {
  margin: 0;
  color: var(--sub);
  font-size: 11px;
  font-weight: 600;
}
.memory-hint {
  margin: 0;
  color: var(--faint);
  font-size: 11px;
  line-height: 1.5;
}
.memory-actions {
  display: flex;
  gap: 6px;
}
.memory-actions button {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--ink);
  font-size: 12px;
}
.memory-actions .memory-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.memory-error {
  margin: 0;
  color: #9a4b45;
  font-size: 11px;
  line-height: 1.5;
}
.memory-empty {
  margin: 0;
  color: var(--faint);
  font-size: 12px;
}
.memory-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.memory-list > li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--soft);
}
.memory-list > li:last-child {
  border-bottom: 0;
}
.memory-list > li.off .memory-main {
  opacity: 0.55;
}
.memory-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
  font-size: 12px;
}
.memory-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.memory-title strong {
  color: var(--ink);
  font-weight: 600;
}
.memory-text {
  color: var(--ink);
  line-height: 1.45;
}
.memory-main code {
  max-width: 100%;
  overflow: hidden;
  color: var(--sub);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.memory-sub {
  color: var(--faint);
  font-size: 11px;
  line-height: 1.45;
}
.memory-badge {
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--sub);
  font-size: 10px;
  line-height: 16px;
}
.memory-badge.warn {
  border-color: #d9c38f;
  color: #8a6d2c;
}
.memory-badge.bad {
  border-color: #e0b4ae;
  color: #9a4b45;
}
.memory-steps {
  margin: 2px 0;
  padding-left: 18px;
  color: var(--sub);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
}
.memory-approve {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  margin-top: 3px;
  padding: 0 9px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
}
.memory-buttons {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}
.memory-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--sub);
}
.memory-bar .memory-icon {
  width: 32px;
  height: 32px;
  border-radius: 7px;
}
.memory-icon:hover,
.memory-icon:focus-visible {
  background: var(--hover);
  color: var(--ink);
}
.memory-icon.danger {
  color: #9a4b45;
}
</style>
