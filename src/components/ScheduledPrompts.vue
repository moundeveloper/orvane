<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import {
  agentEditModeNames,
  agentEditModes,
  agentEfforts,
  agentNames,
  type AgentEditMode,
  type AgentEffort,
  type AgentProvider,
  type AgentSchedule,
} from "../agentSessions";
import { agentRequest } from "../exposition";
import {
  describeSchedule,
  nextOccurrence,
  type TriggerSchedule,
} from "../triggers";
import CustomNumber from "./CustomNumber.vue";
import CustomSelect from "./CustomSelect.vue";
import Icon from "./Icon.vue";
import TimePicker from "./pickers/TimePicker.vue";

const schedules = defineModel<AgentSchedule[]>({ required: true });
const props = defineProps<{
  loading?: boolean;
  modelOptions: (provider: AgentProvider) => { value: string; label: string }[];
}>();
const emit = defineEmits<{
  openSession: [id: string, provider: AgentProvider];
  loadModels: [provider: AgentProvider];
}>();

const filter = ref("");
const selected = ref("");
const cursor = ref("");
const pending = ref(false);
const error = ref("");
const root = ref<HTMLElement>();
const filterInput = ref<HTMLInputElement>();
const promptInput = ref<HTMLTextAreaElement>();
const providers = Object.entries(agentNames).map(([value, label]) => ({
  value,
  label,
}));
const repeat = [
  { value: "interval", label: "Interval" },
  { value: "daily", label: "Daily" },
];
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const efforts = [
  { value: "", label: "Provider default" },
  ...agentEfforts.map((value) => ({
    value,
    label: value[0]!.toUpperCase() + value.slice(1),
  })),
];
const draft = ref<{
  id?: string;
  prompt: string;
  provider: AgentProvider;
  folder: string;
  kind: TriggerSchedule["kind"];
  minutes: number;
  time: string;
  days: number[];
  model: string;
  effort: AgentEffort | "";
  mode: AgentEditMode;
}>();
const editModes = computed(() =>
  agentEditModes[draft.value?.provider ?? "claude"].map((value) => ({
    value,
    label: agentEditModeNames[value],
  })),
);
const modelOptions = computed(() => {
  if (!draft.value) return [];
  const { provider, model } = draft.value;
  const options = props.modelOptions(provider);
  return model && !options.some((option) => option.value === model)
    ? [...options, { value: model, label: model }]
    : options;
});
const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const folderName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const firstLine = (prompt: string) => prompt.split(/\r?\n/, 1)[0];
const lastLabel = {
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  running: "Running",
  stopping: "Stopping",
};

const groups = computed(() => {
  const now = Date.now();
  const today = new Date(now).toDateString();
  const query = filter.value.trim().toLowerCase();
  const grouped = { Failed: [], Today: [], Upcoming: [], Paused: [] } as Record<
    "Failed" | "Today" | "Upcoming" | "Paused",
    { item: AgentSchedule; next: number | null }[]
  >;
  for (const item of schedules.value) {
    if (!`${item.prompt} ${item.folder}`.toLowerCase().includes(query))
      continue;
    const next = nextOccurrence({ ...item, lastRun: item.lastOccurrence }, now);
    const group = !item.enabled
      ? "Paused"
      : item.lastStatus === "failed"
        ? "Failed"
        : next !== null && new Date(next).toDateString() === today
          ? "Today"
          : "Upcoming";
    grouped[group].push({ item, next });
  }
  return Object.entries(grouped).map(([label, rows]) => ({
    label,
    rows: rows.sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)),
  }));
});
const rows = computed(() =>
  groups.value.flatMap((group) => group.rows.map(({ item }) => item)),
);
const nextTime = (at: number | null) =>
  at === null
    ? "Paused"
    : `${new Date(at).toDateString() === new Date().toDateString() ? "Today" : weekday.format(at)} ${time.format(at)}`;

async function change(operation: string, args: Record<string, unknown>) {
  if (pending.value) return false;
  pending.value = true;
  error.value = "";
  try {
    schedules.value = (
      await agentRequest<{ schedules: AgentSchedule[] }>(operation, args)
    ).schedules;
    return true;
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Scheduled prompt could not be updated.";
    if (operation === "schedule-run") {
      const result = await agentRequest<{ schedules: AgentSchedule[] }>(
        "schedules",
      ).catch(() => null);
      if (result) schedules.value = result.schedules;
    }
    return false;
  } finally {
    pending.value = false;
  }
}

function edit(item?: AgentSchedule) {
  if (pending.value) return;
  const provider = item?.provider ?? "claude";
  emit("loadModels", provider);
  error.value = "";
  draft.value = {
    id: item?.id,
    prompt: item?.prompt ?? "",
    provider,
    folder: item?.folder ?? "",
    kind: item?.schedule.kind ?? "daily",
    minutes: item?.schedule.kind === "interval" ? item.schedule.minutes : 60,
    time: item?.schedule.kind === "daily" ? item.schedule.time : "09:00",
    days:
      item?.schedule.kind === "daily" ? [...(item.schedule.days ?? [])] : [],
    model: item?.model ?? "",
    effort: item?.effort ?? "",
    mode: item?.mode ?? agentEditModes[provider][0]!,
  };
  void nextTick(() => promptInput.value?.focus({ preventScroll: true }));
}
function changeProvider(provider: AgentProvider) {
  if (!draft.value || draft.value.provider === provider) return;
  draft.value.provider = provider;
  emit("loadModels", provider);
  draft.value.model = "";
  draft.value.mode = agentEditModes[provider][0]!;
}
function focusRow(id: string) {
  cursor.value = id;
  void nextTick(() =>
    root.value
      ?.querySelector<HTMLButtonElement>(`[data-schedule="${CSS.escape(id)}"]`)
      ?.focus(),
  );
}
function closeForm(id = draft.value?.id) {
  draft.value = undefined;
  error.value = "";
  if (id) focusRow(id);
  else void nextTick(() => filterInput.value?.focus({ preventScroll: true }));
}
async function save() {
  const value = draft.value;
  if (!value?.prompt.trim() || !value.folder.trim()) return;
  const {
    id,
    prompt,
    provider,
    folder,
    kind,
    minutes,
    time,
    days,
    model,
    effort,
    mode,
  } = value;
  const existing = new Set(schedules.value.map((item) => item.id));
  const schedule =
    kind === "interval" ? { kind, minutes } : { kind, time, days };
  if (
    await change("schedule-save", {
      id,
      prompt,
      provider,
      folder: folder.trim(),
      schedule,
      model: model.trim() || undefined,
      effort: effort || undefined,
      mode,
    })
  ) {
    selected.value =
      id ?? schedules.value.find((item) => !existing.has(item.id))?.id ?? "";
    filter.value = "";
    closeForm(selected.value);
  }
}
async function remove(id: string) {
  if (await change("schedule-delete", { id })) {
    selected.value = "";
    closeForm("");
  }
}
async function enable(item: AgentSchedule) {
  if (await change("schedule-enable", { id: item.id, enabled: !item.enabled }))
    focusRow(item.id);
}
const run = (item: AgentSchedule) => change("schedule-run", { id: item.id });
const isRunning = (item: AgentSchedule) => !!item.lastRunId && !item.lastStatus;
function toggle(item: AgentSchedule) {
  cursor.value = item.id;
  selected.value = selected.value === item.id ? "" : item.id;
}
function key(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented) return;
  if (draft.value) {
    if (event.key === "Escape" && !pending.value) closeForm();
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey))
      void save();
    else return;
  } else {
    const target = event.target as HTMLElement;
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      target.closest("input, textarea, [contenteditable]")
    )
      return;
    const index = rows.value.findIndex((item) => item.id === cursor.value);
    const current = rows.value[index] ?? rows.value[0];
    if (event.key === "n") edit();
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next =
        rows.value[
          index < 0
            ? 0
            : Math.max(0, Math.min(rows.value.length - 1, index + offset))
        ];
      if (next) focusRow(next.id);
    } else if (current && event.key === "e") edit(current);
    else if (current && event.key === "p") void enable(current);
    else if (
      current &&
      event.key === "Enter" &&
      target.matches("[data-schedule]") &&
      !isRunning(current)
    )
      void run(current);
    else return;
  }
  event.preventDefault();
  event.stopPropagation();
}
defineExpose({
  focus: () => filterInput.value?.focus({ preventScroll: true }),
  edit,
});
</script>

<template>
  <section
    ref="root"
    class="scheduled"
    aria-label="Scheduled prompts"
    @keydown="key"
  >
    <header v-if="!draft" class="sp-toolbar">
      <label>
        <Icon name="search" :size="15" />
        <input
          ref="filterInput"
          v-model="filter"
          aria-label="Filter scheduled prompts"
          placeholder="Filter by prompt, folder or skill"
        />
      </label>
      <button
        type="button"
        class="sp-button"
        :disabled="pending"
        @click="edit()"
      >
        <Icon name="plus" :size="13" />New <kbd>N</kbd>
      </button>
    </header>
    <p v-if="error" class="sp-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="sp-form" @submit.prevent="save">
      <h3>{{ draft.id ? "Edit scheduled prompt" : "New scheduled prompt" }}</h3>
      <label
        >Prompt<textarea
          ref="promptInput"
          v-model="draft.prompt"
          required
          maxlength="12000"
          rows="4"
        />
      </label>
      <label
        >Project folder<input
          v-model="draft.folder"
          required
          placeholder="Absolute path"
      /></label>
      <div class="sp-fields">
        <label
          >Provider<CustomSelect
            :model-value="draft.provider"
            :options="providers"
            aria-label="Provider"
            @update:model-value="changeProvider($event as AgentProvider)"
        /></label>
        <label
          >Model<CustomSelect
            v-model="draft.model"
            :options="modelOptions"
            aria-label="Model"
            search-label="Find a model"
        /></label>
        <label
          >Effort<CustomSelect
            v-model="draft.effort"
            :options="efforts"
            aria-label="Effort"
        /></label>
        <label
          >Edits<CustomSelect
            v-model="draft.mode"
            :options="editModes"
            aria-label="Edits"
        /></label>
        <label
          >Repeat<CustomSelect
            v-model="draft.kind"
            :options="repeat"
            aria-label="Repeat"
        /></label>
        <label v-if="draft.kind === 'interval'"
          >Minutes<CustomNumber
            v-model="draft.minutes"
            :min="1"
            :max="10080"
            aria-label="Minutes"
        /></label>
        <label v-else
          >Time<TimePicker v-model="draft.time" aria-label="Time"
        /></label>
      </div>
      <div
        v-if="draft.kind === 'daily'"
        class="sp-days"
        role="group"
        aria-label="Days, every day when none selected"
      >
        <button
          v-for="(day, index) in days"
          :key="day"
          type="button"
          class="sp-button"
          :aria-pressed="draft.days.includes(index)"
          @click="
            draft.days = draft.days.includes(index)
              ? draft.days.filter((d) => d !== index)
              : [...draft.days, index]
          "
        >
          {{ day }}
        </button>
      </div>
      <div class="sp-actions sp-form-actions">
        <button
          v-if="draft.id"
          type="button"
          class="sp-button sp-delete"
          :disabled="pending"
          @click="remove(draft.id)"
        >
          Delete
        </button>
        <button
          type="button"
          class="sp-button"
          :disabled="pending"
          @click="closeForm()"
        >
          Cancel <kbd>Esc</kbd>
        </button>
        <button
          type="submit"
          class="sp-button primary"
          :disabled="pending || !draft.prompt.trim() || !draft.folder.trim()"
        >
          Save <kbd>Ctrl+Enter</kbd>
        </button>
      </div>
    </form>
    <div v-else class="sp-list">
      <p v-if="!rows.length" class="sp-empty">
        {{
          loading
            ? "Loading scheduled prompts…"
            : filter
              ? "No matching prompts."
              : "No scheduled prompts."
        }}
      </p>
      <section
        v-for="{ label, rows: items } in groups"
        v-show="items.length"
        :key="label"
      >
        <h3 :class="{ failed: label === 'Failed' }">{{ label }}</h3>
        <div
          v-for="{ item, next } in items"
          :key="item.id"
          class="sp-entry"
          :class="{ open: selected === item.id }"
        >
          <button
            type="button"
            class="sp-row"
            :data-schedule="item.id"
            :aria-expanded="selected === item.id"
            @focus="cursor = item.id"
            @click="toggle(item)"
          >
            <span
              class="sp-dot"
              :class="{
                failed: item.lastStatus === 'failed',
                done: item.lastStatus === 'completed' || isRunning(item),
              }"
              aria-hidden="true"
            />
            <span class="sp-line">{{ firstLine(item.prompt) }}</span>
            <span class="sp-folder" :title="item.folder">{{
              folderName(item.folder)
            }}</span>
            <time class="sp-when">{{
              isRunning(item) ? "Running" : nextTime(next)
            }}</time>
          </button>
          <div v-if="selected === item.id" class="sp-detail">
            <p class="sp-prompt">{{ item.prompt }}</p>
            <div class="sp-facts">
              <span>{{ describeSchedule(item.schedule) }}</span>
              <span
                >{{ agentNames[item.provider] }} ·
                <b>{{ item.model || "Provider default" }}</b></span
              >
              <span
                >Edits
                <b>{{
                  agentEditModeNames[
                    item.mode ?? agentEditModes[item.provider][0]!
                  ]
                }}</b></span
              >
              <span>New session each run</span>
            </div>
            <div class="sp-actions">
              <button
                type="button"
                class="sp-button"
                :disabled="pending"
                @click="enable(item)"
              >
                {{ item.enabled ? "Pause" : "Resume" }} <kbd>P</kbd>
              </button>
              <button
                type="button"
                class="sp-button"
                :disabled="pending"
                @click="edit(item)"
              >
                Edit <kbd>E</kbd>
              </button>
              <button
                type="button"
                class="sp-button primary"
                :disabled="pending || isRunning(item)"
                @click="run(item)"
              >
                Run now <kbd>Enter</kbd>
              </button>
            </div>
            <div v-if="item.lastRun" class="sp-last">
              <Icon
                v-if="item.lastStatus === 'completed'"
                name="check"
                :size="12"
              />
              <span
                >Last run {{ new Date(item.lastRun).toLocaleString() }} ·
                {{ lastLabel[item.lastStatus ?? "running"] }}</span
              >
              <button
                v-if="item.lastSessionId"
                type="button"
                class="sp-link"
                @click="
                  emit(
                    'openSession',
                    item.lastSessionId,
                    item.lastSessionProvider ?? item.provider,
                  )
                "
              >
                Open session
              </button>
              <span v-if="item.lastError" class="failed">{{
                item.lastError
              }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
    <footer v-if="!draft">
      <span
        >{{ schedules.length }} scheduled · run while Orvane is open or in the
        tray</span
      >
      <span><kbd>↑</kbd> <kbd>↓</kbd> Move</span
      ><span><kbd>Enter</kbd> Run now</span
      ><span><kbd>Space</kbd> Details</span>
    </footer>
  </section>
</template>

<style scoped>
.scheduled {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  color: #455968;
  font-size: 13px;
}
.sp-toolbar,
footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 0 18px;
  border-bottom: 1px solid #e3eaee;
}
.sp-toolbar label {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  color: #6f8998;
}
.sp-toolbar input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 4px 0;
}
input,
textarea {
  font: inherit;
  color: #273f50;
}
.sp-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 9px;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  font: inherit;
  font-size: 12px;
  color: #273f50;
  white-space: nowrap;
  cursor: pointer;
}
.sp-button:hover {
  background: #eef3f6;
}
.sp-button:disabled {
  opacity: 0.55;
  cursor: default;
}
.primary,
.primary:hover {
  background: #365f78;
  border-color: #365f78;
  color: white;
}
.primary kbd {
  background: #4b7590;
  border-color: #5f86a0;
  color: #e9f1f6;
}
kbd {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  font:
    10.5px/1 "Cascadia Code",
    Consolas,
    monospace;
  color: #5d7381;
}
.sp-list,
.sp-form {
  flex: 1;
  overflow: auto;
  padding: 8px 12px;
}
h3 {
  margin: 10px 8px 4px;
  font-size: 12px;
  font-weight: 600;
  color: #5d7381;
}
.sp-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) minmax(0, auto) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  font: inherit;
  text-align: left;
  color: #273f50;
  cursor: pointer;
}
.sp-row:hover {
  background: #eef3f6;
}
.sp-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid #a9bcc7;
  justify-self: center;
}
.sp-dot.failed {
  border-color: #a0624f;
}
.sp-dot.done {
  background: #6f8998;
  border-color: #6f8998;
}
.sp-line,
.sp-folder {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sp-folder {
  max-width: 110px;
  font:
    11px "Cascadia Code",
    Consolas,
    monospace;
  color: #647b89;
}
.sp-when {
  min-width: 92px;
  text-align: right;
  font-size: 11.5px;
  color: #5d7381;
  font-variant-numeric: tabular-nums;
}
.sp-entry.open {
  margin: 2px 0 6px;
  border-radius: 8px;
  background: #e4edf2;
}
.sp-detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  padding: 2px 12px 12px 38px;
}
.sp-prompt {
  flex-basis: 100%;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sp-facts,
.sp-last,
.sp-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.sp-facts,
.sp-last {
  color: #5d7381;
  font-size: 11.5px;
}
.sp-facts {
  flex: 1 1 190px;
  gap: 6px 14px;
}
.sp-facts b {
  color: #273f50;
  font-weight: 550;
}
.sp-last {
  flex-basis: 100%;
  overflow-wrap: anywhere;
}
.sp-last svg {
  color: #4f7d5f;
}
.sp-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: #385d76;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.failed,
.sp-error,
.sp-delete {
  color: #934f3e;
}
.sp-error,
.sp-empty {
  margin: 8px 18px;
}
footer {
  min-height: 34px;
  border-top: 1px solid #e3eaee;
  border-bottom: 0;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 11px;
  color: #647b89;
}
footer span:first-child {
  margin-right: auto;
}
footer span {
  white-space: nowrap;
}
.sp-form {
  display: grid;
  align-content: start;
  gap: 12px;
  padding: 14px 18px;
}
.sp-form h3 {
  margin: 0;
  color: #273f50;
}
.sp-form label {
  display: grid;
  align-content: start;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
}
.sp-form input,
textarea {
  min-width: 0;
  padding: 6px 8px;
  background: #fbfcfd;
  border: 1px solid #d3dee5;
  border-radius: 7px;
}
textarea {
  resize: vertical;
}
.sp-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.sp-days {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sp-days [aria-pressed="true"] {
  background: #dce8ef;
  border-color: #a9bcc7;
}
.sp-form-actions {
  justify-content: flex-end;
}
.sp-delete {
  margin-right: auto;
}
button:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
</style>
