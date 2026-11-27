<script setup lang="ts">
// The actions of one deployment, the same in the table and the side panel:
// Run (Map/Reduce, Scheduled) with its live state, Open Suitelet, Parameters
// and Open record. Copy IDs is on the row's right-click menu.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "./Icon.vue";
import DnaLoader from "./DnaLoader.vue";
import ScriptParameters from "./ScriptParameters.vue";
import {
  deployed,
  message,
  runDeployment,
  runKey,
  runnable,
  runs,
  suitelet,
  type NetSuiteRequest,
  type Row,
} from "../netsuiteScripts";

const props = defineProps<{
  deployment: Row;
  scriptType: string;
  environment: string;
  request: NetSuiteRequest;
  openRecord: (kind: string, id: unknown) => unknown;
  openPage?: (url: string, background?: boolean) => Promise<void>;
}>();
const emit = defineEmits<{ error: [text: string]; ran: [] }>();
const id = computed(() => Number(props.deployment.primarykey));
const run = computed(() => runs.get(runKey(props.environment, id.value)));
const live = computed(() => run.value?.phase === "starting" || run.value?.phase === "running");
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
watch(
  live,
  (on) => {
    clearInterval(clock);
    if (on) clock = setInterval(() => (now.value = Date.now()), 1000);
  },
  { immediate: true },
);
watch(
  () => run.value?.phase,
  (phase, before) => {
    if ((phase === "done" || phase === "failed") && before && before !== phase) emit("ran");
  },
);
// A failed start, or a status that could not be put back after the run.
watch(
  () => run.value?.error,
  (text) => {
    if (text) emit("error", text);
  },
);
onBeforeUnmount(() => clearInterval(clock));
const elapsed = computed(() => {
  if (!run.value) return "";
  const s = Math.max(0, Math.round((now.value - run.value.startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});
const runLabel = computed(() => {
  const state = run.value;
  if (!state) return "";
  if (state.phase === "starting") return "Starting";
  const stage = state.stage ? ` · ${String(state.stage).toLowerCase().replace(/_/g, " ")}` : "";
  const percent = state.percent && state.percent !== "0" ? ` ${state.percent}%` : "";
  return `${state.status || "Running"}${stage}${percent}`;
});
function start() {
  void runDeployment(props.environment, id.value, props.request);
}
const opening = ref(false);
async function openSuitelet(event: MouseEvent) {
  if (opening.value || !props.openPage) return;
  opening.value = true;
  try {
    const data = await props.request("suitelet-url", { deploymentId: id.value });
    await props.openPage(String(data.url), event.button === 1 || event.ctrlKey);
  } catch (e) {
    emit("error", message(e));
  } finally {
    opening.value = false;
  }
}
const paramsButton = ref<HTMLButtonElement>();
const paramsOpen = ref(false);
</script>

<template>
  <span class="deployment-actions" @click.stop @dblclick.stop>
    <template v-if="runnable(scriptType)">
      <span v-if="live" class="da-running" role="status" :title="runLabel">
        <DnaLoader />{{ runLabel }} · {{ elapsed }}
      </span>
      <button
        v-else
        type="button"
        class="da-run"
        :disabled="!deployed(deployment)"
        :title="deployed(deployment) ? 'Run now (Save and Execute)' : 'Not deployed'"
        @click="start"
      >
        <Icon name="play" :size="12" />Run
      </button>
      <span
        v-if="!live && run && run.phase !== 'starting'"
        class="da-last"
        :class="run.phase"
        :title="run.error || run.status"
      >{{ run.phase === "failed" ? "Failed" : "Done" }} · {{ elapsed }}</span>
    </template>
    <button
      v-if="suitelet(scriptType)"
      type="button"
      class="da-link"
      :disabled="!deployed(deployment) || opening || !openPage"
      title="Open Suitelet · middle-click opens in the background"
      @click="openSuitelet"
      @auxclick.prevent="$event.button === 1 && openSuitelet($event)"
    >
      <Icon name="external" :size="12" />Open Suitelet
    </button>
    <button
      ref="paramsButton"
      type="button"
      class="da-icon"
      :class="{ on: paramsOpen }"
      aria-label="Parameters"
      title="Parameters"
      :aria-expanded="paramsOpen"
      @click="paramsOpen = !paramsOpen"
    >
      <Icon name="settings" :size="13" />
    </button>
    <button
      type="button"
      class="da-icon"
      aria-label="Open deployment record"
      title="Open deployment record"
      @click="openRecord('deployment', deployment.primarykey)"
    >
      <Icon name="external" :size="13" />
    </button>
    <ScriptParameters
      v-if="paramsOpen && paramsButton"
      :deployment="deployment"
      :anchor="paramsButton"
      :request="request"
      @close="paramsOpen = false"
    />
  </span>
</template>

<style scoped>
.deployment-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
}
.da-run,
.da-link,
.da-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: #385d76;
  font-size: 11.5px;
  white-space: nowrap;
}
.da-run {
  background: #365f78;
  color: #fff;
}
.da-run:hover:not(:disabled) {
  background: #2f556c;
}
.da-link:hover:not(:disabled),
.da-icon:hover,
.da-icon.on {
  background: #e1ebf1;
}
.da-icon {
  width: 24px;
  padding: 0;
  color: #6f8998;
}
.da-run:disabled,
.da-link:disabled {
  opacity: 0.45;
}
.da-running {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 24px;
  max-width: 220px;
  padding: 0 9px;
  border-radius: 7px;
  background: #e1ebf1;
  color: #365f78;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.da-last {
  color: #4f7d5f;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.da-last.failed {
  color: #a0624f;
}
</style>
