<script setup lang="ts">
// Workspace options → Custom tools: the reusable tools agents saved
// (custom_tool_save; server/custom-tools.ts). Search, read what each one
// does, create, edit, turn off (kept, no longer offered to agents) or delete.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";

interface Param { type?: string; description?: string; optional?: boolean }
interface Tool {
  name: string;
  description: string;
  params?: Record<string, Param>;
  steps?: { tool: string; args?: unknown; as?: string }[];
  return?: unknown;
  code?: string;
  timeoutSeconds?: number;
  disabled?: boolean;
}
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
const tools = ref<Tool[]>([]);
const loaded = ref(false);
const error = ref("");
const query = ref("");
const open = ref("");

async function api(body: Record<string, unknown>) {
  const response = await fetch("/__orvane/custom-tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: "Custom tools are not available." }));
  if (!response.ok) throw Error(data.error || "Custom tools could not do that.");
  tools.value = (data.tools as Tool[]).sort((a, b) => a.name.localeCompare(b.name));
}
async function refresh() {
  try {
    await api({ action: "list" });
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loaded.value = true;
  }
}
// Agents may save tools while the panel is open: re-read now and then.
const poll = setInterval(() => {
  if (!editing.value && document.visibilityState === "visible") void refresh();
}, 4000);
// Dismiss on a press anywhere else, without stealing that press.
function outside(event: Event) {
  if (event.target instanceof Node && !panel.value?.contains(event.target)) emit("close");
}
onMounted(() => {
  void refresh();
  document.addEventListener("pointerdown", outside, true);
});
onBeforeUnmount(() => {
  clearInterval(poll);
  document.removeEventListener("pointerdown", outside, true);
});

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return tools.value.filter(
    (t) => !q || [t.name, t.description, t.code, JSON.stringify(t.steps ?? "")].some((v) => v?.toLowerCase().includes(q)),
  );
});
const kind = (t: Tool) => (t.steps ? `chain · ${t.steps.length} step${t.steps.length === 1 ? "" : "s"}` : "code");
const params = (t: Tool) =>
  Object.entries(t.params ?? {}).map(([name, p]) => `${name}${p.optional ? "?" : ""}: ${p.type ?? "string"}`).join(", ");

// ---- Editing: the definition as JSON (the same shape custom_tool_save takes) ----
const editing = ref<{ previous?: string } | null>(null);
const source = ref("");
const formError = ref("");
const editor = ref<HTMLTextAreaElement>();
function startNew() {
  editing.value = {};
  source.value = JSON.stringify(
    { name: "my_tool", description: "What the tool does", params: { query: { type: "string" } }, code: "return input.query;" },
    null,
    2,
  );
  formError.value = "";
  void nextTick(() => editor.value?.focus());
}
function startEdit(tool: Tool) {
  editing.value = { previous: tool.name };
  const { disabled: _off, ...definition } = tool;
  source.value = JSON.stringify(definition, null, 2);
  formError.value = "";
  void nextTick(() => editor.value?.focus());
}
async function save() {
  let tool: unknown;
  try {
    tool = JSON.parse(source.value);
  } catch {
    formError.value = "The definition is not valid JSON.";
    return;
  }
  try {
    await api({ action: "save", tool, ...(editing.value?.previous ? { previousName: editing.value.previous } : {}) });
    open.value = (tool as Tool).name;
    editing.value = null;
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  }
}
const confirming = ref("");
async function act(action: "disable" | "remove", tool: Tool) {
  if (action === "remove" && confirming.value !== tool.name) {
    confirming.value = tool.name;
    return;
  }
  confirming.value = "";
  try {
    await api(action === "remove" ? { action, name: tool.name } : { action, name: tool.name, value: !tool.disabled });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <section
    ref="panel"
    class="tools-panel floating-panel"
    aria-label="Custom tools"
    @keydown.esc.stop="editing ? (editing = null) : emit('close')"
    @wheel.stop
  >
    <header class="tools-head">
      <Icon name="code" :size="14" />
      <h2>Custom tools</h2>
      <button type="button" class="icon-button" aria-label="Close custom tools" @click="emit('close')">
        <Icon name="close" :size="13" />
      </button>
    </header>
    <p class="tools-help">
      Reusable tools agents saved, available to every connected agent as
      <code>custom_&lt;name&gt;</code>. Turned-off tools are kept but not offered to agents.
    </p>
    <div class="tools-bar">
      <input v-model="query" class="tools-input" aria-label="Search custom tools" placeholder="Search tools" spellcheck="false" />
      <button type="button" class="subtle-button" :disabled="!!editing" @click="startNew">
        <Icon name="plus" :size="13" />New tool
      </button>
    </div>

    <form v-if="editing" class="tools-form" @submit.prevent="save">
      <p class="tools-label">{{ editing.previous ? `Edit ${editing.previous}` : "New tool" }}</p>
      <textarea ref="editor" v-model="source" class="tools-input tools-code" aria-label="Tool definition" rows="14" spellcheck="false"></textarea>
      <p class="tools-hint">
        name, description, params {name: {type, description?, optional?}}, then either
        <code>code</code> (a code_run body reading input.param) or <code>steps</code>
        (a tools_chain, args may use <code v-pre>{{input.param}}</code>).
      </p>
      <p v-if="formError" class="tools-error" role="alert">{{ formError }}</p>
      <div class="tools-actions">
        <button type="submit" class="tools-primary">Save</button>
        <button type="button" class="subtle-button" @click="editing = null">Cancel</button>
      </div>
    </form>

    <p v-if="error" class="tools-error" role="alert">{{ error }}</p>
    <p v-if="loaded && !shown.length" class="tools-help">
      {{ query.trim() ? "No tool matches." : "No custom tools yet. Agents save them with custom_tool_save, or create one here." }}
    </p>
    <ul class="tools-list">
      <li v-for="tool in shown" :key="tool.name" :class="{ off: tool.disabled }">
        <div class="tools-row">
          <button
            type="button"
            class="tools-name"
            :aria-expanded="open === tool.name"
            @click="open = open === tool.name ? '' : tool.name"
          >
            <Icon name="right" :size="12" class="tools-caret" :class="{ open: open === tool.name }" />
            <strong>{{ tool.name }}</strong>
            <span class="tools-kind">{{ kind(tool) }}</span>
            <span v-if="tool.disabled" class="tools-badge">Off</span>
          </button>
          <div class="tools-buttons">
            <button type="button" class="icon-button" :aria-label="`Edit ${tool.name}`" title="Edit" :disabled="!!editing" @click="startEdit(tool)">
              <Icon name="edit" :size="13" />
            </button>
            <button
              type="button"
              class="icon-button"
              :aria-label="tool.disabled ? `Turn on ${tool.name}` : `Turn off ${tool.name}`"
              :aria-pressed="!tool.disabled"
              :title="tool.disabled ? 'Turn on' : 'Turn off'"
              @click="act('disable', tool)"
            >
              <Icon :name="tool.disabled ? 'eye' : 'mute'" :size="13" />
            </button>
            <button
              type="button"
              class="icon-button"
              :class="{ danger: confirming === tool.name }"
              :aria-label="confirming === tool.name ? 'Click again to delete' : `Delete ${tool.name}`"
              :title="confirming === tool.name ? 'Click again to delete' : 'Delete'"
              @click="act('remove', tool)"
              @blur="confirming === tool.name && (confirming = '')"
            >
              <Icon name="trash" :size="13" />
            </button>
          </div>
        </div>
        <p class="tools-desc">{{ tool.description }}</p>
        <div v-if="open === tool.name" class="tools-detail">
          <p v-if="params(tool)" class="tools-hint">Inputs: {{ params(tool) }}</p>
          <ol v-if="tool.steps" class="tools-steps">
            <li v-for="(step, index) in tool.steps" :key="index">
              <code>{{ step.tool }}</code>
              <span v-if="step.as"> → {{ step.as }}</span>
            </li>
          </ol>
          <pre v-else class="tools-pre">{{ tool.code }}</pre>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.tools-panel {
  position: fixed;
  z-index: 220;
  top: 64px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(560px, calc(100vw - 48px));
  max-height: calc(100vh - 160px);
  padding: 14px;
  overflow: auto;
  overscroll-behavior: contain;
}
.tools-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.tools-head h2 {
  flex: 1;
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}
.tools-help,
.tools-hint {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.55;
}
.tools-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tools-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 30px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #fff;
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.tools-bar .subtle-button {
  flex: none;
}
.tools-code,
.tools-pre {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
}
.tools-code {
  resize: vertical;
}
.tools-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.tools-label {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
}
.tools-actions {
  display: flex;
  gap: 6px;
}
.tools-primary {
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
}
.tools-error {
  margin: 0;
  color: #9a4b45;
  font-size: 11px;
  line-height: 1.5;
}
.tools-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.tools-list > li {
  padding: 8px 2px;
  border-bottom: 1px solid #edf1f3;
}
.tools-list > li.off .tools-name,
.tools-list > li.off .tools-desc {
  opacity: 0.55;
}
.tools-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tools-name {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 0;
  font-size: 12px;
  text-align: left;
}
.tools-caret {
  flex: none;
  color: var(--muted);
  transition: transform 0.15s;
}
.tools-caret.open {
  transform: rotate(90deg);
}
.tools-kind,
.tools-badge {
  color: var(--muted);
  font-size: 11px;
}
.tools-badge {
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 9px;
  font-size: 10px;
}
.tools-buttons {
  display: flex;
  flex: none;
}
.tools-buttons .danger {
  color: #9a4b45;
}
.tools-desc {
  margin: 2px 0 0 18px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}
.tools-detail {
  margin: 6px 0 0 18px;
}
.tools-steps {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 11px;
  line-height: 1.6;
}
.tools-pre {
  max-height: 260px;
  margin: 4px 0 0;
  padding: 8px;
  overflow: auto;
  border-radius: 6px;
  background: #eef2f4;
  white-space: pre-wrap;
}
@media (prefers-reduced-motion: reduce) {
  .tools-caret {
    transition: none;
  }
}
</style>
