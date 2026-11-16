<script setup lang="ts">
// File widget: a live view of one file on disk (video, PDF, spreadsheet,
// code, audio…). It refreshes when the file changes.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import FileViewer from "./files/FileViewer.vue";
import { api, fileToken, watchFolder } from "./files/explorer";
import type { Block } from "../model";

const props = defineProps<{ block: Block; editing: boolean }>();
const token = ref("");
const error = ref("");
const revision = ref(0);
const path = computed(() => props.block.value);
const name = computed(() => path.value.split(/[\\/]/).pop() ?? "");
const folder = computed(() => path.value.slice(0, Math.max(0, path.value.length - name.value.length)).replace(/[\\/]+$/, "") || path.value);
let stop: (() => void) | undefined;
function listen() {
  stop?.();
  stop = undefined;
  if (!path.value) return;
  stop = watchFolder(folder.value, (names) => {
    if (!names.length || names.some((n) => n.toLowerCase() === name.value.toLowerCase())) revision.value++;
  });
}
onMounted(async () => {
  try {
    token.value = await fileToken();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  listen();
});
watch(path, listen);
onBeforeUnmount(() => stop?.());
const run = (operation: string) => void api(operation, { path: path.value }).catch((e) => (error.value = e.message));
</script>
<template>
  <div class="file-widget">
    <template v-if="path && token">
      <FileViewer :path="path" :token="token" :revision="revision" />
      <div class="file-actions">
        <button type="button" title="Open in default app" aria-label="Open in default app" @click="run('open')">
          <Icon name="external" :size="13" /></button
        ><button type="button" title="Show in system explorer" aria-label="Show in system explorer" @click="run('reveal')">
          <Icon name="folder-open" :size="13" /></button
        ><button type="button" title="Reload" aria-label="Reload" @click="revision++">
          <Icon name="refresh" :size="13" />
        </button>
      </div>
    </template>
    <p v-else-if="error" class="file-empty">{{ error }}</p>
    <p v-else-if="!path" class="file-empty">
      <Icon name="file" :size="22" />Drop a file from the File Explorer onto the canvas to show it here.
    </p>
  </div>
</template>
<style>
.app-content:has(> .block-file:only-child) {
  padding: 0;
  overflow: hidden;
}
.app-content > .block-file {
  display: flex;
  flex: 1;
  min-height: 120px;
}
.block-file:not(:only-child) {
  height: 360px;
}
</style>
<style scoped>
.file-widget {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: #fff;
}
.file-actions {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 5;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: #f8fafbe6;
  box-shadow: 0 2px 8px rgb(60 83 96 / 12%);
  opacity: 0;
  transition: opacity 0.15s;
}
.file-widget:hover .file-actions,
.file-actions:focus-within {
  opacity: 1;
}
.file-actions button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 4px;
  background: none;
  color: #607583;
}
.file-actions button:hover {
  background: #e3edf2;
}
.file-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: auto;
  padding: 16px;
  color: #8798a3;
  font-size: 12px;
  text-align: center;
}
</style>
