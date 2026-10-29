<script setup lang="ts">
import {
  ArrowLeft,
  CheckSquare,
  CloudUpload,
  ExternalLink,
  FileCode2,
  RefreshCw,
  Search,
  Square,
} from "@lucide/vue";
import { computed, ref, watch } from "vue";
import BaseSelect from "./BaseSelect.vue";
import type { SelectOption, SuiteCloudProjectInfo } from "./types";

const props = defineProps<{
  projectName: string;
  info: SuiteCloudProjectInfo;
  isUploading?: boolean;
  isRefreshing?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  upload: [paths: string[], account: string];
  login: [];
  refresh: [];
}>();

const query = ref("");
const selectedAccount = ref("");
const selectedPaths = ref<Set<string>>(new Set());

const accountOptions = computed<SelectOption[]>(() =>
  props.info.accounts.map((account) => ({ value: account, label: account })),
);

const filteredFiles = computed(() => {
  const value = query.value.trim().toLowerCase();
  if (!value) return props.info.files;
  return props.info.files.filter((file) =>
    file.cabinetPath.toLowerCase().includes(value),
  );
});

const allFilteredSelected = computed(
  () =>
    filteredFiles.value.length > 0 &&
    filteredFiles.value.every((file) =>
      selectedPaths.value.has(file.cabinetPath),
    ),
);

const commandPreview = computed(() => {
  const paths = props.info.files
    .filter((file) => selectedPaths.value.has(file.cabinetPath))
    .map((file) => `"${file.cabinetPath}"`);
  return paths.length
    ? `suitecloud file:upload --paths ${paths.join(" ")}`
    : "Select one or more files to preview the command.";
});

const toggleFile = (cabinetPath: string) => {
  const next = new Set(selectedPaths.value);
  if (next.has(cabinetPath)) next.delete(cabinetPath);
  else next.add(cabinetPath);
  selectedPaths.value = next;
};

const toggleFiltered = () => {
  const next = new Set(selectedPaths.value);
  const shouldSelect = !allFilteredSelected.value;
  filteredFiles.value.forEach((file) => {
    if (shouldSelect) next.add(file.cabinetPath);
    else next.delete(file.cabinetPath);
  });
  selectedPaths.value = next;
};

const submit = () => {
  if (!selectedAccount.value || selectedPaths.value.size === 0) return;
  const orderedPaths = props.info.files
    .map((file) => file.cabinetPath)
    .filter((path) => selectedPaths.value.has(path));
  emit("upload", orderedPaths, selectedAccount.value);
};

watch(
  () => props.info,
  () => {
    query.value = "";
    selectedPaths.value = new Set();
    selectedAccount.value =
      (props.info.defaultAccount &&
      props.info.accounts.includes(props.info.defaultAccount)
        ? props.info.defaultAccount
        : props.info.accounts[0]) ?? "";
  },
  { immediate: true },
);
</script>

<template>
  <section class="suitecloud-upload-view" aria-label="SuiteCloud file upload">
    <header class="suitecloud-upload-header">
      <button
        class="icon-button"
        aria-label="Back to projects"
        :disabled="isUploading"
        @click="emit('close')"
      >
        <ArrowLeft aria-hidden="true" />
      </button>
      <CloudUpload class="suitecloud-upload-icon" aria-hidden="true" />
      <div class="suitecloud-upload-title">
        <h2>Upload File Cabinet files</h2>
        <p :aria-label="info.projectPath">
          {{ projectName }} · {{ info.projectPath }}
        </p>
      </div>
    </header>

    <div class="suitecloud-upload-toolbar">
      <div class="search-box suitecloud-file-search">
        <Search aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          placeholder="Filter File Cabinet paths..."
        />
      </div>
      <button
        class="button secondary"
        type="button"
        :disabled="filteredFiles.length === 0"
        @click="toggleFiltered"
      >
        <CheckSquare v-if="allFilteredSelected" aria-hidden="true" />
        <Square v-else aria-hidden="true" />
        {{ allFilteredSelected ? "Clear visible" : "Select visible" }}
      </button>
      <span class="suitecloud-selection-count"
        >{{ selectedPaths.size }} selected</span
      >
    </div>

    <div class="suitecloud-upload-layout">
      <div class="suitecloud-file-list">
        <div class="suitecloud-file-head">
          <span></span>
          <span>File Cabinet path</span>
        </div>
        <div class="suitecloud-file-rows">
          <label
            v-for="file in filteredFiles"
            :key="file.cabinetPath"
            class="suitecloud-file-row"
            :class="{ selected: selectedPaths.has(file.cabinetPath) }"
            :aria-label="file.cabinetPath"
          >
            <input
              type="checkbox"
              :checked="selectedPaths.has(file.cabinetPath)"
              @change="toggleFile(file.cabinetPath)"
            />
            <FileCode2 aria-hidden="true" />
            <span>{{ file.cabinetPath }}</span>
          </label>
          <div v-if="filteredFiles.length === 0" class="suitecloud-file-empty">
            {{
              info.files.length === 0
                ? "No files found in src/FileCabinet."
                : "No files match this filter."
            }}
          </div>
        </div>
      </div>

      <aside class="suitecloud-upload-options">
        <div>
          <label class="field-label">Destination account</label>
          <BaseSelect
            v-model="selectedAccount"
            class="suitecloud-account-select"
            :options="accountOptions"
            placeholder="Choose authentication ID"
            :disabled="isUploading || accountOptions.length === 0"
          />
          <div class="suitecloud-account-actions">
            <button
              class="button secondary"
              type="button"
              :disabled="isUploading"
              @click="emit('login')"
            >
              <ExternalLink aria-hidden="true" />
              Browser login
            </button>
            <button
              class="button secondary"
              type="button"
              :disabled="isUploading || isRefreshing"
              @click="emit('refresh')"
            >
              <RefreshCw aria-hidden="true" />
              {{ isRefreshing ? "Refreshing..." : "Refresh accounts" }}
            </button>
          </div>
          <p class="suitecloud-help">
            Browser login opens <code>suitecloud account:setup</code> in an
            interactive terminal. Refresh accounts after it completes.
          </p>
        </div>

        <div class="suitecloud-command-preview">
          <label class="field-label">Command preview</label>
          <code :aria-label="commandPreview">{{ commandPreview }}</code>
        </div>

        <div class="suitecloud-upload-spacer"></div>
        <button
          class="button primary suitecloud-upload-button"
          :disabled="
            isUploading || !selectedAccount || selectedPaths.size === 0
          "
          @click="submit"
        >
          <CloudUpload aria-hidden="true" />
          {{
            isUploading
              ? "Uploading..."
              : `Upload ${selectedPaths.size || ""} file${selectedPaths.size === 1 ? "" : "s"}`
          }}
        </button>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.suitecloud-upload-view {
  position: absolute;
  inset: 0;
  z-index: 65;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fbfcfd;
}

.suitecloud-upload-header,
.suitecloud-upload-toolbar {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-shrink: 0;
  padding: 9px 12px;
  border-bottom: 1px solid #dbe3ea;
  background: white;
}

.suitecloud-upload-icon {
  width: 18px;
  height: 18px;
  color: #7b2ff7;
}

.suitecloud-upload-title {
  min-width: 0;
}

.suitecloud-upload-title h2,
.suitecloud-upload-title p {
  margin: 0;
}

.suitecloud-upload-title h2 {
  color: #27323a;
  font-size: 15px;
}

.suitecloud-upload-title p {
  max-width: 70vw;
  overflow: hidden;
  color: #62696e;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suitecloud-file-search {
  width: min(520px, 55%);
}

.suitecloud-selection-count {
  color: #62696e;
  font-size: 12px;
  white-space: nowrap;
}

.suitecloud-upload-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
}

.suitecloud-file-list {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: white;
}
.suitecloud-file-rows {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}

.suitecloud-file-head,
.suitecloud-file-row {
  display: grid;
  grid-template-columns: 24px 18px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  padding: 0 12px;
}

.suitecloud-file-head {
  position: static;
  flex: none;
  overflow: hidden;
  scrollbar-gutter: stable;
  z-index: 1;
  height: 32px;
  border-bottom: 1px solid #dbe3ea;
  background: #eef3f7;
  color: #62696e;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}

.suitecloud-file-head span:last-child {
  grid-column: 2 / 4;
}

.suitecloud-file-row {
  min-height: 36px;
  border-bottom: 1px solid #eef3f7;
  color: #27323a;
  cursor: pointer;
  font-size: 12px;
}

.suitecloud-file-row:hover,
.suitecloud-file-row.selected {
  background-color: #faf7ff;
  outline: 1px solid #d8c6ff;
  outline-offset: -1px;
  color: #7b2ff7;
}

.suitecloud-file-row input {
  width: 15px;
  height: 15px;
}

.suitecloud-file-row svg {
  width: 15px;
  height: 15px;
}

.suitecloud-file-row span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suitecloud-file-empty {
  padding: 24px 12px;
  color: #62696e;
  font-size: 12px;
  text-align: center;
}

.suitecloud-upload-options {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px;
  border-left: 1px solid #dbe3ea;
  background: #fbfcfd;
}

.field-label {
  display: block;
  margin-bottom: 6px;
  color: #27323a;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}

.suitecloud-account-select {
  width: 100%;
}

.suitecloud-help {
  margin: 7px 0 0;
  color: #62696e;
  font-size: 11px;
  line-height: 1.4;
}

.suitecloud-account-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}

.suitecloud-help code {
  color: #27323a;
}

.suitecloud-command-preview code {
  display: block;
  max-height: 150px;
  overflow: auto;
  padding: 8px;
  border: 1px solid #dbe3ea;
  border-radius: 4px;
  background: white;
  color: #27323a;
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.suitecloud-upload-spacer {
  flex: 1;
}

.suitecloud-upload-button {
  width: 100%;
  justify-content: center;
}

@media (max-width: 850px) {
  .suitecloud-upload-layout {
    grid-template-columns: minmax(0, 1fr) 260px;
  }
}
</style>
