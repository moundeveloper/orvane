<script setup lang="ts">
// Terminal app: tabs of real shells (cmd, PowerShell, Git Bash, WSL… any
// profile found on this computer), split panes, search, clickable links
// and paths, and shells that keep running when Orvane reloads.
//
// Keys (in a terminal): Ctrl+Shift+T new tab · Ctrl+Shift+1…9 tab with the
// nth profile · Ctrl+Shift+W close pane · Ctrl+Tab / Ctrl+Shift+Tab switch
// tab · Alt+Shift+D split (Alt+Shift+= right, Alt+Shift+- down) · Alt+arrows
// move between panes · Ctrl+Shift+F find · Ctrl+= / Ctrl+- / Ctrl+0 text
// size · Ctrl+C copies a selection (else interrupts) · Ctrl+V pastes ·
// right-click copies a selection or pastes · Ctrl+click opens a link or path.
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";
import Icon from "../Icon.vue";
import TerminalSplit from "./TerminalSplit.vue";
import { TERMINAL, type PaneHandle, type TerminalController } from "./controller";
import { usePopover } from "../pickers/usePopover";
import { registerCommands } from "../../commands";
import { uid, type Block } from "../../model";
import { terminal as client, terminalProfiles, type TerminalProfileInfo } from "../../terminalClient";
import {
  panes,
  readTerminal,
  replacePane,
  type LayoutNode,
  type PaneNode,
  type TerminalState,
  type TerminalTab,
} from "../../terminalLayout";

const props = defineProps<{ block: Block }>();
const DEFAULT_FONT = 13;
const state = reactive<TerminalState>(readTerminal(props.block.value));
function save() {
  const value = JSON.stringify(state);
  if (value !== props.block.value) props.block.value = value;
}
const profiles = ref<TerminalProfileInfo[]>([]);
const defaultProfile = computed(
  () => profiles.value.find((p) => p.id === state.defaultProfile) ?? profiles.value[0],
);
const activeTab = computed(() => state.tabs.find((t) => t.id === state.active));
const fontSize = ref(state.fontSize ?? DEFAULT_FONT);

// Live, not saved: shell titles, activity and bells.
const titles = reactive(new Map<string, string>());
const activity = reactive(new Set<string>());
const bells = reactive(new Set<string>());
const handles = new Map<string, PaneHandle>();
const tabOf = (paneId: string) => state.tabs.find((t) => panes(t.root).some((p) => p.id === paneId));
const profileOf = (id: string) => profiles.value.find((p) => p.id === id);
function tabLabel(tab: TerminalTab) {
  if (tab.name) return tab.name;
  const pane = panes(tab.root).find((p) => p.id === tab.focus);
  const profileName = (pane && profileOf(pane.profile)?.name) || "Terminal";
  const title = titles.get(tab.focus)?.trim();
  // A shell that titles itself with its own program path shows the profile.
  if (!title || /\.exe$/i.test(title)) return profileName;
  return title;
}

// ---- Tabs and panes ----
function newPane(profileId = defaultProfile.value?.id ?? ""): PaneNode {
  return { type: "pane", id: uid(), profile: profileId };
}
function newTab(profileId?: string) {
  const pane = newPane(profileId);
  const tab: TerminalTab = { id: uid(), root: pane, focus: pane.id };
  state.tabs.push(tab);
  selectTab(tab.id);
  save();
}
function selectTab(id: string) {
  state.active = id;
  const tab = activeTab.value;
  if (tab) {
    activity.delete(tab.id);
    bells.delete(tab.id);
  }
  save();
  void nextTick(() => tab && handles.get(tab.focus)?.focus());
}
function closeTab(id: string) {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  for (const pane of panes(state.tabs[index]!.root)) client.kill(pane.id);
  state.tabs.splice(index, 1);
  if (state.active === id) state.active = state.tabs[Math.min(index, state.tabs.length - 1)]?.id ?? "";
  save();
  void nextTick(() => activeTab.value && handles.get(activeTab.value.focus)?.focus());
}
function closePane(paneId: string, kill = true) {
  const tab = tabOf(paneId);
  if (!tab) return;
  if (kill) client.kill(paneId);
  const root = replacePane(tab.root, paneId, null);
  if (!root) return closeTab(tab.id);
  tab.root = root;
  if (tab.focus === paneId) tab.focus = panes(root)[0]!.id;
  save();
  void nextTick(() => handles.get(tab.focus)?.focus());
}
function split(paneId: string, dir: "row" | "column" | "auto") {
  const tab = tabOf(paneId);
  const pane = tab && panes(tab.root).find((p) => p.id === paneId);
  if (!tab || !pane) return;
  if (dir === "auto") {
    const r = handles.get(paneId)?.element.getBoundingClientRect();
    dir = r && r.height > r.width ? "column" : "row";
  }
  // Like Windows Terminal: the new pane uses the same profile.
  const added = newPane(pane.profile);
  const node: LayoutNode = { type: "split", id: uid(), dir, ratio: 0.5, a: pane, b: added };
  tab.root = replacePane(tab.root, paneId, node)!;
  tab.focus = added.id;
  save();
  void nextTick(() => handles.get(added.id)?.focus());
}
function moveFocus(paneId: string, direction: "left" | "right" | "up" | "down") {
  const tab = tabOf(paneId);
  const from = handles.get(paneId)?.element.getBoundingClientRect();
  if (!tab || !from) return;
  const cx = from.left + from.width / 2,
    cy = from.top + from.height / 2;
  let best: { id: string; d: number } | undefined;
  for (const p of panes(tab.root)) {
    const r = handles.get(p.id)?.element.getBoundingClientRect();
    if (!r || p.id === paneId) continue;
    const x = r.left + r.width / 2,
      y = r.top + r.height / 2;
    const ahead =
      direction === "left" ? x < cx - 1 : direction === "right" ? x > cx + 1 : direction === "up" ? y < cy - 1 : y > cy + 1;
    if (!ahead) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (!best || d < best.d) best = { id: p.id, d };
  }
  if (best) handles.get(best.id)?.focus();
}
function renameTab(tab: TerminalTab) {
  renaming.value = tab.id;
  renameText.value = tab.name ?? tabLabel(tab);
  void nextTick(() => renameInput.value?.[0]?.select());
}
const renaming = ref("");
const renameText = ref("");
const renameInput = ref<HTMLInputElement[]>();
function commitRename() {
  const tab = state.tabs.find((t) => t.id === renaming.value);
  renaming.value = "";
  if (!tab) return;
  const name = renameText.value.trim().slice(0, 80);
  if (name) tab.name = name;
  else delete tab.name;
  save();
}
function setFont(size: number) {
  fontSize.value = Math.max(8, Math.min(32, size));
  if (fontSize.value === DEFAULT_FONT) delete state.fontSize;
  else state.fontSize = fontSize.value;
  save();
}
function setDefault(id: string) {
  state.defaultProfile = id;
  save();
}

// ---- Search ----
const searching = ref(false);
const query = ref("");
const caseSensitive = ref(false);
const notFound = ref(false);
const searchInput = ref<HTMLInputElement>();
function openSearch() {
  searching.value = true;
  void nextTick(() => searchInput.value?.select());
}
function findNext(backwards = false) {
  const tab = activeTab.value;
  if (!tab || !query.value) return;
  notFound.value = !handles.get(tab.focus)?.find(query.value, { caseSensitive: caseSensitive.value, backwards });
}
function closeSearch() {
  searching.value = false;
  notFound.value = false;
  const tab = activeTab.value;
  if (tab) {
    handles.get(tab.focus)?.clearFind();
    handles.get(tab.focus)?.focus();
  }
}

// ---- Commands from keys inside a pane ----
function command(name: string, paneId: string) {
  const tab = tabOf(paneId);
  if (name === "new-tab") return newTab();
  if (name.startsWith("profile-")) {
    const profile = profiles.value[Number(name.slice(8)) - 1];
    return profile && newTab(profile.id);
  }
  if (name === "close-pane") return closePane(paneId);
  if (name === "next-tab" || name === "previous-tab") {
    const i = state.tabs.findIndex((t) => t.id === state.active);
    const n = state.tabs.length;
    const next = state.tabs[(i + (name === "next-tab" ? 1 : -1) + n) % n];
    return next && selectTab(next.id);
  }
  if (name === "split-auto") return split(paneId, "auto");
  if (name === "split-right") return split(paneId, "row");
  if (name === "split-down") return split(paneId, "column");
  if (name.startsWith("focus-")) return moveFocus(paneId, name.slice(6) as "left");
  if (name === "find") return openSearch();
  if (name === "font-bigger") return setFont(fontSize.value + 1);
  if (name === "font-smaller") return setFont(fontSize.value - 1);
  if (name === "font-reset") return setFont(DEFAULT_FONT);
  if (name === "clear") return handles.get(paneId)?.clear();
  void tab;
}

const controller: TerminalController = {
  fontSize,
  visible: (paneId) => !!activeTab.value && panes(activeTab.value.root).some((p) => p.id === paneId),
  focused: (paneId) => activeTab.value?.focus === paneId,
  profileOf,
  focus(paneId) {
    const tab = tabOf(paneId);
    if (!tab) return;
    if (tab.focus !== paneId) {
      tab.focus = paneId;
      save();
    }
  },
  title: (paneId, title) => titles.set(paneId, title),
  activity(paneId) {
    const tab = tabOf(paneId);
    if (tab && tab.id !== state.active) activity.add(tab.id);
  },
  bell(paneId) {
    const tab = tabOf(paneId);
    if (tab && (tab.id !== state.active || !document.hasFocus())) bells.add(tab.id);
  },
  closed: (paneId) => closePane(paneId, false),
  command,
  register(paneId, pane) {
    if (pane) handles.set(paneId, pane);
    else handles.delete(paneId);
  },
};
provide(TERMINAL, controller);

// ---- New-tab profile menu ----
const menuButton = ref<HTMLButtonElement>();
const menu = ref<HTMLDivElement>();
const profileMenu = usePopover(menuButton, menu, 320);
function pickProfile(id: string) {
  profileMenu.close();
  newTab(id);
}

// ---- Ctrl+K ----
const stopCommands = registerCommands(`terminal:${props.block.id}`, () => [
  ...profiles.value.map((p) => ({
    id: `terminal-new:${props.block.id}:${p.id}`,
    title: `New terminal tab: ${p.name}`,
    icon: "terminal",
    blockId: props.block.id,
    keywords: "terminal shell console profile",
    run: () => newTab(p.id),
  })),
  ...(activeTab.value
    ? [
        {
          id: `terminal-split-right:${props.block.id}`,
          title: "Split terminal right",
          icon: "columns",
          blockId: props.block.id,
          keywords: "terminal pane",
          run: () => split(activeTab.value!.focus, "row"),
        },
        {
          id: `terminal-split-down:${props.block.id}`,
          title: "Split terminal down",
          icon: "rows",
          blockId: props.block.id,
          keywords: "terminal pane",
          run: () => split(activeTab.value!.focus, "column"),
        },
        {
          id: `terminal-find:${props.block.id}`,
          title: "Find in terminal",
          icon: "search",
          blockId: props.block.id,
          keywords: "terminal search scrollback",
          run: openSearch,
        },
      ]
    : []),
]);

onMounted(async () => {
  profiles.value = await terminalProfiles();
  // A new Terminal app opens with one tab of the default profile.
  if (!state.tabs.length && !props.block.value) newTab();
});
onBeforeUnmount(stopCommands);
// The block can be replaced (undo of a whole workspace, import): follow it.
watch(
  () => props.block.value,
  (value) => {
    if (value === JSON.stringify(state)) return;
    Object.assign(state, readTerminal(value));
  },
);
const kindIcon = (kind?: string) => (kind === "wsl" ? "desktop" : "terminal");
</script>

<template>
  <div class="terminal-view">
    <div class="terminal-bar" role="tablist" aria-label="Terminal tabs">
      <div class="terminal-tabs">
        <div
          v-for="tab in state.tabs"
          :key="tab.id"
          class="terminal-tab"
          :class="{ active: tab.id === state.active }"
          role="tab"
          :aria-selected="tab.id === state.active"
          tabindex="0"
          @click="selectTab(tab.id)"
          @dblclick="renameTab(tab)"
          @auxclick.prevent="$event.button === 1 && closeTab(tab.id)"
          @keydown.enter.self="selectTab(tab.id)"
          @keydown.f2.self="renameTab(tab)"
        >
          <Icon :name="kindIcon(profileOf(panes(tab.root)[0]!.profile)?.kind)" :size="12" />
          <input
            v-if="renaming === tab.id"
            ref="renameInput"
            v-model="renameText"
            class="terminal-rename"
            aria-label="Tab name"
            maxlength="80"
            @keydown.enter="commitRename"
            @keydown.esc.stop="renaming = ''"
            @blur="commitRename"
            @click.stop
          />
          <span v-else class="terminal-tab-label" :title="tabLabel(tab)">{{ tabLabel(tab) }}</span>
          <Icon v-if="bells.has(tab.id)" name="bell" :size="11" class="terminal-tab-bell" />
          <span v-else-if="activity.has(tab.id)" class="terminal-tab-activity" aria-label="New output"></span>
          <small v-if="panes(tab.root).length > 1" class="terminal-tab-count">{{ panes(tab.root).length }}</small>
          <button
            type="button"
            class="terminal-tab-close"
            :aria-label="`Close ${tabLabel(tab)}`"
            @click.stop="closeTab(tab.id)"
          >
            <Icon name="close" :size="11" />
          </button>
        </div>
      </div>
      <div class="terminal-new">
        <button
          type="button"
          class="terminal-icon-button"
          :aria-label="`New tab (${defaultProfile?.name ?? 'default shell'})`"
          :title="`New tab: ${defaultProfile?.name ?? 'default shell'} (Ctrl+Shift+T)`"
          @click="newTab()"
        >
          <Icon name="plus" :size="14" />
        </button>
        <button
          ref="menuButton"
          type="button"
          class="terminal-icon-button terminal-menu-button"
          aria-label="Choose a profile"
          aria-haspopup="menu"
          :aria-expanded="profileMenu.open.value"
          @click.stop="profileMenu.show"
        >
          <Icon name="down" :size="12" />
        </button>
      </div>
      <div class="terminal-actions">
        <button
          type="button"
          class="terminal-icon-button"
          aria-label="Split right"
          title="Split right (Alt+Shift+=)"
          :disabled="!activeTab"
          @click="activeTab && split(activeTab.focus, 'row')"
        >
          <Icon name="columns" :size="14" />
        </button>
        <button
          type="button"
          class="terminal-icon-button"
          aria-label="Split down"
          title="Split down (Alt+Shift+-)"
          :disabled="!activeTab"
          @click="activeTab && split(activeTab.focus, 'column')"
        >
          <Icon name="rows" :size="14" />
        </button>
        <button
          type="button"
          class="terminal-icon-button"
          aria-label="Find"
          title="Find (Ctrl+Shift+F)"
          :disabled="!activeTab"
          @click="openSearch"
        >
          <Icon name="search" :size="14" />
        </button>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="profileMenu.open.value"
        ref="menu"
        class="select-popover terminal-profile-menu"
        role="menu"
        tabindex="-1"
        aria-label="Profiles"
        :style="profileMenu.style.value"
        @pointerdown.stop
        @keydown.esc.stop="profileMenu.close(true)"
        @wheel.stop
      >
        <p v-if="!profiles.length" class="terminal-menu-empty">No shells found on this computer.</p>
        <div v-for="(p, i) in profiles" :key="p.id" class="terminal-menu-row">
          <button type="button" role="menuitem" class="terminal-menu-item" @click="pickProfile(p.id)">
            <Icon :name="kindIcon(p.kind)" :size="13" />
            <span>{{ p.name }}</span>
            <kbd v-if="i < 9">Ctrl+Shift+{{ i + 1 }}</kbd>
          </button>
          <button
            type="button"
            class="terminal-default"
            :class="{ on: defaultProfile?.id === p.id }"
            :aria-pressed="defaultProfile?.id === p.id"
            :aria-label="`Make ${p.name} the default`"
            :title="defaultProfile?.id === p.id ? 'Default profile' : 'Make default'"
            @click="setDefault(p.id)"
          >
            <Icon name="star" :size="12" />
          </button>
        </div>
      </div>
    </Teleport>
    <div v-if="searching" class="terminal-search" role="search" @keydown.esc.stop="closeSearch">
      <input
        ref="searchInput"
        v-model="query"
        aria-label="Find in terminal"
        placeholder="Find"
        :class="{ missing: notFound }"
        @input="notFound = false"
        @keydown.enter.exact.prevent="findNext(false)"
        @keydown.shift.enter.prevent="findNext(true)"
      />
      <button
        type="button"
        class="terminal-icon-button"
        :class="{ on: caseSensitive }"
        aria-label="Match case"
        :aria-pressed="caseSensitive"
        title="Match case"
        @click="caseSensitive = !caseSensitive"
      >
        Aa
      </button>
      <button type="button" class="terminal-icon-button" aria-label="Previous match" @click="findNext(true)">
        <Icon name="up" :size="13" />
      </button>
      <button type="button" class="terminal-icon-button" aria-label="Next match" @click="findNext(false)">
        <Icon name="down" :size="13" />
      </button>
      <button type="button" class="terminal-icon-button" aria-label="Close find" @click="closeSearch">
        <Icon name="close" :size="12" />
      </button>
    </div>
    <div class="terminal-body">
      <div
        v-for="tab in state.tabs"
        v-show="tab.id === state.active"
        :key="tab.id"
        class="terminal-tab-body"
      >
        <TerminalSplit :node="tab.root" @resized="save" />
      </div>
      <div v-if="!state.tabs.length" class="terminal-empty">
        <p>No terminals open.</p>
        <div class="terminal-empty-profiles">
          <button v-for="p in profiles" :key="p.id" type="button" class="subtle-button" @click="newTab(p.id)">
            <Icon :name="kindIcon(p.kind)" :size="13" />{{ p.name }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.terminal-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px 4px;
  flex: none;
}
.terminal-tabs {
  display: flex;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 5px 4px 5px 9px;
  border-radius: 6px;
  color: #556c7a;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  flex: none;
}
.terminal-tab:hover {
  background: rgb(255 255 255 / 35%);
}
.terminal-tab.active {
  background: rgb(255 255 255 / 60%);
  color: #2f4250;
}
.terminal-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-rename {
  width: 130px;
  border: 1px solid #c8d4db;
  border-radius: 4px;
  padding: 1px 5px;
  font: inherit;
  background: #fff;
}
.terminal-tab-activity {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6f8998;
  flex: none;
}
.terminal-tab-bell {
  color: #946b08;
  flex: none;
}
.terminal-tab-count {
  font-size: 10px;
  color: #8a9ca7;
}
.terminal-tab-close {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  opacity: 0.55;
}
.terminal-tab-close:hover {
  opacity: 1;
  background: rgb(69 89 104 / 10%);
}
.terminal-new {
  display: flex;
  flex: none;
}
.terminal-menu-button {
  width: 20px;
  margin-left: -2px;
}
.terminal-actions {
  display: flex;
  gap: 2px;
  margin-left: auto;
  flex: none;
}
.terminal-icon-button {
  display: grid;
  place-items: center;
  min-width: 26px;
  height: 26px;
  padding: 0 4px;
  border-radius: 5px;
  background: transparent;
  color: #556c7a;
  font-size: 11px;
  font-weight: 600;
}
.terminal-icon-button:hover:not(:disabled),
.terminal-icon-button.on,
.terminal-icon-button[aria-expanded="true"] {
  background: rgb(255 255 255 / 55%);
}
.terminal-icon-button:disabled {
  opacity: 0.4;
}
.terminal-body {
  flex: 1;
  min-height: 0;
  position: relative;
  padding: 0 6px 6px;
}
.terminal-tab-body {
  width: 100%;
  height: 100%;
}
.terminal-search {
  position: absolute;
  top: 38px;
  right: 14px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 7px;
  background: rgb(247 250 252 / 88%);
  box-shadow: 0 8px 24px -10px #43576455;
}
.terminal-search input {
  width: 180px;
  border: 0;
  border-radius: 4px;
  padding: 5px 8px;
  background: #fff;
  color: #2f4250;
  font-size: 12px;
  outline: none;
}
.terminal-search input.missing {
  box-shadow: inset 0 0 0 1px #d0453f;
}
.terminal-empty {
  height: 100%;
  display: grid;
  place-content: center;
  gap: 10px;
  text-align: center;
  color: #556c7a;
}
.terminal-empty p {
  margin: 0;
}
.terminal-empty-profiles {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}
</style>

<style>
/* The profile menu is teleported to the body. */
.terminal-profile-menu {
  min-width: 18em;
  padding: 0.4em;
}
.terminal-menu-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.terminal-menu-item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.6em;
  padding: 0.55em 0.6em;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #455968;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.terminal-menu-item:hover,
.terminal-default:hover {
  background: #e2ecf2;
}
.terminal-menu-item span {
  flex: 1;
  white-space: nowrap;
}
.terminal-menu-item kbd {
  font: inherit;
  font-size: 0.85em;
  color: #8a9ca7;
}
.terminal-default {
  display: grid;
  place-items: center;
  width: 2.2em;
  height: 2.2em;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #b4c1c9;
  cursor: pointer;
}
.terminal-default.on {
  color: #b8860b;
}
.terminal-menu-empty {
  margin: 0.4em 0.6em;
  color: #687d8a;
}
</style>

<style>
/* Fills its app, like the other built-in apps. */
.app-content:has(> .block-terminal:only-child) {
  padding: 0;
  overflow: hidden;
}
.app-content > .block-terminal {
  display: flex;
  flex: 1;
  min-height: 240px;
}
.app-content > .block-terminal > * {
  flex: 1;
  min-width: 0;
}
.block-terminal:not(:only-child) {
  height: 520px;
}
</style>
