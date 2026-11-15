<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref } from "vue";
import type { Block } from "../../model";
import {
  readWidget,
  revealWorkbenchDetail,
  workbenchEditable,
} from "../../workbenchWidgets";
import { api, DRAG_MIME, formatSize } from "./explorer";
import GitDiff from "../GitDiff.vue";
import Icon from "../Icon.vue";

const props = defineProps<{ block: Block }>();
const editable = inject(workbenchEditable);
type Roots = { left: string; right: string };
type Side = keyof Roots;
type Stamp = { size: number; hash: string };
type Member = { path: string; left?: Stamp; right?: Stamp };
type Comparison = { changes: Member[]; identical: number; skipped: number };
const saved = readWidget<Roots>(props.block.value);
const left = ref(typeof saved.left === "string" ? saved.left : "");
const right = ref(typeof saved.right === "string" ? saved.right : "");
const result = ref<Comparison>(),
  compared = ref<Roots>(),
  message = ref("");
const busy = ref(false),
  page = ref(0);
const diff = ref<{ path: string; patch: string }>();
const pendingCopy = ref<{ item: Member; from: Side }>();
const diffPanel = ref<HTMLElement>(),
  confirmPanel = ref<HTMLElement>();
const current = computed(
  () =>
    compared.value?.left === left.value.trim() &&
    compared.value?.right === right.value.trim(),
);
const rows = computed(
  () =>
    result.value?.changes.slice(page.value * 100, page.value * 100 + 100) ?? [],
);
const usable = computed(() => !!left.value.trim() && !!right.value.trim());
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function persistFolders() {
  if (editable?.())
    props.block.value = JSON.stringify({
      left: left.value.trim(),
      right: right.value.trim(),
    });
}
async function compare() {
  if (!usable.value || busy.value) return;
  const roots = { left: left.value.trim(), right: right.value.trim() };
  persistFolders();
  busy.value = true;
  message.value = "";
  pendingCopy.value = undefined;
  diff.value = undefined;
  compared.value = undefined;
  result.value = undefined;
  try {
    result.value = await api<Comparison>("compare-folders", roots);
    compared.value = roots;
    page.value = 0;
  } catch (error) {
    message.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
function accepts(event: DragEvent) {
  return (
    editable?.() && !busy.value && event.dataTransfer?.types.includes(DRAG_MIME)
  );
}
function dropped(event: DragEvent, side: Side) {
  if (!accepts(event)) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    const { paths, dirs } = JSON.parse(event.dataTransfer!.getData(DRAG_MIME));
    if (
      !Array.isArray(paths) ||
      !Array.isArray(dirs) ||
      !paths.length ||
      paths.length > 2 ||
      !paths.every((path) => typeof path === "string" && dirs.includes(path))
    )
      return;
    if (paths.length === 2) [left.value, right.value] = paths;
    else (side === "left" ? left : right).value = paths[0];
    persistFolders();
    void compare();
  } catch {
    message.value = "Drop folders from File Explorer.";
  }
}
async function showDiff(item: Member) {
  if (!current.value || !compared.value || busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    const reply = await api<{ patch: string }>("compare-file-diff", {
      ...compared.value,
      path: item.path,
    });
    diff.value = { path: item.path, patch: reply.patch };
    await nextTick();
    revealWorkbenchDetail(diffPanel.value);
  } catch (error) {
    message.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
async function copy(item: Member, from: Side, confirmed = false) {
  if (
    !current.value ||
    !compared.value ||
    !editable?.() ||
    busy.value ||
    !item[from]
  )
    return;
  const to = from === "left" ? "right" : "left";
  if (item[to] && !confirmed) {
    pendingCopy.value = { item, from };
    await nextTick();
    revealWorkbenchDetail(confirmPanel.value);
    return;
  }
  pendingCopy.value = undefined;
  busy.value = true;
  message.value = "";
  try {
    await api("compare-file-copy", {
      from: compared.value[from],
      to: compared.value[to],
      path: item.path,
      source: item[from]!.hash,
      target: item[to]?.hash,
    });
  } catch (error) {
    message.value = errorText(error);
    return;
  } finally {
    busy.value = false;
  }
  await compare();
  if (!message.value)
    message.value = `Copied ${item.path} to the ${to} folder.`;
}
onMounted(() => void compare());
</script>

<template>
  <div class="workbench-widget">
    <form class="folder-roots" @submit.prevent="compare">
      <label
        @dragover="accepts($event) && $event.preventDefault()"
        @drop="dropped($event, 'left')"
      >
        Left folder
        <input
          v-model="left"
          placeholder="Drop a folder here or enter its path"
          :readonly="busy || !editable?.()"
        />
      </label>
      <label
        @dragover="accepts($event) && $event.preventDefault()"
        @drop="dropped($event, 'right')"
      >
        Right folder
        <input
          v-model="right"
          placeholder="Drop a folder here or enter its path"
          :readonly="busy || !editable?.()"
        />
      </label>
      <button type="submit" class="subtle-button" :disabled="busy || !usable">
        <Icon name="columns" :size="14" />Compare folders
      </button>
    </form>
    <p v-if="busy || message" class="workbench-status" role="status">
      {{ message || "Working…" }}
    </p>
    <template v-if="result && current">
      <p class="workbench-status">
        {{ result.changes.length }}
        {{ result.changes.length === 1 ? "difference" : "differences" }} ·
        {{ result.identical }} identical files
        <template v-if="result.skipped">
          · {{ result.skipped }} links or special entries skipped</template
        >
      </p>
      <table v-if="rows.length" class="comparison-table">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Left</th>
            <th scope="col">Right</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in rows" :key="item.path">
            <th scope="row">{{ item.path }}</th>
            <td>{{ item.left ? formatSize(item.left.size) : "Missing" }}</td>
            <td>{{ item.right ? formatSize(item.right.size) : "Missing" }}</td>
            <td>
              <div class="workbench-actions">
                <button
                  v-if="item.left && item.right"
                  type="button"
                  class="subtle-button"
                  :disabled="busy"
                  @click="showDiff(item)"
                >
                  Open diff
                </button>
                <button
                  v-if="item.left && editable?.()"
                  type="button"
                  class="subtle-button"
                  :disabled="busy"
                  @click="copy(item, 'left')"
                >
                  Copy right
                </button>
                <button
                  v-if="item.right && editable?.()"
                  type="button"
                  class="subtle-button"
                  :disabled="busy"
                  @click="copy(item, 'right')"
                >
                  Copy left
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="result.changes.length > 100" class="workbench-actions">
        <button
          type="button"
          class="subtle-button"
          :disabled="page === 0"
          @click="page--"
        >
          Previous
        </button>
        <button
          type="button"
          class="subtle-button"
          :disabled="(page + 1) * 100 >= result.changes.length"
          @click="page++"
        >
          Next
        </button>
      </div>
    </template>
    <section
      v-if="pendingCopy && current"
      ref="confirmPanel"
      class="workbench-detail"
      aria-label="Confirm replacement"
    >
      <p>
        Replace {{ pendingCopy.item.path }} in the
        {{ pendingCopy.from === "left" ? "right" : "left" }} folder?
      </p>
      <div class="workbench-actions">
        <button
          type="button"
          class="subtle-button"
          :disabled="busy"
          @click="copy(pendingCopy.item, pendingCopy.from, true)"
        >
          Replace file
        </button>
        <button
          type="button"
          class="subtle-button"
          @click="pendingCopy = undefined"
        >
          Cancel
        </button>
      </div>
    </section>
    <section
      v-if="diff && current"
      ref="diffPanel"
      class="workbench-detail"
      aria-label="File diff"
    >
      <div class="workbench-actions">
        <strong>{{ diff.path }}</strong
        ><button type="button" class="subtle-button" @click="diff = undefined">
          Close diff
        </button>
      </div>
      <div v-if="diff.patch" class="comparison-diff">
        <GitDiff :patch="diff.patch" />
      </div>
      <p v-else>The files are identical on disk now.</p>
    </section>
  </div>
</template>

<style scoped>
.folder-roots {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
}
.comparison-table {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
}
.comparison-table th,
.comparison-table td {
  text-align: left;
  padding: 7px 5px;
  border-bottom: 1px solid #e1e9ed;
  overflow-wrap: anywhere;
}
.comparison-table tbody th {
  font-weight: 500;
}
.comparison-diff {
  display: flex;
  height: 300px;
  margin-top: 8px;
}
</style>
