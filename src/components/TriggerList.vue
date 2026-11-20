<script setup lang="ts">
// Action library → the selected workflow's scheduled triggers (src/triggers.ts):
// see when each runs next, when it last ran and its last error; pause, run
// now, edit or delete it, and add new ones. Agents use trigger_* for the same.
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { uid, type Workspace } from "../model";
import { describeSchedule, nextOccurrence, type Trigger, type TriggerSchedule } from "../triggers";
import Icon from "./Icon.vue";
import CustomSelect from "./CustomSelect.vue";
import CustomNumber from "./CustomNumber.vue";
import TimePicker from "./pickers/TimePicker.vue";

const props = defineProps<{
  workspace: Workspace;
  workflowId: string;
  writable: boolean;
  runTrigger?: (id: string) => Promise<unknown>;
}>();

const workflow = computed(() => props.workspace.actions?.find((a) => a.id === props.workflowId));
const triggers = computed(() => (props.workspace.triggers || []).filter((t) => t.workflowId === props.workflowId));

// "Next" and "ago" texts stay current while the library is open.
const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 30_000);
onBeforeUnmount(() => clearInterval(clock));

const DAYS = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];
const REPEAT = [
  { value: "interval", label: "Every few minutes" },
  { value: "daily", label: "At a time of day" },
];

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function when(at: number) {
  const date = new Date(at),
    today = new Date(now.value);
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return `today ${time(at)}`;
  if (days === 1) return `tomorrow ${time(at)}`;
  if (days === -1) return `yesterday ${time(at)}`;
  return `${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time(at)}`;
}
function ago(at: number) {
  const minutes = Math.floor((now.value - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return when(at);
}
function nextText(trigger: Trigger) {
  if (!trigger.enabled) return "Paused";
  const at = nextOccurrence(trigger, now.value);
  return at === null ? "No run scheduled" : `Next ${when(at)}`;
}

// ---- Run now ----
const running = reactive<Record<string, boolean>>({});
const message = ref("");
async function runNow(trigger: Trigger) {
  if (!props.writable || !props.runTrigger || running[trigger.id]) return;
  running[trigger.id] = true;
  message.value = "";
  try {
    await props.runTrigger(trigger.id);
    message.value = `${trigger.name} ran.`;
  } catch (error) {
    message.value = error instanceof Error ? error.message : "The run failed.";
  } finally {
    delete running[trigger.id];
    now.value = Date.now();
  }
}

function togglePaused(trigger: Trigger) {
  if (!props.writable) return;
  trigger.enabled = !trigger.enabled;
}
function remove(trigger: Trigger) {
  if (!props.writable || running[trigger.id]) return;
  props.workspace.triggers = (props.workspace.triggers || []).filter((t) => t.id !== trigger.id);
  if (editing.value === trigger.id) cancel();
}

// ---- Add / edit ----
// editing: a trigger ID, "new", or "" when the form is closed.
const editing = ref("");
const draft = reactive({
  name: "",
  kind: "interval" as TriggerSchedule["kind"],
  minutes: 15,
  time: "09:00",
  days: [] as number[],
  inputs: {} as Record<string, string>,
});
const formError = ref("");
function open(trigger?: Trigger) {
  if (!props.writable) return;
  const inputs = Object.fromEntries((workflow.value?.inputs || []).map((name) => [name, trigger?.inputs[name] ?? ""]));
  Object.assign(draft, {
    name: trigger?.name ?? workflow.value?.name ?? "Trigger",
    kind: trigger?.schedule.kind ?? "interval",
    minutes: trigger?.schedule.kind === "interval" ? trigger.schedule.minutes : 15,
    time: trigger?.schedule.kind === "daily" ? trigger.schedule.time : "09:00",
    days: trigger?.schedule.kind === "daily" ? [...(trigger.schedule.days || [])] : [],
    inputs,
  });
  formError.value = "";
  editing.value = trigger?.id ?? "new";
}
function cancel() {
  editing.value = "";
  formError.value = "";
}
function toggleDay(day: number) {
  draft.days = draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day];
}
function save() {
  if (!props.writable || !workflow.value) return;
  const name = draft.name.trim();
  if (!name || name.length > 120) return void (formError.value = "Give the trigger a name (up to 120 characters).");
  if (draft.kind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time))
    return void (formError.value = "Choose a time of day.");
  const schedule: TriggerSchedule =
    draft.kind === "interval"
      ? { kind: "interval", minutes: Math.min(10080, Math.max(1, Math.round(draft.minutes))) }
      : {
          kind: "daily",
          time: draft.time,
          // Every day selected is the same as none: run daily.
          ...(draft.days.length && draft.days.length < 7 ? { days: [...draft.days].sort() } : {}),
        };
  const inputs = Object.fromEntries(workflow.value.inputs.map((input) => [input, draft.inputs[input] ?? ""]));
  props.workspace.triggers ||= [];
  const existing = props.workspace.triggers.find((t) => t.id === editing.value);
  if (existing) {
    // A changed schedule starts counting again from now (as trigger_set does).
    if (JSON.stringify(existing.schedule) !== JSON.stringify(schedule)) {
      existing.createdAt = Date.now();
      delete existing.lastRun;
    }
    Object.assign(existing, { name, schedule, inputs });
  } else
    props.workspace.triggers.push({
      id: uid(),
      name,
      workflowId: workflow.value.id,
      inputs,
      enabled: true,
      schedule,
      createdAt: Date.now(),
    });
  cancel();
}
// One list: each trigger's row, or the form in its place while it is edited;
// a new trigger's form comes last.
const rows = computed(() => [
  ...triggers.value.map((trigger) =>
    editing.value === trigger.id ? { key: `form-${trigger.id}`, trigger: undefined } : { key: trigger.id, trigger },
  ),
  ...(editing.value === "new" ? [{ key: "form-new", trigger: undefined }] : []),
]);
// Switching workflow closes the form.
watch(() => props.workflowId, cancel);
</script>

<template>
  <section class="trigger-list" aria-label="Triggers">
    <header class="trigger-list-header">
      <h2>Triggers</h2>
      <button
        class="subtle-button"
        :disabled="!writable || editing === 'new'"
        aria-label="Add trigger"
        @click="open()"
      >
        <Icon name="plus" :size="13" />Add
      </button>
    </header>
    <p v-if="!triggers.length && editing !== 'new'" class="field-help">
      Run this action by itself on a schedule, also while Orvane sits in the tray.
    </p>
    <template v-for="{ key, trigger } in rows" :key="key">
      <article
        v-if="trigger"
        class="trigger-row"
        :class="{ paused: !trigger.enabled }"
        :aria-label="`Trigger ${trigger.name}`"
      >
        <div class="trigger-title">
          <Icon name="clock" :size="13" /><span>{{ trigger.name }}</span>
        </div>
        <p class="trigger-meta">{{ describeSchedule(trigger.schedule) }} · {{ nextText(trigger) }}</p>
        <p class="trigger-meta">{{ trigger.lastRun ? `Last ran ${ago(trigger.lastRun)}` : "Not run yet" }}</p>
        <p v-if="trigger.lastError" class="trigger-error" role="status">{{ trigger.lastError }}</p>
        <div class="trigger-actions" :inert="!writable">
          <button class="subtle-button" @click="togglePaused(trigger)">
            {{ trigger.enabled ? "Pause" : "Resume" }}
          </button>
          <button class="subtle-button" :disabled="!!running[trigger.id] || !runTrigger" @click="runNow(trigger)">
            <Icon name="play" :size="12" />{{ running[trigger.id] ? "Running…" : "Run now" }}
          </button>
          <button class="icon-button" :aria-label="`Edit trigger ${trigger.name}`" title="Edit" @click="open(trigger)">
            <Icon name="edit" :size="13" />
          </button>
          <button
            class="icon-button"
            :aria-label="`Delete trigger ${trigger.name}`"
            title="Delete"
            :disabled="!!running[trigger.id]"
            @click="remove(trigger)"
          >
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </article>
      <form
      v-else
      class="trigger-form"
      :aria-label="editing === 'new' ? 'New trigger' : 'Edit trigger'"
      @submit.prevent="save"
      @keydown.esc.stop.prevent="cancel"
    >
      <label class="property"
        ><span>Name</span><input v-model="draft.name" aria-label="Trigger name" maxlength="120"
      /></label>
      <label class="property"
        ><span>Repeat</span
        ><CustomSelect v-model="draft.kind" aria-label="Trigger repeat" :options="REPEAT"
      /></label>
      <label v-if="draft.kind === 'interval'" class="property"
        ><span>Every (minutes)</span
        ><CustomNumber v-model="draft.minutes" aria-label="Trigger minutes" :min="1" :max="10080"
      /></label>
      <template v-else>
        <label class="property"
          ><span>Time</span><TimePicker v-model="draft.time" aria-label="Trigger time"
        /></label>
        <div class="property">
          <span>Days (none = every day)</span>
          <div class="trigger-days" role="group" aria-label="Trigger days">
            <button
              v-for="d in DAYS"
              :key="d.day"
              type="button"
              class="trigger-day"
              :class="{ on: draft.days.includes(d.day) }"
              :aria-pressed="draft.days.includes(d.day)"
              @click="toggleDay(d.day)"
            >
              {{ d.label }}
            </button>
          </div>
        </div>
      </template>
      <label v-for="input in workflow?.inputs || []" :key="input" class="property"
        ><span>Input: {{ input }}</span
        ><input v-model="draft.inputs[input]" :aria-label="`Trigger input ${input}`"
      /></label>
      <p v-if="formError" class="trigger-error" role="alert">{{ formError }}</p>
      <div class="trigger-actions">
        <button type="submit" class="subtle-button trigger-save">Save trigger</button>
        <button type="button" class="subtle-button" @click="cancel">Cancel</button>
      </div>
      </form>
    </template>
    <p v-if="message" class="field-help" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.trigger-list {
  margin-top: 22px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.trigger-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.trigger-list-header h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.trigger-row,
.trigger-form {
  margin-top: 10px;
  padding: 10px;
  border-radius: 6px;
  background: #eef2f5;
}
.trigger-row.paused .trigger-title,
.trigger-row.paused .trigger-meta {
  color: var(--muted);
}
.trigger-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 600;
}
.trigger-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trigger-meta {
  margin: 4px 0 0;
  font-size: 11px;
  color: #556c7b;
}
.trigger-error {
  margin: 6px 0 0;
  font-size: 11px;
  color: #a2463b;
  overflow-wrap: anywhere;
}
.trigger-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
}
.trigger-actions .icon-button {
  width: 26px;
  height: 26px;
}
.trigger-actions .icon-button:first-of-type {
  margin-left: auto;
}
.trigger-form .property {
  margin: 0 0 10px;
}
.trigger-days {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.trigger-day {
  padding: 4px 7px;
  border-radius: 4px;
  font-size: 11px;
  color: #556c7b;
  background: #e2e9ee;
}
.trigger-day:hover {
  background: #d8e2e8;
}
.trigger-day.on {
  color: #fff;
  background: var(--accent);
}
.trigger-save {
  background: #e2e9ee;
}
</style>
