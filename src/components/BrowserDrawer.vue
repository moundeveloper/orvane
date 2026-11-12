<script lang="ts">
export interface LibraryPage {
  url: string;
  title: string;
}
export interface Bookmark extends LibraryPage {
  id: string;
  folder?: string;
  space?: string;
}
export type BrowserTheme = "light" | "dark";
export type SearchEngine = "google" | "duckduckgo";
export type BrowserLayout = "balanced" | "performance" | "comfortable";
export type DrawerMode = "library" | "preferences";
</script>

<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import CustomSelect from "./CustomSelect.vue";
import Icon from "./Icon.vue";

const props = defineProps<{
  mode: DrawerMode | null;
  bookmarks: Bookmark[];
  history: LibraryPage[];
  openFolders: Set<string>;
}>();
const emit = defineEmits<{
  close: [];
  visit: [event: MouseEvent, entry: LibraryPage, bookmark?: Bookmark];
  menu: [event: MouseEvent, entry: LibraryPage, bookmark?: Bookmark];
  remove: [bookmark: Bookmark];
  toggleFolder: [name: string];
  export: [];
  import: [];
}>();
const theme = defineModel<BrowserTheme>("theme", { required: true });
const collapsed = defineModel<boolean>("collapsed", { required: true });
const layout = defineModel<BrowserLayout>("layout", { required: true });
const peekEnabled = defineModel<boolean>("peekEnabled", { required: true });
const peekCrossSite = defineModel<boolean>("peekCrossSite", { required: true });
const searchEngine = defineModel<SearchEngine>("searchEngine", { required: true });
const pip = defineModel<boolean>("pip", { required: true });
const headingId = useId();
const collapseId = useId();
const peekId = useId();
const autoPeekId = useId();
const pipId = useId();
const close = ref<HTMLButtonElement>();
const libraryTab = ref<"bookmarks" | "history">("bookmarks");
const title = computed(() => (props.mode === "preferences" ? "Preferences" : "Library"));
const libraryGroups = computed(() => {
  if (libraryTab.value === "history")
    return [{ name: "", entries: props.history }];
  const folders = new Map<string, LibraryPage[]>([["", []]]);
  for (const bookmark of props.bookmarks) {
    const name = bookmark.folder || "";
    const entries = folders.get(name);
    if (entries) entries.push(bookmark);
    else folders.set(name, [bookmark]);
  }
  return [...folders].map(([name, entries]) => ({ name, entries }));
});
const themeOptions = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];
const searchOptions = [
  { value: "google", label: "Google", icon: "search" },
  { value: "duckduckgo", label: "DuckDuckGo", icon: "search" },
];
const layoutOptions = [
  { value: "balanced", label: "Sidebar and address bar" },
  { value: "performance", label: "Sidebar only" },
  { value: "comfortable", label: "Tabs on top" },
];
const shortcuts = [
  ["⌘ / Ctrl T", "New tab"],
  ["⌘ / Ctrl L", "Focus address"],
  ["⌘ / Ctrl K", "Command palette"],
  ["⌘ / Ctrl W", "Close tab"],
  ["⌘ / Ctrl Shift T", "Reopen tab"],
  ["⌘ / Ctrl B", "Library"],
  ["⌘ / Ctrl \\", "Collapse sidebar"],
  ["Alt ← / →", "Back / forward"],
];

function bookmarkOf(entry: LibraryPage) {
  return "id" in entry ? (entry as Bookmark) : undefined;
}

function remove(entry: LibraryPage) {
  const bookmark = bookmarkOf(entry);
  if (bookmark) emit("remove", bookmark);
}

function linkPointerDown(event: MouseEvent) {
  if (event.button !== 1 && !(event.button === 0 && event.altKey)) return;
  event.preventDefault();
  event.stopPropagation();
}

watch(
  () => props.mode,
  (mode) => {
    if (mode) close.value?.focus({ preventScroll: true });
  },
  { flush: "post" },
);
</script>

<template>
  <Transition name="browser-drawer">
    <aside
      v-if="mode"
      class="browser-drawer"
      :aria-labelledby="headingId"
      @keydown.esc.stop.prevent="emit('close')"
    >
      <header class="drawer-head">
        <h2 :id="headingId">{{ title }}</h2>
        <button
          ref="close"
          type="button"
          class="drawer-icon"
          aria-label="Close drawer"
          data-tip="Close drawer"
          @click="emit('close')"
        >
          <Icon name="close" :size="17" />
        </button>
      </header>

      <div v-if="mode === 'library'" class="drawer-content">
        <div class="library-tabs" role="group" aria-label="Library sections">
          <button
            type="button"
            :aria-pressed="libraryTab === 'bookmarks'"
            @click="libraryTab = 'bookmarks'"
          >
            Bookmarks
          </button>
          <button
            type="button"
            :aria-pressed="libraryTab === 'history'"
            @click="libraryTab = 'history'"
          >
            History
          </button>
        </div>

        <nav v-if="libraryTab === 'bookmarks' ? bookmarks.length : history.length"
          :aria-label="libraryTab === 'bookmarks' ? 'Bookmarks' : 'Browsing history'">
          <template v-for="{ name, entries } in libraryGroups" :key="name">
            <button
              v-if="name"
              type="button"
              class="library-folder"
              :aria-expanded="openFolders.has(name)"
              @click="emit('toggleFolder', name)"
            >
              <Icon :name="openFolders.has(name) ? 'folder-open' : 'folder'" :size="14" />
              <span>{{ name }}</span><small>{{ entries.length }}</small>
            </button>
            <template v-if="!name || openFolders.has(name)">
              <div
                v-for="entry in entries"
                :key="bookmarkOf(entry)?.id ?? entry.url"
                class="library-item"
                :class="{ 'in-folder': name }"
                @contextmenu="emit('menu', $event, entry, bookmarkOf(entry))"
              >
                <button
                  type="button"
                  class="library-visit"
                  :aria-label="entry.title || entry.url"
                  data-tip="Open · Shift-click for Peek"
                  @click="emit('visit', $event, entry, bookmarkOf(entry))"
                  @pointerdown="linkPointerDown"
                  @mousedown="linkPointerDown"
                  @auxclick.middle.prevent="emit('visit', $event, entry, bookmarkOf(entry))"
                >
                  <span class="library-favicon" aria-hidden="true">{{
                    (entry.title || entry.url).slice(0, 1).toUpperCase()
                  }}</span>
                  <span class="library-info">
                    <span class="library-title">{{ entry.title || entry.url }}</span>
                    <span class="library-url">{{ entry.url }}</span>
                  </span>
                  <Icon name="external" :size="13" />
                </button>
                <button
                  v-if="libraryTab === 'bookmarks'"
                  type="button"
                  class="drawer-icon"
                  :aria-label="`Remove bookmark ${entry.title || entry.url}`"
                  data-tip="Remove bookmark"
                  @click="remove(entry)"
                >
                  <Icon name="close" :size="14" />
                </button>
              </div>
            </template>
          </template>
        </nav>
        <p v-else class="library-empty">
          {{ libraryTab === "bookmarks"
            ? "No bookmarks yet. Save a page with the star in the address bar."
            : "No browsing history yet." }}
        </p>
      </div>

      <div v-else class="drawer-content">
        <section class="drawer-section">
          <h3>Appearance</h3>
          <div class="drawer-row">
            <span>Appearance</span>
            <div class="drawer-select">
              <CustomSelect v-model="theme" inline aria-label="Appearance" :options="themeOptions" />
            </div>
          </div>
          <div class="drawer-row">
            <label :for="collapseId">Keep sidebar collapsed</label>
            <input :id="collapseId" v-model="collapsed" type="checkbox" role="switch" />
          </div>
        </section>
        <section class="drawer-section">
          <h3>Peek View</h3>
          <div class="drawer-row">
            <label :for="peekId">Enable link previews</label>
            <input :id="peekId" v-model="peekEnabled" type="checkbox" role="switch" />
          </div>
          <div class="drawer-row">
            <label :for="autoPeekId">Automatically preview cross-site links from pinned tabs and bookmarks</label>
            <input
              :id="autoPeekId"
              type="checkbox"
              role="switch"
              :checked="peekEnabled && peekCrossSite"
              :disabled="!peekEnabled"
              @change="peekCrossSite = ($event.target as HTMLInputElement).checked"
            />
          </div>
          <p class="drawer-help">
            Shift-click a Quick Access link or bookmark, or right-click and choose Open Link in Peek View.
          </p>
        </section>
        <section class="drawer-section">
          <h3>Browsing</h3>
          <div class="drawer-row">
            <span>Search engine</span>
            <div class="drawer-select">
              <CustomSelect v-model="searchEngine" inline aria-label="Search engine" :options="searchOptions" />
            </div>
          </div>
          <div class="drawer-row">
            <span>Browser layout</span>
            <div class="drawer-select layout-select">
              <CustomSelect v-model="layout" inline aria-label="Browser layout" :options="layoutOptions" />
            </div>
          </div>
          <div class="drawer-row">
            <label :for="pipId">Pop out video when leaving a tab</label>
            <input :id="pipId" v-model="pip" type="checkbox" role="switch" />
          </div>
        </section>
        <section class="drawer-section">
          <h3>Data</h3>
          <div class="drawer-actions">
            <button type="button" @click="emit('export')">Export session JSON</button>
            <button type="button" @click="emit('import')">Import session</button>
          </div>
        </section>
        <section class="drawer-section">
          <h3>Keyboard shortcuts</h3>
          <ul class="drawer-help drawer-shortcuts">
            <li v-for="[keys, action] in shortcuts" :key="keys"><kbd>{{ keys }}</kbd> · {{ action }}</li>
          </ul>
        </section>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.browser-drawer {
  position: absolute;
  z-index: 6;
  inset: 0 0 0 auto;
  display: flex;
  flex-direction: column;
  width: min(390px, 100%);
  background: var(--surface);
  border-left: 1px solid var(--line);
  box-shadow: -18px 0 55px rgb(42 71 88 / 10%);
}
.browser-drawer-enter-active,
.browser-drawer-leave-active {
  transition: transform 0.28s var(--ease);
}
.browser-drawer-enter-from,
.browser-drawer-leave-to {
  transform: translateX(105%);
}
.browser-drawer-leave-active {
  pointer-events: none;
}
.drawer-head {
  display: flex;
  align-items: center;
  flex: 0 0 67px;
  padding: 0 23px;
  border-bottom: 1px solid var(--soft);
}
.drawer-head h2 {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.2px;
}
.drawer-icon {
  display: grid;
  flex: 0 0 28px;
  place-items: center;
  height: 28px;
  padding: 0;
  border-radius: 7px;
  color: var(--sub);
}
.drawer-icon:hover {
  background: var(--hover);
  color: var(--ink);
}
.drawer-content {
  flex: 1;
  padding: 20px 23px 38px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--scroll-thumb) transparent;
}
.drawer-section {
  margin: 0 0 26px;
}
.drawer-section:last-child {
  margin-bottom: 0;
}
.drawer-section h3 {
  margin: 0 0 11px;
  color: var(--faint);
  font-size: 10px;
  font-weight: 680;
  letter-spacing: 0.7px;
  text-transform: uppercase;
}
.drawer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 43px;
  gap: 12px;
  padding-block: 4px;
  border-bottom: 1px solid var(--soft);
  font-size: 12px;
  line-height: 1.35;
}
.drawer-row input[role="switch"] {
  appearance: none;
  position: relative;
  flex: 0 0 30px;
  height: 18px;
  margin: 0 3px;
  border-radius: 12px;
  background: var(--line);
  cursor: pointer;
}
.drawer-row input[role="switch"]::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: white;
  transition: transform 0.15s;
}
.drawer-row input[role="switch"]:checked {
  background: var(--accent);
}
.drawer-row input[role="switch"]:checked::after {
  transform: translateX(12px);
}
.drawer-row input[role="switch"]:disabled {
  opacity: 0.55;
  cursor: default;
}
.drawer-row input[role="switch"]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.drawer-help {
  margin: 12px 0 0;
  color: var(--faint);
  font-size: 11px;
  line-height: 1.7;
}
.drawer-shortcuts {
  padding: 0;
  list-style: none;
}
.drawer-shortcuts kbd {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
}
.drawer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.drawer-actions button {
  height: 34px;
  padding: 0 13px;
  border-radius: 7px;
  background: var(--low);
  color: var(--sub);
  font-size: 12px;
  font-weight: 570;
}
.drawer-actions button:hover {
  background: var(--hover);
  color: var(--ink);
}
.drawer-select {
  position: relative;
  flex: 0 0 137px;
}
.drawer-select.layout-select {
  flex-basis: min(185px, 55%);
}
.drawer-select :deep(.select-trigger) {
  height: 32px;
  gap: 13px;
  padding: 0 9px 0 11px;
  border: 1px solid var(--soft);
  border-radius: 7px;
  background: var(--low);
  color: var(--ink);
  font-size: 11.5px;
  font-weight: 520;
}
.drawer-select :deep(.select-trigger:hover) {
  background: var(--hover);
  border-color: var(--line);
}
.drawer-select :deep(.select-trigger:is(:focus-visible, [aria-expanded="true"])) {
  outline: none;
  border-color: var(--line);
  box-shadow: inset 0 -1.5px 0 var(--accent);
}
.drawer-select :deep(.select-trigger svg) {
  flex: none;
  color: var(--faint);
  transition: transform 0.18s var(--ease);
}
.drawer-select :deep(.select-trigger[aria-expanded="true"] svg) {
  transform: rotate(180deg);
}
.drawer-select :deep(.select-popover) {
  position: absolute;
  z-index: 2;
  inset: calc(100% + 5px) 0 auto auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: max(155px, 100%);
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  box-shadow: var(--floating);
}
.drawer-select :deep(.select-popover > button) {
  justify-content: flex-start;
  gap: 9px;
  min-height: 34px;
  border-radius: 6px;
  color: var(--sub);
  font-size: 11.5px;
}
.drawer-select :deep(.select-popover > button[data-highlighted="true"]) {
  background: var(--selection);
  color: var(--ink);
}
.drawer-select :deep(.select-popover > button > span) {
  flex: 1;
}
.drawer-select :deep(.select-popover > button > svg) {
  color: var(--faint);
}
.library-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 19px;
  padding: 4px;
  border-radius: 8px;
  background: var(--low);
}
.library-tabs button {
  flex: 1;
  height: 30px;
  border-radius: 6px;
  color: var(--sub);
  font-size: 11px;
}
.library-tabs button[aria-pressed="true"] {
  background: var(--surface);
  box-shadow: 0 1px 3px rgb(64 92 111 / 7%);
  color: var(--ink);
}
.library-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 5px;
  border-bottom: 1px solid var(--soft);
}
.library-item.in-folder {
  margin-left: 12px;
}
.library-visit,
.library-folder {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 12px;
  min-height: 53px;
  padding: 8px 6px 8px 0;
  text-align: left;
  color: var(--sub);
}
.library-visit:hover,
.library-folder:hover {
  color: var(--ink);
}
.library-visit > svg,
.library-folder > svg {
  flex: none;
}
.library-favicon {
  display: grid;
  place-items: center;
  flex: 0 0 16px;
  height: 16px;
  border-radius: 4px;
  background: var(--selection);
  color: var(--accent);
  font-size: 9px;
  font-weight: 700;
}
.library-info {
  flex: 1;
  min-width: 0;
}
.library-info > span,
.library-folder > span {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.library-title {
  color: var(--ink);
  font-size: 12px;
}
.library-url {
  margin-top: 3px;
  color: var(--faint);
  font-size: 10px;
}
.library-folder {
  width: 100%;
  min-height: 34px;
  padding-inline: 5px;
  border-bottom: 1px solid var(--soft);
}
.library-folder > span {
  flex: 1;
}
.library-empty {
  margin: 0;
  padding: 35px 10px;
  color: var(--faint);
  font-size: 12px;
  text-align: center;
}
@media (prefers-reduced-motion: reduce) {
  .browser-drawer-enter-active,
  .browser-drawer-leave-active {
    transition: none;
  }
}
</style>
