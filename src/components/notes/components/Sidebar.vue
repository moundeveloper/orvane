<script setup lang="ts">
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch,
  type Ref,
} from "vue";
import {
  TREE_EXPANDED,
  TREE_ROW_HEIGHT,
  flattenTree,
  treeWindow,
} from "../pageTree";
import { useNotesWorkspace } from "../stores/workspace";
import PageTreeItem from "./PageTreeItem.vue";
import TrashPanel from "./TrashPanel.vue";
import Icon from "../../Icon.vue";

const emit = defineEmits<{
  (e: "open-search"): void;
  (e: "toggle-sidebar"): void;
}>();
const ws = useNotesWorkspace();
const theme = inject<Ref<"light" | "dark">>("theme")!;
const toggleTheme = inject<() => void>("toggleTheme")!;
const openPageTab =
  inject<(id: string, activate?: boolean) => void>("openPageTab")!;

const trashOpen = ref(false);

// The page tree is flattened and only the rows near the viewport are
// mounted; a spacer keeps the full scroll extent. Rows have one height.
const expandedPages = reactive(new Set<string>());
provide(TREE_EXPANDED, expandedPages);
const rows = computed(() =>
  flattenTree((parentId) => ws.childrenOf(parentId), expandedPages),
);
const scroller = ref<HTMLElement>(),
  list = ref<HTMLElement>();
const view = reactive({ top: 0, height: 0, listTop: 0 });
let measureFrame = 0;
function measure() {
  measureFrame = 0;
  const el = scroller.value;
  if (!el) return;
  view.top = el.scrollTop;
  view.height = el.clientHeight;
  view.listTop = list.value?.offsetTop ?? 0;
}
function scheduleMeasure() {
  measureFrame ||= requestAnimationFrame(measure);
}
const mounted = computed(() =>
  treeWindow(rows.value.length, view.top, view.height, view.listTop),
);
const resized =
  typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(scheduleMeasure);
onMounted(() => {
  measure();
  if (scroller.value) resized?.observe(scroller.value);
});
// Favorites above the tree move where it starts.
watch(() => ws.favorites.length, scheduleMeasure, { flush: "post" });
onBeforeUnmount(() => {
  cancelAnimationFrame(measureFrame);
  resized?.disconnect();
});

async function newPage(type: "page" | "database" = "page") {
  const p = await ws.createPage(null, "", type);
  openPageTab(p.id, true);
}

// drop page to root level
function onRootDrop(e: DragEvent) {
  const id = e.dataTransfer?.getData("slate/page-id");
  if (id) ws.movePage(id, null, ws.childrenOf(null).length);
}
</script>

<template>
  <div class="sb">
    <div class="sb-header">
      <span class="sb-title">Notes</span>
      <button
        class="icon-btn"
        aria-label="Collapse sidebar (Ctrl+\)"
        @click="emit('toggle-sidebar')"
      >
        «
      </button>
    </div>

    <button class="sb-row" @click="emit('open-search')">
      <Icon name="search" :size="14" /> Search
      <span class="sb-kbd">Ctrl+K</span>
    </button>
    <button class="sb-row" @click="newPage()">
      <Icon name="plus" :size="14" /> New page
    </button>
    <button class="sb-row" @click="newPage('database')">
      <Icon name="box" :size="14" /> New database
    </button>

    <div ref="scroller" class="sb-scroll" @scroll.passive="scheduleMeasure">
      <template v-if="ws.favorites.length">
        <div class="sb-label">Favorites</div>
        <PageTreeItem
          v-for="p in ws.favorites"
          :key="'fav-' + p.id"
          :page="p"
          :depth="0"
          flat
        />
      </template>

      <div class="sb-label">Pages</div>
      <div
        ref="list"
        class="sb-tree"
        :style="{
          height: rows.length ? rows.length * TREE_ROW_HEIGHT + 'px' : undefined,
          paddingTop: mounted.start * TREE_ROW_HEIGHT + 'px',
        }"
        @dragover.prevent
        @drop="onRootDrop"
      >
        <PageTreeItem
          v-for="row in rows.slice(mounted.start, mounted.end)"
          :key="row.page.id"
          :page="row.page"
          :depth="row.depth"
        />
        <div v-if="!rows.length" class="sb-empty">No pages yet</div>
      </div>
    </div>

    <div class="sb-footer">
      <button class="sb-row" @click="trashOpen = true">
        <Icon name="trash" :size="14" /> Trash
        <span v-if="ws.trashedPages.length" class="sb-count">{{
          ws.trashedPages.length
        }}</span>
      </button>
    </div>

    <TrashPanel v-if="trashOpen" @close="trashOpen = false" />
  </div>
</template>

<style scoped>
.sb {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.sb-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 8px;
}
.sb-title {
  font-weight: 600;
  flex: 1;
}
.sb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% - 16px);
  min-height: 30px;
  margin: 0 8px;
  padding: 4px 8px;
  border-radius: 4px;
  color: var(--notes-text-secondary);
  font-size: 14px;
  text-align: left;
}
.sb-row:hover {
  background: var(--notes-bg-hover);
}
.sb-icon {
  width: 18px;
  height: 18px;
  text-align: center;
  font-size: 13px;
  line-height: 18px;
  flex-shrink: 0;
}
.sb-kbd {
  margin-left: auto;
  font-size: 11px;
  color: var(--notes-text-faint);
}
.sb-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--notes-text-faint);
  background: var(--notes-bg-active);
  border-radius: 8px;
  padding: 0 6px;
}
.sb-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 12px;
  /* The tree measures its offset from this box. */
  position: relative;
}
.sb-tree {
  box-sizing: border-box;
}
.sb-label {
  padding: 12px 16px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--notes-text-faint);
}
.sb-empty {
  padding: 4px 16px;
  color: var(--notes-text-faint);
  font-size: 13px;
}
.sb-footer {
  border-top: 1px solid var(--notes-border);
  padding: 8px 0;
}
</style>
