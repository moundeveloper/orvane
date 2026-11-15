<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import type { Block } from "../model";
import {
  netSuiteCanvas,
  querySource,
  readRecordPreview,
  recordTypePattern,
} from "../netsuiteCanvas";
import { sharedRead } from "../sharedReads";
import CustomSelect from "./CustomSelect.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ block: Block }>();
const canvas = inject(netSuiteCanvas);
const link = computed(() => readRecordPreview(props.block.value));
const sourceAvailable = computed(
  () =>
    !!link.value &&
    !!canvas?.sourceExists(link.value.sourceBlockId, link.value.queryId),
);
const selection = computed(() => {
  if (!link.value || !sourceAvailable.value) return;
  return canvas?.selections.get(
    querySource(link.value.sourceBlockId, link.value.queryId),
  );
});
const environment = computed(() => selection.value?.environment ?? "");
const recordType = computed(() => link.value?.type ?? "");
const recordId = computed(() => {
  const value = selection.value?.row[link.value?.column ?? ""];
  const id =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
});
const draftType = ref(""),
  draftColumn = ref("");
watch(
  link,
  (value) => {
    draftType.value = value?.type ?? "";
    draftColumn.value = value?.column ?? "";
  },
  { immediate: true },
);
const columns = computed(() =>
  Array.from(
    new Set([
      ...(link.value?.columns ?? []),
      ...Object.keys(selection.value?.row ?? {}),
      ...(draftColumn.value ? [draftColumn.value] : []),
    ]),
  ).map((name) => ({ value: name, label: name })),
);
const normalizedType = computed(() => draftType.value.trim().toLowerCase());
const validMapping = computed(
  () => recordTypePattern.test(normalizedType.value) && !!draftColumn.value,
);
const dirty = computed(
  () =>
    normalizedType.value !== recordType.value ||
    draftColumn.value !== link.value?.column,
);
function applyMapping() {
  if (!canvas?.editable() || !link.value || !validMapping.value || !dirty.value)
    return;
  props.block.value = JSON.stringify({
    ...link.value,
    column: draftColumn.value,
    type: normalizedType.value,
  });
}

type Field = { id: string; label: string; value: string };
type PreviewResponse = { fields: Field[] };
const api = (
  window as unknown as {
    orvaneDesktop?: {
      netsuite?: {
        run: (
          environment: string,
          operation: string,
          args: Record<string, unknown>,
        ) => Promise<PreviewResponse>;
      };
    };
  }
).orvaneDesktop?.netsuite;
const fields = ref<Field[]>([]),
  loading = ref(false),
  error = ref(""),
  refresh = ref(0);
watch(
  [environment, recordType, recordId, refresh],
  async ([account, kind, id], _previous, onCleanup) => {
    fields.value = [];
    error.value = "";
    loading.value = false;
    if (!api || !account || !kind || !id) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    loading.value = true;
    try {
      const result = await sharedRead(
        `netsuite:${account}:record-preview:${kind}:${id}`,
        () => api.run(account, "record-preview", { kind, id }),
        controller.signal,
      );
      if (!controller.signal.aborted) fields.value = result.fields;
    } catch (cause) {
      if (!controller.signal.aborted)
        error.value = String(
          cause instanceof Error ? cause.message : cause,
        ).replace(
          /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
          "",
        );
    } finally {
      if (!controller.signal.aborted) loading.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="record-preview">
    <template v-if="link">
      <div class="record-source">
        <Icon name="link" :size="14" />
        <span>{{ link.queryName }}</span>
      </div>
      <form
        v-if="sourceAvailable"
        class="record-mapping"
        @submit.prevent="applyMapping"
      >
        <label>
          Record type
          <input
            v-model="draftType"
            placeholder="e.g. customer"
            maxlength="100"
            :disabled="!canvas?.editable()"
          />
        </label>
        <label>
          Internal ID column
          <CustomSelect
            v-model="draftColumn"
            :options="columns"
            placeholder="Choose a column"
            aria-label="Internal ID column"
            :disabled="!canvas?.editable()"
          />
        </label>
        <button
          type="submit"
          class="subtle-button"
          :disabled="!validMapping || !dirty || !canvas?.editable()"
        >
          Apply
        </button>
      </form>
      <p v-if="!sourceAvailable" class="record-message">
        The linked query is unavailable.
      </p>
      <p v-else-if="!api" class="record-message">
        Open Orvane Desktop to preview NetSuite records.
      </p>
      <p v-else-if="!link.column || !recordType" class="record-message">
        Choose a SuiteScript record type and the column containing its internal
        ID.
      </p>
      <p v-else-if="!selection" class="record-message">
        Select a row in the linked SuiteQL results.
      </p>
      <p v-else-if="!recordId" class="record-message">
        The selected row has no valid internal ID in {{ link.column }}.
      </p>
      <template v-else>
        <div class="record-header">
          <div>
            <strong>{{ recordType }} #{{ recordId }}</strong
            ><small>{{ environment.replace(/^https?:\/\//, "") }}</small>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="Refresh record"
            :disabled="loading"
            @click="refresh++"
          >
            <Icon name="refresh" :size="14" />
          </button>
        </div>
        <p v-if="loading" class="record-message" role="status">
          Loading record…
        </p>
        <p v-else-if="error" class="record-message record-error" role="alert">
          {{ error }}
        </p>
        <dl v-else-if="fields.length" class="record-fields">
          <template v-for="field in fields" :key="field.id">
            <dt :title="field.id">{{ field.label }}</dt>
            <dd>{{ field.value }}</dd>
          </template>
        </dl>
        <p v-else class="record-message">
          This record has no populated body fields available to your role.
        </p>
      </template>
    </template>
    <p v-else class="record-message">
      Add a record preview from SuiteQL results to link it to a query.
    </p>
  </div>
</template>

<style>
.app-content:has(> .block-netsuite-record:only-child) {
  padding: 0;
  overflow: hidden;
}
.app-content > .block-netsuite-record {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
<style scoped>
.record-preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 14px;
  color: #294451;
  font-size: 12px;
}
.record-source,
.record-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.record-source {
  color: #526e7e;
}
.record-mapping {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
  margin: 12px 0 16px;
}
.record-mapping label {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.record-mapping input {
  min-width: 0;
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid #d7e2e7;
  border-radius: 6px;
  background: #fff;
  color: inherit;
  font: inherit;
}
.record-header {
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid #dbe6eb;
}
.record-header small {
  display: block;
  margin-top: 3px;
  color: #526e7e;
}
.record-message {
  color: #526e7e;
}
.record-error {
  color: #9b3838;
}
.record-fields {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  margin: 0;
}
.record-fields dt,
.record-fields dd {
  margin: 0;
  padding: 7px 5px;
  border-bottom: 1px solid #e2eaee;
  overflow-wrap: anywhere;
}
.record-fields dt {
  color: #526e7e;
}
.record-fields dd {
  white-space: pre-wrap;
}
</style>
