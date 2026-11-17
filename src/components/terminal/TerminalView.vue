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
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";
import Icon from "../Icon.vue";
import TerminalSplit from "./TerminalSplit.vue";
import { TERMINAL, type PaneHandle, type TerminalController } from "./controller";
import { usePopover } from "../pickers/usePopover";
import { registerCommands } from "../../commands";
import { uid, type Block } from "../../model";
import { terminal as client, terminalProfiles, type TerminalProfileInfo } from "../../terminalClient";
import { addWorkbenchWidget, workbenchEditable } from "../../workbenchWidgets";
import {
  panes,
  readTerminal,
  replacePane,
  type LayoutNode,
  type PaneNode,
  type TerminalState,
  type TerminalTab,
} from "../../terminalLayout";

const props = withDefaults(defineProps<{ block: Block; initialCwd?: string; visible?: boolean }>(), {
  visible: true,
});
const editable = inject(workbenchEditable, () => false);
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
const visitedTabs = reactive(new Set<string>());
watch([activeTab, () => props.visible, () => state.tabs.map((tab) => tab.id)], ([tab, visible, ids]) => {
  for (const id of visitedTabs) if (!ids.includes(id)) visitedTabs.delete(id);
  if (tab && visible) visitedTabs.add(tab.id);
}, { immediate: true });
function openTestResults() {
  const tab = activeTab.value;
  const cwd = tab && panes(tab.root).find((pane) => pane.id === tab.focus)?.cwd;
  addWorkbenchWidget("test-results", { cwd: cwd ?? "" });
}
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
function newPane(profileId = defaultProfile.value?.id ?? "", cwd = props.initialCwd): PaneNode {
  return { type: "pane", id: uid(), profile: profileId, cwd };
}
function newTab(profileId?: string, cwd?: string, name?: string) {
  const pane = newPane(profileId, cwd);
  const tab: TerminalTab = { id: uid(), root: pane, focus: pane.id, name };
  state.tabs.push(tab);
  selectTab(tab.id);
}
defineExpose({ openTab: (cwd: string, name?: string) => newTab(undefined, cwd, name) });

const tabMime = "application/x-orvane-terminal-tab";
const terminalBody = ref<HTMLElement>();
const dragging = ref<{ tabId: string; paneId?: string }>();
const tabDrop = ref<{ id: string; after: boolean }>();
type PaneDrop = { id: string; edge: "left" | "right" | "top" | "bottom" };
type PaneRect = { x: number; y: number; width: number; height: number };
const paneDrop = ref<PaneDrop>();
const previewFrames = ref<(PaneRect & { id: string })[]>([]);
const dropGuide = ref<(PaneRect & { id: string; compact: boolean })>();
const dropDirections = [
  { edge: "left", icon: "back", label: "Split left" },
  { edge: "right", icon: "forward", label: "Split right" },
  { edge: "top", icon: "up", label: "Split above" },
  { edge: "bottom", icon: "down", label: "Split below" },
] as const;
let paneDrag: {
  pointer: number; paneId: string; tabId: string; x: number; y: number;
  pane: HTMLElement; scale: number; bounds: DOMRect;
  source: DOMRect; lift: number;
  targets: { pane: HTMLElement; rect: DOMRect }[];
} | undefined;

function clearPanePreview() {
  if (!paneDrag) return;
  for (const { pane } of paneDrag.targets) {
    pane.classList.remove("terminal-pane-preview-moving", "terminal-pane-lifted");
    pane.style.removeProperty("--terminal-preview-transform");
    pane.style.removeProperty("--terminal-preview-clip");
  }
  previewFrames.value = [];
  dropGuide.value = undefined;
}

function resetDrag() {
  clearPanePreview();
  paneDrag = undefined;
  dragging.value = undefined;
  tabDrop.value = undefined;
  paneDrop.value = undefined;
}
function startDrag(event: DragEvent, tabId: string) {
  if (!event.dataTransfer || (event.target as Element).closest("input, button")) {
    event.preventDefault();
    return;
  }
  dragging.value = { tabId };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(tabMime, tabId);
}
function beginPaneDrag(event: PointerEvent) {
  const body = terminalBody.value;
  const target = event.target as Element;
  const handle = target.closest("[data-drag-terminal-pane]");
  if (paneDrag || event.button !== 0 || !activeTab.value || !body ||
      (!handle && (!event.shiftKey || target.closest("button")))) return;
  const pane = target.closest<HTMLElement>(".terminal-pane.has-pane-handle");
  const tabBody = pane?.closest<HTMLElement>(".terminal-tab-body");
  if (!pane?.dataset.terminalPane || !tabBody) return;
  const bounds = tabBody.getBoundingClientRect();
  const source = pane.getBoundingClientRect();
  const targets = [...tabBody.querySelectorAll<HTMLElement>("[data-terminal-pane]")]
    .map((pane) => ({ pane, rect: pane.getBoundingClientRect() }));
  event.preventDefault();
  event.stopPropagation();
  paneDrag = {
    pointer: event.pointerId, paneId: pane.dataset.terminalPane, tabId: activeTab.value.id,
    x: event.clientX, y: event.clientY, pane, bounds, targets,
    source, lift: Math.min(0.72, 360 / source.width, 200 / source.height),
    scale: bounds.width / tabBody.offsetWidth || 1,
  };
  body.setPointerCapture(event.pointerId);
}
function movePaneDrag(event: PointerEvent) {
  const drag = paneDrag;
  if (!drag || drag.pointer !== event.pointerId) return;
  if (!dragging.value) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    dragging.value = { tabId: drag.tabId, paneId: drag.paneId };
    drag.pane.classList.add("terminal-pane-lifted");
  }
  const { source, lift } = drag;
  const dx = (event.clientX - drag.x + (drag.x - source.left) * (1 - lift)) / drag.scale;
  const dy = (event.clientY - drag.y + (drag.y - source.top) * (1 - lift)) / drag.scale;
  drag.pane.style.setProperty("--terminal-preview-transform", `translate(${dx}px, ${dy}px) scale(${lift})`);

  const target = event.clientY < drag.bounds.top
    ? document.elementFromPoint(event.clientX, event.clientY)
    : null;
  const tab = target?.closest<HTMLElement>("[data-terminal-tab]");
  const previous = paneDrop.value;
  if (tab && terminalBody.value?.parentElement?.contains(tab)) {
    paneDrop.value = undefined;
    dropGuide.value = undefined;
    positionTabDrop(tab, tab.dataset.terminalTab!, event.clientX);
  } else {
    tabDrop.value = undefined;
    // Keep the hit regions fixed while the painted frames move underneath them.
    const hit = drag.targets.find(({ rect }) =>
      event.clientX >= rect.left && event.clientX < rect.right &&
      event.clientY >= rect.top && event.clientY < rect.bottom);
    const id = hit?.pane.dataset.terminalPane;
    if (!hit || !id || id === drag.paneId || hit.rect.width < 48 || hit.rect.height < 48) {
      dropGuide.value = undefined;
    } else if (dropGuide.value?.id !== id) {
      const { rect } = hit;
      dropGuide.value = {
        id, compact: rect.width < 200 || rect.height < 100,
        x: (rect.left - drag.bounds.left) / drag.scale, y: (rect.top - drag.bounds.top) / drag.scale,
        width: rect.width / drag.scale, height: rect.height / drag.scale,
      };
    }
    positionPaneDrop(hit?.pane ?? null, event.clientX, event.clientY, hit?.rect);
  }
  if (previous !== paneDrop.value) previewPaneDrop();
}
function endPaneDrag(event: PointerEvent, cancel = false) {
  if (!paneDrag || paneDrag.pointer !== event.pointerId) return;
  if (cancel) return resetDrag();
  if (dragging.value) movePaneDrag(event);
  if (tabDrop.value) dropTab(event, tabDrop.value.id);
  else dropPane(event);
}
function cancelPaneDrag(event: KeyboardEvent) {
  if (event.key !== "Escape" || !paneDrag) return;
  event.preventDefault();
  event.stopPropagation();
  const body = terminalBody.value;
  if (body?.hasPointerCapture(paneDrag.pointer)) body.releasePointerCapture(paneDrag.pointer);
  resetDrag();
}

function splitAtDrop(root: LayoutNode, moving: LayoutNode, drop: PaneDrop, id: string) {
  const target = panes(root).find((pane) => pane.id === drop.id);
  if (!target) return root;
  const before = drop.edge === "left" || drop.edge === "top";
  return replacePane(root, target.id, {
    type: "split", id, ratio: 0.5,
    dir: drop.edge === "left" || drop.edge === "right" ? "row" : "column",
    a: before ? moving : target, b: before ? target : moving,
  })!;
}

function previewPaneDrop() {
  const drag = paneDrag;
  const tab = activeTab.value;
  if (!drag || !tab) return;
  const { scale, bounds } = drag;
  const moving = panes(tab.root).find((pane) => pane.id === drag.paneId);
  const remaining = moving && paneDrop.value && replacePane(tab.root, moving.id, null);
  const projected = new Map<string, PaneRect>();
  const gap = parseFloat(getComputedStyle(terminalBody.value!).getPropertyValue("--terminal-divider-size"));
  function place(node: LayoutNode, rect: PaneRect) {
    if (node.type === "pane") {
      projected.set(node.id, rect);
      return;
    }
    if (node.dir === "row") {
      const width = Math.max(0, rect.width - gap);
      const first = width * node.ratio;
      place(node.a, { ...rect, width: first });
      place(node.b, { ...rect, x: rect.x + first + gap, width: width - first });
    } else {
      const height = Math.max(0, rect.height - gap);
      const first = height * node.ratio;
      place(node.a, { ...rect, height: first });
      place(node.b, { ...rect, y: rect.y + first + gap, height: height - first });
    }
  }
  if (remaining && moving && paneDrop.value) {
    place(splitAtDrop(remaining, moving, paneDrop.value, "preview"), {
      x: 0, y: 0, width: bounds.width / scale, height: bounds.height / scale,
    });
  }
  const frames: typeof previewFrames.value = [];
  for (const { pane, rect } of drag.targets) {
    const id = pane.dataset.terminalPane!;
    const next = projected.get(id);
    if (pane !== drag.pane) {
      const dx = next ? next.x - (rect.left - bounds.left) / scale : 0;
      const dy = next ? next.y - (rect.top - bounds.top) / scale : 0;
      const width = rect.width / scale;
      const height = rect.height / scale;
      pane.classList.add("terminal-pane-preview-moving");
      pane.style.setProperty("--terminal-preview-transform", `translate(${dx}px, ${dy}px)`);
      pane.style.setProperty("--terminal-preview-clip", next
        ? `inset(0 ${Math.max(0, width - next.width)}px ${Math.max(0, height - next.height)}px 0 round 6px)`
        : "inset(0 round 6px)");
      if (!next || (Math.abs(dx) < 1 && Math.abs(dy) < 1 &&
          Math.abs(next.width - width) < 1 && Math.abs(next.height - height) < 1)) continue;
    }
    if (next) frames.push({ id, ...next });
  }
  previewFrames.value = frames;
}
function animatePaneMove() {
  const body = terminalBody.value;
  if (!body || matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  const visiblePanes = () => [...body.querySelectorAll<HTMLElement>("[data-terminal-pane]")]
    .filter((pane) => pane.offsetWidth && pane.offsetHeight);
  const before = new Map(visiblePanes().map((pane) => [pane.dataset.terminalPane, pane.getBoundingClientRect()]));
  return () => void nextTick(() => {
    const scale = body.getBoundingClientRect().width / body.offsetWidth || 1;
    for (const pane of visiblePanes()) {
      const rect = pane.getBoundingClientRect();
      const previous = before.get(pane.dataset.terminalPane);
      if (previous && previous.x === rect.x && previous.y === rect.y &&
          previous.width === rect.width && previous.height === rect.height) continue;
      const x = previous ? (previous.x - rect.x) / scale : 0;
      const y = previous ? (previous.y - rect.y) / scale : 0;
      pane.animate([
        { transform: `translate(${x}px, ${y}px)`, opacity: 0.76 },
        { transform: "translate(0, 0)", opacity: 1 },
      ], { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    }
  });
}
function movePaneToTab(source: TerminalTab, paneId: string, at = state.tabs.length) {
  const animate = animatePaneMove();
  const pane = takePane(source, paneId);
  if (!pane) return;
  const tab: TerminalTab = { id: uid(), root: pane, focus: pane.id };
  state.tabs.splice(at, 0, tab);
  selectTab(tab.id);
  animate();
}
function detachPaneClick(event: MouseEvent) {
  const paneId = (event.target as Element).closest<HTMLElement>("[data-untile-terminal-pane]")?.dataset.untileTerminalPane;
  if (paneId && activeTab.value) movePaneToTab(activeTab.value, paneId);
}
function overTab(event: DragEvent, id: string) {
  paneDrop.value = undefined;
  if (!dragging.value || (!dragging.value.paneId && dragging.value.tabId === id) || !event.dataTransfer?.types.includes(tabMime)) {
    tabDrop.value = undefined;
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  positionTabDrop(event.currentTarget as HTMLElement, id, event.clientX);
}
function positionTabDrop(tab: HTMLElement, id: string, x: number) {
  const rect = tab.getBoundingClientRect();
  tabDrop.value = { id, after: x >= rect.left + rect.width / 2 };
}
function dropTab(event: MouseEvent, id: string) {
  const drag = dragging.value;
  const drop = tabDrop.value;
  const from = state.tabs.findIndex((tab) => tab.id === drag?.tabId);
  const to = state.tabs.findIndex((tab) => tab.id === id);
  resetDrag();
  if (!drop || drop.id !== id || from < 0 || to < 0 || (from === to && !drag?.paneId)) return;
  event.preventDefault();
  if (drag?.paneId) {
    return movePaneToTab(state.tabs[from]!, drag.paneId, to + Number(drop.after));
  }
  const [tab] = state.tabs.splice(from, 1);
  state.tabs.splice(to + Number(drop.after) - Number(from < to), 0, tab!);
  save();
}
function overPane(event: DragEvent) {
  tabDrop.value = undefined;
  const drag = dragging.value;
  if (!drag || (!drag.paneId && drag.tabId === state.active) || !event.dataTransfer?.types.includes(tabMime)) return;
  positionPaneDrop((event.target as Element).closest<HTMLElement>("[data-terminal-pane]"), event.clientX, event.clientY);
  if (!paneDrop.value) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}
function positionPaneDrop(target: HTMLElement | null, clientX: number, clientY: number, bounds?: DOMRect) {
  if (!target || target.dataset.terminalPane === dragging.value?.paneId) {
    paneDrop.value = undefined;
    return;
  }
  const rect = bounds ?? target.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const edges = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  const edge = (Object.keys(edges) as (keyof typeof edges)[]).reduce((a, b) => edges[a] < edges[b] ? a : b);
  const id = target.dataset.terminalPane!;
  const previous = paneDrop.value;
  if (bounds && previous?.id === id && edges[previous.edge] < 0.36 &&
      edges[previous.edge] - edges[edge] < 0.04) return;
  if (edges[edge] >= 0.32) paneDrop.value = undefined;
  else if (paneDrop.value?.id !== id || paneDrop.value.edge !== edge) paneDrop.value = { id, edge };
}
function dropPane(event: MouseEvent) {
  const drag = dragging.value;
  const drop = paneDrop.value;
  const source = state.tabs.find((tab) => tab.id === drag?.tabId);
  const target = activeTab.value;
  if (!drop || !source || !target || (!drag?.paneId && source === target) || drop.id === drag?.paneId) return resetDrag();
  const pane = panes(target.root).find((item) => item.id === drop.id);
  if (!pane) return resetDrag();
  event.preventDefault();
  const animate = animatePaneMove();
  resetDrag();
  const moving = drag?.paneId ? takePane(source, drag.paneId) : source.root;
  if (!moving) return;
  const root = splitAtDrop(target.root, moving, drop, uid());
  // Remove the tab without closing any of its live shell sessions.
  if (!drag?.paneId) state.tabs.splice(state.tabs.indexOf(source), 1);
  target.root = root;
  target.focus = drag?.paneId ?? source.focus;
  selectTab(target.id);
  animate();
}
function takePane(tab: TerminalTab, id: string) {
  const pane = panes(tab.root).find((item) => item.id === id);
  const root = pane && replacePane(tab.root, id, null);
  if (!root) return;
  tab.root = root;
  if (tab.focus === id) tab.focus = panes(root)[0]!.id;
  return pane;
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
  const added = newPane(pane.profile, pane.cwd);
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
  visible: (paneId) => props.visible && !!activeTab.value && panes(activeTab.value.root).some((p) => p.id === paneId),
  focused: (paneId) => activeTab.value?.focus === paneId,
  profileOf: (id) => profileOf(id) ?? profiles.value[0],
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
  closeAfterExit: (paneId) => {
    if (tabOf(paneId)?.root.type !== "pane") return false;
    closePane(paneId, false);
    return true;
  },
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
onMounted(() => window.addEventListener("keydown", cancelPaneDrag, true));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", cancelPaneDrag, true);
  resetDrag();
});
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
      <TransitionGroup tag="div" class="terminal-tabs" move-class="terminal-tab-move" :css="false">
        <div
          v-for="tab in state.tabs"
          :key="tab.id"
          class="terminal-tab"
          :class="{ active: tab.id === state.active, 'drop-before': tabDrop?.id === tab.id && !tabDrop.after, 'drop-after': tabDrop?.id === tab.id && tabDrop.after }"
          role="tab"
          :aria-label="tabLabel(tab)"
          :title="panes(tab.root).find((pane) => pane.id === tab.focus)?.cwd"
          :aria-selected="tab.id === state.active"
          :data-terminal-tab="tab.id"
          tabindex="0"
          :draggable="renaming !== tab.id"
          @dragstart="startDrag($event, tab.id)"
          @dragover="overTab($event, tab.id)"
          @dragleave="!($event.currentTarget as HTMLElement).contains($event.relatedTarget as Node) && (tabDrop = undefined)"
          @drop="dropTab($event, tab.id)"
          @dragend="resetDrag"
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
      </TransitionGroup>
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
        <button v-if="editable?.()" type="button" class="terminal-icon-button" aria-label="Pin Playwright results"
          title="Pin Playwright results" @click="openTestResults"><Icon name="play" :size="14" /></button>
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
        <slot name="actions" />
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
    <div ref="terminalBody" class="terminal-body" @click="detachPaneClick" @dragend="resetDrag" @dragover="overPane" @drop="dropPane"
      @pointerdown.capture="beginPaneDrag" @pointermove="movePaneDrag" @pointerup="endPaneDrag($event)"
      @pointercancel="endPaneDrag($event, true)" @lostpointercapture="endPaneDrag($event, true)"
      @dragleave="!($event.currentTarget as HTMLElement).contains($event.relatedTarget as Node) && (paneDrop = undefined)">
      <div
        v-for="tab in state.tabs"
        v-show="tab.id === state.active"
        :key="tab.id"
        class="terminal-tab-body"
        :class="{ 'previewing-split': tab.id === state.active && previewFrames.length }"
      >
        <TerminalSplit v-if="visitedTabs.has(tab.id)" :node="tab.root"
          :drop="tab.id === state.active && !dragging?.paneId ? paneDrop : undefined" @resized="save" />
        <div v-if="tab.id === state.active" class="terminal-split-preview" aria-hidden="true">
          <div v-for="frame in previewFrames" :key="frame.id" class="terminal-split-preview-frame"
            :class="{ destination: frame.id === dragging?.paneId }"
            :style="{ width: frame.width + 'px', height: frame.height + 'px',
              transform: `translate(${frame.x}px, ${frame.y}px)` }" />
        </div>
        <div v-if="tab.id === state.active && dropGuide" class="terminal-drop-guide"
          :class="{ compact: dropGuide.compact }" aria-hidden="true"
          :style="{ left: dropGuide.x + 'px', top: dropGuide.y + 'px',
            width: dropGuide.width + 'px', height: dropGuide.height + 'px' }">
          <span v-for="direction in dropDirections" :key="direction.edge" class="terminal-drop-marker"
            :class="[direction.edge, { selected: paneDrop?.edge === direction.edge }]">
            <Icon :name="direction.icon" :size="14" />
          </span>
          <span v-if="!dropGuide.compact" class="terminal-drop-hint">
            {{ dropDirections.find((direction) => direction.edge === paneDrop?.edge)?.label ?? "Drag to an edge to split" }}
          </span>
        </div>
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
.terminal-tab-move {
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
@media (prefers-reduced-motion: reduce) {
  .terminal-tab-move { transition: none; }
}
.terminal-tab.drop-before {
  box-shadow: inset 2px 0 #546e7c;
}
.terminal-tab.drop-after {
  box-shadow: inset -2px 0 #546e7c;
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
  --terminal-divider-size: 6px;
  flex: 1;
  min-height: 0;
  position: relative;
  padding: 0 6px 6px;
}
.terminal-tab-body {
  position: relative;
  width: 100%;
  height: 100%;
}
.previewing-split :deep(.terminal-divider) {
  visibility: hidden;
}
.terminal-split-preview {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}
.terminal-split-preview-frame {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 6px;
  box-shadow: inset 0 0 0 1px rgb(111 137 152 / 42%);
  transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1);
}
.terminal-split-preview-frame.destination {
  background: rgb(111 137 152 / 14%);
  box-shadow: inset 0 0 0 1px #6f8998;
}
.terminal-drop-guide {
  position: absolute;
  z-index: 4;
  pointer-events: none;
}
.terminal-drop-marker,
.terminal-drop-hint {
  position: absolute;
  display: grid;
  place-items: center;
  background: #f7f9fa;
  color: #455968;
  border: 1px solid #b5c5cf;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgb(69 89 104 / 14%);
}
.terminal-drop-marker {
  width: 24px;
  height: 24px;
}
.terminal-drop-marker.selected {
  background: #c5d8e3;
  color: #223744;
  border-color: #6f8998;
}
.terminal-drop-marker.left,
.terminal-drop-marker.right {
  top: 50%;
  translate: 0 -50%;
}
.terminal-drop-marker.top,
.terminal-drop-marker.bottom {
  left: 50%;
  translate: -50% 0;
}
.terminal-drop-marker.left { left: min(8px, 8%); }
.terminal-drop-marker.right { right: min(8px, 8%); }
.terminal-drop-marker.top { top: min(8px, 8%); }
.terminal-drop-marker.bottom { bottom: min(8px, 8%); }
.terminal-drop-hint {
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  padding: 3px 7px;
  font-size: 11px;
  white-space: nowrap;
}
.terminal-drop-guide.compact .terminal-drop-marker {
  width: 20px;
  height: 20px;
}
.terminal-body :deep(.terminal-pane-preview-moving) {
  clip-path: var(--terminal-preview-clip);
  transform: var(--terminal-preview-transform);
  transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1), clip-path 150ms cubic-bezier(0.22, 1, 0.36, 1);
}
.terminal-body :deep(.terminal-pane-lifted) {
  z-index: 3;
  pointer-events: none;
  transform-origin: top left;
  transform: var(--terminal-preview-transform);
  background: #f7f9fa;
  box-shadow: 0 6px 18px rgb(69 89 104 / 24%);
}
@media (prefers-reduced-motion: reduce) {
  .terminal-split-preview-frame,
  .terminal-body :deep(.terminal-pane-preview-moving) {
    transition: none;
  }
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
