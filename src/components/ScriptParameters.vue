<script setup lang="ts">
// A deployment's custscript parameters (Magic NetSuite's "Deployment
// Parameters"): loaded from the deployment record, edited in place, saved
// with Ctrl+S. Opens beside its button; Esc or a click outside closes it.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { message, type NetSuiteRequest, type Row } from "../netsuiteScripts";

const props = defineProps<{
  deployment: Row;
  anchor: HTMLElement;
  request: NetSuiteRequest;
}>();
const emit = defineEmits<{ close: [] }>();
type Parameter = {
  id: string;
  label: string;
  type: string | null;
  value: unknown;
  text: string | null;
  draft: string | boolean;
};
const panel = ref<HTMLElement>();
const parameters = ref<Parameter[]>([]);
const loading = ref(true),
  saving = ref(false),
  error = ref(""),
  saved = ref("");
const position = ref({ top: 0, left: 0 });
const checkbox = (p: Parameter) => String(p.type).toLowerCase() === "checkbox";
const long = (p: Parameter) =>
  ["textarea", "longtext", "richtext", "clobtext"].includes(String(p.type).toLowerCase());
/** Select fields are edited by internal ID; their text shows what it is. */
const select = (p: Parameter) =>
  ["select", "multiselect"].includes(String(p.type).toLowerCase());
function initial(p: { type: string | null; value: unknown }): string | boolean {
  if (String(p.type).toLowerCase() === "checkbox") return p.value === true || p.value === "T";
  if (Array.isArray(p.value)) return p.value.join(", ");
  return p.value === null || p.value === undefined ? "" : String(p.value);
}
const changed = computed(() =>
  parameters.value.filter((p) => p.draft !== initial(p)),
);
function submitValue(p: Parameter) {
  if (checkbox(p)) return p.draft === true;
  const text = String(p.draft);
  if (String(p.type).toLowerCase() === "multiselect")
    return text.split(",").map((part) => part.trim()).filter(Boolean);
  if (["integer", "float", "currency", "percent"].includes(String(p.type).toLowerCase()) && text.trim() !== "") {
    const n = Number(text.replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return text;
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const data = await props.request("deployment-parameters", {
      deploymentId: Number(props.deployment.primarykey),
    });
    parameters.value = ((data.parameters ?? []) as Row[]).map((p) => ({
      id: String(p.id),
      label: String(p.label || p.id),
      type: p.type ?? null,
      value: p.value,
      text: p.text ?? null,
      draft: initial({ type: p.type ?? null, value: p.value }),
    }));
  } catch (e) {
    error.value = message(e);
  } finally {
    loading.value = false;
    await nextTick();
    panel.value?.querySelector<HTMLElement>("input, textarea, button.sp-toggle")?.focus({ preventScroll: true });
  }
}
async function save() {
  if (saving.value || !changed.value.length) return;
  saving.value = true;
  error.value = "";
  try {
    const values = Object.fromEntries(changed.value.map((p) => [p.id, submitValue(p)]));
    await props.request("save-deployment-parameters", {
      deploymentId: Number(props.deployment.primarykey),
      values,
    });
    saved.value = `${changed.value.length} saved`;
    await load();
  } catch (e) {
    error.value = message(e);
  } finally {
    saving.value = false;
  }
}
function place() {
  const rect = props.anchor.getBoundingClientRect();
  const width = 340;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  const below = rect.bottom + 6;
  const top = below + 320 > window.innerHeight ? Math.max(8, rect.top - 6 - 320) : below;
  position.value = { top, left };
}
function key(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    event.stopPropagation();
    void save();
  }
}
function outside(event: PointerEvent) {
  const path = event.composedPath();
  if (panel.value && !path.includes(panel.value) && !path.includes(props.anchor)) emit("close");
}
onMounted(() => {
  place();
  void load();
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", place);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", place);
});
</script>

<template>
  <Teleport to="body">
    <section
      ref="panel"
      class="select-popover script-parameters"
      role="dialog"
      aria-label="Deployment parameters"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      @keydown="key"
    >
      <header>
        <strong>Parameters</strong>
        <span :title="String(deployment.scriptid)">{{ deployment.scriptid }}</span>
        <button type="button" class="sp-icon" aria-label="Close parameters" @click="emit('close')">
          <Icon name="close" :size="13" />
        </button>
      </header>
      <div class="sp-body">
        <p v-if="loading && !parameters.length" class="sp-note" role="status">Reading the deployment…</p>
        <!-- A failed save keeps the edited fields below so it can be retried. -->
        <p v-if="error" class="sp-note sp-error" role="alert">{{ error }}</p>
        <p v-if="!loading && !error && !parameters.length" class="sp-note">
          This deployment has no <code>custscript</code> parameters.
        </p>
        <label v-for="p in parameters" :key="p.id" class="sp-field">
          <span class="sp-label"><b>{{ p.label }}</b><code>{{ p.id }}</code></span>
          <button
            v-if="checkbox(p)"
            type="button"
            class="sp-toggle"
            role="switch"
            :aria-checked="p.draft === true"
            @click="p.draft = p.draft !== true"
          ><i />{{ p.draft === true ? "Yes" : "No" }}</button>
          <textarea v-else-if="long(p)" v-model="(p.draft as string)" rows="3" spellcheck="false" />
          <input v-else v-model="(p.draft as string)" spellcheck="false" />
          <small v-if="select(p) && p.text" class="sp-hint">{{ p.text }}</small>
        </label>
      </div>
      <footer>
        <span>{{ saving ? "Saving…" : changed.length ? `${changed.length} change${changed.length === 1 ? "" : "s"}` : saved }}</span>
        <button type="button" class="sp-btn" @click="emit('close')">Cancel</button>
        <button type="button" class="sp-btn sp-primary" :disabled="!changed.length || saving" @click="save">
          Save <kbd>Ctrl S</kbd>
        </button>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
.script-parameters {
  position: fixed;
  z-index: 260;
  width: 340px;
  max-height: min(460px, calc(100vh - 16px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  padding: 0;
  overflow: hidden;
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
  color: #455968;
  font-size: 12px;
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px 12px;
}
header {
  border-bottom: 1px solid #e3eaee;
}
header strong {
  color: #273f50;
  font-size: 12.5px;
}
header span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8296a2;
  font: 11px "Cascadia Code", Consolas, monospace;
}
footer {
  border-top: 1px solid #e3eaee;
  background: #f4f7f9;
}
footer span {
  flex: 1;
  color: #8296a2;
  font-size: 11.5px;
}
.sp-body {
  overflow: auto;
  padding: 4px 0;
}
.sp-note {
  margin: 0;
  padding: 12px;
  color: #5d7381;
}
.sp-error {
  color: #8c4637;
  white-space: pre-wrap;
}
.sp-field {
  display: grid;
  gap: 3px;
  padding: 6px 12px;
}
.sp-label {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.sp-label b {
  color: #5d7381;
  font-weight: 500;
  font-size: 11.5px;
}
.sp-label code,
.sp-body code {
  color: #8296a2;
  font: 10.5px "Cascadia Code", Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sp-field input,
.sp-field textarea {
  width: 100%;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid #dbe5eb;
  border-radius: 7px;
  background: #fff;
  color: #273f50;
  font: 12px "Cascadia Code", Consolas, monospace;
  resize: vertical;
}
.sp-field input:focus,
.sp-field textarea:focus {
  outline: none;
  border-color: #7b97a7;
  box-shadow: 0 0 0 3px #6f89981a;
}
.sp-hint {
  color: #8296a2;
  font-size: 11px;
}
.sp-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 0;
  border: 0;
  background: none;
  color: #273f50;
  font-size: 12px;
}
.sp-toggle i {
  position: relative;
  width: 28px;
  height: 16px;
  border-radius: 9px;
  background: #c5d1d8;
  transition: background 120ms ease-out;
}
.sp-toggle i::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  transition: transform 120ms ease-out;
}
.sp-toggle[aria-checked="true"] i {
  background: #365f78;
}
.sp-toggle[aria-checked="true"] i::after {
  transform: translateX(12px);
}
.sp-icon {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #6f8998;
}
.sp-icon:hover {
  background: #eef3f6;
}
.sp-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  color: #455968;
  font-size: 12px;
}
.sp-btn:hover:not(:disabled) {
  background: #eef3f6;
}
.sp-primary {
  border-color: #365f78;
  background: #365f78;
  color: #fff;
}
.sp-primary:hover:not(:disabled) {
  background: #2f556c;
}
.sp-btn:disabled {
  opacity: 0.5;
}
.sp-primary kbd {
  display: inline-grid;
  place-items: center;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #ffffff40;
  border-radius: 4px;
  background: #ffffff26;
  color: #fff;
  font: 10.5px/1 "Cascadia Code", Consolas, monospace;
}
@media (prefers-reduced-motion: reduce) {
  .sp-toggle i,
  .sp-toggle i::after {
    transition: none;
  }
}
</style>
