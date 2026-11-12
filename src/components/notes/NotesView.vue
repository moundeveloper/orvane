<script setup lang="ts">
import {
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  watch,
} from "vue";
import type { Block as CanvasBlock } from "../../model";
import {
  createOwnedWorkspaceStore,
  NOTES_WORKSPACE_CHANGED_EVENT,
  notesWorkspaceKey,
  type NotesWorkspaceChange,
} from "./stores/workspace";
import Sidebar from "./components/Sidebar.vue";
import SearchModal from "./components/SearchModal.vue";
import PageView from "./components/PageView.vue";
import EmptyState from "./components/EmptyState.vue";
import "./assets/main.css";
import { provideNotesPortal } from "./portal";

const props = defineProps<{
  block: CanvasBlock;
  editing: boolean;
  tabId?: string;
  tabFullPath?: string;
  tabActive?: boolean;
  tabFocused?: boolean;
}>();
const emit = defineEmits<{
  (e: "notes-navigate", navigation: { path: string; replace?: boolean }): void;
}>();

const componentUid = getCurrentInstance()?.uid ?? crypto.randomUUID();
const ownedWorkspace = createOwnedWorkspaceStore(
  props.tabId ?? `notes-${componentUid}`,
);
const ws = ownedWorkspace.store;
let disposed = false;
provide(notesWorkspaceKey, ws);
const savedState = (() => {
  try {
    return JSON.parse(props.block.value || "{}");
  } catch {
    return {};
  }
})();
const route = { params: {} as { id?: string } };
const appRoot = ref<HTMLElement | null>(null);
const portalLayer = provideNotesPortal(appRoot).target;
const storageError = ref("");
function onStorageError(event: Event) {
  storageError.value = String(
    (event as CustomEvent).detail || "Notes could not be saved.",
  );
}

const sidebarOpen = ref(true);
const sidebarWidth = ref(260);
const searchOpen = ref(false);
const theme = ref<"light" | "dark">("light");
const tabIds = ref<string[]>([]);
const draggingTabId = ref<string | null>(null);
const tabDrop = ref<{ id: string; side: "before" | "after" } | null>(null);
const tabsRestored = ref(false);

const activePageId = ref<string | null>(savedState.active || null);
provide("notesActivePageId", activePageId);
const tabFocused = computed(() => props.tabFocused ?? true);
provide("notesTabFocused", tabFocused);

const tabsStorageKey = computed(() =>
  props.tabId ? `slate-page-tabs:${props.tabId}` : "slate-page-tabs",
);
const activePageStorageKey = computed(() =>
  props.tabId ? `slate-active-page:${props.tabId}` : "slate-active-page",
);

function saveViewState() {
  props.block.value = JSON.stringify({
    active: activePageId.value,
    tabs: tabIds.value,
  });
}
function persistTabs() {
  saveViewState();
}
function persistActivePage(id: string | null) {
  activePageId.value = id;
  saveViewState();
}
const pageTabs = computed(() =>
  tabIds.value
    .map((id) => ws.pages.find((p) => p.id === id && !p.trashedAt))
    .filter((p): p is NonNullable<typeof p> => !!p),
);

watch(activePageId, (id) => {
  if (!tabsRestored.value || typeof id !== "string") return;
  if (!tabIds.value.includes(id))
    tabIds.value = [...tabIds.value, id].slice(-12);
  persistTabs();
  persistActivePage(id);
});

provide("openSearch", () => (searchOpen.value = true));
provide("openPageTab", openPageTab);
provide("navigatePage", navigatePage);
provide("closePageTab", closeTab);
provide("navigateNotesRoot", () => navigatePath("/notes", true));
provide("toggleTheme", toggleTheme);
provide("theme", theme);

function applyTheme(t: "light" | "dark") {
  theme.value = t;
  theme.value = "light";
}

function toggleTheme() {
  applyTheme(theme.value === "light" ? "dark" : "light");
}

async function newPage() {
  const p = await ws.createPage(null, "");
  openPageTab(p.id, true);
}

function navigatePath(path: string, replace = false) {
  activePageId.value = path.startsWith("/notes/")
    ? decodeURIComponent(path.slice(7))
    : null;
  saveViewState();
}
function navigateToPage(id: string, replace = false) {
  activePageId.value = id;
  saveViewState();
}
function openTab(id: string) {
  navigateToPage(id);
}

function openPageTab(id: string, activate = false) {
  const existed = tabIds.value.includes(id);
  if (!existed) {
    tabIds.value = [...tabIds.value, id].slice(-12);
    persistTabs();
  }
  if (activate || existed) navigateToPage(id);
}

function navigatePage(id: string) {
  if (tabIds.value.includes(id)) {
    navigateToPage(id);
    return;
  }
  const currentId = activePageId.value;
  const currentIndex = currentId ? tabIds.value.indexOf(currentId) : -1;
  if (currentIndex >= 0) {
    const next = [...tabIds.value];
    next[currentIndex] = id;
    tabIds.value = next;
    persistTabs();
  } else {
    tabIds.value = [...tabIds.value, id].slice(-12);
    persistTabs();
  }
  navigateToPage(id);
}

function closeTab(id: string) {
  const index = tabIds.value.indexOf(id);
  tabIds.value = tabIds.value.filter((tabId) => tabId !== id);
  persistTabs();
  if (activePageId.value !== id) return;
  const nextId = tabIds.value[Math.max(0, index - 1)] ?? tabIds.value[0];
  if (nextId) navigateToPage(nextId);
  else {
    persistActivePage(null);
    navigatePath("/notes");
  }
}

function onTabMouseup(e: MouseEvent, id: string) {
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  closeTab(id);
}

function preventTabMiddle(e: MouseEvent) {
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopPropagation();
}

async function addRootTab() {
  const p = await ws.createPage(null, "");
  openPageTab(p.id, true);
}

function onTabDragStart(id: string, e: DragEvent) {
  draggingTabId.value = id;
  e.dataTransfer?.setData("slate/tab-id", id);
  e.dataTransfer!.effectAllowed = "move";
}

function onTabDragOver(id: string, e: DragEvent) {
  const moving = draggingTabId.value ?? e.dataTransfer?.getData("slate/tab-id");
  if (!moving || moving === id) return;
  e.preventDefault();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  tabDrop.value = {
    id,
    side: e.clientX < rect.left + rect.width / 2 ? "before" : "after",
  };
}

function onTabDragLeave(id: string, e: DragEvent) {
  const tab = e.currentTarget as HTMLElement;
  const nextTarget = e.relatedTarget;
  if (nextTarget instanceof Node && tab.contains(nextTarget)) return;
  const rect = tab.getBoundingClientRect();
  if (
    e.clientX >= rect.left &&
    e.clientX <= rect.right &&
    e.clientY >= rect.top &&
    e.clientY <= rect.bottom
  ) {
    return;
  }
  if (tabDrop.value?.id === id) tabDrop.value = null;
}

function onTabDrop(id: string, e: DragEvent) {
  e.preventDefault();
  const moving = draggingTabId.value ?? e.dataTransfer?.getData("slate/tab-id");
  const drop = tabDrop.value;
  draggingTabId.value = null;
  tabDrop.value = null;
  if (!moving || moving === id || !drop) return;
  const next = tabIds.value.filter((tabId) => tabId !== moving);
  const targetIndex = next.indexOf(drop.id);
  next.splice(
    drop.side === "before" ? targetIndex : targetIndex + 1,
    0,
    moving,
  );
  tabIds.value = next;
  persistTabs();
}

function onKeydown(e: KeyboardEvent) {
  if (!tabFocused.value || !appRoot.value?.contains(document.activeElement))
    return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchOpen.value = !searchOpen.value;
  } else if (mod && e.key === "\\") {
    e.preventDefault();
    sidebarOpen.value = !sidebarOpen.value;
  } else if (mod && e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newPage();
  }
}

// sidebar resize
let resizing = false;
function startResize() {
  resizing = true;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}
function onMouseMove(e: MouseEvent) {
  if (!resizing) return;
  const left = appRoot.value?.getBoundingClientRect().left ?? 0;
  const scale = appRoot.value
    ? appRoot.value.getBoundingClientRect().width / appRoot.value.offsetWidth
    : 1;
  sidebarWidth.value = Math.min(420, Math.max(180, (e.clientX - left) / scale));
}
function stopResize() {
  if (!resizing) return;
  resizing = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function onWorkspaceChanged(event: Event) {
  const detail = (event as CustomEvent<NotesWorkspaceChange>).detail;
  if (!detail || detail.source === ws.$id) return;
  if (detail.pages) void ws.refreshPages().catch(onRefreshError);
  if (detail.blocksPageId)
    void ws.refreshBlocks(detail.blocksPageId).catch(onRefreshError);
}
function onRefreshError(error: unknown) {
  if (!disposed) storageError.value = String(error);
}

onMounted(async () => {
  window.addEventListener("orvane-notes-error", onStorageError);
  applyTheme("light");

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", stopResize);
  window.addEventListener(NOTES_WORKSPACE_CHANGED_EVENT, onWorkspaceChanged);
  try {
    await ws.load();
    if (disposed) return;
  } catch (error) {
    storageError.value = String(error);
    return;
  }
  try {
    const paneTabs = JSON.stringify(savedState.tabs || []);
    const legacyTabs = null;
    const savedTabs = JSON.parse(paneTabs ?? legacyTabs ?? "[]");
    if (Array.isArray(savedTabs)) {
      tabIds.value = savedTabs
        .filter((id): id is string => typeof id === "string")
        .filter((id) =>
          ws.pages.some((page) => page.id === id && !page.trashedAt),
        )
        .slice(-12);
    }
  } catch (err) {
    console.error("Failed to restore saved page tabs from localStorage.", err);
    tabIds.value = [];
  }
  const currentId = activePageId.value;
  if (currentId && !tabIds.value.includes(currentId)) {
    tabIds.value = [...tabIds.value, currentId];
  }
  tabsRestored.value = true;
  persistTabs();
  if (currentId) {
    persistActivePage(currentId);
  } else {
    const paneActivePage = savedState.active;
    const legacyActivePage = null;
    const restoredActivePage = paneActivePage ?? legacyActivePage;
    const fallbackPageId =
      restoredActivePage && tabIds.value.includes(restoredActivePage)
        ? restoredActivePage
        : tabIds.value[tabIds.value.length - 1];
    if (fallbackPageId) {
      persistActivePage(fallbackPageId);
      navigateToPage(fallbackPageId, true);
    }
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("orvane-notes-error", onStorageError);

  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", stopResize);
  window.removeEventListener(NOTES_WORKSPACE_CHANGED_EVENT, onWorkspaceChanged);
  disposed = true;
  ownedWorkspace.dispose();
});
</script>

<template>
  <div
    ref="appRoot"
    class="notes-workspace app"
    v-if="ws.loaded"
    @keydown.stop="onKeydown"
    @wheel="$event.ctrlKey || $event.metaKey || $event.stopPropagation()"
  >
    <aside
      class="sidebar"
      v-show="sidebarOpen"
      :style="{ width: sidebarWidth + 'px' }"
    >
      <Sidebar
        @open-search="searchOpen = true"
        @toggle-sidebar="sidebarOpen = false"
      />
      <div class="resize-handle" @mousedown.prevent="startResize" />
    </aside>
    <main class="main">
      <p v-if="storageError" class="notes-save-error" role="alert">
        {{ storageError }} <button @click="storageError = ''">Dismiss</button>
      </p>
      <button
        v-if="!sidebarOpen"
        class="icon-btn sidebar-opener"
        aria-label="Open sidebar (Ctrl+\)"
        @click="sidebarOpen = true"
      >
        ☰
      </button>
      <div class="page-tabs">
        <button
          v-for="tab in pageTabs"
          :key="tab.id"
          class="page-tab"
          :class="{
            active: activePageId === tab.id,
            'drop-before': tabDrop?.id === tab.id && tabDrop.side === 'before',
            'drop-after': tabDrop?.id === tab.id && tabDrop.side === 'after',
          }"
          draggable="true"
          @click="openTab(tab.id)"
          @mousedown="preventTabMiddle"
          @pointerdown="preventTabMiddle"
          @mouseup="onTabMouseup($event, tab.id)"
          @auxclick.stop.prevent="onTabMouseup($event, tab.id)"
          @dragstart="onTabDragStart(tab.id, $event)"
          @dragover="onTabDragOver(tab.id, $event)"
          @dragleave="onTabDragLeave(tab.id, $event)"
          @drop="onTabDrop(tab.id, $event)"
          @dragend="
            draggingTabId = null;
            tabDrop = null;
          "
        >
          <span class="tab-icon">{{
            tab.icon ?? (tab.type === "database" ? "▦" : "📄")
          }}</span>
          <span class="tab-title">{{ tab.title || "Untitled" }}</span>
          <span
            class="tab-close"
            aria-label="Close tab"
            @click.stop="closeTab(tab.id)"
            >×</span
          >
        </button>
        <button class="tab-add" aria-label="New root page" @click="addRootTab">
          ＋
        </button>
      </div>
      <div class="notes-page-scroll" tabindex="0" aria-label="Note content">
        <PageView v-if="activePageId" :id="activePageId" />
        <EmptyState v-else />
      </div>
    </main>
    <SearchModal v-if="searchOpen" @close="searchOpen = false" />
    <Teleport to="body">
      <div ref="portalLayer" class="notes-portal-layer" />
    </Teleport>
  </div>
  <div v-else class="notes-workspace loading">
    {{ storageError || "Loading workspace…" }}
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100%;
}
.sidebar {
  position: relative;
  flex-shrink: 0;
  background: var(--notes-bg-sidebar);
  border-right: 1px solid var(--notes-border);
  display: flex;
  flex-direction: column;
}
.resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
}
.main {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.page-tabs {
  position: relative;
  z-index: 12;
  display: flex;
  align-items: center;
  gap: 1px;
  min-height: 36px;
  padding: 4px 8px 0;
  background: var(--notes-bg);
  border-bottom: 1px solid var(--notes-border);
  overflow-x: auto;
  flex: 0 0 auto;
}
.notes-page-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.page-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 120px;
  max-width: 220px;
  height: 31px;
  padding: 0 6px 0 8px;
  border-radius: 6px 6px 0 0;
  color: var(--notes-text-secondary);
  font-size: 13px;
  flex-shrink: 0;
}
.page-tab.drop-before::before,
.page-tab.drop-after::after {
  content: "";
  position: absolute;
  top: 5px;
  bottom: 5px;
  width: 2px;
  border-radius: 2px;
  background: var(--notes-accent);
}
.page-tab.drop-before::before {
  left: -1px;
}
.page-tab.drop-after::after {
  right: -1px;
}
.page-tab:hover {
  background: var(--notes-bg-hover);
}
.page-tab.active {
  background: var(--notes-bg-active);
  color: var(--notes-text);
}
.tab-icon {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
  font-size: 13px;
}
.tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: var(--notes-text-faint);
  flex-shrink: 0;
}
.tab-close:hover {
  background: var(--notes-bg-hover);
  color: var(--notes-text);
}
.tab-add {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  color: var(--notes-text-secondary);
  flex-shrink: 0;
}
.tab-add:hover {
  background: var(--notes-bg-hover);
}
.sidebar-opener {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 20;
}
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--notes-text-secondary);
}
</style>
