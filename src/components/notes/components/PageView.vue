<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from "vue";
import { useNotesWorkspace } from "../stores/workspace";
import BlockEditor from "./BlockEditor.vue";
import DatabaseView from "./DatabaseView.vue";
import IconPicker from "./IconPicker.vue";

const props = defineProps<{ id: string }>();
const ws = useNotesWorkspace();
const navigatePage = inject<(id: string) => void>("navigatePage")!;
const navigateNotesRoot = inject<() => void>("navigateNotesRoot")!;
const closePageTab = inject<(id: string) => void>("closePageTab");

const titleEl = ref<HTMLElement>();
const editorEl = ref<InstanceType<typeof BlockEditor>>();

watch(
  [
    () => props.id,
    () => !!ws.pages.find((p) => p.id === props.id && !p.trashedAt),
  ],
  async ([id, exists]) => {
    if (!exists) {
      if (closePageTab) closePageTab(id);
      else navigateNotesRoot();
      return;
    }
    await ws.openPage(id);
    if (ws.currentPage?.type === "page" && ws.blocks.length === 0) {
      await nextTick();
      await editorEl.value?.focusFirstBlock();
    }
  },
  { immediate: true },
);

const page = computed(() => ws.currentPage);

watch(
  () => [page.value?.id, page.value?.title] as const,
  () =>
    nextTick(() => {
      if (
        titleEl.value &&
        page.value &&
        document.activeElement !== titleEl.value
      ) {
        titleEl.value.textContent = page.value.title;
      }
    }),
  { immediate: true },
);

let titleTimer: number | undefined;
function onTitleInput(e: Event) {
  if (!page.value) return;
  page.value.title = (e.target as HTMLElement).textContent ?? "";
  clearTimeout(titleTimer);
  void ws.savePage(page.value);
}

async function onTitleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === "ArrowDown") {
    e.preventDefault();
    if (page.value?.type === "page") await editorEl.value?.focusFirstBlock();
    else titleEl.value?.blur();
  }
}

async function setIcon(emoji: string | null) {
  if (!page.value) return;
  page.value.icon = emoji;
  await ws.savePage(page.value);
}

function startSideSelection(e: PointerEvent | MouseEvent) {
  editorEl.value?.startSelectionDrag(e);
}
</script>

<template>
  <div class="page" v-if="page && page.id === props.id">
    <nav class="crumbs">
      <template v-for="(c, i) in ws.breadcrumb" :key="c.id">
        <span v-if="i > 0" class="crumb-sep">/</span>
        <button class="crumb" @click="navigatePage(c.id)">
          {{ c.icon ? c.icon + " " : "" }}{{ c.title || "Untitled" }}
        </button>
      </template>
      <span class="crumbs-right">
        <button
          class="icon-btn"
          :aria-label="page.isFavorite ? 'Remove favorite' : 'Add to favorites'"
          @click="ws.toggleFavorite(page.id)"
        >
          {{ page.isFavorite ? "★" : "☆" }}
        </button>
      </span>
    </nav>

    <div class="page-workspace">
      <div class="selection-gutter left" @pointerdown="startSideSelection" />
      <div class="selection-gutter right" @pointerdown="startSideSelection" />
      <div class="page-body">
        <div class="page-icon-row">
          <IconPicker
            :model-value="page.icon"
            :fallback="page.type === 'database' ? '▦' : undefined"
            removable
            aria-label="Change page icon"
            @update:model-value="setIcon"
          >
            <span class="page-icon">
              {{ page.icon ?? (page.type === "database" ? "▦" : "") }}
              <span v-if="!page.icon && page.type === 'page'" class="add-icon"
                >＋ Add icon</span
              >
            </span>
          </IconPicker>
        </div>

        <h1
          ref="titleEl"
          class="page-title"
          contenteditable="true"
          data-placeholder="Untitled"
          spellcheck="false"
          @input="onTitleInput"
          @keydown="onTitleKeydown"
        />

        <DatabaseView v-if="page.type === 'database'" :page="page" />
        <BlockEditor v-else ref="editorEl" :key="page.id" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 48px;
  position: sticky;
  top: 0;
  background: var(--notes-bg);
  z-index: 11;
  font-size: 13px;
  border-bottom: 1px solid transparent;
}
.crumb {
  color: var(--notes-text-secondary);
  padding: 2px 6px;
  border-radius: 4px;
}
.crumb:hover {
  background: var(--notes-bg-hover);
}
.crumb-sep {
  color: var(--notes-text-faint);
}
.crumbs-right {
  margin-left: auto;
}
.page-workspace {
  position: relative;
  flex: 1;
  min-height: calc(100vh - 76px);
}
.page-body {
  position: relative;
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
  padding: 24px 68px 30vh;
}
.selection-gutter {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  width: max(40px, calc(50% - 520px));
  cursor: default;
}
.selection-gutter.left {
  left: 0;
}
.selection-gutter.right {
  right: 0;
}
.page-icon-row {
  position: relative;
  min-height: 8px;
}
.page-icon {
  font-size: 40px;
  line-height: 1;
  border-radius: 6px;
  padding: 4px;
}
.add-icon {
  font-size: 13px;
  color: var(--notes-text-faint);
}
.page-title {
  font-size: 38px;
  font-weight: 700;
  outline: none;
  margin: 8px 0 18px;
  line-height: 1.2;
}
.page-title:empty::before {
  content: attr(data-placeholder);
  color: var(--notes-text-faint);
}
</style>
