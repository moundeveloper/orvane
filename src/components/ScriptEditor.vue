<script setup lang="ts">
// The script page's editor (Magic NetSuite's script detail, centre column):
// the script file and related files as tabs, Save (Ctrl+S) and History.
// Drafts and saved versions are the File Cabinet's own, so an unsaved edit
// shows in both places and survives a restart.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";
import NetSuiteFileEditor from "./NetSuiteFileEditor.vue";
import NetSuiteFileDiff from "./NetSuiteFileDiff.vue";
import { usePopover } from "./pickers/usePopover";
import {
  addVersion,
  clearVersions,
  findDraft,
  listVersions,
  loadFiles,
  removeDraft,
  removeVersion,
  updateDraft,
  type FileVersion,
} from "../netsuiteFiles";
import { message, typeLabel, type NetSuiteRequest, type Row } from "../netsuiteScripts";

const props = defineProps<{
  script: Row;
  environment: string;
  request: NetSuiteRequest;
  openRecord: (kind: string, id: unknown) => unknown;
}>();
const emit = defineEmits<{ error: [text: string] }>();
type Tab = { id: number; name: string; main?: boolean };
type Loaded = { content: string; binary: boolean; loading: boolean; error: string; folder?: string };
const relatedKey = computed(() => `orvane.netsuite.script-files.${props.environment}.${props.script.id}`);
const related = ref<Tab[]>([]);
function readRelated() {
  try {
    const list = JSON.parse(localStorage.getItem(relatedKey.value) ?? "[]");
    related.value = Array.isArray(list)
      ? list.filter((t) => Number.isSafeInteger(t?.id) && typeof t?.name === "string")
      : [];
  } catch {
    related.value = [];
  }
}
function storeRelated() {
  try {
    localStorage.setItem(relatedKey.value, JSON.stringify(related.value));
  } catch {
    /* only a convenience */
  }
}
const tabs = computed<Tab[]>(() => [
  ...(props.script.fileid
    ? [{ id: Number(props.script.fileid), name: String(props.script.scriptfile || "Script file"), main: true }]
    : []),
  ...related.value.filter((t) => t.id !== Number(props.script.fileid)),
]);
const activeId = ref(0);
const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? tabs.value[0]);
const files = shallowRef(new Map<number, Loaded>());
const loaded = computed(() => (active.value ? files.value.get(active.value.id) : undefined));
function setLoaded(id: number, value: Loaded) {
  const next = new Map(files.value);
  next.set(id, value);
  files.value = next;
}
async function load(tab: Tab, force = false) {
  if (!force && files.value.get(tab.id) && !files.value.get(tab.id)!.error) return;
  setLoaded(tab.id, { content: "", binary: false, loading: true, error: "" });
  try {
    const data = await props.request("file", { id: tab.id });
    setLoaded(tab.id, { content: String(data.content ?? ""), binary: !!data.binary, loading: false, error: "" });
  } catch (e) {
    setLoaded(tab.id, { content: "", binary: false, loading: false, error: message(e) });
  }
}
const draft = computed(() => (active.value ? findDraft(props.environment, active.value.id) : undefined));
const text = computed(() => draft.value?.content ?? loaded.value?.content ?? "");
const dirty = (id: number) => {
  const d = findDraft(props.environment, id);
  return !!d && d.content !== d.original;
};
/** The draft was started from content NetSuite no longer has. */
const stale = computed(
  () => !!draft.value && !!loaded.value && !loaded.value.loading && !loaded.value.error && draft.value.original !== loaded.value.content,
);
function edit(value: string) {
  const tab = active.value,
    file = loaded.value;
  if (!tab || !file || file.loading || file.error || file.binary) return;
  const current = findDraft(props.environment, tab.id);
  if (current) {
    if (value === current.original) return removeDraft(props.environment, tab.id);
    current.content = value;
    updateDraft(current);
  } else if (value !== file.content) {
    updateDraft({ environment: props.environment, id: tab.id, content: value, original: file.content });
  }
}
function discardDraft() {
  if (active.value) removeDraft(props.environment, active.value.id);
}
const saving = ref(false);
async function save() {
  const tab = active.value,
    current = draft.value,
    environment = props.environment;
  if (!tab || !current || current.content === current.original || saving.value) return;
  const { content, original } = current;
  saving.value = true;
  try {
    await props.request("save-file", { id: tab.id, content, original });
    versions.value = await addVersion(environment, tab.id, original, content);
    setLoaded(tab.id, { ...(files.value.get(tab.id) as Loaded), content });
    const latest = findDraft(environment, tab.id);
    if (latest?.content === content) removeDraft(environment, tab.id);
    else if (latest) {
      latest.original = content;
      updateDraft(latest);
    }
  } catch (e) {
    emit("error", message(e));
  } finally {
    saving.value = false;
  }
}
/* ---------- History ---------- */
const historyOpen = ref(false);
const versions = ref<FileVersion[]>([]);
const picked = ref<FileVersion | null>(null);
async function readVersions() {
  versions.value = active.value ? await listVersions(props.environment, active.value.id) : [];
  if (picked.value && !versions.value.some((v) => v.id === picked.value!.id)) picked.value = null;
}
function restore(version: FileVersion) {
  edit(version.content);
  picked.value = null;
  historyOpen.value = false;
}
async function deleteVersion(version: FileVersion) {
  await removeVersion(version);
  await readVersions();
}
async function clearHistory() {
  if (!active.value) return;
  await clearVersions(props.environment, active.value.id);
  await readVersions();
}
const when = (at: number) => {
  const d = new Date(at),
    today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
/* ---------- Related files ---------- */
// The search opens on <body>: inside the tab strip (overflow-x: auto) it was
// clipped to the strip's height and hidden behind the editor.
const addButton = ref<HTMLElement>(),
  addPopover = ref<HTMLElement>();
const { open: adding, style: addStyle, show: showAdd, close: closeAdd } = usePopover(addButton, addPopover, 340, { width: 30 });
const search = ref(""),
  found = ref<Row[]>([]),
  searching = ref(false),
  addField = ref<HTMLInputElement>();
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(searchTimer);
  if (value.trim().length < 2) {
    found.value = [];
    return;
  }
  searchTimer = setTimeout(async () => {
    searching.value = true;
    try {
      const data = await props.request("search-files", { search: value.trim().slice(0, 100) });
      if (search.value === value) found.value = (data.files ?? []) as Row[];
    } catch (e) {
      emit("error", message(e));
    } finally {
      searching.value = false;
    }
  }, 250);
});
async function openAdd() {
  showAdd();
  search.value = "";
  found.value = [];
  if (adding.value) {
    await nextTick();
    addField.value?.focus();
  }
}
function addRelated(file: Row) {
  const tab = { id: Number(file.id), name: String(file.name) };
  if (!tabs.value.some((t) => t.id === tab.id)) {
    related.value = [...related.value, tab];
    storeRelated();
  }
  adding.value = false;
  activeId.value = tab.id;
}
function closeRelated(tab: Tab) {
  related.value = related.value.filter((t) => t.id !== tab.id);
  storeRelated();
  if (activeId.value === tab.id) activeId.value = tabs.value[0]?.id ?? 0;
}
/* ---------- Wiring ---------- */
watch(
  () => [props.environment, props.script.id] as const,
  () => {
    readRelated();
    files.value = new Map();
    activeId.value = tabs.value[0]?.id ?? 0;
    historyOpen.value = false;
    picked.value = null;
    adding.value = false;
  },
  { immediate: true },
);
watch(
  active,
  (tab) => {
    if (tab) void load(tab);
    void readVersions();
  },
  { immediate: true },
);
function keys(event: KeyboardEvent) {
  if (event.altKey && !event.ctrlKey && event.key.toLowerCase() === "h") {
    event.preventDefault();
    historyOpen.value = !historyOpen.value;
    if (historyOpen.value) void readVersions();
  }
}
onMounted(() => void loadFiles());
onBeforeUnmount(() => clearTimeout(searchTimer));
defineExpose({ save });
</script>

<template>
  <section class="script-editor" aria-label="Script" @keydown="keys">
    <header class="se-head">
      <div class="se-who">
        <strong>{{ script.name }} <span class="se-pill">{{ typeLabel(script.scripttype) }}</span></strong>
        <span>{{ script.scriptid }} · #{{ script.id }}{{ script.scriptfile ? ` · ${script.scriptfile}` : "" }}</span>
      </div>
      <button type="button" class="se-btn" title="Open in NetSuite" @click="openRecord('script', script.id)">
        <Icon name="external" :size="13" />Open
      </button>
      <button
        type="button"
        class="se-btn se-primary"
        :disabled="!draft || draft.content === draft.original || saving"
        title="Save to NetSuite · Ctrl+S"
        @click="save"
      >
        <Icon name="save" :size="13" />{{ saving ? "Saving…" : "Save" }} <kbd>Ctrl S</kbd>
      </button>
    </header>
    <div class="se-tabs" role="tablist" aria-label="Script files">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="se-tab"
        :aria-selected="active?.id === tab.id"
        :title="tab.name"
        @click="activeId = tab.id"
      >
        <Icon :name="tab.main ? 'code' : 'file'" :size="13" />{{ tab.name }}<i v-if="dirty(tab.id)" class="se-mod" aria-label="unsaved" />
        <span
          v-if="!tab.main"
          class="se-tab-x"
          role="button"
          :aria-label="`Remove ${tab.name}`"
          @click.stop="closeRelated(tab)"
        ><Icon name="close" :size="11" /></span>
      </button>
      <span class="se-add-anchor">
        <button ref="addButton" type="button" class="se-icon" aria-label="Add related file" title="Add related file" :aria-expanded="adding" @click="openAdd">
          <Icon name="plus" :size="13" />
        </button>
        <Teleport to="body">
        <div v-if="adding" ref="addPopover" class="select-popover se-add" role="dialog" aria-label="Add related file" tabindex="-1" :style="addStyle" @keydown.esc.stop="closeAdd(true)">
          <label class="se-add-field">
            <Icon name="search" :size="13" />
            <input ref="addField" v-model="search" placeholder="Find a file in the File Cabinet" spellcheck="false" />
          </label>
          <p v-if="searching" class="se-add-note">Searching…</p>
          <p v-else-if="search.trim().length >= 2 && !found.length" class="se-add-note">No files match.</p>
          <button v-for="file in found.slice(0, 30)" :key="String(file.id)" type="button" class="se-add-row" @click="addRelated(file)">
            <Icon name="file" :size="13" /><b>{{ file.name }}</b><span>{{ file.foldername }}</span>
          </button>
        </div>
        </Teleport>
      </span>
    </div>
    <div class="se-status">
      <template v-if="loaded?.binary">Read-only binary file</template>
      <span v-else-if="draft && draft.content !== draft.original" class="se-unsaved"><i />Unsaved changes</span>
      <template v-else-if="loaded && !loaded.loading">Saved</template>
      <span v-if="stale" class="se-stale">Changed in NetSuite since this draft · <button type="button" @click="discardDraft">Discard draft</button></span>
      <span class="se-space" />
      <button
        type="button"
        class="se-btn se-small"
        :class="{ on: historyOpen }"
        :disabled="!active"
        title="Saved versions · Alt+H"
        @click="historyOpen = !historyOpen; historyOpen && readVersions()"
      >
        <Icon name="clock" :size="12" />History {{ versions.length }}
      </button>
    </div>
    <div v-if="historyOpen" class="se-history">
      <aside class="se-versions" aria-label="Saved versions">
        <p v-if="!versions.length" class="se-note">No saved versions yet. Each Save from Orvane keeps the content it replaced.</p>
        <button
          v-for="version in versions"
          :key="version.id"
          type="button"
          class="se-version"
          :aria-selected="picked?.id === version.id"
          @click="picked = picked?.id === version.id ? null : version"
        >
          <b>{{ when(version.savedAt) }}</b>
          <span class="se-delta"><span class="add">+{{ version.added }}</span> <span class="del">−{{ version.removed }}</span></span>
          <small>{{ version.lines }} lines</small>
        </button>
        <button v-if="versions.length" type="button" class="se-btn se-small se-danger" @click="clearHistory">Clear history</button>
      </aside>
      <div class="se-compare">
        <template v-if="picked">
          <div class="se-compare-bar">
            <span>{{ when(picked.savedAt) }} → editor</span>
            <span class="se-space" />
            <button type="button" class="se-btn se-small" @click="restore(picked)"><Icon name="undo" :size="12" />Restore this version</button>
            <button type="button" class="se-btn se-small se-danger" @click="deleteVersion(picked)">Delete version</button>
          </div>
          <NetSuiteFileDiff :left="picked.content" :right="text" :name="active?.name || ''" @close="picked = null" />
        </template>
        <p v-else class="se-note">Pick a version to compare it with the editor.</p>
      </div>
    </div>
    <div v-else class="se-code">
      <p v-if="!active" class="se-note">This script has no file in the File Cabinet.</p>
      <p v-else-if="loaded?.loading" class="se-note" role="status">Reading {{ active.name }}…</p>
      <p v-else-if="loaded?.error" class="se-note se-error" role="alert">
        {{ loaded.error }} <button type="button" class="se-btn se-small" @click="active && load(active, true)">Try again</button>
      </p>
      <p v-else-if="loaded?.binary" class="se-note">This file is binary and can't be edited here.</p>
      <NetSuiteFileEditor
        v-else-if="loaded"
        :key="`${environment}|${active.id}`"
        :model-value="text"
        :name="active.name"
        @update:model-value="edit"
        @save="save"
      />
    </div>
  </section>
</template>

<style scoped>
.script-editor {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  font-size: 12px;
}
.se-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 10px 12px 6px;
}
.se-who {
  flex: 1;
  min-width: 0;
}
.se-who strong {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  color: #273f50;
  font-size: 14.5px;
  font-weight: 600;
  white-space: nowrap;
}
.se-who > span {
  display: block;
  overflow: hidden;
  color: #8296a2;
  font: 11px "Cascadia Code", Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.se-pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 6px;
  background: #e6eef3;
  color: #385d76;
  font-size: 11px;
  font-weight: 500;
}
.se-btn {
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
  white-space: nowrap;
}
.se-btn:hover:not(:disabled),
.se-btn.on {
  background: #eef3f6;
}
.se-btn:disabled {
  opacity: 0.5;
}
.se-primary {
  border-color: #365f78;
  background: #365f78;
  color: #fff;
}
.se-primary:hover:not(:disabled) {
  background: #2f556c;
}
.se-primary kbd {
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
.se-small {
  height: 22px;
  padding: 0 7px;
  font-size: 11.5px;
}
.se-danger {
  color: #a0624f;
}
.se-icon {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: none;
  color: #6f8998;
}
.se-icon:hover {
  background: #eef3f6;
}
.se-tabs {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
  padding: 4px 10px 0;
  border-bottom: 1px solid #e3eaee;
  overflow-x: auto;
  scrollbar-width: none;
}
.se-tab {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px 7px 0 0;
  background: none;
  color: #5d7381;
  font: 12px "Cascadia Code", Consolas, monospace;
  white-space: nowrap;
}
.se-tab:hover {
  background: #eef3f6;
}
.se-tab[aria-selected="true"] {
  margin-bottom: -1px;
  border: 1px solid #e3eaee;
  border-bottom-color: #fff;
  background: #fff;
  color: #273f50;
}
.se-mod {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #b08a4a;
}
.se-tab-x {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: #8296a2;
  opacity: 0;
}
.se-tab:hover .se-tab-x,
.se-tab:focus-visible .se-tab-x {
  opacity: 1;
}
.se-tab-x:hover {
  background: #e1ebf1;
}
.se-add-anchor {
  position: relative;
  flex: none;
  align-self: center;
}
.se-add {
  width: 360px;
  max-height: 340px;
  padding: 6px;
  overflow: auto;
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
}
.se-add-field {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1.5px solid #7b97a7;
  border-radius: 8px;
  background: #fff;
  color: #8296a2;
}
.se-add-field input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: #273f50;
  font: 12px inherit;
  outline: none;
}
.se-add-note {
  margin: 0;
  padding: 8px;
  color: #8296a2;
}
.se-add-row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 0 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #6f8998;
  text-align: left;
}
.se-add-row:hover {
  background: #e4edf2;
}
.se-add-row b {
  overflow: hidden;
  color: #273f50;
  font: 500 12px "Cascadia Code", Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.se-add-row span {
  grid-column: 2;
  color: #8296a2;
  font-size: 11px;
}
.se-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 4px 12px;
  border-bottom: 1px solid #e3eaee;
  background: #fff;
  color: #8296a2;
  font-size: 11.5px;
  white-space: nowrap;
}
.se-unsaved {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #b08a4a;
}
.se-unsaved i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #b08a4a;
}
.se-stale {
  overflow: hidden;
  color: #a0624f;
  text-overflow: ellipsis;
}
.se-stale button {
  padding: 0;
  border: 0;
  background: none;
  color: #385d76;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.se-space {
  flex: 1;
}
.se-code {
  display: flex;
  min-height: 0;
  background: #fff;
}
.se-code > :deep(*) {
  flex: 1;
  min-width: 0;
}
.se-note {
  margin: 0;
  padding: 14px;
  color: #5d7381;
}
.se-error {
  color: #8c4637;
  white-space: pre-wrap;
}
.se-history {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  min-height: 0;
}
.se-versions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  padding: 6px;
  overflow: auto;
  border-right: 1px solid #e3eaee;
}
.se-version {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0 8px;
  padding: 6px 8px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: inherit;
  text-align: left;
}
.se-version:hover {
  background: #eef3f6;
}
.se-version[aria-selected="true"] {
  background: #e4edf2;
}
.se-version b {
  color: #273f50;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.se-version small {
  color: #8296a2;
  font-size: 11px;
}
.se-delta {
  grid-row: 1 / 3;
  grid-column: 2;
  align-self: center;
  font: 11px "Cascadia Code", Consolas, monospace;
}
.add {
  color: #3f6b4f;
}
.del {
  color: #7b3b2d;
}
.se-versions > .se-danger {
  align-self: flex-start;
  margin-top: 6px;
}
.se-compare {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  min-width: 0;
}
.se-compare-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid #e3eaee;
  color: #5d7381;
  font-size: 12px;
}
</style>
