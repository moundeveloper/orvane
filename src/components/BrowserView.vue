<script lang="ts">
// Shared by every Browser app: a budget of live pages. Each <webview> costs
// a renderer process (about 100 MB on a trivial page, far more on NetSuite),
// so beyond the limit the pages nobody has seen for a while are replaced by
// a picture while hidden, then automatically restored when visible again.
interface LivePage {
  /** Last time the page was on screen (now while it is). */
  seen(): number;
  /** On screen, or the one the user is working in: never discarded. */
  kept(): boolean;
  discard(): Promise<void>;
  /** Keep a current picture of the page, if it is on screen. */
  remember(): void;
}
const livePages = new Set<LivePage>();
/** Settings (localStorage, positive numbers), read when used. */
function browserSetting(name: "liveLimit" | "discardAfterMs" | "pauseAfterMs") {
  const defaults = { liveLimit: 6, discardAfterMs: 120_000, pauseAfterMs: 1500 };
  try {
    const value = Number(localStorage.getItem(`orvane.browser.${name}`));
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // Storage unavailable: defaults.
  }
  return defaults[name];
}
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
let sweeping = false;
// Unloading long-hidden pages is on unless turned off. A page can keep
// unsaved state in JavaScript outside any form we can inspect: such tabs use
// "Keep tab live", and the tab behind a processing tab is always kept.
function discardEnabled() {
  try {
    return localStorage.getItem("orvane.browser.discardEnabled") !== "false";
  } catch {
    return true;
  }
}
async function sweep() {
  sweepTimer = undefined;
  if (!sweeping && discardEnabled()) {
    sweeping = true;
    try {
      const limit = browserSetting("liveLimit"),
        after = browserSetting("discardAfterMs"),
        now = Date.now();
      let excess = livePages.size - limit;
      const idle = [...livePages]
        .filter((page) => !page.kept() && now - page.seen() > after)
        .sort((a, b) => a.seen() - b.seen());
      for (const page of idle) {
        if (excess-- <= 0) break;
        await page.discard();
      }
    } finally {
      sweeping = false;
    }
  }
  scheduleSweep();
}
function scheduleSweep() {
  if (sweepTimer || !livePages.size) return;
  const after = browserSetting("discardAfterMs");
  sweepTimer = setTimeout(sweep, Math.min(30_000, Math.max(250, after / 4)));
}
function addLivePage(page: LivePage) {
  livePages.add(page);
  // Over budget from now on: the pages on screen keep a picture to show if
  // they are discarded later (an off-screen page can't be captured).
  if (livePages.size > browserSetting("liveLimit"))
    for (const other of livePages) other.remember();
  scheduleSweep();
}
</script>

<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { uid, type Block } from "../model";
import {
  siteName,
  type AutoLoginUpdate,
  type PasswordPrompt,
  type PasswordsApi,
} from "../passwords";
import { getDomain } from "tldts";
import Icon from "./Icon.vue";
import "../splitDropZone.css";
import { activateApp, appOf, BROWSER_SHORTCUT } from "../canvasScroll";
import { onOpenRequest, PAGE_DRAG_MIME, registerCommands } from "../commands";
import BrowserDrawer, {
  type Bookmark,
  type BrowserLayout as Layout,
  type SidebarPosition,
  type BrowserTheme,
  type DrawerMode,
  type LibraryPage,
  type SearchEngine,
} from "./BrowserDrawer.vue";
import PasswordsPanel from "./PasswordsPanel.vue";
import BrowserSourcesWidget from "./BrowserSources.vue";
import { readBrowserSources, sameSourcePage, sourceHighlightScript, SOURCE_MESSAGE, type BrowserSources, type SourcePassage } from "../browserHighlights";
import { importImageData } from "../imageDrop";
import { addWorkbenchWidget, REFRESH_BROWSER_CLIP, workbenchEditable, type BrowserClipRequest, type ClipRect } from "../workbenchWidgets";
import { CANCEL_PICK, PICK_ELEMENT, readPicked, readRect, readSize, runInPage } from "../liveClip";
import { registerAppText } from "../appText";
import { registerBrowserAgentHost, userOwns, type AgentAccess } from "../browserAgent";
import { liveRuns } from "../flowTestsLive";

const props = defineProps<{ block: Block; editing: boolean }>();
const canPinClip = inject(workbenchEditable);

interface BrowserTab {
  id: string;
  url: string;
  title?: string;
  /** Pinned: the address a double-click returns it to. */
  pinned?: string;
  rootUrl?: string;
  loginId?: string;
  group?: string;
  space?: string;
  peek?: { id: string; url: string; title?: string; space?: string };
  /** Never unloaded to save memory (chats, dashboards…). */
  keepLive?: boolean;
  sources?: BrowserSources;
}
interface TabGroup {
  id: string;
  name: string;
  color: string;
  space: string;
  collapsed?: boolean;
}
/** A named set of tabs and bookmarks; all spaces share one login session. */
interface Space {
  id: string;
  name: string;
  icon: string;
  color: string;
  /** The tab to return to. */
  active?: string;
}
interface SplitView {
  primary: string;
  secondary: string;
  anchor: string;
}
interface TabHistory {
  stack: string[];
  index: number;
  reloads: number;
}
/** The parts of Electron's <webview> element this app uses. */
interface WebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
  setAudioMuted(muted: boolean): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
}
interface ProcessingTab { id: string; label: string; status: string; autoRefresh: boolean; busy?: boolean; temporary?: boolean; }
interface BrowserNetSuiteEnvironment { origin: string; label: string }
const netSuiteAppOrigin = /^https:\/\/[a-z0-9-]+\.app\.netsuite\.com$/i;
interface ProcessingApi {
  list(): Promise<ProcessingTab[]>;
  create(id: number): Promise<ProcessingTab>;
  refresh(origin: string): Promise<ProcessingTab>;
  close(origin: string): Promise<void>;
  onChanged(callback: () => void): () => void;
}
interface OrvaneDesktop {
  sourceStyle?(webContentsId: number): Promise<void>;
  processing?: ProcessingApi;
  browserNetSuiteEnvironments?(id: number): Promise<BrowserNetSuiteEnvironment[]>;
  webview: boolean;
  partition: string;
  setPageDensity(webContentsId: number, density: number): Promise<void>;
  setPageActive?(webContentsId: number, active: boolean): Promise<void>;
  setPagePinned?(webContentsId: number, pinned: boolean): Promise<void>;
  capturePage?(
    webContentsId: number,
    mode: "visible" | "full" | "area",
    rect?: { x: number; y: number; width: number; height: number },
  ): Promise<string>;
  captureClip?(id: number, url: string, rect: ClipRect, fromViewport: boolean): Promise<{ image: string; rect: ClipRect }>;
  rememberPage?(webContentsId: number): Promise<void>;
  snapshotPage?(
    webContentsId: number,
    picture: boolean,
  ): Promise<{ edited: boolean; image?: string; scroll?: { x: number; y: number } } | null>;
  onGuestInput(
    callback: (
      input:
        | { from: number; kind: "zoom"; x: number; y: number; deltaY: number }
        | { from: number; kind: "zoom"; clientX: number; clientY: number; deltaY: number }
        | { from: number; kind: "pan"; dx: number; dy: number }
        | { from: number; kind: "focus" }
        | { from: number; kind: "pointer-down" }
        | { from: number; kind: "peek"; url: string }
        | { from: number; kind: "split"; url: string }
        | { from: number; kind: "key"; name: string }
        | { from: number; kind: "inspect"; x: number; y: number },
    ) => void,
  ): () => void;
  devtoolsSrc?: string;
  openDevTools?(webContentsId: number, devtoolsId: number, x?: number, y?: number): Promise<boolean>;
  closeDevTools?(webContentsId: number): Promise<void>;
  onOpenTab(
    callback: (request: { from: number; url: string; background: boolean }) => void,
  ): () => void;
  passwords?: PasswordsApi;
  setTabLogin?(id: number, rootUrl: string, loginId: string): Promise<void>;
  pageDialogs?: {
    claim(id: string): Promise<boolean>;
    answer(id: string, ok: boolean, value?: string): Promise<boolean>;
    onOpen(callback: (request: PageDialog) => void): () => void;
    onDone(callback: (id: string) => void): () => void;
  };
}
/** A page's alert(), confirm() or prompt(), waiting for the user. */
interface PageDialog {
  id: string;
  from: number;
  kind: "alert" | "confirm" | "prompt";
  origin: string;
  message: string;
  value: string;
}

// Inside the Orvane desktop app pages load in <webview>, which sites can't
// refuse like an iframe and which has real history; otherwise an iframe.
const desktop = (window as unknown as { orvaneDesktop?: OrvaneDesktop })
  .orvaneDesktop;
const useWebview = !!desktop?.webview;
const processing = desktop?.processing;
const processingTabs = ref<ProcessingTab[]>([]), processingOpen = ref(false), processingError = ref(''), processingGroup = ref<HTMLElement>();
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};
async function refreshProcessing() {
  if (!processing) return;
  try { processingTabs.value = await processing.list(); } catch (e) { processingError.value = String(e); }
}
async function createProcessing() {
  const view = webviews.get(state.value.active);
  if (!processing || !view) return;
  try { processingError.value = ''; await processing.create(view.getWebContentsId()); processingOpen.value = true; await refreshProcessing(); }
  catch (e) { processingError.value = e instanceof Error ? e.message : String(e); }
}
async function processingAction(action: 'refresh' | 'close', id: string) {
  try { processingError.value = ''; await processing?.[action](id); await refreshProcessing(); }
  catch (e) { processingError.value = e instanceof Error ? e.message : String(e); }
}
let stopProcessing: (() => void) | undefined;
function closeProcessingOutside(event: PointerEvent) { if (!processingGroup.value?.contains(event.target as Node)) processingOpen.value = false; }
onMounted(() => { stopProcessing = processing?.onChanged(refreshProcessing); void refreshProcessing(); document.addEventListener('pointerdown', closeProcessingOutside, true); });
onBeforeUnmount(() => { stopProcessing?.(); document.removeEventListener('pointerdown', closeProcessingOutside, true); });

const START = "";
const MAX_SPACES = 6;
const MAX_BOOKMARKS = 60;
const MAX_HISTORY = 60;
const MAX_CLOSED = 16;
const DEFAULT_SIDEBAR_WIDTH = 262;
function sidebarWidth(width: number) {
  return Math.round(Math.max(208, Math.min(376, width)));
}
const COLORS = ["#6f8998", "#7a9a7e", "#b5874a", "#a36f8f", "#6b7fb3", "#9a6a5a"];
function readBookmarks(saved: { bookmarks?: unknown }): Bookmark[] {
  if (!Array.isArray(saved.bookmarks)) return [];
  return saved.bookmarks
    .filter(
      (b): b is Bookmark =>
        !!b &&
        typeof b.id === "string" &&
        typeof b.url === "string" &&
        !!safeUrl(b.url),
    )
    .map((b) => ({
      id: b.id,
      url: b.url,
      title: typeof b.title === "string" ? b.title.slice(0, 200) : "",
      ...(typeof b.folder === "string" && b.folder
        ? { folder: b.folder.slice(0, 40) }
        : {}),
      ...(typeof b.space === "string" ? { space: b.space } : {}),
    }))
    .slice(0, MAX_BOOKMARKS);
}
function readHistory(value: unknown): LibraryPage[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: LibraryPage[] = [];
  for (const entry of value) {
    if (entries.length >= MAX_HISTORY) break;
    if (!entry || typeof entry.url !== "string") continue;
    const url = safeUrl(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    entries.push({
      url,
      title: typeof entry.title === "string" ? entry.title.slice(0, 200) : "",
    });
  }
  return entries;
}

function readState(imported?: Record<string, unknown>) {
  const text = (value: unknown, limit = 40) =>
    typeof value === "string" ? value.slice(0, limit) : "";
  let saved: Record<string, unknown> = imported || {};
  if (!imported) {
    try {
      const parsed = JSON.parse(props.block.value || "{}");
      if (parsed && typeof parsed === "object") saved = parsed;
    } catch {
      // Unreadable state starts a fresh browser.
    }
  }
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && typeof item.id === "string",
    );
  const color = (value: unknown, index: number) =>
    COLORS.includes(value as string)
      ? (value as string)
      : COLORS[index % COLORS.length]!;
  const spaces: Space[] = list(saved.spaces)
    .slice(0, MAX_SPACES)
    .map((space, index) => ({
      id: space.id as string,
      name: text(space.name) || `Space ${index + 1}`,
      icon: text(space.icon, 4),
      color: color(space.color, index),
      ...(typeof space.active === "string" ? { active: space.active } : {}),
    }));
  if (!spaces.length)
    spaces.push({ id: "main", name: "Main", icon: "", color: COLORS[0]! });
  const inSpace = (value: unknown) =>
    spaces.some((space) => space.id === value)
      ? (value as string)
      : spaces[0]!.id;
  const groups: TabGroup[] = list(saved.groups).map((group, index) => ({
    id: group.id as string,
    name: text(group.name) || "Group",
    color: color(group.color, index),
    space: inSpace(group.space),
    ...(group.collapsed === true ? { collapsed: true } : {}),
  }));
  const tabs: BrowserTab[] = list(saved.tabs)
    .filter(
      (tab) =>
        typeof tab.url === "string" && (tab.url === START || !!safeUrl(tab.url)),
    )
    .map((tab) => {
      const rootUrl = typeof tab.rootUrl === "string" ? safeUrl(tab.rootUrl) : undefined;
      const sources = readBrowserSources(tab.sources);
      return {
      id: tab.id as string,
      url: rootUrl ?? (tab.url as string),
      ...(rootUrl ? { rootUrl } : {}),
      ...(rootUrl && typeof tab.loginId === "string" ? { loginId: tab.loginId } : {}),
      ...(typeof tab.title === "string" && (!rootUrl || tab.url === rootUrl) ? { title: tab.title } : {}),
      ...(typeof tab.pinned === "string" && safeUrl(tab.pinned)
        ? { pinned: tab.pinned }
        : {}),
      ...(tab.keepLive === true ? { keepLive: true } : {}),
      ...(sources ? { sources } : {}),
      ...(groups.some((group) => group.id === tab.group)
        ? { group: tab.group as string }
        : {}),
      space: inSpace(tab.space),
      ...(tab.peek && typeof tab.peek === "object" && "url" in tab.peek &&
      typeof tab.peek.url === "string" && safeUrl(tab.peek.url)
        ? { peek: { id: uid(), url: tab.peek.url, space: inSpace(tab.space) } }
        : {}),
      };
    });
  // Every space always has a tab to show.
  for (const space of spaces)
    if (!tabs.some((tab) => tab.space === space.id))
      tabs.push({ id: uid(), url: START, space: space.id });
  const space = inSpace(saved.space);
  const here = tabs.filter((tab) => tab.space === space);
  const hasTab = (id: unknown): id is string =>
    here.some((tab) => tab.id === id);
  const active = hasTab(saved.active) ? saved.active : here[0]!.id;
  const savedPair =
    saved.split && typeof saved.split === "object"
      ? (saved.split as Partial<SplitView>)
      : null;
  const primary =
    savedPair?.primary ?? (saved.flipped === true ? saved.split : active);
  const secondary =
    savedPair?.secondary ?? (saved.flipped === true ? active : saved.split);
  const split: SplitView | null =
    hasTab(primary) && hasTab(secondary) && primary !== secondary
      ? {
          primary,
          secondary,
          anchor: hasTab(savedPair?.anchor) ? savedPair.anchor : primary,
        }
      : null;
  const layout: Layout =
    saved.layout === "performance" || saved.layout === "comfortable"
      ? saved.layout
      : "balanced";
  const theme: BrowserTheme = saved.theme === "dark" ? "dark" : "light";
  const searchEngine: SearchEngine =
    saved.searchEngine === "duckduckgo" ? "duckduckgo" : "google";
  return {
    tabs,
    closed: list(saved.closed)
      .filter((tab) => tab.url === START || (typeof tab.url === "string" && safeUrl(tab.url)))
      .slice(0, MAX_CLOSED)
      .map((tab) => ({
        id: tab.id as string,
        url: tab.url as string,
        title: text(tab.title, 200),
        space: inSpace(tab.space),
        group: text(tab.group, 100),
        pinned: typeof tab.pinned === "string" ? safeUrl(tab.pinned) : undefined,
        position: Math.max(0, Number(tab.position) || 0),
      })),
    active: split && active !== split.secondary ? split.primary : active,
    bookmarks: readBookmarks(saved),
    recentPages: readHistory(saved.recentPages),
    theme,
    searchEngine,
    peekEnabled: saved.peekEnabled !== false,
    peekCrossSite: saved.peekCrossSite !== false,
    spaces,
    space,
    groups,
    layout,
    split,
    stacked: saved.stacked === true,
    /** Where the divider sits, as a percentage. */
    ratio: splitRatio(Number(saved.ratio) || 50),
    /** Sidebar width in pixels. */
    side: sidebarWidth(Number(saved.side) || DEFAULT_SIDEBAR_WIDTH),
    sidebarPosition: (saved.sidebarPosition === "right" ? "right" : "left") as SidebarPosition,
    collapsed: saved.collapsed === true,
    pip: saved.pip === true,
  };
}

/** Only plain web pages; never this Orvane origin (its local APIs). */
function safeUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const local = ["localhost", "127.0.0.1", "[::1]"];
  const here = new URL(location.href);
  if (
    url.origin === here.origin ||
    (local.includes(url.hostname) &&
      local.includes(here.hostname) &&
      url.port === here.port)
  )
    return undefined;
  return url.href;
}

/** Address-bar text → URL, or a web search for anything that isn't one. */
function resolveInput(text: string) {
  const value = text.trim();
  if (!value) return { url: START };
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^\s:]+:\d+/.test(value)) {
    const url = safeUrl(value);
    return url
      ? { url }
      : { error: "Only http and https pages outside Orvane can open here." };
  }
  if (!/\s/.test(value) && /^[^\s/]+\.[^\s/]+|^localhost(:|\/|$)/i.test(value)) {
    const scheme = /^(localhost|127\.|\[::1\])/i.test(value) ? "http" : "https";
    const url = safeUrl(`${scheme}://${value}`);
    if (url) return { url };
    return { error: "Orvane itself can't be opened inside its own browser." };
  }
  return {
    url:
      (state.value.searchEngine === "duckduckgo"
        ? "https://duckduckgo.com/?q="
        : "https://www.google.com/search?q=") + encodeURIComponent(value),
  };
}

const state = ref(readState());
const spaceTabs = computed(() =>
  state.value.tabs.filter((tab) => tab.space === state.value.space),
);
const currentSpace = computed(
  () => state.value.spaces.find((space) => space.id === state.value.space)!,
);
const spaceBookmarks = computed(() =>
  state.value.bookmarks.filter(
    (bookmark) => !bookmark.space || bookmark.space === state.value.space,
  ),
);
const histories = new Map<string, TabHistory>();
const history = (tab: BrowserTab) => {
  let entry = histories.get(tab.id);
  if (!entry) {
    entry = { stack: [tab.url], index: 0, reloads: 0 };
    histories.set(tab.id, entry);
  }
  return entry;
};
const revision = ref(0);
const activeTab = computed(
  () => state.value.tabs.find((t) => t.id === state.value.active)!,
);
// Webview tabs: the first URL each was created with (later navigation goes
// through loadURL so Vue never resets src), and live back/forward state.
const started = reactive<Record<string, string>>({});
const openingEnvironment = new Map<string, string>();
for (const tab of state.value.tabs) {
  if (tab.url) started[tab.id] = tab.url;
  if (tab.peek) started[tab.peek.id] = tab.peek.url;
}
const webviews = new Map<string, WebviewElement>();
const loading = reactive<Record<string, boolean>>({});
const activeLoading = computed(() => useWebview && !!loading[activeTab.value.id]);
const sourceOpen = reactive<Record<string, boolean>>({});
const sourceChecking = reactive<Record<string, boolean>>({});
const sourceErrors = reactive<Record<string, string>>({});
const activeSources = computed(() => {
  const sources = activeTab.value.sources;
  return sources && sameSourcePage(sources.url, activeTab.value.url) ? sources : undefined;
});
const loginStartupTabs = new Set<string>();
/** Tabs whose page was discarded to save memory: a picture until reloaded. */
const discarded = reactive<Record<string, { image: string; scroll?: { x: number; y: number } }>>({});
const restoreScroll = new Map<string, { x: number; y: number }>();
const webviewNav = reactive<Record<string, { back: boolean; forward: boolean }>>(
  {},
);
const nav = computed(() => {
  void revision.value;
  if (useWebview) {
    const live = webviewNav[activeTab.value.id];
    return { back: !!live?.back, forward: !!live?.forward };
  }
  const entry = history(activeTab.value);
  return {
    back: entry.index > 0,
    forward: entry.index < entry.stack.length - 1,
  };
});
const address = ref(activeTab.value.url);
const error = ref("");

function save() {
  props.block.value = JSON.stringify(state.value);
}
function receiveSources(tab: BrowserTab, raw: unknown) {
  const sources = tab.sources;
  const report = raw as { url?: string; selected?: string; passages?: { id?: string; text?: string; found?: boolean; matches?: number }[] };
  if (!sources || !report || !Array.isArray(report.passages) || !sameSourcePage(report.url ?? "", sources.url) || !sameSourcePage(tab.url, sources.url)) return;
  let changed = false;
  for (const passage of sources.passages) {
    const match = report.passages.find((item) => item?.id === passage.id);
    if (!match) continue;
    const found = match.found === true && typeof match.text === "string" && !!match.text;
    const text = found ? match.text!.slice(0, 6000) : passage.text;
    const matches = found && Number.isFinite(match.matches) ? Math.max(0, Math.min(20, match.matches!)) : 0;
    if (passage.found !== found || passage.text !== text || passage.matches !== matches) changed = true;
    Object.assign(passage, { found, text, matches });
  }
  if (report.selected && sources.passages.some((p) => p.id === report.selected) && sources.selected !== report.selected) {
    sources.selected = report.selected; changed = true;
  }
  sourceChecking[tab.id] = false;
  if (changed) save();
}
async function uncoverSource(tab: BrowserTab, view: WebviewElement, raw: unknown) {
  if (tab.id !== activeTab.value.id || !sourceOpen[tab.id]) return;
  const result = raw as { target?: { left: number; top: number; right: number; bottom: number }; viewport?: { width: number; height: number } };
  if (!result?.target || !result.viewport || ![...Object.values(result.target), ...Object.values(result.viewport)].every(Number.isFinite) || result.viewport.width <= 0 || result.viewport.height <= 0) return;
  await nextTick();
  const popover = root.value?.querySelector<HTMLElement>(".browser-sources .sources-popover");
  if (!popover) return;
  const panel = popover.getBoundingClientRect(), guest = view.getBoundingClientRect(), target = result.target;
  const x = guest.width / result.viewport.width, y = guest.height / result.viewport.height;
  if (guest.left + target.left*x < panel.right && guest.left + target.right*x > panel.left && guest.top + target.top*y < panel.bottom && guest.top + target.bottom*y > panel.top) {
    const focused = popover.contains(document.activeElement);
    sourceOpen[tab.id] = false;
    if (focused) void nextTick(() => root.value?.querySelector<HTMLElement>(".browser-sources .sources-open")?.focus({ preventScroll: true }));
  }
}
async function paintSources(tab: BrowserTab, scroll = false) {
  const view = webviews.get(tab.id), sources = tab.sources;
  if (!view) return;
  if (!sources || !sameSourcePage(sources.url, tab.url)) return runInPage(view, sourceHighlightScript());
  sourceChecking[tab.id] = true;
  delete sourceErrors[tab.id];
  try {
    await desktop?.sourceStyle?.(view.getWebContentsId());
    if (webviews.get(tab.id) !== view || tab.sources !== sources) return;
    const result = await runInPage(view, sourceHighlightScript(sources, scroll));
    if (webviews.get(tab.id) === view && tab.sources === sources) receiveSources(tab, result);
    if (scroll && webviews.get(tab.id) === view && tab.sources === sources) await uncoverSource(tab, view, result);
    return result;
  } catch (error) {
    if (tab.sources === sources) sourceErrors[tab.id] = error instanceof Error ? error.message : "Highlights are unavailable on this page.";
    throw error;
  } finally { sourceChecking[tab.id] = false; }
}
async function highlightRequest(tabId: string, args: Record<string, unknown>) {
  const tab = state.value.tabs.find((item) => item.id === tabId);
  const view = webviews.get(tabId);
  if (!tab || !view || !useWebview) throw Error("Source highlights need a live desktop Browser tab.");
  if (args.action === "clear") {
    await runInPage(view, sourceHighlightScript());
    delete tab.sources; delete sourceOpen[tabId]; delete sourceErrors[tabId]; save();
    return { cleared: true, tabId };
  }
  if (args.action === "set") {
    if (!Array.isArray(args.passages) || !args.passages.length || args.passages.length > 20) throw Error("Provide 1–20 exact source passages.");
    const passages: SourcePassage[] = args.passages.map((raw) => {
      const item = raw as { quote?: unknown; label?: unknown; prefix?: unknown; suffix?: unknown };
      if (!item || typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 4000) throw Error("Each passage needs an exact quote of at most 4000 characters.");
      return { id: uid(), quote: item.quote.trim(), text: "", found: false, matches: 0,
        ...(typeof item.label === "string" ? { label: item.label.slice(0, 120) } : {}),
        ...(typeof item.prefix === "string" ? { prefix: item.prefix.slice(0, 200) } : {}),
        ...(typeof item.suffix === "string" ? { suffix: item.suffix.slice(0, 200) } : {}) };
    });
    const sources: BrowserSources = { url: tab.url, title: label(tab), passages, selected: passages[0]!.id };
    await desktop?.sourceStyle?.(view.getWebContentsId());
    const result = await runInPage(view, sourceHighlightScript(sources, false)) as { url?: string; passages?: {id: string; found: boolean; text: string; matches: number}[] };
    if (webviews.get(tabId) !== view || !sameSourcePage(result?.url ?? "", tab.url) || !Array.isArray(result.passages)) throw Error("The page changed while matching its source passages. Try again.");
    const matched = result.passages;
    const accepted = passages.filter((p) => matched.some((m) => m.id === p.id && m.found && typeof m.text === "string" && !!m.text));
    const unmatched = passages.filter((p) => !accepted.includes(p)).map((p) => ({ quote: p.quote, reason: "Exact passage not found in the current main document." }));
    if (!accepted.length) {
      await runInPage(view, sourceHighlightScript()); delete tab.sources; save();
      return { tabId, url: tab.url, passages: [], unmatched };
    }
    sources.passages = accepted; sources.selected = accepted[0]!.id;
    tab.sources = sources; receiveSources(tab, result);
    sourceOpen[tabId] = true;
    await paintSources(tab, args.scroll !== false); save();
    return { tabId, ...tab.sources, unmatched };
  }
  if (!["jump", "list"].includes(String(args.action))) throw Error("Use set, jump, list or clear.");
  const sources = tab.sources;
  if (!sources || !sameSourcePage(sources.url, tab.url)) return { tabId, url: tab.url, passages: [] };
  if (args.action === "jump") {
    if (!sources.passages.some((p) => p.id === args.passageId)) throw Error("No such source passage in this tab.");
    sources.selected = String(args.passageId);
  }
  await paintSources(tab, args.action === "jump" && args.scroll !== false); save();
  return { tabId, ...sources };
}
function jumpSource(id: string) {
  void highlightRequest(activeTab.value.id, { action: "jump", passageId: id }).catch((error) => say(String(error.message || error)));
}
function clearSources() {
  void highlightRequest(activeTab.value.id, { action: "clear" }).catch((error) => say(String(error.message || error)));
}
function sourceCount(tab: BrowserTab) {
  return tab.sources && sameSourcePage(tab.sources.url, tab.url) ? tab.sources.passages.length : 0;
}
function recordVisit(tab: BrowserTab) {
  if (!tab.url) return;
  const rest = state.value.recentPages.filter((entry) => entry.url !== tab.url);
  state.value.recentPages = [
    { url: tab.url, title: label(tab) },
    ...rest.slice(0, MAX_HISTORY - 1),
  ];
}
function show(url: string) {
  activeTab.value.url = url;
  recordVisit(activeTab.value);
  address.value = url;
  error.value = "";
  revision.value++;
  save();
}
function go(text = address.value) {
  if (aiLocked(activeTab.value.id)) return say("AI is using this tab. Take control first.");
  const result = resolveInput(text);
  if ("error" in result) {
    error.value = result.error!;
    return;
  }
  if (useWebview) {
    const tab = activeTab.value;
    if (!result.url) return;
    tab.title = undefined;
    delete discarded[tab.id];
    restoreScroll.delete(tab.id);
    const view = webviews.get(tab.id);
    if (view && started[tab.id]) {
      view.loadURL(result.url).catch(() => undefined);
    } else started[tab.id] = result.url;
    show(result.url);
    focusFrame();
    return;
  }
  const entry = history(activeTab.value);
  entry.stack = entry.stack.slice(0, entry.index + 1);
  if (entry.stack[entry.index] !== result.url) {
    entry.stack.push(result.url);
    entry.index++;
  }
  show(result.url);
  if (result.url) focusFrame();
}
function step(delta: number) {
  if (useWebview) {
    const view = webviews.get(activeTab.value.id);
    if (delta < 0) view?.goBack();
    else view?.goForward();
    return;
  }
  const entry = history(activeTab.value);
  const index = entry.index + delta;
  if (index < 0 || index >= entry.stack.length) return;
  entry.index = index;
  show(entry.stack[index]!);
}
function reload() {
  if (useWebview) {
    if (discarded[activeTab.value.id]) restoreTab(activeTab.value.id);
    else webviews.get(activeTab.value.id)?.reload();
    return;
  }
  history(activeTab.value).reloads++;
  revision.value++;
}
function stopLoading() {
  if (!activeLoading.value) return;
  webviews.get(activeTab.value.id)?.stop();
}
function reloadOrStop() {
  if (activeLoading.value) stopLoading();
  else reload();
}
const bookmarked = computed(() =>
  state.value.bookmarks.find((b) => b.url === activeTab.value.url),
);
function toggleBookmark() {
  const tab = activeTab.value;
  if (!tab.url) return;
  const existing = bookmarked.value;
  if (existing) removeBookmark(existing.id);
  else if (state.value.bookmarks.length < MAX_BOOKMARKS) {
    state.value.bookmarks.push({
      id: uid(),
      url: tab.url,
      title: label(tab),
      space: state.value.space,
    });
    save();
    say("Bookmarked");
  }
}
function removeBookmark(id: string) {
  state.value.bookmarks = state.value.bookmarks.filter((b) => b.id !== id);
  save();
  say("Bookmark removed");
}
function openBookmark(bookmark: Bookmark, newTab = false) {
  if (newTab) void addTab(bookmark.url);
  else if (state.value.peekEnabled && state.value.peekCrossSite &&
    state.value.layout !== "comfortable" &&
    siteOf(bookmark.url) !== siteOf(activeTab.value.url)) openPeek(bookmark.url);
  else go(bookmark.url);
}
function openExternal() {
  if (activeTab.value.url)
    window.open(activeTab.value.url, "_blank", "noopener,noreferrer");
}
function addTab(url = START, background = false, after?: string) {
  const tab: BrowserTab = { id: uid(), url, space: state.value.space };
  if (url) started[tab.id] = url;
  const at = after ? state.value.tabs.findIndex((item) => item.id === after) : -1;
  if (at < 0) state.value.tabs.push(tab);
  else state.value.tabs.splice(at + 1, 0, tab);
  recordVisit(tab);
  if (background) save();
  else selectTab(tab.id);
  if (!url && !background) focusAddress();
  return tab;
}
function selectTab(id: string) {
  const previous = state.value.active;
  const split = state.value.split;
  if (split && !inSplit(id)) {
    // A tab outside the pair replaces the page in the focused pane.
    const pane = split.secondary === previous ? "secondary" : "primary";
    split[pane] = id;
  }
  if (id !== previous && !inSplit(previous)) leaving(previous);
  state.value.active = id;
  touch(id);
  const space = state.value.spaces.find((item) => item.id === state.value.space);
  if (space) space.active = id;
  // Choosing a tab whose page was discarded is asking for it back.
  if (discarded[id]) restoreTab(id);
  address.value = activeTab.value.url;
  error.value = "";
  save();
}
function closeTab(id: string) {
  const tabs = state.value.tabs;
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  if (tabs[index]!.rootUrl) return say("Unlock this tab before closing it.");
  rememberClosed(tabs[index]!, index);
  const space = tabs[index]!.space;
  const siblings = tabs.filter((t) => t.space === space);
  const at = siblings.findIndex((t) => t.id === id);
  forget(id);
  let fallback = siblings[at ? at - 1 : 1];
  if (siblings.length === 1) {
    fallback = { id: uid(), url: START, space };
    tabs[index] = fallback;
  } else {
    tabs.splice(index, 1);
  }
  if (space !== state.value.space) return save();
  selectAfterRemoval(fallback!.id);
}
// Closing a tab by hand (close button, middle click, Ctrl+W) is instant: the
// tab and its page go at once and the tabs after it move up into the gap
// (browser-reorder-move). No slide-out first: the owner found it too slow.
function closeTabSliding(id: string) {
  closeTab(id);
}
function label(tab: BrowserTab) {
  if (tab.title) return tab.title;
  if (!tab.url) return "New tab";
  try {
    const host = new URL(tab.url).hostname.replace(/^www\./, "");
    return host.charAt(0).toUpperCase() + host.slice(1);
  } catch {
    return tab.url;
  }
}

// ---- <webview> wiring (desktop app only) ----
function bindWebview(tab: BrowserTab, element: unknown) {
  if (!element) return;
  const view = element as WebviewElement;
  if (webviews.get(tab.id) === view) return;
  webviews.set(tab.id, view);
  view.addEventListener("console-message", (event) => {
    const message = (event as Event & { message?: string }).message;
    if (webviews.get(tab.id) !== view || !message?.startsWith(SOURCE_MESSAGE)) return;
    try { receiveSources(tab, JSON.parse(message.slice(SOURCE_MESSAGE.length))); } catch { /* Page data is untrusted. */ }
  });
  view.addEventListener("found-in-page", (event) => {
    const result = (event as Event & { result?: { activeMatchOrdinal?: number; matches?: number } }).result;
    const find = finds[tab.id];
    if (!find || !result || webviews.get(tab.id) !== view) return;
    if (typeof result.matches === "number") find.matches = result.matches;
    if (typeof result.activeMatchOrdinal === "number") find.current = result.activeMatchOrdinal;
  });
  view.addEventListener("did-navigate", () => {
    const find = finds[tab.id];
    if (find) find.current = find.matches = 0;
  });
  const startup = started[tab.id];
  const restorePosition = () => {
    const position = restoreScroll.get(tab.id);
    if (!position || webviews.get(tab.id) !== view) return;
    void runInPage(view, `(() => { scrollTo(${position.x}, ${position.y}); return Math.abs(scrollX - ${position.x}) < 2 && Math.abs(scrollY - ${position.y}) < 2; })()`)
      .then((restored) => {
        if (restored && restoreScroll.get(tab.id) === position) restoreScroll.delete(tab.id);
      }).catch(() => undefined);
  };
  view.addEventListener("did-finish-load", restorePosition);
  const configureStartupLogin = !loginStartupTabs.has(tab.id) && startup === tab.rootUrl && !!tab.loginId;
  if (configureStartupLogin) loginStartupTabs.add(tab.id);
  addLivePageFor(tab, view);
  const sync = () => {
    try {
      webviewNav[tab.id] = {
        back: view.canGoBack(),
        forward: view.canGoForward(),
      };
    } catch {
      // Not attached yet.
    }
  };
  const navigated = (url: string) => {
    if (!safeUrl(url) || webviews.get(tab.id) !== view) return;
    const target = openingEnvironment.get(tab.id);
    if (target) {
      const page = new URL(url);
      const appHost = page.protocol === "https:" && !page.port && /^[a-z0-9-]+\.app\.netsuite\.com$/i.test(page.hostname);
      const signIn = /^\/(?:app\/login\/|pages\/customerlogin\.jsp$)/i.test(page.pathname);
      if (appHost && !signIn) {
        openingEnvironment.delete(tab.id);
        // A central login can land on the default account. Try the chosen
        // account again once using the session the login just established.
        if (page.origin !== originOf(target)) {
          void view.loadURL(target).catch(() => undefined);
          return;
        }
      } else if (!appHost && page.origin !== "https://system.netsuite.com") {
        openingEnvironment.delete(tab.id);
      }
    }
    if (tab.url !== url) delete tab.title;
    tab.url = url;
    if (state.value.tabs.some((item) => item.id === tab.id)) recordVisit(tab);
    if (tab.id === state.value.active && document.activeElement !== addressInput.value)
      address.value = url;
    sync();
    save();
    if (tab.sources && runningNow(tab.id)) void paintSources(tab).catch(() => undefined);
  };
  view.addEventListener("did-navigate", (event) =>
    navigated((event as Event & { url: string }).url),
  );
  view.addEventListener("did-navigate-in-page", (event) => {
    const detail = event as Event & { url: string; isMainFrame: boolean };
    if (detail.isMainFrame) navigated(detail.url);
  });
  view.addEventListener("page-title-updated", (event) => {
    if (webviews.get(tab.id) !== view) return;
    tab.title = (event as Event & { title: string }).title.slice(0, 200);
    if (tab.sources && sameSourcePage(tab.sources.url, tab.url)) tab.sources.title = label(tab);
    if (state.value.tabs.some((item) => item.id === tab.id)) {
      const visit = state.value.recentPages.find((entry) => entry.url === tab.url);
      if (visit) visit.title = label(tab);
    }
    save();
  });
  view.addEventListener("did-fail-load", (event) => {
    const detail = event as Event & {
      errorCode: number;
      errorDescription: string;
      isMainFrame: boolean;
    };
    // -3 is an aborted load, e.g. a redirect or a new navigation.
    if (detail.isMainFrame && detail.errorCode !== -3 && tab.id === state.value.active)
      error.value = `This page couldn't load (${detail.errorDescription || detail.errorCode}).`;
  });
  view.addEventListener("did-stop-loading", () => {
    if (webviews.get(tab.id) !== view) return;
    delete loading[tab.id];
    if (tab.id !== state.value.active) return;
    rememberedAt = 0;
    setTimeout(rememberPicture, 300);
  });
  view.addEventListener("did-start-loading", () => {
    if (webviews.get(tab.id) !== view) return;
    loading[tab.id] = true;
    if (tab.id === state.value.active) error.value = "";
  });
  view.addEventListener("render-process-gone", () => {
    if (webviews.get(tab.id) === view) delete loading[tab.id];
  });
  // Clicking into the other page of a Split View selects that pane.
  view.addEventListener("focus", () => focusPane(tab.id));
  view.addEventListener("media-started-playing", () => {
    playing[tab.id] = true;
  });
  view.addEventListener("media-paused", () => {
    playing[tab.id] = false;
  });
  const configureLogin = () => {
    if (!configureStartupLogin || !tab.rootUrl || startup !== tab.rootUrl || !tab.loginId) return;
    try {
      void desktop?.setTabLogin?.(view.getWebContentsId(), tab.rootUrl, tab.loginId).catch(() => undefined);
    } catch {
      // The first load can start before the element exposes its guest ID.
    }
  };
  view.addEventListener("did-start-loading", configureLogin, { once: true });
  view.addEventListener("dom-ready", () => {
    sync();
    applyZoom(view);
    syncPinned(tab);
    // A new document starts running: pause it again if nobody sees it.
    if (webviews.get(tab.id) === view) {
      delete pageActive[tab.id];
      updateActivity();
      restorePosition();
    }
  });
  view.addEventListener("dom-ready", configureLogin, { once: true });
}
function webviewFor(id: number) {
  return [...webviews.values()].find((view) => {
    try {
      return view.getWebContentsId() === id;
    } catch {
      return false;
    }
  });
}
// ---- Saved passwords (desktop app only) ----
const passwords = desktop?.passwords;
const showPasswords = ref(false);
const passwordsRevision = ref(0);
/** Save-password prompts by tab; the password itself stays in Electron. */
const prompts = reactive<Record<string, PasswordPrompt>>({});
const prompt = computed(() => prompts[state.value.active]);
const activeOrigin = computed(() => {
  try {
    return new URL(activeTab.value.url).origin;
  } catch {
    return undefined;
  }
});
function dismissPrompt(tabId: string) {
  const open = prompts[tabId];
  if (!open) return;
  delete prompts[tabId];
  void passwords?.decide(open.id, "dismiss").catch(() => undefined);
}
async function decide(choice: "save" | "never") {
  const tabId = state.value.active;
  const open = prompts[tabId];
  if (!open) return;
  delete prompts[tabId];
  await passwords?.decide(open.id, choice).catch(() => undefined);
  passwordsRevision.value++;
}
/** NetSuite auto sign-in that needs the user: it stopped, or NetSuite asks
 * for a verification code. The page stays as NetSuite shows it. */
const autoLogins = reactive<Record<string, AutoLoginUpdate>>({});
const autoLogin = computed(() => autoLogins[state.value.active]);
const autoLoginText: Record<string, string> = {
  failed: "Auto sign-in stopped: NetSuite showed the login page again. Sign in here yourself.",
  paused: "Auto sign-in is paused after a failed attempt. Sign in here yourself, or save the new password.",
  challenge: "Enter the verification code (or answer) in NetSuite to finish signing in.",
};
let stopPrompt: (() => void) | undefined, stopAutoLogin: (() => void) | undefined;
onMounted(() => {
  const tabFor = (from: number) => {
    const view = webviewFor(from);
    return view && state.value.tabs.find((t) => webviews.get(t.id) === view);
  };
  stopPrompt = passwords?.onPrompt((request) => {
    const tab = tabFor(request.from);
    if (tab) prompts[tab.id] = request;
  });
  stopAutoLogin = passwords?.onAutoLogin((update) => {
    const tab = tabFor(update.from);
    if (!tab) return;
    if (autoLoginText[update.kind]) autoLogins[tab.id] = update;
    else delete autoLogins[tab.id];
  });
});
onBeforeUnmount(() => {
  stopPrompt?.();
  stopAutoLogin?.();
});
// ---- Find in page (Ctrl+F): a floating bar over the tab's page ----
const finds = reactive<Record<string, { open: boolean; text: string; current: number; matches: number }>>({});
const findInput = ref<HTMLInputElement>();
const activeFind = computed(() => {
  const find = finds[state.value.active];
  return find?.open && webviews.has(state.value.active) ? find : undefined;
});
function openFind() {
  const id = state.value.active;
  if (!webviews.has(id)) return;
  const find = (finds[id] ??= { open: false, text: "", current: 0, matches: 0 });
  find.open = true;
  void nextTick(() => {
    findInput.value?.focus();
    findInput.value?.select();
  });
}
function runFind(forward = true, next = false) {
  const id = state.value.active;
  const find = finds[id];
  const view = webviews.get(id);
  if (!find || !view) return;
  try {
    if (!find.text) {
      view.stopFindInPage("clearSelection");
      find.current = find.matches = 0;
    } else view.findInPage(find.text, { forward, findNext: next });
  } catch {
    // The page is not attached yet.
  }
}
function findKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    findInput.value?.select();
  } else if (event.key === "Enter") {
    event.preventDefault();
    runFind(!event.shiftKey, true);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeFind();
  }
}
function closeFind() {
  const id = state.value.active;
  const find = finds[id];
  if (!find) return;
  find.open = false;
  try {
    webviews.get(id)?.stopFindInPage("keepSelection");
  } catch {
    // Already gone.
  }
  webviews.get(id)?.focus();
}
// ---- Page popups (alert/confirm/prompt) as an Orvane card on their tab ----
const pageDialogs = reactive<Record<string, PageDialog & { input: string }>>({});
const pageDialogBox = new Map<string, HTMLElement>();
let stopPageDialog: (() => void) | undefined, stopPageDialogDone: (() => void) | undefined;
function focusPageDialog(tabId: string) {
  void nextTick(() => {
    const box = pageDialogBox.get(tabId);
    (box?.querySelector<HTMLElement>("input") ?? box?.querySelector<HTMLElement>(".primary"))?.focus();
    box?.querySelector<HTMLInputElement>("input")?.select();
  });
}
onMounted(() => {
  const api = desktop?.pageDialogs;
  if (!api) return;
  stopPageDialog = api.onOpen((request) => {
    const view = webviewFor(request.from);
    const tab = view && state.value.tabs.find((t) => webviews.get(t.id) === view);
    if (!tab) return;
    void api.claim(request.id).then((mine) => {
      if (!mine) return;
      pageDialogs[tab.id] = { ...request, input: request.value };
      if (isShown(tab.id)) focusPageDialog(tab.id);
    });
  });
  stopPageDialogDone = api.onDone((id) => {
    for (const [tabId, dialog] of Object.entries(pageDialogs))
      if (dialog.id === id) delete pageDialogs[tabId];
  });
});
onBeforeUnmount(() => {
  stopPageDialog?.();
  stopPageDialogDone?.();
});
watch(() => state.value.active, (id) => {
  if (id && pageDialogs[id]) focusPageDialog(id);
});
function answerPageDialog(tabId: string, ok: boolean) {
  const dialog = pageDialogs[tabId];
  if (!dialog) return;
  delete pageDialogs[tabId];
  void desktop?.pageDialogs?.answer(dialog.id, ok, dialog.kind === "prompt" ? dialog.input : undefined);
  webviews.get(tabId)?.focus();
}
// The page's selection, text and picture for Agent sessions.
let stopAppText: (() => void) | undefined;
const activeView = () => webviews.get(state.value.active);
onMounted(() => {
  if (!root.value) return;
  stopAppText = registerAppText(root.value, {
    selection: async () => {
      const view = activeView();
      return view ? String((await runInPage(view, "String(getSelection())").catch(() => "")) ?? "") : "";
    },
    text: async () => {
      const view = activeView();
      return view
        ? String((await runInPage(view, "document.body ? document.body.innerText.slice(0, 20000) : ''").catch(() => "")) ?? "")
        : "";
    },
    picture: async () => {
      const view = activeView();
      return view && desktop?.capturePage ? (await desktop.capturePage(view.getWebContentsId(), "visible")) || "" : "";
    },
    detail: () => activeTab.value.url,
  });
});
onBeforeUnmount(() => stopAppText?.());
// Ctrl+K palette: commands, and opening a page from browser history.
const stopCommands = registerCommands(`browser:${props.block.id}`, () => [
  ...(activeSources.value ? [{ id: `browser-sources:${props.block.id}`, title: "Browser source passages", icon: "edit" as const,
    blockId: props.block.id, keywords: "highlights quotes evidence", run: () => { sourceOpen[activeTab.value.id] = !sourceOpen[activeTab.value.id]; } }] : []),
  { id: `browser-tab:${props.block.id}`, title: "New browser tab", icon: "plus", blockId: props.block.id, keywords: "web", run: () => addTab() },
  { id: `browser-library:${props.block.id}`, title: "Bookmarks and history", icon: "library", blockId: props.block.id, run: () => openDrawer("library") },
  { id: `browser-memory:${props.block.id}`, title: "Browser memory (AI routes, notes, flows)", icon: "keyboard", blockId: props.block.id, keywords: "site memory ai", run: () => openDrawer("memory") },
  ...(useWebview && activeTab.value.url
    ? [{
        id: `browser-find:${props.block.id}`,
        title: "Find in page",
        icon: "search",
        blockId: props.block.id,
        keywords: "search text ctrl+f",
        run: () => openFind(),
      }, {
        id: `browser-ai:${props.block.id}`,
        title: aiAccess[activeTab.value.id] ? "Stop AI access to this tab" : "Let AI use this tab",
        icon: "keyboard",
        blockId: props.block.id,
        keywords: "share agent claude control",
        run: () => toggleAiAccess([activeTab.value.id]),
      }]
    : []),
]);
const stopOpen = onOpenRequest((request) => {
  if (request.kind !== "browser-url" || (request.blockId && request.blockId !== props.block.id)) return;
  const existing = request.reuse && state.value.tabs.find((tab) => tab.url === request.url);
  if (existing) goToTab(existing);
  else addTab(request.url);
  return true;
});
onBeforeUnmount(() => (stopCommands(), stopOpen()));

let stopOpenTab: (() => void) | undefined, stopGuestInput: (() => void) | undefined;
onMounted(() => {
  stopOpenTab = desktop?.onOpenTab(({ from, url, background }) => {
    const view = webviewFor(from);
    const safe = safeUrl(url);
    if (!view || !safe) return;
    const source = state.value.tabs.find((item) => webviews.get(item.id) === view);
    // In Split View a link meant for a new tab stays in the pane it was
    // clicked in, as an ordinary navigation, so Back returns to the page.
    // (Opening a tab there would replace the focused pane, which may be the
    // other one, and the new tab would have no history.)
    if (source && !background && state.value.split && inSplit(source.id)) {
      focusPane(source.id);
      delete discarded[source.id];
      view.loadURL(safe).catch(() => undefined);
      return;
    }
    // Otherwise it opens next to the tab it came from, like other browsers.
    void addTab(safe, background, source?.id);
  });
  // Canvas gestures made over a page arrive from the main process; replay
  // them where the canvas listens, in canvas screen coordinates.
  stopGuestInput = desktop?.onGuestInput((input) => {
    if (input.kind === "pointer-down") {
      closeBrowserPopovers();
      window.dispatchEvent(new Event("orvane:guest-pointer-down"));
      return;
    }
    const view = webviewFor(input.from);
    if (!view) return;
    if (input.kind === "inspect") return startInspect(view, input.x, input.y);
    // A press in a page makes this the app in use, like a press anywhere in it.
    if (input.kind === "focus") activateApp(appOf(root.value));
    if (input.kind === "focus" || input.kind === "peek" || input.kind === "split") {
      const tab = state.value.tabs.find((item) => webviews.get(item.id) === view);
      if (tab) focusPane(tab.id);
      if (input.kind === "peek") return openPeek(input.url);
    if (input.kind === "split") {
      const tab = state.value.tabs.find((item) => webviews.get(item.id) === view);
      if (tab && isShown(tab.id)) openSplit(input.url, tab.id);
      return;
    }
      return;
    }
    if (input.kind === "key") return shortcut(input.name);
    if (input.kind === "pan") {
      window.dispatchEvent(
        new CustomEvent("orvane-canvas-pan", {
          detail: { dx: input.dx, dy: input.dy },
        }),
      );
      return;
    }
    // Page CSS pixels → Orvane screen pixels at the current canvas zoom
    // (zooms over an iframe arrive already in Orvane's window pixels).
    const rect = view.getBoundingClientRect();
    const scale = view.offsetWidth ? rect.width / view.offsetWidth : 1;
    const at =
      "clientX" in input
        ? { clientX: input.clientX, clientY: input.clientY }
        : { clientX: rect.left + input.x * scale, clientY: rect.top + input.y * scale };
    view.dispatchEvent(
      new WheelEvent("wheel", {
        ...at,
        deltaY: input.deltaY,
        deltaMode: 0,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
});
onBeforeUnmount(() => {
  stopOpenTab?.();
  stopGuestInput?.();
});

// A web page swallows every pointer and wheel event, which would stop
// canvas panning and zooming over it. A shield covers the page until it is
// clicked, and returns as soon as focus leaves the page.
const addressInput = ref<HTMLInputElement>();
const interacting = ref(false);
const frames = new Map<string, HTMLIFrameElement>();
function bindFrame(id: string, element: unknown) {
  if (element instanceof HTMLIFrameElement) frames.set(id, element);
  else frames.delete(id);
}
const pageElement = () =>
  (useWebview ? webviews : frames).get(state.value.active);
function focusFrame() {
  interacting.value = true;
  nextTick(() => pageElement()?.focus());
}
function leaveFrame(event: Event) {
  // Events inside the page never reach this document, so any pointer or
  // focus event here means the user is outside the page.
  if (event.target !== pageElement()) interacting.value = false;
}
// ---- AI control (MCP browser_* tools, src/browserAgent.ts) ----
// "granted": the AI may take the tab; "controlled": it is working in it, so
// the page wears the AI border and takes no input from the user until the
// AI releases it or the user takes control (which withdraws access).
// Test runs in a tab (src/flowTestsLive.ts): the REC pill and step trail.
const testRunOf = (id: string) => liveRuns[id];
const testFlowOf = (id: string) => {
  const run = liveRuns[id];
  return run?.flows.find((f) => f.status === "running") ?? [...(run?.flows ?? [])].reverse().find((f) => f.steps.length);
};
const testIndexOf = (id: string) => {
  const run = liveRuns[id];
  const flow = testFlowOf(id);
  return run && flow ? run.flows.indexOf(flow) + 1 : 0;
};
const testNow = ref(Date.now());
const testTimer = setInterval(() => {
  if (Object.keys(liveRuns).length) testNow.value = Date.now();
}, 1000);
onBeforeUnmount(() => clearInterval(testTimer));
const testClock = (startedAt: string) => {
  const s = Math.max(0, Math.round((testNow.value - Date.parse(startedAt)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const aiAccess = reactive<Record<string, AgentAccess>>({});
const aiLocked = (id: string) => aiAccess[id] === "controlled";
function setAiAccess(tabId: string, access: AgentAccess | undefined) {
  if (!access) delete aiAccess[tabId];
  else aiAccess[tabId] = access;
  if (access === "controlled") {
    const view = webviews.get(tabId);
    if (view && document.activeElement === view) view.blur();
    if (tabId === state.value.active) interacting.value = false;
  }
  updateActivity();
}
/** Share tabs with the AI, or (if every one is shared) withdraw access. */
function toggleAiAccess(ids: string[]) {
  const withdraw = ids.every((id) => aiAccess[id]);
  for (const id of ids) {
    if (withdraw) {
      setAiAccess(id, undefined);
      userOwns(id);
    }
    else if (!aiAccess[id]) setAiAccess(id, "granted");
  }
}
function takeControl(tabId: string) {
  setAiAccess(tabId, undefined);
  userOwns(tabId);
  focusPane(tabId);
  focusFrame();
}
let stopAgentHost: (() => void) | undefined;
onMounted(() => {
  stopAgentHost = registerBrowserAgentHost({
    blockId: props.block.id,
    tabs: () =>
      state.value.tabs.map((tab) => ({
        tabId: tab.id,
        title: label(tab),
        url: tab.url,
        active: tab.id === state.value.active,
        ...(aiAccess[tab.id] ? { access: aiAccess[tab.id] } : {}),
        ...(tab.group ? { group: state.value.groups.find((g) => g.id === tab.group)?.name } : {}),
      })),
    groups: () =>
      state.value.groups
        .filter((group) => group.space === state.value.space)
        .map((group) => ({
          name: group.name,
          tabIds: state.value.tabs.filter((tab) => tab.group === group.id).map((tab) => tab.id),
        })),
    group(tabIds, name) {
      const ids = tabIds.filter((id) => state.value.tabs.some((tab) => tab.id === id));
      if (ids.length !== tabIds.length) throw Error("No such tab.");
      // Like groupTabs, but the user's own tab selection is left alone.
      const move = (group: TabGroup | null) => {
        for (const tab of state.value.tabs) {
          if (!ids.includes(tab.id)) continue;
          if (!group) delete tab.group;
          else {
            if (tab.pinned) togglePin(tab);
            tab.group = group.id;
            group.collapsed = false;
          }
        }
        save();
      };
      if (name === null) {
        move(null);
        return null;
      }
      const clean = name.slice(0, 60);
      let group = state.value.groups.find(
        (g) => g.space === state.value.space && g.name.toLowerCase() === clean.toLowerCase(),
      );
      if (!group) {
        group = { id: uid(), name: clean, space: state.value.space,
          color: COLORS[state.value.groups.length % COLORS.length]! };
        state.value.groups.push(group);
      }
      move(group);
      return group.name;
    },
    open(url) {
      const safe = url ? safeUrl(url) : START;
      if (url && !safe) throw Error("Only http, https and file addresses open in the Browser.");
      if (state.value.split) state.value.split = null;
      const tab = addTab(safe || START);
      // The address bar keeps no focus: the AI drives this tab.
      (document.activeElement as HTMLElement | null)?.blur?.();
      return tab.id;
    },
    access: (tabId) => aiAccess[tabId],
    highlight: highlightRequest,
    setAccess: setAiAccess,
    page(tabId) {
      if (discarded[tabId]) restoreTab(tabId);
      try {
        return webviews.get(tabId)?.getWebContentsId();
      } catch {
        return undefined; // Not attached yet.
      }
    },
    navigationUrl(tabId, url) {
      const tab = state.value.tabs.find((t) => t.id === tabId);
      if (!tab) throw Error("No such tab.");
      if (tab.id !== state.value.active) goToTab(tab);
      const result = resolveInput(url);
      if ("error" in result) throw Error(result.error);
      if (!result.url) throw Error("Enter a web address.");
      return result.url;
    },
    select(tabId) {
      const tab = state.value.tabs.find((t) => t.id === tabId);
      if (tab && !isShown(tab.id)) goToTab(tab);
    },
    close(tabId) {
      if (!state.value.tabs.some((t) => t.id === tabId)) throw Error("No such tab.");
      delete aiAccess[tabId];
      closeTab(tabId);
    },
    ...(desktop?.browserNetSuiteEnvironments
      ? {
          async netSuiteEnvironments(tabId: string) {
            if (discarded[tabId]) restoreTab(tabId);
            const until = Date.now() + 3000;
            let view = webviews.get(tabId);
            while (!view && Date.now() < until) {
              await new Promise((done) => setTimeout(done, 100));
              view = webviews.get(tabId);
            }
            if (!view) throw Error("That NetSuite tab is not loaded. Select it, then try again.");
            return desktop!.browserNetSuiteEnvironments!(view.getWebContentsId());
          },
          openNetSuiteEnvironment(origin: string) {
            const tabId = switchNetSuiteEnvironment(origin);
            if (!tabId) throw Error(`${origin} is not a NetSuite account address.`);
            return tabId;
          },
        }
      : {}),
  });
});
onBeforeUnmount(() => stopAgentHost?.());
function shieldDown(event: PointerEvent, id: string) {
  if (event.button !== 0 || props.editing) return;
  focusPane(id);
  focusFrame();
}
onMounted(() => {
  document.addEventListener("focusin", leaveFrame);
  document.addEventListener("pointerdown", leaveFrame, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("focusin", leaveFrame);
  document.removeEventListener("pointerdown", leaveFrame, true);
});
// The canvas scales apps with a CSS transform, which would stretch a page
// rendered at normal density and blur it. Webview pages render at the
// on-screen density instead (layout unchanged). Nothing polls: the scale is
// measured once when the canvas camera settles ("orvane-camera" events from
// the canvas), when the page area resizes or comes into view, so pages are
// not re-rastered on every animation frame and the window can idle.
const pageBox = ref<HTMLElement>();
const renderScale = ref(1);
function applyZoom(view: WebviewElement) {
  try {
    void desktop
      ?.setPageDensity(view.getWebContentsId(), devicePixelRatio * renderScale.value)
      .catch(() => undefined);
  } catch {
    // Not attached yet; dom-ready applies it.
  }
}
/** Below this canvas scale a page is too small to read: it may pause. */
const READABLE_SCALE = 0.25;
// On-screen scale of the page area (1 = actual size): measured exactly when
// the camera settles, estimated from the camera zoom while it moves.
let measuredScale = 1,
  cameraZoomAtMeasure = 0,
  estimatedScale = 1;
const onScreen = ref(true);
function measure() {
  const box = pageBox.value;
  if (!box?.offsetWidth) return;
  const previous = measuredScale;
  measuredScale = box.getBoundingClientRect().width / box.offsetWidth;
  // Scale changes nobody announces (the app animating in, a layout change):
  // look again shortly, until it holds still.
  clearTimeout(recheck);
  if (Math.abs(measuredScale - previous) > 0.005) recheck = setTimeout(measure, 250);
  estimatedScale = measuredScale;
  cameraZoomAtMeasure = lastCameraZoom;
  const scale = Math.min(4, Math.max(0.25, Math.round(measuredScale * 100) / 100));
  if (scale !== renderScale.value) {
    renderScale.value = scale;
    for (const view of webviews.values()) applyZoom(view);
  }
  updateActivity();
  rememberPicture();
}
let lastCameraZoom = 0,
  cameraMoving = false,
  recheck: ReturnType<typeof setTimeout> | undefined;
function cameraChanged(event: Event) {
  const detail = (event as CustomEvent<{ zoom?: number; moving?: boolean }>).detail;
  const wasReadable = estimatedScale >= READABLE_SCALE;
  if (typeof detail?.zoom === "number" && detail.zoom > 0) {
    // While moving only arithmetic (no layout reads): enough to wake a page
    // that is zoomed back into view without waiting for the camera to stop.
    if (cameraZoomAtMeasure)
      estimatedScale = measuredScale * (detail.zoom / cameraZoomAtMeasure);
    lastCameraZoom = detail.zoom;
  }
  if (detail?.moving) {
    // The camera starts moving: pages may be leaving the screen.
    if (!cameraMoving) rememberPicture();
    if (wasReadable !== (estimatedScale >= READABLE_SCALE)) updateActivity();
  } else measure();
  cameraMoving = !!detail?.moving;
}

// ---- Pausing and discarding pages nobody sees (desktop app only) ----
// A page is "seen" when its Browser app is on screen at a readable zoom and
// it is the app's selected tab. Unseen pages pause shortly after (no
// JavaScript, no repaint) and resume at once when seen again; beyond the
// shared live-page budget, long-unseen ones are discarded (see livePages).
const seenAt: Record<string, number> = {};
const wasSeen: Record<string, boolean> = {};
const pageActive: Record<string, boolean> = {};
/** Paused pages take no input: gestures over them reach the canvas. */
const asleep = reactive<Record<string, boolean>>({});
const pauseTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const livePageOf = new Map<string, LivePage>();
const seenNow = (tabId: string) =>
  isShown(tabId) &&
  ((onScreen.value && estimatedScale >= READABLE_SCALE) || interacting.value);
/** Seen, or worked in by the AI: either way the page must run. */
const runningNow = (tabId: string) => seenNow(tabId) || aiAccess[tabId] === "controlled";
function setPageActive(tabId: string, active: boolean) {
  const view = webviews.get(tabId);
  if (!view || !desktop?.setPageActive) return;
  let id: number;
  try {
    id = view.getWebContentsId();
  } catch {
    return; // Not attached yet; dom-ready calls updateActivity again.
  }
  pageActive[tabId] = active;
  if (active) delete asleep[tabId];
  else asleep[tabId] = true;
  void desktop.setPageActive(id, active).catch(() => undefined);
  const tab = pages.value.find((item) => item.id === tabId);
  if (active && tab?.sources) void paintSources(tab).catch(() => undefined);
}
function updateActivity() {
  if (!useWebview) return;
  const now = Date.now();
  for (const tab of pages.value) {
    if (discarded[tab.id] && runningNow(tab.id)) {
      restoreTab(tab.id, false);
      continue;
    }
    if (!webviews.has(tab.id)) continue;
    const seen = seenNow(tab.id);
    // Last seen: now while seen, and the moment it stopped being seen.
    if (seen || wasSeen[tab.id] !== false || seenAt[tab.id] === undefined) seenAt[tab.id] = now;
    wasSeen[tab.id] = seen;
    if (seen || runningNow(tab.id)) {
      clearTimeout(pauseTimers[tab.id]);
      delete pauseTimers[tab.id];
      if (pageActive[tab.id] !== true) setPageActive(tab.id, true);
    } else if (pageActive[tab.id] !== false && !pauseTimers[tab.id]) {
      pauseTimers[tab.id] = setTimeout(() => {
        delete pauseTimers[tab.id];
        if (webviews.has(tab.id) && !runningNow(tab.id)) setPageActive(tab.id, false);
      }, browserSetting("pauseAfterMs"));
    }
  }
}
// The picture shown for a discarded page is taken while it is on screen:
// Chromium draws no new frame for an off-screen page. Only needed (and only
// taken) when there are more live pages than the budget.
let rememberedAt = 0;
function rememberPicture() {
  if (!discardEnabled()) return;
  const tabId = state.value.active,
    view = webviews.get(tabId);
  if (!view || !desktop?.rememberPage || !seenNow(tabId)) return;
  if (livePages.size <= browserSetting("liveLimit") || Date.now() - rememberedAt < 1000) return;
  rememberedAt = Date.now();
  try {
    void desktop.rememberPage(view.getWebContentsId()).catch(() => undefined);
  } catch {
    // Not attached yet.
  }
}
function addLivePageFor(tab: BrowserTab, view: WebviewElement) {
  dropLivePage(tab.id);
  seenAt[tab.id] = Date.now();
  let skipUntil = 0;
  const page: LivePage = {
    seen: () => (seenNow(tab.id) ? Date.now() : (seenAt[tab.id] ?? Date.now())),
    kept: () =>
      seenNow(tab.id) ||
      Date.now() < skipUntil ||
      !!tab.keepLive ||
      aiAccess[tab.id] === "controlled" ||
      // The MCP and NetSuite apps create a processing tab from a live tab
      // of that account: keep the tab behind one.
      processingTabs.value.some((p) => p.id === originOf(tab.url)) ||
      (tab.id === state.value.active &&
        (interacting.value || document.activeElement === view)),
    remember: () => {
      if (tab.id === state.value.active) rememberPicture();
    },
    async discard() {
      if (!desktop?.snapshotPage || webviews.get(tab.id) !== view) return;
      let snapshot: Awaited<ReturnType<NonNullable<OrvaneDesktop["snapshotPage"]>>> = null;
      try {
        // Only a selected tab shows its picture (others reload when chosen).
        snapshot = await desktop.snapshotPage(
          view.getWebContentsId(),
          tab.id === state.value.active,
        );
      } catch {
        snapshot = null;
      }
      // Taking the picture resumed the page; it may also have come back
      // into view, or hold edited fields: keep it then, and ask again later.
      if (!snapshot || snapshot.edited || page.kept() || webviews.get(tab.id) !== view) {
        skipUntil = Date.now() + browserSetting("discardAfterMs");
        delete pageActive[tab.id];
        updateActivity();
        return;
      }
      const scroll = snapshot.scroll;
      discarded[tab.id] = { image: snapshot.image || "",
        ...(scroll && Number.isFinite(scroll.x) && Number.isFinite(scroll.y) ? { scroll } : {}) };
      unbindWebview(tab.id);
    },
  };
  livePageOf.set(tab.id, page);
  addLivePage(page);
}
function dropLivePage(tabId: string) {
  const page = livePageOf.get(tabId);
  if (page) livePages.delete(page);
  livePageOf.delete(tabId);
  clearTimeout(pauseTimers[tabId]);
  delete pauseTimers[tabId];
  delete pageActive[tabId];
  delete asleep[tabId];
  delete seenAt[tabId];
  delete wasSeen[tabId];
}
function unbindWebview(tabId: string) {
  delete loading[tabId];
  webviews.delete(tabId);
  delete webviewNav[tabId];
  dropLivePage(tabId);
}
/** Bring a discarded tab back: a new page at the same address. */
function restoreTab(tabId: string, focus = true) {
  const tab = pages.value.find((t) => t.id === tabId);
  if (!tab || !discarded[tabId]) return;
  const scroll = discarded[tabId].scroll;
  if (scroll) restoreScroll.set(tabId, scroll);
  delete discarded[tabId];
  if (tab.url) started[tabId] = tab.url;
  if (focus && tabId === state.value.active) focusFrame();
}
watch(() => state.value.active, () => updateActivity());
watch(interacting, () => updateActivity());

if (useWebview) {
  let visibility: IntersectionObserver | undefined,
    resize: ResizeObserver | undefined,
    settleTimer: ReturnType<typeof setTimeout> | undefined;
  onMounted(() => {
    const box = pageBox.value;
    window.addEventListener("orvane-camera", cameraChanged);
    if (!box) return;
    visibility = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      onScreen.value = entry.isIntersecting;
      if (entry.isIntersecting) measure();
      else updateActivity();
    });
    visibility.observe(box);
    resize = new ResizeObserver(() => measure());
    resize.observe(box);
    // The app may still be animating in (scaled) when it mounts.
    settleTimer = setTimeout(measure, 450);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("orvane-camera", cameraChanged);
    visibility?.disconnect();
    resize?.disconnect();
    clearTimeout(settleTimer);
    clearTimeout(recheck);
    for (const tabId of [...livePageOf.keys()]) dropLivePage(tabId);
  });
}
// ---- Sidebar, pins, groups, spaces, Peek, Split View and shortcuts ----
const root = ref<HTMLElement>();
/** Position inside the Browser app, whatever the canvas zoom. */
function local(event: MouseEvent) {
  const box = root.value!;
  const rect = box.getBoundingClientRect();
  const scale = box.offsetWidth ? rect.width / box.offsetWidth : 1;
  return {
    x: (event.clientX - rect.left) / scale,
    y: (event.clientY - rect.top) / scale,
  };
}
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 2200);
}
onBeforeUnmount(() => clearTimeout(noticeTimer));

/** Everything a tab owns outside the saved state. */
function forget(id: string) {
  closePeek(id, false);
  delete aiAccess[id];
  userOwns(id);
  openingEnvironment.delete(id);
  histories.delete(id);
  webviews.delete(id);
  dropLivePage(id);
  delete discarded[id];
  restoreScroll.delete(id);
  dismissPrompt(id);
  delete autoLogins[id];
  delete started[id];
  delete webviewNav[id];
  delete playing[id];
  delete loading[id];
  delete sourceOpen[id]; delete sourceChecking[id]; delete sourceErrors[id];
  delete muted[id];
  selected.delete(id);
  const at = recent.indexOf(id);
  if (at >= 0) recent.splice(at, 1);
}

function rememberClosed(tab: BrowserTab, position: number) {
  state.value.closed.unshift({
    id: tab.id,
    url: tab.url,
    title: tab.title || "",
    space: tab.space || state.value.space,
    group: tab.group || "",
    pinned: tab.pinned,
    position,
  });
  state.value.closed.splice(MAX_CLOSED);
}
function reopenClosed() {
  const saved = state.value.closed[0];
  if (!saved) return;
  const space = state.value.spaces.some((item) => item.id === saved.space)
    ? saved.space
    : state.value.space;
  switchSpace(space);
  const tab: BrowserTab = { id: uid(), url: saved.url, space };
  if (saved.title) tab.title = saved.title;
  if (saved.pinned) tab.pinned = saved.pinned;
  if (state.value.groups.some((group) => group.id === saved.group && group.space === space))
    tab.group = saved.group;
  if (tab.url) started[tab.id] = tab.url;
  state.value.tabs.splice(saved.position, 0, tab);
  state.value.closed.shift();
  selectTab(tab.id);
}

// Tabs in the order they were last used, newest first (Ctrl+Tab).
const recent: string[] = [state.value.active];
function touch(id: string) {
  const at = recent.indexOf(id);
  if (at >= 0) recent.splice(at, 1);
  recent.unshift(id);
}

type Row =
  | { kind: "title"; text: string; action?: "tab" | "group" }
  | { kind: "group"; group: TabGroup; count: number }
  | { kind: "empty-group"; group: TabGroup }
  | { kind: "tab"; tab: BrowserTab; grouped: boolean }
  | { kind: "split"; grouped: boolean };
function rowKey(row: Row) {
  if (row.kind === "tab") return row.tab.id;
  if (row.kind === "group" || row.kind === "empty-group")
    return `${row.kind}-${row.group.id}`;
  return row.kind === "split" ? "split" : `title-${row.text}`;
}
/** The sidebar: pinned tabs, groups, then loose tabs, each under a heading.
    A Split View stays at the position of the tab that started it. */
const rows = computed(() => {
  const out: Row[] = [];
  const split = state.value.split;
  const add = (tab: BrowserTab, grouped: boolean) => {
    if (!inSplit(tab.id)) out.push({ kind: "tab", tab, grouped });
    if (split?.anchor === tab.id) out.push({ kind: "split", grouped });
  };
  const pinned = spaceTabs.value.filter((tab) => tab.pinned);
  if (pinned.length) {
    out.push({ kind: "title", text: "Pinned" });
    for (const tab of pinned) add(tab, false);
  }
  const groups = state.value.groups
    .filter((group) => group.space === state.value.space)
    .map((group) => ({
      group,
      members: spaceTabs.value.filter(
        (tab) => tab.group === group.id && !tab.pinned,
      ),
    }));
  out.push({ kind: "title", text: "Groups", action: "group" });
  for (const { group, members } of groups) {
    out.push({ kind: "group", group, count: members.length });
    if (group.collapsed) {
      if (members.some((tab) => tab.id === split?.anchor))
        out.push({ kind: "split", grouped: true });
    } else {
      const start = out.length;
      for (const tab of members) add(tab, true);
      if (out.length === start) out.push({ kind: "empty-group", group });
    }
  }
  out.push({ kind: "title", text: "Tabs", action: "tab" });
  for (const tab of spaceTabs.value)
    if (!tab.pinned && !groups.some((entry) => entry.group.id === tab.group))
      add(tab, false);
  return out;
});
/** A letter standing in for a site's icon. */
function glyph(tab: BrowserTab) {
  try {
    return new URL(tab.url).hostname.replace(/^www[.]/, "").slice(0, 1).toUpperCase();
  } catch {
    return label(tab).slice(0, 1).toUpperCase();
  }
}
function faviconStyle(url: string) {
  const site = siteOf(url).split(".")[0];
  const tones: Record<string, string> = {
    github: "#d6dce3", wikipedia: "#e6e7ed", google: "#e9e6d9", example: "#dbe6e8",
  };
  return { "--favicon-bg": tones[site || ""] };
}

// Pinned tabs: pages you live in. They remember an address to return to,
// and (desktop) preview links that leave their site instead of leaving.
function syncPinned(tab: BrowserTab) {
  try {
    const view = webviews.get(tab.id);
    if (view)
      void desktop
        ?.setPagePinned?.(view.getWebContentsId(), !!tab.pinned &&
          state.value.peekEnabled && state.value.peekCrossSite &&
          state.value.layout !== "comfortable")
        ?.catch(() => undefined);
  } catch {
    // Not attached yet; dom-ready syncs again.
  }
}
watch(
  [() => state.value.peekEnabled, () => state.value.peekCrossSite, () => state.value.layout],
  () => state.value.tabs.forEach(syncPinned),
);
function togglePin(tab: BrowserTab) {
  if (tab.pinned) delete tab.pinned;
  else if (tab.url) {
    tab.pinned = tab.url;
    delete tab.group;
    pruneGroups();
  }
  syncPinned(tab);
  save();
}
function resetPin(tab: BrowserTab) {
  if (!tab.pinned) return;
  if (state.value.active !== tab.id) selectTab(tab.id);
  if (tab.url !== tab.pinned) go(tab.pinned);
}

// Selection: Ctrl-click and Shift-click pick several tabs to act on.
const selected = reactive(new Set<string>());
let anchor = "";
function tabClick(event: MouseEvent, tab: BrowserTab) {
  // Alt-click splits with a tab; on either tab of the split, it leaves it.
  if (event.altKey) return splitWith(tab.id);
  if (event.ctrlKey || event.metaKey) {
    if (selected.has(tab.id)) selected.delete(tab.id);
    else selected.add(tab.id);
    anchor = tab.id;
    return;
  }
  if (event.shiftKey && anchor) {
    const ids = rows.value.flatMap((row) =>
      row.kind === "tab" ? [row.tab.id]
        : row.kind === "split" ? splitPair.value?.map((tab) => tab.id) ?? []
        : [],
    );
    const from = ids.indexOf(anchor),
      to = ids.indexOf(tab.id);
    if (from >= 0 && to >= 0)
      for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1))
        selected.add(id);
    return;
  }
  selected.clear();
  anchor = tab.id;
  selectTab(tab.id);
}
function focusSplitRow(event: KeyboardEvent, pane: number) {
  const pair = splitPair.value;
  const row = event.currentTarget as HTMLElement;
  if (!pair || event.target !== row) return;
  event.preventDefault();
  focusPane(pair[pane]!.id);
  const target = row.parentElement?.querySelectorAll<HTMLElement>(".browser-tab")[pane];
  target?.focus({ preventScroll: true });
}

// Menus are drawn inside the app so they scale and move with it.
interface MenuItem {
  label?: string;
  run?: () => void;
  checked?: boolean;
  disabled?: boolean;
  icon?: string;
  hint?: string;
  initial?: string;
  danger?: boolean;
  children?: () => MenuItem[];
}
const menu = ref<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
const menuBox = ref<HTMLElement>();
const netSuiteEnvironmentButton = ref<HTMLButtonElement>();
let menuTrigger: HTMLElement | undefined;
function openMenu(event: MouseEvent, items: MenuItem[], title = "") {
  event.preventDefault();
  event.stopPropagation();
  const box = root.value!;
  const bounds = box.getBoundingClientRect();
  const scale = bounds.width / box.offsetWidth || 1;
  menuTrigger = event.currentTarget as HTMLElement;
  const target = menuTrigger.getBoundingClientRect();
  const at = event.type === "click"
    ? { x: (target.left - bounds.left) / scale, y: (target.bottom - bounds.top) / scale + 6 }
    : local(event);
  menu.value = { ...at, title, items };
  nextTick(() => positionMenu(event.detail === 0));
}
function positionMenu(focus: boolean) {
  const box = root.value, popup = menuBox.value, current = menu.value;
  if (!box || !popup || !current) return;
  current.x = Math.max(4, Math.min(current.x, box.clientWidth - popup.offsetWidth - 4));
  current.y = Math.max(4, Math.min(current.y, box.clientHeight - popup.offsetHeight - 4));
  if (focus) popup.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
}
function pick(item: MenuItem) {
  if (item.children && menu.value) {
    menu.value = { ...menu.value, title: item.label || "", items: item.children() };
    nextTick(() => positionMenu(true));
    return;
  }
  menu.value = null;
  item.run?.();
}
function menuKeys(event: KeyboardEvent) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const items = Array.from(menuBox.value?.querySelectorAll<HTMLButtonElement>("button:enabled") || []);
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
    event.key === "ArrowDown" ? (at + 1) % items.length : (Math.max(0, at) + items.length - 1) % items.length;
  items[next]?.focus();
}
function closeBrowserPopovers() {
  menu.value = null;
  if (drawer.value) closeDrawer(false);
  processingOpen.value = false;
  showPasswords.value = false;
}
function closeBrowserPopoversOutside(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!menuBox.value?.contains(target) &&
      !(menu.value?.title === "NetSuite environments" && netSuiteEnvironmentButton.value?.contains(target))) menu.value = null;
  if (drawer.value && !(root.value?.contains(target) &&
      target.closest(".browser-drawer, [data-browser-drawer-toggle]"))) closeDrawer(false);
  if (showPasswords.value && !(root.value?.contains(target) &&
      target.closest(".passwords, [data-passwords-toggle]"))) showPasswords.value = false;
}
function closeBrowserPopoversOnFrameFocus() {
  if (!useWebview && document.activeElement instanceof HTMLIFrameElement) closeBrowserPopovers();
}
function loginMenu(tab: BrowserTab): MenuItem[] {
  const rootUrl = tab.rootUrl;
  if (!rootUrl || !passwords) return [];
  const clear: MenuItem[] = tab.loginId ? [{ label: "Turn off auto-login", icon: "close", run: () => {
    clearTabLogin(tab);
    save();
  } }] : [];
  void passwords.list().then((list) => {
    if (menu.value?.items !== waiting || tab.rootUrl !== rootUrl) return;
    const origin = new URL(rootUrl).origin;
    const options = (list?.logins ?? []).filter((login) => login.origin === origin);
    menu.value.items = [...clear, ...options.map((login) => ({
      label: login.username || login.origin,
      icon: "key",
      checked: tab.loginId === login.id,
      run: () => { tab.loginId = login.id; save(); say("Auto-login will run when Browser next opens this tab."); },
    })), ...(!options.length ? [{ label: "No saved logins for this site", disabled: true }] : [])];
    nextTick(() => positionMenu(true));
  }).catch(() => {
    if (menu.value?.items === waiting) menu.value.items = [...clear, { label: "Saved passwords are unavailable", disabled: true }];
  });
  const waiting = reactive<MenuItem[]>([{ label: "Loading saved logins…", disabled: true }]);
  return waiting;
}
function clearTabLogin(tab: BrowserTab) {
  delete tab.loginId;
  try {
    const view = webviews.get(tab.id);
    if (view) void desktop?.setTabLogin?.(view.getWebContentsId(), "", "").catch(() => undefined);
  } catch {
    // An unattached tab cannot have an active login request.
  }
}
onMounted(() => {
  document.addEventListener("pointerdown", closeBrowserPopoversOutside, true);
  window.addEventListener("blur", closeBrowserPopoversOnFrameFocus);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeBrowserPopoversOutside, true);
  window.removeEventListener("blur", closeBrowserPopoversOnFrameFocus);
});

function tabMenu(event: MouseEvent, tab: BrowserTab) {
  const ids =
    selected.has(tab.id) && selected.size > 1 ? [...selected] : [tab.id];
  const many = ids.length > 1;
  const groups = state.value.groups.filter(
    (group) => group.space === state.value.space && group.id !== tab.group,
  );
  openMenu(event, [
    ...(many
      ? []
      : [
          {
            label: "Duplicate tab", icon: "copy",
            run: () => {
              const copy = addTab(tab.url);
              copy.title = tab.title;
              copy.group = tab.group;
              save();
            },
          },
          {
            label: tab.pinned ? "Unpin tab" : "Pin tab",
            icon: "pin",
            disabled: !tab.url,
            run: () => togglePin(tab),
          },
          {
            label: tab.rootUrl ? "Unlock tab" : "Lock tab to this URL",
            icon: "lock",
            disabled: !tab.url && !tab.rootUrl,
            run: () => {
              if (tab.rootUrl) {
                delete tab.rootUrl;
                clearTabLogin(tab);
              }
              else tab.rootUrl = tab.url;
              save();
            },
          },
          ...(tab.rootUrl && passwords && new URL(tab.rootUrl).protocol === "https:"
            ? [{ label: "Auto-login", icon: "key", children: () => loginMenu(tab) }]
            : []),
          {
            label: aiAccess[tab.id] ? "Stop AI access" : "Let AI use this tab",
            icon: "keyboard",
            disabled: !useWebview || !tab.url,
            run: () => toggleAiAccess([tab.id]),
          },
          {
            label: tab.keepLive ? "Allow unloading" : "Keep tab live",
            icon: "clock",
            run: () => {
              if (tab.keepLive) delete tab.keepLive;
              else tab.keepLive = true;
              save();
            },
          },
          {
            label: "Open in Split View",
            icon: "columns",
            disabled: tab.id === state.value.active,
            run: () => splitWith(tab.id),
          },
          { label: "Peek at tab", icon: "eye", disabled: !tab.url || !state.value.peekEnabled,
            run: () => openPeek(tab.url) },
          {},
        ]),
    ...(many && useWebview
      ? [{
          label: ids.every((id) => aiAccess[id]) ? `Stop AI access to ${ids.length} tabs` : `Let AI use ${ids.length} tabs`,
          icon: "keyboard",
          run: () => toggleAiAccess(ids),
        }]
      : []),
    {
      label: many ? `Group ${ids.length} tabs` : "Create group with tab",
      icon: "folder",
      run: () => newGroup(ids),
    },
    ...groups.map((group) => ({
      label: `Move to ${group.name}`,
      icon: "folder",
      run: () => groupTabs(ids, group),
    })),
    ...(tab.group && !many
      ? [{ label: "Remove from group", icon: "unlink", run: () => groupTabs(ids, null) }]
      : []),
    ...state.value.spaces
      .filter((space) => space.id !== state.value.space)
      .map((space) => ({
        label: `Move to ${space.name}`,
        icon: "layers",
        run: () => moveToSpace(ids, space.id),
      })),
    {},
    {
      label: many ? `Close ${ids.length} tabs` : "Close tab",
      icon: "close",
      hint: many ? undefined : "Ctrl W",
      danger: true,
      disabled: !ids.some((id) => state.value.tabs.some((item) => item.id === id && !item.rootUrl)),
      run: () => ids.forEach(closeTab),
    },
  ], many ? "Selected tabs" : label(tab));
}

// ---- Tab groups ----
interface BrowserDialog {
  title: string;
  label?: string;
  value: string;
  placeholder?: string;
  message?: string;
  action: string;
  submit: (value: string) => void;
}
const dialog = ref<BrowserDialog>();
const dialogInput = ref<HTMLInputElement>();
const dialogCancel = ref<HTMLButtonElement>();
let dialogTrigger: HTMLElement | null;
function openDialog(options: BrowserDialog) {
  dialogTrigger = document.activeElement as HTMLElement | null;
  menu.value = null;
  switcher.value = null;
  dialog.value = options;
  nextTick(() => {
    (dialogInput.value || dialogCancel.value)?.focus();
    dialogInput.value?.select();
  });
}
function dismissDialog() {
  dialog.value = undefined;
  dialogTrigger?.focus();
}
function submitDialog() {
  const options = dialog.value;
  if (!options || (options.label && !options.value.trim())) return;
  dismissDialog();
  options.submit(options.value.trim());
}
function rename(target: Space | TabGroup) {
  const isGroup = "space" in target;
  openDialog({
    title: isGroup ? "Rename tab group" : "Rename space",
    label: isGroup ? "Group name" : "Space name",
    value: target.name, action: "Save",
    submit: (name) => { target.name = name; save(); },
  });
}
function newGroup(ids: string[] = []) {
  const space = state.value.space;
  openDialog({
    title: "New tab group", label: "Group name", value: "",
    placeholder: "e.g. Research", action: "Save",
    submit: (name) => {
      const group: TabGroup = { id: uid(), name, space,
        color: COLORS[state.value.groups.length % COLORS.length]! };
      state.value.groups.push(group);
      groupTabs(ids, group);
    },
  });
}
function pruneGroups() {
  state.value.groups = state.value.groups.filter((group) =>
    state.value.spaces.some((space) => group.space === space.id),
  );
}
function groupTabs(ids: string[], group: TabGroup | null) {
  for (const tab of state.value.tabs) {
    if (!ids.includes(tab.id)) continue;
    if (group) {
      if (tab.pinned) togglePin(tab);
      tab.group = group.id;
      group.collapsed = false;
    } else delete tab.group;
  }
  selected.clear();
  save();
}
type BrowserDrag = {
  kind: "tab" | "space";
  id: string;
  pointer: number;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
  width: number;
  height: number;
  moving: boolean;
  detached: boolean;
  fromSplit: boolean;
  reattach: boolean;
  split?: "primary" | "secondary";
  strip: HTMLElement;
  reorderRows: HTMLElement[];
  horizontal: boolean;
  forward: boolean;
  group?: string;
  destination?: { id: string; after: boolean };
  original: string[];
};
const browserDrag = ref<BrowserDrag>();
const dragPreview = ref<HTMLElement>();
let dragPoint = { x: 0, y: 0 };
let suppressDragClick = false;
let tipResumeAt: { x: number; y: number } | undefined;
function positionDragPreview() {
  const drag = browserDrag.value;
  const browser = root.value;
  if (!drag || !dragPreview.value || !browser) return;
  const bounds = browser.getBoundingClientRect();
  const scale = bounds.width / browser.offsetWidth || 1;
  if (drag.detached) {
    const x = bounds.left + (dragPoint.x - drag.grabX) * scale;
    const y = bounds.top + (dragPoint.y - drag.grabY) * scale;
    dragPreview.value.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    return;
  }
  const strip = drag.strip.getBoundingClientRect();
  const left = (strip.left - bounds.left) / scale;
  const top = (strip.top - bounds.top) / scale;
  const slots = drag.reorderRows.map((row) => dragSlot(row, drag.horizontal, scale));
  const origin = drag.horizontal ? bounds.left : bounds.top;
  const stripStart = drag.horizontal ? left : top;
  const stripSize = (drag.horizontal ? strip.width : strip.height) / scale;
  const start = Math.max(stripStart, (Math.min(...slots.map((slot) => slot.start)) - origin) / scale);
  const end = Math.min(stripStart + stripSize, (Math.max(...slots.map((slot) => slot.end)) - origin) / scale);
  const clamp = (point: number, size: number) => Math.max(start, Math.min(point, end - size));
  const x = drag.horizontal
    ? clamp(dragPoint.x - drag.grabX, drag.width)
    : drag.startX - drag.grabX;
  const y = drag.horizontal
    ? drag.startY - drag.grabY
    : clamp(dragPoint.y - drag.grabY, drag.height);
  dragPreview.value.style.transform =
    `translate3d(${x}px, ${y}px, 0)`;
}
function dragSlot(row: HTMLElement, horizontal: boolean, scale: number) {
  const rect = row.getBoundingClientRect();
  const transform = getComputedStyle(row).transform;
  const matrix = transform === "none" ? undefined : new DOMMatrixReadOnly(transform);
  const start = horizontal ? rect.left - (matrix?.e ?? 0) * scale : rect.top - (matrix?.f ?? 0) * scale;
  return { start, end: start + (horizontal ? rect.width : rect.height) };
}
function beginBrowserDrag(event: PointerEvent, kind: BrowserDrag["kind"], id: string) {
  if (event.button !== 0 || event.pointerType === "touch" || event.altKey ||
      event.ctrlKey || event.metaKey || event.shiftKey ||
      (kind === "tab" && (event.target as Element).closest("button"))) return;
  const { x, y } = local(event);
  const source = event.currentTarget as HTMLElement;
  const strip = source.closest<HTMLElement>(kind === "tab" ? ".browser-tabs" : ".browser-spaces");
  if (!strip) return;
  source.setPointerCapture(event.pointerId);
  const bounds = source.getBoundingClientRect();
  const scale = bounds.width / source.offsetWidth || 1;
  const tab = kind === "tab" ? spaceTabs.value.find((item) => item.id === id) : undefined;
  const reorderRows = [...strip.querySelectorAll<HTMLElement>(kind === "tab" ? "[data-drag-tab]" : "[data-drag-space]")]
    .filter((row) => {
      if (kind === "space" || row === source) return true;
      if (inSplit(id) || row.closest(".inline-split")) return false;
      const other = spaceTabs.value.find((item) => item.id === row.dataset.dragTab);
      return other && !!other.pinned === !!tab?.pinned && other.group === tab?.group;
    });
  dragPoint = { x, y };
  browserDrag.value = {
    kind, id, pointer: event.pointerId, startX: x, startY: y,
    grabX: (event.clientX - bounds.left) / scale, grabY: (event.clientY - bounds.top) / scale,
    width: source.offsetWidth, height: source.offsetHeight, moving: false, strip, reorderRows, forward: false,
    detached: false, fromSplit: kind === "tab" && inSplit(id), reattach: false,
    horizontal: kind === "space"
      ? !(state.value.collapsed || narrow.value)
      : state.value.layout === "comfortable",
    original: (kind === "tab" ? state.value.tabs : state.value.spaces).map((item) => item.id),
  };
}
function moveBrowserDrag(event: PointerEvent) {
  const drag = browserDrag.value;
  if (!drag || drag.pointer !== event.pointerId) return;
  const { x, y } = local(event);
  const delta = drag.horizontal ? x - dragPoint.x : y - dragPoint.y;
  if (delta) drag.forward = delta > 0;
  dragPoint = { x, y };
  if (!drag.moving) {
    if (Math.hypot(x - drag.startX, y - drag.startY) < 2) return;
    drag.moving = true;
    root.value?.setPointerCapture(event.pointerId);
    window.addEventListener("keydown", cancelBrowserDragKey, true);
    hideTip();
    nextTick(positionDragPreview);
  }
  const { horizontal } = drag;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const wasDetached = drag.detached;
  const list = target?.closest<HTMLElement>(drag.kind === "tab" ? ".browser-tabs" : ".browser-spaces");
  if (drag.kind === "tab") {
    const insideStrip = list === drag.strip;
    drag.reattach = drag.fromSplit && insideStrip && (wasDetached || !target?.closest(".inline-split"));
    drag.detached = !insideStrip || drag.reattach;
  }
  if (wasDetached !== drag.detached) void nextTick(positionDragPreview);
  else positionDragPreview();
  const page = pageBox.value?.getBoundingClientRect();
  const overPage = drag.kind === "tab" && (splitPair.value || drag.id !== state.value.active) && !peek.value &&
    !!page && event.clientX >= page.left && event.clientX < page.right &&
    event.clientY >= page.top && event.clientY < page.bottom;
  drag.split = undefined;
  if (overPage && page) {
    const share = state.value.stacked
      ? (event.clientY - page.top) / page.height
      : (event.clientX - page.left) / page.width;
    drag.split = share < state.value.ratio / 100 ? "primary" : "secondary";
  }
  drag.group = drag.kind === "tab" ? target?.closest<HTMLElement>("[data-drop-group]")?.dataset.dropGroup : undefined;
  drag.destination = undefined;
  if (drag.split || drag.group) return;

  const attribute = drag.kind === "tab" ? "dragTab" : "dragSpace";
  if (list !== drag.strip) return;
  const scale = list.getBoundingClientRect().width / list.offsetWidth || 1;
  const pointer = horizontal ? event.clientX : event.clientY;
  if (drag.reattach || wasDetached) {
    const tab = spaceTabs.value.find((item) => item.id === drag.id);
    let nearest: { id: string; after: boolean; distance: number } | undefined;
    for (const row of list.querySelectorAll<HTMLElement>("[data-drag-tab]")) {
      const id = row.dataset.dragTab!;
      if (id === drag.id || row.closest(".inline-split") || !row.offsetWidth) continue;
      const other = spaceTabs.value.find((item) => item.id === id);
      if (!other || !!tab?.pinned !== !!other.pinned) continue;
      const { start, end } = dragSlot(row, horizontal, scale);
      const middle = (start + end) / 2;
      const distance = Math.abs(pointer - middle);
      if (!nearest || distance < nearest.distance) nearest = { id, after: pointer >= middle, distance };
    }
    if (nearest) {
      if (drag.reattach) drag.destination = { id: nearest.id, after: nearest.after };
      else moveToDragSlot(drag, nearest.id, nearest.after);
    }
    return;
  }
  if (drag.fromSplit) return;
  const size = horizontal ? drag.width : drag.height;
  const start = pointer - (horizontal ? drag.grabX : drag.grabY) * scale;
  const after = drag.forward;
  const edge = after ? start + size * scale : start;
  const source = drag.reorderRows.find((row) => row.dataset[attribute] === drag.id);
  if (!source) return;
  const sourceSlot = dragSlot(source, horizontal, scale);
  let crossed: { id: string; middle: number } | undefined;
  for (const row of list.querySelectorAll<HTMLElement>(drag.kind === "tab" ? "[data-drag-tab]" : "[data-drag-space]")) {
    const id = row.dataset[attribute];
    if (!id || row === source || row.closest(".inline-split")) continue;
    const { start, end } = dragSlot(row, horizontal, scale);
    const middle = (start + end) / 2;
    if (!drag.reorderRows.includes(row)) {
      if (pointer >= start && pointer < end) {
        moveToDragSlot(drag, id, pointer >= middle);
        return;
      }
      continue;
    }
    // Move as soon as the leading edge covers half of the neighboring slot.
    if (after ? middle < sourceSlot.end || edge < middle : middle > sourceSlot.start || edge > middle) continue;
    if (!crossed || (after ? middle > crossed.middle : middle < crossed.middle)) crossed = { id, middle };
  }
  if (crossed) moveToDragSlot(drag, crossed.id, after);
}
function moveToDragSlot(drag: BrowserDrag, target: string | undefined, after: boolean) {
  if (drag.kind === "space") {
    reorderBrowserItems(state.value.spaces, drag.id, target, after);
  } else {
    const tab = spaceTabs.value.find((item) => item.id === drag.id);
    const other = spaceTabs.value.find((item) => item.id === target);
    if (!tab || !other || !!tab.pinned !== !!other.pinned) return;
    if (tab.group === other.group) reorderBrowserItems(state.value.tabs, drag.id, other.id, after);
    else drag.destination = { id: other.id, after };
  }
}
function reorderBrowserItems<T extends { id: string }>(items: T[], source: string, target: string | undefined, after: boolean) {
  const from = items.findIndex((item) => item.id === source);
  const at = items.findIndex((item) => item.id === target);
  if (from < 0 || at < 0 || from === at) return;
  const to = at + Number(after) - Number(from < at);
  if (from !== to) items.splice(to, 0, items.splice(from, 1)[0]!);
}
function endBrowserDrag(event?: PointerEvent, cancel = false) {
  const drag = browserDrag.value;
  if (!drag || (event && drag.pointer !== event.pointerId)) return;
  browserDrag.value = undefined;
  if (!drag.moving) return;
  window.removeEventListener("keydown", cancelBrowserDragKey, true);
  tipResumeAt = dragPoint;
  hideTip();
  suppressDragClick = true;
  setTimeout(() => { suppressDragClick = false; });
  const note = !cancel && event && drag.kind === "tab"
    ? document.elementFromPoint(event.clientX, event.clientY)?.closest(".board-note")
    : undefined;
  if (cancel || note || drag.detached || drag.split || drag.group || drag.destination) {
    const positions = new Map(drag.original.map((id, index) => [id, index]));
    const items = drag.kind === "tab" ? state.value.tabs : state.value.spaces;
    items.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
  }
  if (cancel) return;
  if (note) {
    const tab = spaceTabs.value.find((item) => item.id === drag.id);
    if (tab?.url) {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(PAGE_DRAG_MIME, JSON.stringify({ url: tab.url, title: label(tab) }));
      note.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
    }
    save();
    return;
  }
  if (drag.split) return placeBeside(drag.id, state.value.active, drag.split);
  if (drag.reattach && state.value.split) {
    const { primary, secondary } = state.value.split;
    state.value.split = null;
    leaving(state.value.active === primary ? secondary : primary);
  }
  const group = state.value.groups.find((item) => item.id === drag.group);
  if (group) return groupTabs([drag.id], group);
  if (drag.destination) {
    const tab = spaceTabs.value.find((item) => item.id === drag.id);
    const target = spaceTabs.value.find((item) => item.id === drag.destination?.id);
    if (tab && target) {
      tab.group = target.group;
      reorderBrowserItems(state.value.tabs, drag.id, target.id, drag.destination.after);
    }
  }
  save();
}
function cancelBrowserDragKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  endBrowserDrag(undefined, true);
}
onBeforeUnmount(() => window.removeEventListener("keydown", cancelBrowserDragKey, true));
function ignoreDragClick(event: MouseEvent) {
  if (!suppressDragClick) return;
  event.preventDefault();
  event.stopPropagation();
}
const draggedTab = computed(() => browserDrag.value?.kind === "tab"
  ? spaceTabs.value.find((tab) => tab.id === browserDrag.value?.id)
  : undefined);
const draggedSpace = computed(() => browserDrag.value?.kind === "space"
  ? state.value.spaces.find((space) => space.id === browserDrag.value?.id)
  : undefined);
function groupMenu(event: MouseEvent, group: TabGroup) {
  const members = () => state.value.tabs.filter((tab) => tab.group === group.id);
  const removeGroup = () => {
    state.value.groups = state.value.groups.filter((item) => item.id !== group.id);
    groupTabs(members().map((tab) => tab.id), null);
  };
  openMenu(event, [
    { label: "New tab in group", icon: "plus",
      run: () => { const tab = addTab(); groupTabs([tab.id], group); } },
    { label: "Rename group", icon: "edit", run: () => rename(group) },
    { label: group.collapsed ? "Expand group" : "Collapse group", icon: "down",
      run: () => { group.collapsed = !group.collapsed; save(); } },
    {},
    { label: "Change color", icon: "settings", run: () => {
      group.color = COLORS[(COLORS.indexOf(group.color) + 1) % COLORS.length]!;
      save();
    } },
    { label: "Save as bookmark folder", icon: "star", run: () => {
      for (const tab of members())
        if (tab.url && state.value.bookmarks.length < MAX_BOOKMARKS)
          state.value.bookmarks.push({
            id: uid(), url: tab.url, title: label(tab), folder: group.name, space: state.value.space,
          });
      openFolders.add(group.name);
      removeGroup();
    } },
    { label: "Ungroup tabs", icon: "unlink", run: removeGroup },
    {},
    { label: "Close group", icon: "close", danger: true,
      run: () => { members().forEach((tab) => closeTab(tab.id)); removeGroup(); } },
  ], group.name);
}
/** Sweep loose tabs that share a site into groups named after it. */
function groupBySite() {
  const sites = new Map<string, BrowserTab[]>();
  for (const tab of spaceTabs.value) {
    if (tab.pinned || tab.group || !tab.url) continue;
    let host = "";
    try {
      host = new URL(tab.url).hostname.replace(/^www[.]/, "");
    } catch {
      continue;
    }
    sites.set(host, [...(sites.get(host) || []), tab]);
  }
  let made = 0;
  for (const [host, tabs] of sites) {
    if (tabs.length < 2) continue;
    const group: TabGroup = {
      id: uid(),
      name: host,
      color: COLORS[state.value.groups.length % COLORS.length]!,
      space: state.value.space,
    };
    state.value.groups.push(group);
    for (const tab of tabs) tab.group = group.id;
    made++;
  }
  say(made ? `Grouped tabs into ${made} group${made > 1 ? "s" : ""}.` : "No tabs share a site.");
  save();
}

// ---- Browser library, preferences and portable session data ----
const drawer = ref<DrawerMode | null>(null);
const openFolders = reactive(new Set<string>());
function toggleBookmarkFolder(name: string) {
  if (openFolders.has(name)) openFolders.delete(name);
  else openFolders.add(name);
}
let drawerReturnFocus: HTMLElement | undefined;
function openDrawer(mode: DrawerMode) {
  menu.value = null;
  if (drawer.value === mode) return closeDrawer();
  const target = document.activeElement;
  if (!drawer.value && target instanceof HTMLElement && root.value?.contains(target))
    drawerReturnFocus = target;
  drawer.value = mode;
}
function closeDrawer(restoreFocus = true) {
  drawer.value = null;
  if (restoreFocus) drawerReturnFocus?.focus({ preventScroll: true });
  drawerReturnFocus = undefined;
}
function visitLibrary(event: MouseEvent, entry: LibraryPage, bookmark?: Bookmark) {
  closeDrawer(false);
  if (event.button === 1) void addTab(entry.url);
  else if (event.shiftKey && state.value.peekEnabled) openPeek(entry.url);
  else if (event.altKey) openSplit(entry.url);
  else if (bookmark) openBookmark(bookmark);
  else go(entry.url);
}
function setPeekPreference(enabled: boolean) {
  state.value.peekEnabled = enabled;
  if (!enabled) for (const tab of state.value.tabs) closePeek(tab.id, false);
  save();
}
function exportBrowserSession() {
  const blob = new Blob([JSON.stringify(state.value, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "orvane-browser-session.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
  say("Session exported");
}
let sessionImport = 0;
function importBrowserSession() {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "application/json,.json";
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file) return;
    const request = ++sessionImport;
    try {
      const imported = JSON.parse(await file.text());
      if (request !== sessionImport || !root.value) return;
      if (
        !imported ||
        !Array.isArray(imported.tabs) ||
        !Array.isArray(imported.spaces) ||
        !Array.isArray(imported.groups)
      ) throw new Error("Invalid browser session");
      const next = readState(imported);
      const ids = new Map(next.tabs.map((tab) => [tab.id, uid()]));
      if (ids.size !== next.tabs.length) throw new Error("Duplicate tab IDs");
      for (const tab of next.tabs) tab.id = ids.get(tab.id)!;
      for (const space of next.spaces)
        if (space.active) space.active = ids.get(space.active);
      next.active = ids.get(next.active)!;
      if (next.split) {
        next.split.primary = ids.get(next.split.primary)!;
        next.split.secondary = ids.get(next.split.secondary)!;
        next.split.anchor = ids.get(next.split.anchor)!;
      }
      // Imported pages get fresh identities so no existing webview or its
      // navigation history can be mistaken for a page in the imported session.
      for (const page of pages.value) forget(page.id);
      for (const tab of next.tabs) {
        if (tab.url) started[tab.id] = tab.url;
        if (tab.peek) started[tab.peek.id] = tab.peek.url;
      }
      state.value = next;
      openFolders.clear();
      touch(next.active);
      address.value = activeTab.value.url;
      error.value = "";
      closeDrawer();
      save();
      say("Session imported");
    } catch {
      if (request === sessionImport && root.value) say("Could not import this session");
    }
  }, { once: true });
  picker.click();
}
function linkMenu(event: MouseEvent, url: string, bookmark?: Bookmark) {
  const useLink = (run: () => void) => () => {
    if (drawer.value) closeDrawer();
    run();
  };
  openMenu(event, [
    { label: "Open Link in Peek View", icon: "eye", hint: "Shift-click",
      disabled: !state.value.peekEnabled || state.value.layout === "comfortable",
      run: useLink(() => openPeek(url)) },
    { label: "Open in new tab", icon: "plus", run: useLink(() => { addTab(url); }) },
    { label: "Open in Split View", icon: "columns", hint: "Alt-click",
      run: useLink(() => openSplit(url)) },
    { label: "Open externally", icon: "external",
      run: () => { window.open(url, "_blank", "noopener,noreferrer"); } },
    ...(bookmark ? [{}, { label: "Remove bookmark", icon: "trash", danger: true,
      run: () => removeBookmark(bookmark.id) }] : []),
  ], "Link");
}

// ---- Spaces ----
function switchSpace(id: string) {
  if (id === state.value.space) return;
  const space = state.value.spaces.find((item) => item.id === id);
  if (!space) return;
  leaving(state.value.active);
  state.value.split = null;
  state.value.space = id;
  selected.clear();
  const tabs = state.value.tabs.filter((tab) => tab.space === id);
  selectTab((tabs.find((tab) => tab.id === space.active) || tabs[0]!).id);
}
function stepSpace(delta: number) {
  const spaces = state.value.spaces;
  const at = spaces.findIndex((space) => space.id === state.value.space);
  switchSpace(spaces[(at + delta + spaces.length) % spaces.length]!.id);
}
function addSpace() {
  if (state.value.spaces.length >= MAX_SPACES) return;
  openDialog({
    title: "New space", label: "Space name", value: "",
    placeholder: "e.g. Projects", action: "Save",
    submit: (name) => {
      const space: Space = {
        id: uid(), name, icon: "", color: COLORS[state.value.spaces.length % COLORS.length]!,
      };
      state.value.spaces.push(space);
      state.value.tabs.push({ id: uid(), url: START, space: space.id });
      switchSpace(space.id);
    },
  });
}
function removeSpace(id: string) {
  const spaces = state.value.spaces;
  if (spaces.length < 2) return;
  const home = spaces.find((space) => space.id !== id)!;
  if (state.value.space === id) switchSpace(home.id);
  for (const tab of state.value.tabs)
    if (tab.space === id) {
      tab.space = home.id;
      delete tab.group;
    }
  for (const bookmark of state.value.bookmarks)
    if (bookmark.space === id) bookmark.space = home.id;
  state.value.spaces = spaces.filter((space) => space.id !== id);
  pruneGroups();
  save();
}
function moveToSpace(ids: string[], spaceId: string) {
  const moving = state.value.tabs.filter((tab) => ids.includes(tab.id));
  for (const tab of moving) {
    tab.space = spaceId;
    delete tab.group;
  }
  selected.clear();
  if (!spaceTabs.value.length)
    state.value.tabs.push({ id: uid(), url: START, space: state.value.space });
  selectAfterRemoval(spaceTabs.value[0]!.id);
}
function spaceMenu(event: MouseEvent, space: Space) {
  const destination = state.value.spaces.find((item) => item.id !== space.id);
  openMenu(event, [
    { label: "Switch to space", icon: "layers", run: () => switchSpace(space.id) },
    { label: "Rename space", icon: "edit", run: () => rename(space) },
    { label: "Change color", icon: "settings", run: () => {
      space.color = COLORS[(COLORS.indexOf(space.color) + 1) % COLORS.length]!;
      save();
    } },
    {},
    { label: "Delete space", icon: "trash", danger: true, disabled: !destination,
      run: () => openDialog({
        title: `Delete ${space.name}?`,
        message: `Its tabs and bookmarks will move to ${destination?.name}. The tab groups in this space will be removed.`,
        value: "", action: "Delete", submit: () => removeSpace(space.id),
      }) },
  ], space.name);
}

// ---- Peek: a link opens in a panel over the page instead of replacing it.
// The panel is an ordinary page; "Open as tab" keeps it alive as it is.
const peek = computed(() =>
  state.value.peekEnabled && state.value.layout !== "comfortable"
    ? activeTab.value.peek
    : undefined,
);
// Tab order is independent of guest order. Reordering guest elements would
// detach and reload Electron webviews.
const pages = computed<BrowserTab[]>(() => state.value.tabs.flatMap((tab) =>
  tab.peek ? [tab, tab.peek] : [tab],
).sort((a, b) => a.id.localeCompare(b.id)));
function siteOf(url: string) {
  if (!url) return "";
  const host = new URL(url).hostname;
  return getDomain(host, { allowPrivateDomains: true }) || host;
}
function openPeek(raw: string) {
  const url = safeUrl(raw);
  if (!url) return;
  if (!state.value.peekEnabled || state.value.layout === "comfortable")
    return void addTab(url);
  closePeek(activeTab.value.id, false);
  const preview = { id: uid(), url, space: state.value.space };
  started[preview.id] = url;
  activeTab.value.peek = preview;
  save();
}
function closePeek(id = state.value.active, persist = true) {
  const owner = state.value.tabs.find((tab) => tab.id === id);
  if (!owner?.peek) return;
  const preview = owner.peek;
  delete owner.peek;
  forget(preview.id);
  if (persist) save();
}
function keepPeek(split: boolean) {
  const tab = peek.value;
  if (!tab) return;
  delete activeTab.value.peek;
  tab.space = state.value.space;
  const ownerIndex = state.value.tabs.indexOf(activeTab.value);
  state.value.tabs.splice(ownerIndex + 1, 0, tab);
  recordVisit(tab);
  if (split) placeBeside(tab.id);
  else selectTab(tab.id);
}

// ---- Split View ----
function inSplit(id: string) {
  const split = state.value.split;
  return !!split && (id === split.primary || id === split.secondary);
}
function selectAfterRemoval(fallback: string) {
  const active = state.value.active;
  const hasTab = (id: string) => spaceTabs.value.some((tab) => tab.id === id);
  let next = hasTab(active) ? active : fallback;
  const split = state.value.split;
  if (split) {
    const missing = !hasTab(split.primary) ? "primary"
      : !hasTab(split.secondary) ? "secondary"
      : null;
    if (missing) {
      const other = split[missing === "primary" ? "secondary" : "primary"];
      const replacement = fallback !== other
        ? fallback
        : spaceTabs.value.find((tab) => tab.id !== other)?.id;
      if (hasTab(other) && replacement) {
        if (active === split[missing]) next = replacement;
        split[missing] = replacement;
      } else {
        state.value.split = null;
        if (hasTab(other)) next = other;
      }
    }
    if (!hasTab(split.anchor)) split.anchor = split.primary;
  }
  if (next !== active) selectTab(next);
  else save();
}
function closeSplit() {
  const split = state.value.split;
  if (!split) return;
  state.value.split = null;
  if (state.value.active !== split.primary) selectTab(split.primary);
  else {
    leaving(split.secondary);
    save();
  }
}
/** Open the target opposite the source, preserving the sidebar anchor. */
function placeBeside(id: string, source = state.value.active, side?: "primary" | "secondary") {
  const split = state.value.split;
  if (split) {
    const pane = side ?? (split.secondary === source ? "primary" : "secondary");
    const replaced = split[pane];
    const opposite = pane === "primary" ? "secondary" : "primary";
    if (split[opposite] === id) {
      split[opposite] = replaced;
      split[pane] = id;
    } else if (replaced !== id) {
      if (replaced !== state.value.active) leaving(replaced);
      split[pane] = id;
    }
  } else {
    if (source === id) return;
    state.value.split = side === "primary"
      ? { primary: id, secondary: source, anchor: source }
      : { primary: source, secondary: id, anchor: source };
  }
  selectTab(id);
}
function splitWith(id: string) {
  if (inSplit(id)) return closeSplit();
  if (!spaceTabs.value.some((tab) => tab.id === id)) return;
  if (id === state.value.active) return toggleSplit();
  placeBeside(id);
}
function openSplit(url: string, source = state.value.active) {
  const safe = safeUrl(url);
  if (!safe) return;
  const tab = addTab(safe, true, source);
  placeBeside(tab.id, source);
}
/** A pane was clicked or focused: it becomes the selected one. */
function focusPane(id: string) {
  if (id !== state.value.active && inSplit(id)) selectTab(id);
}
// In the iframe build a click inside a page only shows up as this window
// losing focus to that frame.
function frameTookFocus() {
  for (const [id, frame] of frames) {
    if (document.activeElement === frame) {
      focusPane(id);
      break;
    }
  }
}
onMounted(() => window.addEventListener("blur", frameTookFocus));
onBeforeUnmount(() => window.removeEventListener("blur", frameTookFocus));
/** Exchange the two pages; the selection stays with its tab. */
function swapSplit() {
  const split = state.value.split;
  if (!split) return;
  [split.primary, split.secondary] = [split.secondary, split.primary];
  save();
}
function toggleSplitOrientation() {
  state.value.stacked = !state.value.stacked;
  save();
}
/** Start a split with a blank tab beside the source. */
function toggleSplit() {
  if (state.value.split) return closeSplit();
  const source = state.value.active;
  const tab = addTab(START, true, source);
  placeBeside(tab.id, source);
}
/** [first pane, second pane] while a Split View is open. */
const splitPair = computed<[BrowserTab, BrowserTab] | null>(() => {
  const split = state.value.split;
  if (!split) return null;
  const primary = spaceTabs.value.find((tab) => tab.id === split.primary);
  const secondary = spaceTabs.value.find((tab) => tab.id === split.secondary);
  return primary && secondary ? [primary, secondary] : null;
});
const visiblePanes = computed(() => splitPair.value ?? [activeTab.value]);
const frameTabs = computed(() =>
  visiblePanes.value.filter((tab) => tab.url).sort((a, b) => a.id.localeCompare(b.id)),
);
function frameKey(tab: BrowserTab) {
  // Per-tab keys let both documents survive a change of focused pane.
  void revision.value;
  return `${tab.id}:${history(tab).reloads}:${tab.url}`;
}
const isShown = (id: string) =>
  id === state.value.active ||
  inSplit(id) ||
  id === peek.value?.id;
const paneClass = (id: string) => {
  const pair = splitPair.value;
  return {
    "browser-hidden": !isShown(id),
    "pane-first": pair?.[0]!.id === id,
    "pane-second": pair?.[1]!.id === id,
    "browser-peeking": id === peek.value?.id,
  };
};
let dividing = false;
function divideDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dividing = true;
}
function divideMove(event: PointerEvent) {
  if (!dividing) return;
  const at = pagePoint(event),
    box = pageBox.value!;
  const share = state.value.stacked
    ? at.y / box.offsetHeight
    : at.x / box.offsetWidth;
  state.value.ratio = splitRatio(share * 100);
}
function divideUp() {
  if (dividing) save();
  dividing = false;
}
function splitRatio(ratio: number) {
  return Math.round(Math.max(25, Math.min(75, ratio)));
}
function divideKey(event: KeyboardEvent) {
  const [back, forward] = state.value.stacked
    ? ["ArrowUp", "ArrowDown"]
    : ["ArrowLeft", "ArrowRight"];
  const key = event.key;
  if (![back, forward, "Home", "End"].includes(key)) return;
  event.preventDefault();
  const ratio = key === "Home" ? 25 : key === "End" ? 75
    : state.value.ratio + (key === back ? -5 : 5);
  state.value.ratio = splitRatio(ratio);
  save();
}
let gripping = false;
function gripDown(event: PointerEvent) {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  gripping = true;
}
function gripMove(event: PointerEvent) {
  if (!gripping || !root.value) return;
  const { x } = local(event);
  state.value.side = sidebarWidth(state.value.sidebarPosition === "right" ? root.value.offsetWidth - x : x);
}
function gripUp() {
  if (gripping) save();
  gripping = false;
}

// ---- Start page: every blank pane gets one ----
const blankPanes = computed(() =>
  visiblePanes.value.filter((tab) => !tab.url),
);
const startText = reactive<Record<string, string>>({});
const quick = [
  { title: "Google", url: "https://www.google.com/" },
  { title: "GitHub", url: "https://github.com/" },
  { title: "Wikipedia", url: "https://www.wikipedia.org/" },
  { title: "Example", url: "https://example.com/" },
];
function openQuick(event: MouseEvent, tab: BrowserTab, url: string) {
  if (tab.id !== state.value.active) selectTab(tab.id);
  if (event.shiftKey) openPeek(url);
  else if (event.altKey) openSplit(url);
  else if (event.ctrlKey || event.metaKey) addTab(url, true);
  else startGo(tab, url);
}
function startGo(tab: BrowserTab, text: string) {
  if (tab.id !== state.value.active) selectTab(tab.id);
  delete startText[tab.id];
  go(text);
}
/** Back to the start page, dropping the page that was loaded. */
function goHome() {
  const tab = activeTab.value;
  if (!tab.url) return;
  forget(tab.id);
  touch(tab.id);
  delete tab.title;
  show(START);
}
const embedHintDismissed = ref(false);
watch(() => activeTab.value.id, () => { embedHintDismissed.value = false; });

// ---- Inspect: DevTools docked under the page, like other browsers ----
// Electron renders the page's DevTools into a DevTools <webview> placed in
// the row under the page; the page area shrinks to make room.
const inspect = ref<{ tabId: string; guestId: number; x: number; y: number; key: number }>();
const devtoolsHeight = ref(300);
let devtoolsKey = 0;
let devtoolsReady = false;
function startInspect(view: WebviewElement, x: number, y: number) {
  const tab = state.value.tabs.find((item) => webviews.get(item.id) === view);
  if (!tab || !desktop?.openDevTools || !desktop.devtoolsSrc) return;
  const guestId = view.getWebContentsId();
  const open = inspect.value;
  // Already docked for this page: just reveal the element.
  if (open && open.guestId === guestId && devtoolsReady) {
    void desktop.openDevTools(guestId, devtoolsElement!.getWebContentsId(), x, y);
    return;
  }
  if (open) void desktop.closeDevTools?.(open.guestId);
  devtoolsReady = false;
  inspect.value = { tabId: tab.id, guestId, x, y, key: ++devtoolsKey };
}
let devtoolsElement: WebviewElement | undefined;
function bindDevtools(element: unknown) {
  const view = element as WebviewElement | null;
  if (!view || view === devtoolsElement) return;
  devtoolsElement = view;
  const target = inspect.value;
  view.addEventListener("dom-ready", () => {
    const current = inspect.value;
    if (!current || current !== target || devtoolsReady || !desktop?.openDevTools) return;
    devtoolsReady = true;
    void desktop.openDevTools(current.guestId, view.getWebContentsId(), current.x, current.y);
  }, { once: true });
}
function closeInspect() {
  const open = inspect.value;
  if (!open) return;
  void desktop?.closeDevTools?.(open.guestId);
  inspect.value = undefined;
  devtoolsElement = undefined;
  devtoolsReady = false;
}
// DevTools belong to the page they inspect: switching away closes them.
watch(() => state.value.active, (active) => {
  if (inspect.value && inspect.value.tabId !== active) closeInspect();
});
watch(() => state.value.tabs.map((tab) => tab.id), (ids) => {
  if (inspect.value && !ids.includes(inspect.value.tabId)) closeInspect();
});
function startDevtoolsResize(event: PointerEvent) {
  const grip = event.currentTarget as HTMLElement;
  const box = root.value;
  if (!box) return;
  event.preventDefault();
  grip.setPointerCapture(event.pointerId);
  const scale = box.getBoundingClientRect().height / box.offsetHeight || 1;
  const startY = event.clientY, start = devtoolsHeight.value;
  const max = Math.max(120, box.clientHeight - 160);
  const move = (next: PointerEvent) => {
    devtoolsHeight.value = Math.round(Math.min(max, Math.max(120, start - (next.clientY - startY) / scale)));
  };
  const end = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", end);
    grip.removeEventListener("pointercancel", end);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

// ---- Tooltips, drawn inside the app so they follow its zoom ----
const tip = ref<{ text: string; meta: string; shortcut: boolean; x: number; y: number }>();
const tipBox = ref<HTMLElement>();
let tipFor: HTMLElement | undefined;
let tipByKeyboard = false;
let tipPoint = { x: 0, y: 0 };
let tipTimer: ReturnType<typeof setTimeout> | undefined;
function hideTip() {
  tipFor = undefined;
  clearTimeout(tipTimer);
  tip.value = undefined;
}
function placeTip() {
  const box = root.value, tooltip = tipBox.value, owner = tipFor, visible = tip.value;
  if (!box || !tooltip || !owner?.isConnected || !visible) return;
  const bounds = box.getBoundingClientRect(), anchor = owner.getBoundingClientRect();
  const scale = bounds.width / box.offsetWidth || 1;
  const right = box.clientWidth - tooltip.offsetWidth - 6;
  const bottom = box.clientHeight - tooltip.offsetHeight - 6;
  let x = tipByKeyboard ? (anchor.left - bounds.left) / scale : tipPoint.x + 15;
  let y = tipByKeyboard ? (anchor.bottom - bounds.top) / scale + 8 : tipPoint.y + 23;
  if (x > right && !tipByKeyboard) x = tipPoint.x - tooltip.offsetWidth - 17;
  if (y > bottom)
    y = (tipByKeyboard ? (anchor.top - bounds.top) / scale : tipPoint.y) - tooltip.offsetHeight - 10;
  visible.x = Math.max(6, Math.min(right, x));
  visible.y = Math.max(6, Math.min(bottom, y));
}
function planTip(target: HTMLElement | undefined, keyboard: boolean) {
  if (browserDrag.value || tipResumeAt) return;
  if (target === tipFor && tipByKeyboard === keyboard) return;
  hideTip();
  if (!target || target.matches(":disabled")) return;
  tipFor = target;
  tipByKeyboard = keyboard;
  tipTimer = setTimeout(() => {
    if (!target.isConnected) return;
    const raw = target.dataset.tip || "";
    if (!raw) return;
    const [label, detail] = raw.split(/ · (.+)/);
    const keys = label?.match(/^(.*?)\s+\(([^()]+)\)$/);
    const shortcut = target.dataset.key || keys?.[2];
    tip.value = { text: keys?.[1] || label || raw, meta: shortcut || detail || "",
      shortcut: !!shortcut, x: 0, y: 0 };
    nextTick(placeTip);
  }, keyboard ? 240 : 500);
}
function tipOver(event: PointerEvent) {
  if (event.pointerType === "touch" || event.buttons) return;
  tipPoint = local(event);
  if (tipResumeAt) {
    if (Math.hypot(tipPoint.x - tipResumeAt.x, tipPoint.y - tipResumeAt.y) < 4) return;
    tipResumeAt = undefined;
  }
  const target = (event.target as HTMLElement)?.closest<HTMLElement>("[data-tip]");
  planTip(target || undefined, false);
  if (tip.value) placeTip();
}
function tipFocus(event: FocusEvent) {
  const target = (event.target as HTMLElement)?.closest<HTMLElement>("[data-tip]");
  if (target?.matches(":focus-visible")) planTip(target, true);
}
function tipBlur(event: FocusEvent) {
  if (tipByKeyboard && tipFor?.contains(event.target as Node)) hideTip();
}
onBeforeUnmount(hideTip);

// An app too narrow for a full sidebar shows it as icons.
const narrow = ref(false);
let widthWatch: ResizeObserver | undefined;
onMounted(() => {
  if (!root.value || typeof ResizeObserver === "undefined") return;
  widthWatch = new ResizeObserver(() => {
    narrow.value = (root.value?.offsetWidth || 0) < 560;
  });
  widthWatch.observe(root.value);
});
onBeforeUnmount(() => widthWatch?.disconnect());
function spacesMenu(event: MouseEvent) {
  openMenu(event, [
    ...state.value.spaces.map((space) => ({
      label: space.name,
      initial: space.icon || space.name.charAt(0).toUpperCase(),
      checked: space.id === state.value.space,
      run: () => switchSpace(space.id),
    })),
    {},
    {
      label: "New space",
      icon: "plus",
      disabled: state.value.spaces.length >= MAX_SPACES,
      run: addSpace,
    },
    { label: "Rename current space", icon: "edit", run: () => rename(currentSpace.value) },
  ], "Spaces");
}
watch([splitPair, peek], () => updateActivity());

// ---- Background media: a mini player, and optional picture-in-picture ----
const playing = reactive<Record<string, boolean>>({});
const muted = reactive<Record<string, boolean>>({});
const miniTab = computed(() =>
  state.value.tabs.find((tab) => playing[tab.id] && !isShown(tab.id)),
);
function toggleMute(tab: BrowserTab) {
  muted[tab.id] = !muted[tab.id];
  try {
    webviews.get(tab.id)?.setAudioMuted(!!muted[tab.id]);
  } catch {
    // Not attached.
  }
}
const POP_OUT =
  "(()=>{const v=[...document.querySelectorAll('video')].find(v=>!v.paused&&!v.ended);if(v&&document.pictureInPictureEnabled&&!document.pictureInPictureElement)v.requestPictureInPicture().catch(()=>{})})()";
/** Before a tab goes out of view: pop its playing video out, if asked. */
function leaving(id: string) {
  if (!state.value.pip || !playing[id]) return;
  try {
    void webviews
      .get(id)
      ?.executeJavaScript(POP_OUT, true)
      ?.catch(() => undefined);
  } catch {
    // Not attached.
  }
}

// ---- Search tabs (Ctrl+Shift+A) and recent tabs (Ctrl+Tab) ----
const switcher = ref<{
  mode: "search" | "recent";
  query: string;
  index: number;
} | null>(null);
const switcherInput = ref<HTMLInputElement>();
const commandList = ref<HTMLElement>();
const commandTrack = ref<HTMLElement>();
const commandScroll = ref({ height: 0, top: 0 });
const commandId = uid();
const switcherItems = computed(() => {
  const open = switcher.value;
  if (!open) return [];
  const tabItem = (tab: BrowserTab) => ({
    key: tab.id, title: label(tab), detail: tab.space === state.value.space ? "Tab" : "Other space",
    icon: "globe", run: () => goToTab(tab),
  });
  if (open.mode === "recent")
    return recent
      .map((id) => state.value.tabs.find((tab) => tab.id === id))
      .filter((tab): tab is BrowserTab => !!tab)
      .slice(0, 5)
      .map(tabItem);
  const query = open.query.trim();
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const commands = [
    { key: "new-tab", title: "New tab", detail: "Ctrl T", icon: "plus", run: () => addTab() },
    { key: "new-group", title: "New tab group", detail: "", icon: "folder", run: () => newGroup() },
    { key: "new-space", title: "New space", detail: "", icon: "layers", run: addSpace },
    { key: "split", title: state.value.split ? "Exit Split View" : "Enter Split View",
      detail: "", icon: "columns", run: toggleSplit },
    ...(state.value.peekEnabled && state.value.layout !== "comfortable"
      ? [{ key: "peek", title: "Peek a link", detail: "", icon: "eye", run: openPeekPrompt }] : []),
    { key: "library", title: "Bookmarks and history", detail: "Ctrl B", icon: "library", run: () => openDrawer("library") },
    { key: "preferences", title: "Preferences", detail: "", icon: "settings", run: () => openDrawer("preferences") },
    ...(showNetSuiteEnvironment.value
      ? [{ key: "netsuite-environments", title: "Switch NetSuite environment", detail: "", icon: "swap", run: () => netSuiteEnvironmentButton.value?.click() }]
      : []),
    ...(state.value.layout !== "comfortable"
      ? [{ key: "sidebar", title: state.value.collapsed ? "Expand sidebar" : "Collapse sidebar",
        detail: "", icon: "sidebar", run: toggleSidebar },
        { key: "sidebar-position", title: state.value.sidebarPosition === "left" ? "Move sidebar right" : "Move sidebar left",
          detail: "", icon: "sidebar", run: () => setSidebarPosition(state.value.sidebarPosition === "left" ? "right" : "left") }] : []),
  ].filter((command) => matches(command.title));
  return [
    ...commands,
    ...state.value.spaces.filter((space) => matches(`Switch to ${space.name}`)).map((space) => ({
      key: `space-${space.id}`, title: `Switch to ${space.name}`,
      detail: "Space", icon: "layers", run: () => switchSpace(space.id),
    })),
    ...state.value.tabs.filter((tab) => matches(`${label(tab)} ${tab.url}`)).map(tabItem),
    ...(query ? state.value.bookmarks
      .filter((bookmark) => matches(`${bookmark.title} ${bookmark.url}`))
      .map((bookmark) => ({
        key: `bookmark-${bookmark.id}`, title: bookmark.title || bookmark.url,
        detail: "Bookmark", icon: "star", run: () => openBookmark(bookmark),
      })) : []),
    ...(query ? [{
      key: "open", title: `Search or open “${query}”`, detail: "↵",
      icon: "search", run: () => go(query),
    }] : []),
  ];
});
function updateCommandScroll() {
  const list = commandList.value;
  if (!list || list.scrollHeight <= list.clientHeight) {
    commandScroll.value = { height: 0, top: 0 };
    return;
  }
  const track = list.clientHeight - 16;
  const height = Math.min(track, Math.max(37, track * list.clientHeight / list.scrollHeight));
  const top = (track - height) * list.scrollTop / (list.scrollHeight - list.clientHeight);
  commandScroll.value = { height, top };
}
function searchChanged() {
  if (switcher.value) switcher.value.index = 0;
  if (commandList.value) commandList.value.scrollTop = 0;
  nextTick(updateCommandScroll);
}
let commandGrab = 0;
function commandDrag(event: PointerEvent) {
  const track = commandTrack.value;
  if (!track) return;
  event.preventDefault();
  const rect = track.getBoundingClientRect();
  const scale = rect.height / track.offsetHeight || 1;
  commandGrab = event.target === track ? commandScroll.value.height / 2 :
    (event.clientY - rect.top) / scale - commandScroll.value.top;
  track.setPointerCapture(event.pointerId);
  commandDragMove(event);
}
function commandDragMove(event: PointerEvent) {
  const list = commandList.value, track = commandTrack.value;
  if (!list || !track?.hasPointerCapture(event.pointerId)) return;
  const rect = track.getBoundingClientRect();
  const scale = rect.height / track.offsetHeight || 1;
  const range = Math.max(1, track.clientHeight - commandScroll.value.height);
  const at = (event.clientY - rect.top) / scale - commandGrab;
  list.scrollTop = Math.max(0, Math.min(1, at / range)) * (list.scrollHeight - list.clientHeight);
}
function goToTab(tab: BrowserTab) {
  if (tab.space && tab.space !== state.value.space) {
    leaving(state.value.active);
    state.value.split = null;
    state.value.space = tab.space;
  }
  selectTab(tab.id);
}
function moveSwitcher(delta: number) {
  const open = switcher.value,
    count = switcherItems.value.length;
  if (!open || !count) return;
  open.index = (open.index + delta + count) % count;
  if (open.mode === "search") nextTick(() =>
    commandList.value?.children[open.index]?.scrollIntoView({ block: "nearest" }),
  );
}
function commitSwitcher(index = switcher.value?.index ?? 0) {
  const item = switcherItems.value[index];
  switcher.value = null;
  item?.run();
}
function cycle(delta: number) {
  if (switcher.value?.mode !== "recent")
    switcher.value = { mode: "recent", query: "", index: 0 };
  moveSwitcher(delta);
}

// ---- Address, clipboard and screenshots ----
const barOpen = ref(false);
function focusAddress() {
  barOpen.value = true;
  nextTick(() => addressInput.value?.focus());
}
function copyAddress() {
  if (!activeTab.value.url) return;
  navigator.clipboard
    .writeText(activeTab.value.url)
    .then(() => say("Address copied."))
    .catch(() => say("The address could not be copied."));
}
const cropping = ref<{ x0: number; y0: number; x: number; y: number } | null>(
  null,
);
const cropArming = ref(false);
const cropPurpose = ref<"copy" | "clip" | "live">("copy");
const cropSurface = ref<Record<string, string>>();
function armCrop(purpose: "copy" | "clip" | "live") {
  cropSurface.value = undefined;
  if (purpose !== "copy") {
    const box = pageBox.value;
    const view = webviews.get(activeTab.value.id);
    if (!box?.offsetWidth || !view) return say("Open the page you want to clip first.");
    const area = box.getBoundingClientRect();
    const guest = view.getBoundingClientRect();
    const scale = area.width / box.offsetWidth;
    if (!guest.width || !guest.height || !scale) return say("Open the page you want to clip first.");
    cropSurface.value = {
      left: (guest.left - area.left) / scale + "px",
      top: (guest.top - area.top) / scale + "px",
      width: guest.width / scale + "px",
      height: guest.height / scale + "px",
      right: "auto",
      bottom: "auto",
    };
  }
  cropPurpose.value = purpose;
  cropArming.value = true;
}
async function pinClip(rect: ClipRect) {
  if (!canPinClip?.()) return;
  const tab = activeTab.value;
  const view = webviews.get(tab.id);
  try {
    if (!view || !desktop?.captureClip) throw Error("Pinning a clip requires a page in Orvane Desktop.");
    const captured = await desktop.captureClip(view.getWebContentsId(), tab.url, rect, true);
    const title = label(tab);
    const image = await importImageData(captured.image, title);
    addWorkbenchWidget("browser-clip", { url: tab.url, rect: captured.rect, image: image.value, blockId: props.block.id, tabId: tab.id }, `Clip · ${title}`);
  } catch (error) {
    say(error instanceof Error ? error.message : "The clip could not be captured.");
  }
}
// Live clips show the page itself through a cropped window (LiveClip.vue):
// pinning records where the part is on the page and the page's size.
async function pinLive(rect: ClipRect) {
  if (!canPinClip?.()) return;
  const tab = activeTab.value;
  const view = webviews.get(tab.id);
  try {
    if (!view) throw Error("Pinning a live clip requires a page in Orvane Desktop.");
    const page = (await runInPage(view, "({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })")) as
      { x: number; y: number; width: number; height: number };
    const viewport = readSize(page);
    const zoom = viewport && view.offsetWidth ? view.offsetWidth / page.width : 1;
    const area = readRect({ x: rect.x / zoom + page.x, y: rect.y / zoom + page.y, width: rect.width / zoom, height: rect.height / zoom });
    if (!viewport || !area) throw Error("Choose a larger area of the page.");
    addWorkbenchWidget("browser-clip", { mode: "live", pick: "area", url: tab.url, rect: area, viewport, blockId: props.block.id, tabId: tab.id }, `Live clip · ${label(tab)}`);
  } catch (error) {
    say(error instanceof Error ? error.message : "The live clip could not be pinned.");
  }
}
let picking: WebviewElement | undefined;
async function pickElement() {
  if (!canPinClip?.()) return;
  const tab = activeTab.value;
  const view = webviews.get(tab.id);
  if (!view) return say("Open the page you want to clip first.");
  picking = view;
  // The page takes the pointer and keys while picking.
  focusFrame();
  try {
    const picked = readPicked(await runInPage(view, PICK_ELEMENT));
    if (!picked || picking !== view) return;
    addWorkbenchWidget(
      "browser-clip",
      { mode: "live", pick: "element", selector: picked.selector, url: tab.url, rect: picked.rect, viewport: picked.viewport, blockId: props.block.id, tabId: tab.id },
      `Live clip · ${label(tab)}`,
    );
  } catch {
    say("The element could not be picked.");
  } finally {
    if (picking === view) picking = undefined;
  }
}
// Clicking outside the page, or another tab, ends picking.
watch([interacting, () => state.value.active], () => {
  if (!picking || (interacting.value && webviews.get(state.value.active) === picking)) return;
  runInPage(picking, CANCEL_PICK).catch(() => undefined);
  picking = undefined;
});
function refreshClip(event: Event) {
  const request = (event as CustomEvent<BrowserClipRequest>).detail;
  if (!request || request.respond || (!request.anySource && request.blockId !== props.block.id) || !desktop?.captureClip) return;
  const liveTabs = state.value.tabs.filter((item) => item.url === request.url && webviews.get(item.id)?.isConnected);
  const tab = liveTabs.find((item) => item.id === request.tabId) ?? liveTabs[0];
  const view = tab && webviews.get(tab.id);
  if (!view || !view.isConnected) return;
  request.respond = (async () => {
    const captured = await desktop.captureClip!(view.getWebContentsId(), request.url, request.rect, false);
    const image = await importImageData(captured.image, "Browser clip");
    return image.value;
  })();
}
onMounted(() => window.addEventListener(REFRESH_BROWSER_CLIP, refreshClip));
onBeforeUnmount(() => window.removeEventListener(REFRESH_BROWSER_CLIP, refreshClip));
async function capture(
  mode: "visible" | "full" | "area",
  rect?: { x: number; y: number; width: number; height: number },
) {
  const view = webviews.get(state.value.active);
  if (!view || !desktop?.capturePage)
    return say("Screenshots need a page open in the Orvane desktop app.");
  // The shell returns the picture; copying it is this window's job.
  let ok = false;
  try {
    const picture = await desktop.capturePage(
      view.getWebContentsId(),
      mode,
      rect,
    );
    if (picture) {
      const image = await (await fetch(picture)).blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": image }),
      ]);
      ok = true;
    }
  } catch {
    ok = false;
  }
  say(ok ? "Screenshot copied to the clipboard." : "The page could not be captured.");
}
function pagePoint(event: PointerEvent) {
  const box = event.currentTarget as HTMLElement;
  const rect = box.getBoundingClientRect();
  const scale = box.offsetWidth ? rect.width / box.offsetWidth : 1;
  return {
    x: Math.max(0, Math.min(box.offsetWidth, (event.clientX - rect.left) / scale)),
    y: Math.max(0, Math.min(box.offsetHeight, (event.clientY - rect.top) / scale)),
  };
}
function cropDown(event: PointerEvent) {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  const at = pagePoint(event);
  cropping.value = { x0: at.x, y0: at.y, x: at.x, y: at.y };
}
function cropMove(event: PointerEvent) {
  if (cropping.value) Object.assign(cropping.value, pagePoint(event));
}
function cropUp(event?: PointerEvent) {
  const drag = cropping.value;
  cropping.value = null;
  cropArming.value = false;
  if (!drag || event?.type === "pointercancel") return;
  // The area is in the Browser's pixels; a focused page shown at another
  // zoom (--focus-page-zoom) measures it in its own CSS pixels.
  const view = webviews.get(state.value.active);
  const zoom = (view && Number(getComputedStyle(view).zoom)) || 1;
  const rect = {
    x: Math.min(drag.x0, drag.x) / zoom,
    y: Math.min(drag.y0, drag.y) / zoom,
    width: Math.abs(drag.x - drag.x0) / zoom,
    height: Math.abs(drag.y - drag.y0) / zoom,
  };
  if (rect.width > 4 && rect.height > 4)
    void (cropPurpose.value === "clip" ? pinClip(rect) : cropPurpose.value === "live" ? pinLive(rect) : capture("area", rect));
}
const cropBox = computed(() => {
  const drag = cropping.value;
  return drag
    ? {
        left: Math.min(drag.x0, drag.x) + "px",
        top: Math.min(drag.y0, drag.y) + "px",
        width: Math.abs(drag.x - drag.x0) + "px",
        height: Math.abs(drag.y - drag.y0) + "px",
      }
    : undefined;
});

function setLayout(layout: Layout) {
  state.value.layout = layout;
  save();
}
function setSidebarPosition(position: SidebarPosition) {
  state.value.sidebarPosition = position;
  save();
}
function toggleSidebar() {
  if (state.value.layout === "comfortable") return;
  state.value.collapsed = !state.value.collapsed;
  save();
}
function browserTools(): MenuItem[] {
  return [
    { label: "Layout: sidebar and address bar", icon: "sidebar", checked: state.value.layout === "balanced",
      run: () => setLayout("balanced") },
    { label: "Layout: sidebar only", icon: "sidebar", checked: state.value.layout === "performance",
      run: () => setLayout("performance") },
    { label: "Layout: tabs on top", icon: "columns", checked: state.value.layout === "comfortable",
      run: () => setLayout("comfortable") },
    {},
    { label: "Group tabs by site", icon: "folder", run: groupBySite },
    { label: "Copy address", icon: "copy", disabled: !activeTab.value.url, run: copyAddress },
    { label: "Swap panes", icon: "swap", disabled: !state.value.split, run: swapSplit },
    { label: state.value.stacked ? "Split side by side" : "Split top and bottom",
      icon: state.value.stacked ? "columns" : "rows", disabled: !state.value.split, run: toggleSplitOrientation },
    {},
    { label: "Screenshot: visible page", icon: "download", run: () => void capture("visible") },
    { label: "Screenshot: full page", icon: "download", run: () => void capture("full") },
    { label: "Screenshot: select an area", icon: "resize", run: () => armCrop("copy") },
    { label: "Pin a snapshot clip", icon: "image", disabled: !canPinClip?.() || !desktop?.captureClip || !activeTab.value.url || !!peek.value, run: () => armCrop("clip") },
    { label: "Pin a live area", icon: "crop", disabled: !canPinClip?.() || !useWebview || !activeTab.value.url || !!peek.value, run: () => armCrop("live") },
    { label: "Pin a live element", icon: "box", disabled: !canPinClip?.() || !useWebview || !activeTab.value.url || !!peek.value, run: () => void pickElement() },
  ];
}
/** Returns the id of the tab now showing that account. */
function switchNetSuiteEnvironment(origin: string) {
  if (!netSuiteAppOrigin.test(origin)) return;
  const existing = state.value.tabs.find((tab) => {
    const current = originOf(tab.url);
    return current === origin || (current === "https://system.netsuite.com" &&
      originOf(tab.rootUrl || started[tab.id] || "") === origin);
  });
  if (existing) {
    goToTab(existing);
    return existing.id;
  }
  const url = `${origin}/app/center/card.nl`;
  const tab = addTab(url);
  openingEnvironment.set(tab.id, url);
  return tab.id;
}
const netSuiteOrigin = computed(() => originOf(activeTab.value.url));
const showNetSuiteEnvironment = computed(() => !!desktop?.browserNetSuiteEnvironments &&
  (netSuiteAppOrigin.test(netSuiteOrigin.value) || netSuiteOrigin.value === "https://system.netsuite.com"));
const currentNetSuiteAccount = computed(() => netSuiteAppOrigin.test(netSuiteOrigin.value)
  ? new URL(netSuiteOrigin.value).hostname.split(".")[0] : "");
function openNetSuiteEnvironments(event: MouseEvent) {
  if (menu.value?.title === "NetSuite environments") {
    menu.value = null;
    return;
  }
  const tab = activeTab.value;
  const origin = netSuiteOrigin.value;
  const openAccounts = new Map<string, BrowserNetSuiteEnvironment>();
  for (const item of state.value.tabs) {
    const tabOrigin = originOf(item.url);
    if (netSuiteAppOrigin.test(tabOrigin) && !openAccounts.has(tabOrigin))
      openAccounts.set(tabOrigin, { origin: tabOrigin, label: new URL(tabOrigin).hostname.split(".")[0]! });
  }
  const itemsFor = (entries: Iterable<BrowserNetSuiteEnvironment>): MenuItem[] =>
    Array.from(entries, (entry) => ({
      label: entry.label,
      checked: entry.origin === origin,
      run: () => switchNetSuiteEnvironment(entry.origin),
    }));
  openMenu(event, [...itemsFor(openAccounts.values()), { label: "Loading other environments…", disabled: true }], "NetSuite environments");
  const popup = menu.value;
  const update = (items: MenuItem[]) => {
    if (!popup || menu.value !== popup || activeTab.value.id !== tab.id || netSuiteOrigin.value !== origin) return;
    popup.items = items;
    void nextTick(() => positionMenu(false));
  };
  void Promise.resolve().then(() => {
    const view = webviews.get(tab.id);
    if (!view || !desktop?.browserNetSuiteEnvironments) throw Error("Browser tab is unavailable.");
    return desktop.browserNetSuiteEnvironments(view.getWebContentsId());
  }).then(entries => {
    for (const entry of entries) openAccounts.set(entry.origin, entry);
    update(itemsFor(openAccounts.values()));
  }).catch((error: Error) => update([
    ...itemsFor(openAccounts.values()),
    { label: error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?(?:Error:\s*)?/, ""), disabled: true },
    { label: "Retry environment lookup", icon: "refresh", run: () => netSuiteEnvironmentButton.value?.click() },
  ]));
}
watch([() => activeTab.value.id, netSuiteOrigin], () => {
  if (menu.value?.title === "NetSuite environments") menu.value = null;
});
function moreMenu(event: MouseEvent) {
  openMenu(event, [
    { label: "New tab", icon: "plus", hint: "Ctrl T", run: () => { addTab(); } },
    { label: "Reopen closed tab", icon: "undo", hint: "Ctrl Shift T", disabled: !state.value.closed.length, run: reopenClosed },
    { label: "Command palette", icon: "search", hint: "Ctrl K", run: () => shortcut("search") },
    {},
    { label: state.value.split ? "Exit Split View" : "Enter Split View", icon: "columns", run: toggleSplit },
    { label: "Peek a link…", icon: "eye", disabled: !state.value.peekEnabled || state.value.layout === "comfortable", run: openPeekPrompt },
    { label: state.value.collapsed ? "Show sidebar" : "Hide sidebar", icon: "sidebar",
      hint: "Ctrl " + String.fromCharCode(92), disabled: state.value.layout === "comfortable", run: toggleSidebar },
    {},
    { label: "Bookmarks & history", icon: "library", hint: "Ctrl B", run: () => openDrawer("library") },
    { label: "Memory", icon: "keyboard", run: () => openDrawer("memory") },
    { label: "New space", icon: "layers", disabled: state.value.spaces.length >= MAX_SPACES, run: addSpace },
    { label: "New tab group", icon: "folder", run: () => newGroup() },
    {},
    { label: "Export", icon: "download", run: exportBrowserSession },
    { label: "Import", icon: "upload", run: importBrowserSession },
    { label: "Preferences", icon: "settings", run: () => openDrawer("preferences") },
    { label: "Browser tools", icon: "more", children: browserTools },
  ], "Browser");
}
function previewInput(text: string) {
  const result = resolveInput(text);
  if ("error" in result) say(result.error!);
  else if (result.url) openPeek(result.url);
}
function modalTab(event: KeyboardEvent) {
  const elements = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
    "button:not(:disabled):not([tabindex='-1']), input:not(:disabled)",
  ));
  const first = elements[0], last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
function peekAddress() {
  previewInput(address.value);
  barOpen.value = false;
}
function openPeekPrompt() {
  openDialog({ title: "Peek a link", label: "URL or search", value: "",
    placeholder: "Paste a link or search the web", action: "Preview", submit: previewInput });
}
function shortcut(name: string) {
  // Space held in a page pans the canvas (see App.vue hoverPan).
  if (name === "space-down" || name === "space-up")
    return void window.dispatchEvent(new CustomEvent("orvane:space", { detail: name === "space-down" }));
  // Orvane's Ctrl+K search and Ctrl+Shift+P commands, pressed inside a page.
  // Ctrl+Shift+L in a page: its selection goes to the agent session composer.
  if (name === "send-selection")
    return void window.dispatchEvent(new CustomEvent("orvane:send-selection", { detail: root.value }));
  if (name === "palette" || name === "commands" || name === "agent")
    return void window.dispatchEvent(new CustomEvent("orvane:palette", { detail: name === "palette" ? "" : name === "commands" ? ">" : "agent" }));
  if (name === "google-sign-in") say("Continue sign-in on the site in your system browser.");
  else if (name === "address") focusAddress();
  else if (name === "find") openFind();
  else if (name === "new-tab") addTab();
  else if (name === "close-tab") {
    if (peek.value) closePeek();
    else closeTabSliding(state.value.active);
  } else if (name === "reopen-tab") reopenClosed();
  else if (name === "library") openDrawer("library");
  else if (name === "sidebar") toggleSidebar();
  else if (name === "history-back") step(-1);
  else if (name === "history-forward") step(1);
  else if (name === "promote-peek" && peek.value) keepPeek(false);
  else if (/^tab-[1-9]$/.test(name)) {
    const tab = spaceTabs.value[Number(name.at(-1)) - 1];
    if (tab) selectTab(tab.id);
  } else if (name === "peek") openPeekPrompt();
  else if (name === "search") {
    closeDrawer();
    switcher.value = { mode: "search", query: "", index: 0 };
    nextTick(() => { switcherInput.value?.focus(); updateCommandScroll(); });
  } else if (name === "copy-url") copyAddress();
  else if (name === "tab-next") cycle(1);
  else if (name === "tab-back") cycle(-1);
  else if (name === "release") {
    if (switcher.value?.mode === "recent") commitSwitcher();
  } else if (name === "space-next") stepSpace(1);
  else if (name === "space-back") stepSpace(-1);
  else if (name === "escape" && peek.value) closePeek();
}
function hostKey(event: KeyboardEvent) {
  if (event.key === "Tab") tipResumeAt = undefined;
  if (event.key === "Escape") {
    hideTip();
    const sourceEscape = sourceOpen[activeTab.value.id] && !(event.target as Element)?.closest("input,textarea,[contenteditable]");
    if (!(menu.value || switcher.value || dialog.value || drawer.value || peek.value || cropArming.value || processingOpen.value || showPasswords.value || sourceEscape)) {
      if (activeLoading.value && !finds[state.value.active]?.open && !(event.target as Element)?.closest("input,textarea,[contenteditable]")) {
        event.preventDefault(); event.stopPropagation(); stopLoading();
      }
      return;
    }
    if ((event.target as Element)?.closest(".browser-drawer") && !menu.value) return;
    event.preventDefault();
    event.stopPropagation();
    if (menu.value) { menu.value = null; menuTrigger?.focus(); }
    else if (dialog.value) dismissDialog();
    else if (switcher.value) switcher.value = null;
    else if (drawer.value) closeDrawer();
    else if (processingOpen.value) processingOpen.value = false;
    else if (showPasswords.value) showPasswords.value = false;
    else if (cropArming.value) {
      cropping.value = null;
      cropArming.value = false;
    }
    else if (peek.value) closePeek();
    else if (sourceEscape) {
      sourceOpen[activeTab.value.id] = false;
      root.value?.querySelector<HTMLElement>(".browser-sources .sources-open")?.focus();
    }
    return;
  }
  const name = keyShortcut(event);
  if (!name) return;
  event.preventDefault();
  event.stopPropagation();
  shortcut(name);
}
function keyShortcut(event: KeyboardEvent) {
  if (dialog.value || switcher.value?.mode === "search") return;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  let name: string | undefined;
  if (event.altKey && key === "arrowleft") name = mod ? "space-back" : "history-back";
  else if (event.altKey && key === "arrowright") name = mod ? "space-next" : "history-forward";
  else if (mod && !event.altKey) {
    if (key === "tab") name = event.shiftKey ? "tab-back" : "tab-next";
    else if (event.shiftKey) name = ({ a: "search", c: "copy-url", t: "reopen-tab" } as Record<string, string>)[key];
    else if (/^[1-9]$/.test(key)) name = "tab-" + key;
    else name = ({ k: "palette", l: "address", t: "new-tab", w: "close-tab", b: "library", f: "find",
      [String.fromCharCode(92)]: "sidebar", ...(peek.value ? { o: "promote-peek" } : {}) } as Record<string, string>)[key];
  }
  return name;
}
// A key the canvas got while this Browser is the app in use (its frame was
// clicked, not its page or toolbar): run it as if it were pressed inside.
function canvasShortcut(event: Event) {
  const detail = (event as CustomEvent<{ blockId?: string; key?: KeyboardEvent; handled?: boolean }>).detail;
  if (detail?.blockId !== props.block.id || props.editing || !detail.key) return;
  const name = keyShortcut(detail.key);
  if (!name || name === "palette") return;
  detail.handled = true;
  shortcut(name);
}
// Ctrl+Tab from the canvas: the Ctrl release lands outside the Browser too.
onMounted(() => {
  window.addEventListener(BROWSER_SHORTCUT, canvasShortcut);
  window.addEventListener("keyup", hostKeyUp);
});
onBeforeUnmount(() => {
  window.removeEventListener(BROWSER_SHORTCUT, canvasShortcut);
  window.removeEventListener("keyup", hostKeyUp);
});
function hostKeyUp(event: KeyboardEvent) {
  if (event.key === "Control" || event.key === "Meta") shortcut("release");
}

// Middle-click closes a tab; keep the press from starting a canvas pan,
// which would capture the pointer before the tab sees the click.
function tabMiddleDown(event: MouseEvent) {
  // Alt-click opens a Split View; without this the canvas would take the
  // press as Alt-drag and move the app.
  if (event.button !== 1 && !(event.button === 0 && event.altKey)) return;
  event.preventDefault();
  event.stopPropagation();
}
function browserWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey)) event.stopPropagation();
}
</script>

<template>
  <div
    ref="root"
    class="browser-view"
    :class="[
      `layout-${state.layout}`,
      `theme-${state.theme}`,
      { 'side-collapsed': state.collapsed || narrow, 'side-right': state.sidebarPosition === 'right', 'bar-open': barOpen, 'browser-in-view': onScreen },
    ]"
    :style="{ '--side-wide': state.side + 'px', '--split': state.ratio + '%' }"
    aria-label="Web browser"
    @wheel="browserWheel"
    @keydown.capture="hostKey"
    @keyup.capture="hostKeyUp"
    @pointermove="browserDrag ? moveBrowserDrag($event) : tipOver($event)"
    @pointerup="endBrowserDrag($event)"
    @pointercancel="endBrowserDrag($event, true)"
    @lostpointercapture.self="endBrowserDrag($event, true)"
    @pointerleave="!browserDrag?.moving && endBrowserDrag()"
    @click.capture="ignoreDragClick"
    @scroll.capture="hideTip"
    @focusin="tipFocus"
    @focusout="tipBlur"
    @mouseleave="hideTip"
    @pointerdown.capture="hideTip"
  >
    <aside class="browser-side" aria-label="Browser tabs">
      <div class="side-head">
        <button
          type="button"
          class="current-space"
          aria-label="Switch space"
          data-tip="Switch space · right-click to rename or delete"
          @click="spacesMenu"
          @contextmenu="spaceMenu($event, currentSpace)"
        >
          <span class="space-initial" :style="{ '--space': currentSpace.color }">{{
            currentSpace.icon || currentSpace.name.slice(0, 1).toUpperCase()
          }}</span>
          <span class="space-label">{{ currentSpace.name }}</span>
          <Icon name="down" :size="12" />
        </button>
        <span class="side-spacer"></span>
        <button
          type="button"
          class="icon-button side-toggle"
          :aria-label="state.collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          data-tip="Collapse or expand sidebar"
          @click="
            state.collapsed = !state.collapsed;
            save();
          "
        >
          <Icon name="sidebar" :size="15" />
        </button>
      </div>
      <TransitionGroup tag="div" class="browser-spaces" role="tablist" aria-label="Spaces" move-class="browser-reorder-move">
          <button
            v-for="space in state.spaces"
            :key="space.id"
            type="button"
            class="browser-space"
            :class="{ active: space.id === state.space, 'drag-source': browserDrag?.moving && browserDrag.id === space.id }"
            :data-drag-space="space.id"
            @pointerdown="beginBrowserDrag($event, 'space', space.id)"
            :style="{ '--space': space.color }"
            role="tab"
            :aria-selected="space.id === state.space"
            :aria-label="`Space ${space.name}`"
            :data-tip="space.name"
            @click="switchSpace(space.id)"
            @contextmenu="spaceMenu($event, space)"
          >
            {{ space.icon || space.name.slice(0, 1).toUpperCase() }}
          </button>
        <button
          v-if="state.spaces.length < MAX_SPACES"
          key="add-space"
          type="button"
          class="browser-space browser-space-add"
          aria-label="New space"
          data-tip="New space"
          @click="addSpace"
        >
          <Icon name="plus" :size="11" />
        </button>
      </TransitionGroup>
      <button
        v-if="state.layout === 'performance'"
        type="button"
        class="browser-chip"
        aria-label="Edit address"
        data-tip="Search or enter address"
        data-key="Ctrl L"
        @click="focusAddress"
      >
        <Icon name="search" :size="12" />
        <span>{{ activeTab.url ? label(activeTab) : "Search or enter address" }}</span>
      </button>
      <TransitionGroup tag="div" class="browser-tabs" role="tablist" move-class="browser-reorder-move">
        <template v-for="row in rows" :key="rowKey(row)">
          <div v-if="row.kind === 'title'" class="side-title">
            <span class="side-title-text">{{ row.text }}</span>
            <template v-if="row.action === 'tab'">
              <span class="side-key">Ctrl T</span>
              <button
                type="button"
                class="side-add browser-new-tab"
                aria-label="New tab"
                data-tip="New tab"
                data-key="Ctrl T"
                @click="addTab()"
              >
                <Icon name="plus" :size="14" />
              </button>
            </template>
            <button
              v-else-if="row.action === 'group'"
              type="button"
              class="side-add new-group"
              aria-label="New tab group"
              data-tip="New tab group"
              @click="newGroup()"
            >
              <Icon name="plus" :size="13" />
            </button>
          </div>
          <div
            v-else-if="row.kind === 'group'"
            class="browser-group"
            :class="{ collapsed: row.group.collapsed, 'group-drop-active': browserDrag?.group === row.group.id }"
            :data-drop-group="row.group.id"
            :style="{ '--group': row.group.color }"
            role="button"
            tabindex="0"
            :aria-expanded="!row.group.collapsed"
            :aria-label="`Tab group ${row.group.name}`"
            @click="
              row.group.collapsed = !row.group.collapsed;
              save();
            "
            @keydown.enter.self="
              row.group.collapsed = !row.group.collapsed;
              save();
            "
            @dblclick.stop="rename(row.group)"
            @contextmenu="groupMenu($event, row.group)"
          >
            <Icon class="browser-group-chevron" name="down" :size="12" />
            <span class="browser-group-dot"></span>
            <span class="browser-group-name">{{ row.group.name }}</span>
            <small>{{ row.count }}</small>
            <button
              type="button"
              class="side-add"
              :aria-label="`Group options for ${row.group.name}`"
              data-tip="Group options"
              @click.stop="groupMenu($event, row.group)"
            >
              <Icon name="more" :size="13" />
            </button>
          </div>
          <div v-else-if="row.kind === 'empty-group'" class="browser-group-empty"
            :data-drop-group="row.group.id" :class="{ 'group-drop-active': browserDrag?.group === row.group.id }">
            Drop tabs here
          </div>
          <div
            v-else-if="row.kind === 'split' && splitPair"
            class="inline-split"
            role="group"
            aria-label="Split View panes"
            :class="{ grouped: row.grouped, 'pane-detached': browserDrag?.detached && browserDrag.fromSplit }"
            :style="{
              '--active-pane-index': splitPair[0]!.id === state.active ? 0 : 1,
            }"
          >
            <span class="split-active-highlight" aria-hidden="true"></span>
            <div
              v-for="(tab, pane) in splitPair"
              :key="tab.id"
              v-show="!(browserDrag?.detached && browserDrag.id === tab.id)"
              class="browser-tab"
              :class="{
                active: tab.id === state.active,
                pinned: !!tab.pinned,
                selected: selected.has(tab.id),
                'drag-source': browserDrag?.moving && browserDrag.id === tab.id,
              }"
              role="tab"
              :aria-selected="tab.id === state.active"
              tabindex="0"
              :data-tip="`${label(tab)} · ${state.stacked ? (pane ? 'Bottom' : 'Top') : (pane ? 'Right' : 'Left')} pane`"
              :data-drag-tab="tab.id"
              @click="tabClick($event, tab)"
              @keydown.enter.self.prevent="selectTab(tab.id)"
              @keydown.space.self.prevent="selectTab(tab.id)"
              @keydown.up="focusSplitRow($event, 0)"
              @keydown.down="focusSplitRow($event, 1)"
              @pointerdown="tabMiddleDown($event); beginBrowserDrag($event, 'tab', tab.id)"
              @mousedown="tabMiddleDown"
              @auxclick.prevent="$event.button === 1 && closeTabSliding(tab.id)"
              @contextmenu="tabMenu($event, tab)"
            >
              <span class="tab-load-shell"><span class="tab-favicon" :class="{ 'tab-site-loading': loading[tab.id] }" :style="faviconStyle(tab.url)">
                <Icon v-if="!tab.url" name="box" :size="14" />
                <template v-else>{{ glyph(tab) }}</template>
              </span><svg v-if="loading[tab.id]" class="tab-load-ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="load-track" cx="9" cy="9" r="7.5" /><path class="load-arc" d="M9 1.5a7.5 7.5 0 0 1 7.5 7.5" /></svg></span>
              <span class="tab-text">{{ label(tab) }}</span>
              <span v-if="sourceCount(tab)" class="tab-source-count" aria-label="Source passages"><Icon name="edit" :size="10" />{{ sourceCount(tab) }}</span>
              <span v-if="pageDialogs[tab.id]" class="tab-asks" aria-label="Page is waiting for you" data-tip="Page is waiting for you"></span>
              <Icon v-if="tab.rootUrl" name="lock" :size="12" aria-label="Locked tab" />
              <span class="pane-tag">{{
                state.stacked
                  ? pane
                    ? "Bottom"
                    : "Top"
                  : pane
                    ? "Right"
                    : "Left"
              }}</span>
              <button v-if="tab.peek" type="button" class="tab-peek-indicator"
                aria-label="Close preview" :data-tip="`Close preview · ${label(tab.peek)}`"
                @click.stop="closePeek(tab.id)">
                <Icon name="eye" :size="12" />
              </button>
            </div>
            <button
              type="button"
              class="inline-split-exit"
              aria-label="Exit Split View"
              data-tip="Exit Split View"
              @click.stop="closeSplit"
            >
              <Icon name="close" :size="12" />
            </button>
          </div>
          <div
            v-else-if="row.kind === 'tab'"
            v-show="!(browserDrag?.detached && browserDrag.id === row.tab.id)"
            class="browser-tab"
            :class="{
              active: row.tab.id === state.active,
              pinned: !!row.tab.pinned,
              grouped: row.grouped,
              selected: selected.has(row.tab.id),
              'ai-controlled': aiAccess[row.tab.id] === 'controlled',
              'drag-source': browserDrag?.moving && browserDrag.id === row.tab.id,
              'group-drop-active': browserDrag?.destination?.id === row.tab.id && !browserDrag.reattach,
              'attach-before': browserDrag?.reattach && browserDrag.destination?.id === row.tab.id && !browserDrag.destination.after,
              'attach-after': browserDrag?.reattach && browserDrag.destination?.id === row.tab.id && browserDrag.destination.after,
            }"
            role="tab"
            :aria-selected="row.tab.id === state.active"
            tabindex="0"
            :data-tip="row.tab.pinned ? `${label(row.tab)} · Double-click to return` : label(row.tab)"
            :data-drag-tab="row.tab.id"
            @click="tabClick($event, row.tab)"
            @dblclick="resetPin(row.tab)"
            @keydown.enter.self.prevent="selectTab(row.tab.id)"
            @keydown.space.self.prevent="selectTab(row.tab.id)"
            @pointerdown="tabMiddleDown($event); beginBrowserDrag($event, 'tab', row.tab.id)"
            @mousedown="tabMiddleDown"
            @auxclick.prevent="$event.button === 1 && closeTabSliding(row.tab.id)"
            @contextmenu="tabMenu($event, row.tab)"
          >
            <span class="tab-load-shell"><span class="tab-favicon" :class="{ 'tab-site-loading': loading[row.tab.id] }" :style="faviconStyle(row.tab.url)">
              <Icon v-if="!row.tab.url" name="box" :size="14" />
              <template v-else>{{ glyph(row.tab) }}</template>
            </span><svg v-if="loading[row.tab.id]" class="tab-load-ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="load-track" cx="9" cy="9" r="7.5" /><path class="load-arc" d="M9 1.5a7.5 7.5 0 0 1 7.5 7.5" /></svg></span>
            <span class="tab-text">{{ label(row.tab) }}</span>
            <span v-if="sourceCount(row.tab)" class="tab-source-count" aria-label="Source passages"><Icon name="edit" :size="10" />{{ sourceCount(row.tab) }}</span>
            <span v-if="pageDialogs[row.tab.id]" class="tab-asks" aria-label="Page is waiting for you" data-tip="Page is waiting for you"></span>
            <span v-if="aiAccess[row.tab.id]" class="tab-ai-mark" :class="aiAccess[row.tab.id]"
              :aria-label="aiAccess[row.tab.id] === 'controlled' ? 'AI is using this tab' : 'AI may use this tab'"
              :data-tip="aiAccess[row.tab.id] === 'controlled' ? 'AI is using this tab' : 'AI may use this tab'"></span>
            <button v-if="row.tab.peek" type="button" class="tab-peek-indicator"
              aria-label="Close preview" :data-tip="`Close preview · ${label(row.tab.peek)}`"
              @click.stop="closePeek(row.tab.id)">
              <Icon name="eye" :size="12" />
            </button>
            <Icon
              v-if="playing[row.tab.id]"
              class="browser-tab-sound"
              name="sound"
              :size="12"
            />
            <Icon v-if="row.tab.rootUrl" name="lock" :size="12" aria-label="Locked tab" />
            <button v-else
              class="browser-tab-close"
              :aria-label="`Close ${label(row.tab)}`"
              @click.stop="closeTabSliding(row.tab.id)"
            >
              <Icon name="close" :size="12" />
            </button>
          </div>
        </template>
      </TransitionGroup>
      <div v-if="miniTab" class="browser-mini" aria-label="Playing in another tab">
        <button
          type="button"
          class="browser-mini-title"
          :data-tip="`Go to ${label(miniTab)}`"
          @click="goToTab(miniTab)"
        >
          <Icon name="play" :size="12" /><span>{{ label(miniTab) }}</span>
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="muted[miniTab.id] ? 'Unmute' : 'Mute'"
          :aria-pressed="!!muted[miniTab.id]"
          :data-tip="muted[miniTab.id] ? 'Unmute' : 'Mute'"
          @click="toggleMute(miniTab)"
        >
          <Icon :name="muted[miniTab.id] ? 'mute' : 'sound'" :size="13" />
        </button>
      </div>
      <div class="browser-foot">
        <button
          type="button"
          class="foot-link"
          aria-label="Library"
          data-tip="Bookmarks and history"
          data-key="Ctrl B"
          @click="openDrawer('library')"
          data-browser-drawer-toggle
        >
          <Icon name="library" :size="15" /><span>Library</span>
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="Preferences"
          data-tip="Preferences"
          @click="openDrawer('preferences')"
          data-browser-drawer-toggle
        >
          <Icon name="settings" :size="15" />
        </button>
        <button v-if="state.layout === 'performance'" type="button" class="icon-button"
          aria-label="Browser menu" :aria-expanded="menu?.title === 'Browser'" data-tip="Browser menu" @click="moreMenu">
          <Icon name="more" :size="15" />
        </button>
      </div>
      <div
        class="side-grip"
        @pointerdown.prevent="gripDown"
        @pointermove="gripMove"
        @pointerup="gripUp"
        @pointercancel="gripUp"
      ></div>
    </aside>
    <div v-if="processing" ref="processingGroup" class="processing-group">
      <button class="processing-toggle" :aria-expanded="processingOpen" @click="processingOpen = !processingOpen">Processing tabs <span>{{ processingTabs.length }}</span></button>
      <button class="processing-add" :disabled="!activeTab.url" @click="createProcessing">Use current tab</button>
      <div v-if="processingOpen" class="processing-list">
        <p v-if="!processingTabs.length">No processing tabs yet. Use the current tab to create one.</p>
        <div v-for="tab in processingTabs" :key="tab.id" class="processing-row">
          <span class="processing-name">{{ tab.label }}<small v-if="tab.temporary"> · Temporary</small></span>
          <span>{{ tab.busy ? "Busy" : tab.status }}</span>
          <template v-if="!tab.temporary">
            <button :disabled="tab.busy" @click="processingAction('refresh', tab.id)">Refresh</button>
            <button :disabled="tab.busy" @click="processingAction('close', tab.id)">Close</button>
          </template>
        </div>
      </div>
      <p v-if="processingError" role="alert">{{ processingError }}</p>
    </div>
    <form
      class="browser-bar"
      @submit.prevent="
        go();
        barOpen = false;
      "
      @focusout="
        !($event.currentTarget as HTMLElement).contains(
          $event.relatedTarget as Node | null,
        ) && (barOpen = false)
      "
    >
      <button
        type="button"
        class="icon-button"
        aria-label="Back"
        data-tip="Back"
        data-key="Alt ←"
        :disabled="!nav.back"
        @click="step(-1)"
      >
        <Icon name="back" :size="15" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Forward"
        data-tip="Forward"
        data-key="Alt →"
        :disabled="!nav.forward"
        @click="step(1)"
      >
        <Icon name="forward" :size="15" />
      </button>
      <button
        type="button"
        class="icon-button browser-load-button"
        :aria-label="activeLoading ? 'Stop loading' : 'Reload'"
        :data-tip="activeLoading ? 'Stop loading' : 'Reload'"
        :disabled="!activeTab.url"
        @click="reloadOrStop"
      >
        <svg v-if="activeLoading" class="toolbar-load-ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="load-track" cx="9" cy="9" r="7.5" /><path class="load-arc" d="M9 1.5a7.5 7.5 0 0 1 7.5 7.5" /></svg>
        <Icon :name="activeLoading ? 'close' : 'refresh'" :size="activeLoading ? 10 : 14" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Start page"
        data-tip="Start page"
        :disabled="!activeTab.url"
        @click="goHome"
      >
        <Icon name="home" :size="15" />
      </button>
      <div class="address-shell">
        <Icon :name="activeTab.url.startsWith('https:') ? 'lock' : activeTab.url ? 'globe' : 'search'" :size="14" />
        <input
          ref="addressInput"
          v-model="address"
          class="browser-address"
          aria-label="Address"
          placeholder="Search or enter address"
          spellcheck="false"
          autocomplete="off"
          @focus="($event.target as HTMLInputElement).select()"
          @keydown.esc="address = activeTab.url"
          @keydown.shift.enter.prevent="peekAddress"
        />
        <button
          type="button"
          class="icon-button browser-star"
          :class="{ on: bookmarked }"
          :aria-label="bookmarked ? 'Remove bookmark' : 'Bookmark this page'"
          :aria-pressed="!!bookmarked"
          :data-tip="bookmarked ? 'Remove bookmark' : 'Bookmark this page'"
          :disabled="!activeTab.url"
          @click="toggleBookmark"
        >
          <Icon name="star" :size="14" />
        </button>
      </div>
      <button v-if="useWebview" type="button" class="icon-button browser-source-button"
        aria-label="Sources" :data-tip="activeSources ? 'Source passages' : 'No source highlights in this tab'"
        :class="{ on: activeSources && sourceOpen[activeTab.id] }" :disabled="!activeSources"
        @click="sourceOpen[activeTab.id] = !sourceOpen[activeTab.id]">
        <Icon name="edit" :size="15" /><span v-if="activeSources" class="browser-source-count">{{ activeSources.passages.length }}</span>
      </button>
      <button
        v-if="passwords"
        type="button"
        class="icon-button"
        :class="{ on: showPasswords }"
        aria-label="Saved passwords"
        data-tip="Saved passwords"
        data-passwords-toggle
        :aria-pressed="showPasswords"
        @click="showPasswords = !showPasswords"
      >
        <Icon name="key" :size="14" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Open in your browser"
        data-tip="Open in your browser"
        :disabled="!activeTab.url"
        @click="openExternal"
      >
        <Icon name="external" :size="14" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Peek a link"
        data-tip="Peek a link"
        :disabled="state.layout === 'comfortable' || !state.peekEnabled"
        @click="openPeekPrompt"
      >
        <Icon name="eye" :size="15" />
      </button>
      <button
        type="button"
        class="icon-button"
        :class="{ on: !!state.split }"
        aria-label="Toggle Split View"
        :data-tip="state.split ? 'Exit Split View' : 'Enter Split View'"
        :aria-pressed="!!state.split"
        @click="toggleSplit"
      >
        <Icon name="columns" :size="15" />
      </button>
      <span class="browser-bar-divider" aria-hidden="true"></span>
      <button type="button" class="icon-button" aria-label="Command palette"
        data-tip="Command palette" data-key="Ctrl K" @click="shortcut('search')">
        <Icon name="search" :size="15" />
      </button>
      <button v-if="state.layout !== 'performance'" type="button" class="icon-button" aria-label="Browser menu"
        :aria-expanded="menu?.title === 'Browser'"
        data-tip="Browser menu" @click="moreMenu">
        <Icon name="more" :size="15" />
      </button>
    </form>
    <div v-if="showNetSuiteEnvironment" class="browser-netsuite-bar">
      <button
        ref="netSuiteEnvironmentButton"
        type="button"
        class="browser-netsuite-switch"
        aria-label="Switch NetSuite environment"
        aria-haspopup="menu"
        :aria-expanded="menu?.title === 'NetSuite environments'"
        @click="openNetSuiteEnvironments"
      >
        <Icon name="swap" :size="14" />
        <span class="browser-netsuite-label">NetSuite environment</span>
        <span v-if="currentNetSuiteAccount" class="browser-netsuite-account">{{ currentNetSuiteAccount }}</span>
        <Icon name="down" :size="12" />
      </button>
    </div>
    <p v-if="error" class="browser-error" role="alert">{{ error }}</p>
    <div
      v-if="prompt"
      class="browser-password-prompt"
      role="dialog"
      aria-label="Save password"
      @keydown.stop
    >
      <Icon name="key" :size="13" />
      <p>
        {{ prompt.update ? "Update the saved password" : "Save password" }} for
        <strong>{{ prompt.username || "this login" }}</strong> on
        <strong>{{ siteName(prompt.origin) }}</strong>?
      </p>
      <button type="button" class="primary" @click="decide('save')">
        {{ prompt.update ? "Update" : "Save" }}
      </button>
      <button v-if="!prompt.update" type="button" @click="decide('never')">Never</button>
      <button
        type="button"
        class="icon-button"
        aria-label="Not now"
        @click="dismissPrompt(state.active)"
      >
        <Icon name="close" :size="12" />
      </button>
    </div>
    <div
      v-if="autoLogin && !prompt"
      class="browser-password-prompt browser-auto-login"
      :class="{ warn: autoLogin.kind !== 'challenge' }"
      role="status"
      aria-label="NetSuite sign-in"
      @keydown.stop
    >
      <Icon :name="autoLogin.kind === 'challenge' ? 'key' : 'alert'" :size="13" />
      <p>{{ autoLoginText[autoLogin.kind] }}</p>
      <button
        type="button"
        class="icon-button"
        aria-label="Dismiss"
        @click="delete autoLogins[state.active]"
      >
        <Icon name="close" :size="12" />
      </button>
    </div>
    <div
      ref="pageBox"
      class="browser-page"
      :class="{ split: !!state.split, stacked: state.stacked }"
    >
      <PasswordsPanel
        v-if="passwords && showPasswords"
        :api="passwords"
        :origin="activeOrigin"
        :revision="passwordsRevision"
        @close="showPasswords = false"
      />
      <template v-if="useWebview">
        <template v-for="tab in pages" :key="tab.id">
          <button
            v-if="discarded[tab.id]"
            v-show="isShown(tab.id)"
            type="button"
            class="browser-discarded"
            :class="paneClass(tab.id)"
            :aria-label="`Reload ${label(tab)}`"
            @click="restoreTab(tab.id)"
          >
            <img v-if="discarded[tab.id]!.image" :src="discarded[tab.id]!.image" alt="" />
            <span>Click to reload</span>
          </button>
          <webview
            v-else-if="started[tab.id]"
            :ref="(element: unknown) => bindWebview(tab, element)"
            class="browser-webview"
            :class="[paneClass(tab.id), { 'browser-asleep': asleep[tab.id] }]"
            :src="started[tab.id]"
            :partition="desktop!.partition"
            allowpopups
          ></webview>
        </template>
      </template>
      <template v-else>
        <iframe
          v-for="tab in frameTabs"
          :key="frameKey(tab)"
          :ref="(element: unknown) => bindFrame(tab.id, element)"
          class="browser-frame"
          :class="paneClass(tab.id)"
          :src="tab.url"
          :title="`Web page: ${label(tab)}`"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          referrerpolicy="strict-origin-when-cross-origin"
          allow=""
        ></iframe>
        <iframe
          v-if="peek"
          :key="`peek:${peek.id}`"
          class="browser-peeking"
          :src="peek.url"
          :title="`Peek: ${label(peek)}`"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          referrerpolicy="strict-origin-when-cross-origin"
          allow=""
        ></iframe>
      </template>
      <div v-if="activeFind" class="browser-find" role="search" aria-label="Find in page" @keydown.stop>
        <Icon name="search" :size="14" />
        <input
          ref="findInput"
          v-model="activeFind.text"
          aria-label="Find in page"
          spellcheck="false"
          autocomplete="off"
          @input="runFind()"
          @keydown="findKey"
        />
        <span class="browser-find-count" aria-live="polite">{{
          activeFind.text ? (activeFind.matches ? `${activeFind.current} of ${activeFind.matches}` : "No matches") : ""
        }}</span>
        <span class="browser-find-sep" aria-hidden="true"></span>
        <button type="button" aria-label="Previous match" data-tip="Previous · Shift Enter" :disabled="!activeFind.matches" @click="runFind(false, true)">
          <Icon name="up" :size="13" />
        </button>
        <button type="button" aria-label="Next match" data-tip="Next · Enter" :disabled="!activeFind.matches" @click="runFind(true, true)">
          <Icon name="down" :size="13" />
        </button>
        <button type="button" aria-label="Close find" data-tip="Close · Esc" @click="closeFind">
          <Icon name="close" :size="12" />
        </button>
      </div>
      <template v-for="(dialog, tabId) in pageDialogs" :key="dialog.id">
        <div
          v-show="isShown(String(tabId))"
          class="browser-page-dialog"
          :class="paneClass(String(tabId))"
          @pointerdown.self.prevent
        >
          <div
            :ref="(element) => element ? pageDialogBox.set(String(tabId), element as HTMLElement) : pageDialogBox.delete(String(tabId))"
            class="page-dialog-card"
            role="alertdialog"
            aria-modal="true"
            :aria-label="`${dialog.origin || 'This page'} asks`"
            @keydown.stop
            @keydown.esc.prevent="answerPageDialog(String(tabId), false)"
          >
            <p class="page-dialog-who"><b>{{ dialog.origin || "This page" }}</b> asks</p>
            <p class="page-dialog-message">{{ dialog.message }}</p>
            <input
              v-if="dialog.kind === 'prompt'"
              v-model="dialog.input"
              class="page-dialog-input"
              aria-label="Answer"
              spellcheck="false"
              @keydown.enter.prevent="answerPageDialog(String(tabId), true)"
            />
            <div class="page-dialog-actions">
              <span class="page-dialog-keys"><kbd>Enter</kbd><span>OK</span><template v-if="dialog.kind !== 'alert'"><kbd>Esc</kbd><span>Cancel</span></template></span>
              <button v-if="dialog.kind !== 'alert'" type="button" @click="answerPageDialog(String(tabId), false)">Cancel</button>
              <button type="button" class="primary" @click="answerPageDialog(String(tabId), true)">OK</button>
            </div>
          </div>
        </div>
      </template>
      <div
        v-for="tab in blankPanes"
        :key="`start-${tab.id}`"
        class="browser-start"
        :class="paneClass(tab.id)"
        @pointerdown="tab.id !== state.active && selectTab(tab.id)"
      >
        <div class="start-wrap">
          <span class="start-symbol"><Icon name="box" :size="24" /></span>
          <h2 class="start-heading">A quieter place to browse.</h2>
          <p class="start-sub">Your space for everything on the web.</p>
          <form
            class="start-search"
            @submit.prevent="startGo(tab, startText[tab.id] || '')"
            @keydown.stop
          >
            <Icon name="search" :size="16" />
            <input
              v-model="startText[tab.id]"
              aria-label="Search the web"
              placeholder="Search or enter a URL"
              spellcheck="false"
              autocomplete="off"
            />
            <kbd>↵</kbd>
          </form>
          <template v-if="quick.length">
            <div class="quick-title">
              <span>Quick access</span><small>Shift-click to Peek</small>
            </div>
            <div class="quick-sites">
              <button
                v-for="bookmark in quick"
                :key="bookmark.url"
                type="button"
                class="quick-site"
                :data-tip="`Shift-click to preview ${bookmark.title}`"
                @pointerdown="tabMiddleDown"
                @mousedown="tabMiddleDown"
                @contextmenu="linkMenu($event, bookmark.url)"
                @click="openQuick($event, tab, bookmark.url)"
              >
                <span class="site-mark">{{
                  (bookmark.title || bookmark.url).slice(0, 1).toUpperCase()
                }}</span>
                <span>{{ bookmark.title || bookmark.url }}</span>
              </button>
            </div>
          </template>
          <small class="start-foot">⌘ / Ctrl K for commands · Shift-click a shortcut to Peek</small>
        </div>
      </div>
      <BrowserSourcesWidget v-if="activeSources && !showPasswords && !pageDialogs[activeTab.id]" :key="activeTab.id"
        :sources="activeSources" :open="!!sourceOpen[activeTab.id]" :checking="!!sourceChecking[activeTab.id]"
        :problem="sourceErrors[activeTab.id]" @update:open="sourceOpen[activeTab.id] = $event" @jump="jumpSource" @clear="clearSources" />
      <template v-for="tab in visiblePanes" :key="`shield-${tab.id}`">
        <div
          v-if="tab.url && (editing || (!useWebview && (!interacting || tab.id !== state.active)))"
          class="browser-shield"
          :class="paneClass(tab.id)"
          :aria-label="editing ? undefined : 'Click to use this page'"
          @pointerdown="shieldDown($event, tab.id)"
          @mousedown.prevent
        ></div>
      </template>
      <template v-for="tab in visiblePanes" :key="`ai-${tab.id}`">
        <Transition name="ai-lock">
          <div
            v-if="useWebview && aiLocked(tab.id)"
            class="browser-ai-lock"
            :class="paneClass(tab.id)"
            role="status"
            @pointerdown.self.prevent
            @contextmenu.self.prevent
          >
            <div class="ai-lock-bar">
              <span class="ai-lock-dot"></span>
              <span>AI is using this tab</span>
              <button type="button" class="ai-lock-take" @click="takeControl(tab.id)">Take control</button>
            </div>
          </div>
        </Transition>
      </template>
      <!-- A test run in this tab (Test runs app or flow_tests): REC and the step trail. -->
      <template v-for="tab in visiblePanes" :key="`test-${tab.id}`">
        <div v-if="testRunOf(tab.id)" class="browser-test-run" :class="paneClass(tab.id)">
          <span v-if="testRunOf(tab.id)!.status === 'running' && testRunOf(tab.id)!.recording" class="test-rec" role="status">
            <i></i>REC <time>{{ testClock(testRunOf(tab.id)!.startedAt) }}</time>
          </span>
          <div class="test-trail" role="status" :aria-label="`Test run: ${testFlowOf(tab.id)?.name ?? ''}`">
            <div class="test-trail-head">
              <strong>{{ testFlowOf(tab.id)?.name ?? "Test run" }}</strong>
              <span>{{ testRunOf(tab.id)!.status === "done" ? "finished" : `test ${testIndexOf(tab.id)} of ${testRunOf(tab.id)!.flows.length}` }}</span>
            </div>
            <div
              v-for="s in (testFlowOf(tab.id)?.steps ?? []).slice(-6)"
              :key="s.step"
              class="test-step"
              :class="s.ok === undefined ? 'now' : s.ok ? 'done' : 'bad'"
            >
              <svg v-if="s.ok" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg>
              <svg v-else-if="s.ok === false" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>
              <span v-else class="test-now"></span>
              <span>{{ s.label }}</span>
            </div>
          </div>
        </div>
      </template>
      <div
        v-if="splitPair"
        class="split-chrome"
        role="toolbar"
        aria-label="Split View"
      >
        <div
          v-for="(tab, pane) in splitPair"
          :key="tab.id"
          class="pane-caption"
          :class="[pane ? 'second' : 'first', { current: tab.id === state.active }]"
          @click="focusPane(tab.id)"
        >
          <span class="tab-load-shell"><span class="tab-favicon" :class="{ 'tab-site-loading': loading[tab.id] }" :style="faviconStyle(tab.url)">
            <Icon v-if="!tab.url" name="box" :size="12" />
            <template v-else>{{ glyph(tab) }}</template>
          </span><svg v-if="loading[tab.id]" class="tab-load-ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="load-track" cx="9" cy="9" r="7.5" /><path class="load-arc" d="M9 1.5a7.5 7.5 0 0 1 7.5 7.5" /></svg></span>
          <span class="caption-name">{{ label(tab) }}</span>
          <span v-if="tab.id === state.active" class="pane-active-label">Active pane</span>
          <button
            type="button"
            aria-label="Focus pane"
            :aria-pressed="tab.id === state.active"
            data-tip="Focus pane"
            @click.stop="focusPane(tab.id)"
          >
            <Icon name="resize" :size="12" />
          </button>
          <button
            type="button"
            aria-label="Close Split View"
            data-tip="Close Split View"
            @click.stop="closeSplit"
          >
            <Icon name="close" :size="12" />
          </button>
        </div>
        <div
          class="pane-divider"
          role="separator"
          tabindex="0"
          aria-label="Split View divider"
          :aria-orientation="state.stacked ? 'horizontal' : 'vertical'"
          :aria-valuenow="state.ratio"
          :aria-valuemin="25"
          :aria-valuemax="75"
          data-tip="Drag to resize"
          @keydown="divideKey"
          @pointerdown="divideDown"
          @pointermove="divideMove"
          @pointerup="divideUp"
          @pointercancel="divideUp"
        ></div>
      </div>
      <template v-if="peek">
        <div class="browser-peek-backdrop" @click="closePeek()"></div>
        <div class="peek-address">
          <Icon name="globe" :size="12" /><span>{{ peek.url }}</span>
        </div>
        <div class="peek-rail" role="toolbar" aria-label="Peek View">
          <button
            type="button"
            aria-label="Close Peek"
            data-tip="Close"
            data-key="Esc"
            @click="closePeek()"
          >
            <Icon name="close" :size="15" />
          </button>
          <span class="peek-rail-line"></span>
          <button
            type="button"
            aria-label="Open as tab"
            data-tip="Open as tab"
            data-key="Ctrl O"
            @click="keepPeek(false)"
          >
            <Icon name="external" :size="15" />
          </button>
          <button
            type="button"
            aria-label="Open as Split"
            data-tip="Open as Split View"
            @click="keepPeek(true)"
          >
            <Icon name="columns" :size="15" />
          </button>
        </div>
      </template>
      <div v-if="!useWebview && activeTab.url && !peek && !embedHintDismissed"
        class="browser-embed-hint"
        :class="{ 'hint-first': splitPair?.[0].id === activeTab.id, 'hint-second': splitPair?.[1].id === activeTab.id }">
        <Icon name="info" :size="14" />
        <span>Some websites block embedded browsing.</span>
        <button type="button" @click="openExternal">Open site <Icon name="external" :size="12" /></button>
        <button type="button" aria-label="Dismiss embedded browsing hint" @click="embedHintDismissed = true">
          <Icon name="close" :size="13" />
        </button>
      </div>
      <div v-if="browserDrag?.moving && browserDrag.kind === 'tab'" class="browser-split-drag-shield" aria-hidden="true"></div>
      <Transition name="browser-split-target">
        <div v-if="browserDrag?.split" class="browser-split-target" aria-hidden="true">
          <div class="split-drop-zone" :class="{ 'drop-selected': browserDrag.split === 'primary' }">
            <Icon name="layers" :size="15" />{{ state.stacked ? "Split Top" : "Split Left" }}
          </div>
          <div class="split-drop-zone" :class="{ 'drop-selected': browserDrag.split === 'secondary' }">
            <Icon name="layers" :size="15" />{{ state.stacked ? "Split Bottom" : "Split Right" }}
          </div>
        </div>
      </Transition>
      <div
        v-if="cropArming"
        class="browser-crop"
        :style="cropSurface"
        aria-label="Drag to choose the area to capture"
        @pointerdown.prevent="cropDown"
        @pointermove="cropMove"
        @pointerup="cropUp"
        @pointercancel="cropUp"
      >
        <div v-if="cropBox" class="browser-crop-box" :style="cropBox"></div>
      </div>
    </div>
    <Teleport to="body" :disabled="!browserDrag?.detached">
      <div v-if="browserDrag?.moving" ref="dragPreview" class="browser-drag-preview" aria-hidden="true"
      :class="{ 'space-preview': browserDrag.kind === 'space', detached: browserDrag.detached }"
      :style="{ width: browserDrag.width + 'px', height: browserDrag.height + 'px', '--space': draggedSpace?.color }">
      <template v-if="draggedTab">
        <span class="tab-favicon" :style="faviconStyle(draggedTab.url)">
          <Icon v-if="!draggedTab.url" name="box" :size="14" />
          <template v-else>{{ glyph(draggedTab) }}</template>
        </span>
        <span class="tab-text">{{ label(draggedTab) }}</span>
      </template>
      <template v-else-if="draggedSpace">
        {{ draggedSpace.icon || draggedSpace.name.slice(0, 1).toUpperCase() }}
      </template>
      </div>
    </Teleport>
    <div
      v-if="menu"
      ref="menuBox"
      class="browser-menu"
      role="menu"
      :aria-label="menu.title || undefined"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @keydown="menuKeys"
    >
      <div v-if="menu.title" class="browser-menu-label" aria-hidden="true">{{ menu.title }}</div>
      <template v-for="(item, index) in menu.items" :key="index">
        <hr v-if="!item.label" />
        <button
          v-else
          type="button"
          :role="item.checked === undefined ? 'menuitem' : 'menuitemradio'"
          :aria-checked="item.checked"
          :aria-haspopup="item.children ? 'menu' : undefined"
          :class="{ chosen: item.checked, danger: item.danger }"
          :disabled="item.disabled"
          @click="pick(item)"
        >
          <span v-if="item.initial" class="menu-initial">{{ item.initial }}</span>
          <Icon v-else-if="item.icon" :name="item.icon" :size="15" />
          <span>{{ item.label }}</span>
          <Icon v-if="item.checked" name="check" :size="13" />
          <Icon v-if="item.children" name="right" :size="13" />
          <kbd v-if="item.hint">{{ item.hint }}</kbd>
        </button>
      </template>
    </div>
    <div v-if="dialog" class="browser-scrim" @pointerdown.self="dismissDialog">
      <form class="browser-switcher browser-dialog"
        :role="dialog.message ? 'alertdialog' : 'dialog'"
        aria-modal="true" :aria-label="dialog.title"
        @keydown.tab="modalTab" @submit.prevent="submitDialog">
        <header>
          <h2>{{ dialog.title }}</h2>
          <button type="button" class="icon-button" aria-label="Close dialog" @click="dismissDialog">
            <Icon name="close" :size="16" />
          </button>
        </header>
        <div class="browser-dialog-body">
          <label v-if="dialog.label">
            <span>{{ dialog.label }}</span>
            <input ref="dialogInput" v-model="dialog.value" required maxlength="64"
              spellcheck="false" autocomplete="off" :placeholder="dialog.placeholder" />
          </label>
          <p v-else>{{ dialog.message }}</p>
          <footer>
            <button ref="dialogCancel" type="button" @click="dismissDialog">Cancel</button>
            <button type="submit" :class="{ danger: dialog.message }">{{ dialog.action }}</button>
          </footer>
        </div>
      </form>
    </div>
    <div v-if="switcher" class="browser-scrim" :class="{ quiet: switcher.mode === 'recent' }"
      @pointerdown.self="switcher = null">
      <div class="browser-switcher" role="dialog"
        :aria-modal="switcher.mode === 'search' || undefined"
        :aria-label="switcher.mode === 'search' ? 'Search tabs' : 'Recent tabs'"
        @keydown.tab="switcher.mode === 'search' && modalTab($event)">
        <div v-if="switcher.mode === 'search'" class="command-input-row">
          <Icon name="search" :size="16" />
          <input ref="switcherInput" v-model="switcher.query"
            aria-label="Search open tabs and bookmarks"
            placeholder="Search tabs, commands or enter a URL"
            role="combobox" aria-expanded="true" :aria-controls="commandId"
            :aria-activedescendant="switcherItems.length ? commandId + '-' + switcher.index : undefined"
            spellcheck="false" autocomplete="off" @input="searchChanged"
            @keydown.down.prevent="moveSwitcher(1)" @keydown.up.prevent="moveSwitcher(-1)"
            @keydown.enter.prevent="commitSwitcher()" />
          <kbd>ESC</kbd>
        </div>
        <div class="command-list-shell">
          <div :id="commandId" ref="commandList" class="command-results" role="listbox"
            aria-label="Browser results" @scroll.passive="updateCommandScroll">
            <button v-for="(item, index) in switcherItems" :id="commandId + '-' + index"
              :key="item.key" type="button" class="command-row" role="option"
              tabindex="-1" :aria-selected="index === switcher.index"
              :class="{ current: index === switcher.index }"
              @pointerdown.prevent @click="commitSwitcher(index)">
              <Icon :name="item.icon" :size="15" />
              <span>{{ item.title }}</span>
              <small>{{ item.detail }}</small>
            </button>
            <p v-if="!switcherItems.length">Nothing matches.</p>
          </div>
          <div v-if="switcher.mode === 'search' && commandScroll.height"
            ref="commandTrack" class="command-scroll-track" aria-hidden="true"
            @pointerdown="commandDrag" @pointermove="commandDragMove">
            <span :style="{ height: commandScroll.height + 'px', top: commandScroll.top + 'px' }"></span>
          </div>
        </div>
      </div>
    </div>
    <p v-if="notice" class="browser-notice" role="status">{{ notice }}</p>
    <BrowserDrawer
      :mode="drawer"
      :bookmarks="spaceBookmarks"
      :history="state.recentPages"
      :open-folders="openFolders"
      :current-url="activeTab.url"
      :theme="state.theme"
      :collapsed="state.collapsed"
      :layout="state.layout"
      :sidebar-position="state.sidebarPosition"
      :peek-enabled="state.peekEnabled"
      :peek-cross-site="state.peekCrossSite"
      :search-engine="state.searchEngine"
      :pip="state.pip"
      @close="closeDrawer()"
      @visit="visitLibrary"
      @menu="(event, entry, bookmark) => linkMenu(event, entry.url, bookmark)"
      @remove="(bookmark) => removeBookmark(bookmark.id)"
      @toggle-folder="toggleBookmarkFolder"
      @export="exportBrowserSession"
      @import="importBrowserSession"
      @update:theme="state.theme = $event; save()"
      @update:collapsed="state.collapsed = $event; save()"
      @update:layout="setLayout"
      @update:sidebar-position="setSidebarPosition"
      @update:peek-enabled="setPeekPreference"
      @update:peek-cross-site="state.peekCrossSite = $event; save()"
      @update:search-engine="state.searchEngine = $event; save()"
      @update:pip="state.pip = $event; save()"
    />
    <section
      v-if="inspect && useWebview"
      class="browser-devtools"
      aria-label="Developer tools"
      :style="{ height: devtoolsHeight + 'px' }"
    >
      <div
        class="devtools-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize developer tools"
        @pointerdown="startDevtoolsResize"
      ></div>
      <header class="devtools-bar">
        <span>Developer tools</span>
        <button
          type="button"
          class="icon-button"
          aria-label="Close developer tools"
          data-tip="Close developer tools"
          @click="closeInspect"
        >
          <Icon name="close" :size="13" />
        </button>
      </header>
      <webview
        :key="inspect.key"
        :ref="bindDevtools"
        class="devtools-view"
        partition="orvane-devtools"
        :src="desktop!.devtoolsSrc"
      ></webview>
    </section>
    <div
      v-if="tip"
      ref="tipBox"
      class="browser-tip"
      role="tooltip"
      :style="{ left: tip.x + 'px', top: tip.y + 'px' }"
    >
      <span>{{ tip.text }}</span><kbd v-if="tip.meta && tip.shortcut">{{ tip.meta }}</kbd>
      <small v-else-if="tip.meta">{{ tip.meta }}</small>
    </div>
  </div>
</template>

<style>
.app-content:has(> .block-browser:only-child) {
  padding: 0;
  overflow: hidden;
}
.app-content > .block-browser {
  flex: 1;
  min-height: 260px;
}
.block-browser:not(:only-child) {
  height: 520px;
}
</style>

<style scoped>
.browser-view {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--surface-text, #455968);
  background: var(--surface);
  overflow: hidden;
}
.browser-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px 0;
  flex: none;
  min-width: 0;
  overflow: hidden;
}
.processing-group { position: relative; display: flex; align-items: center; gap: 8px; flex: none; padding: 3px 10px; background: var(--low); color: var(--sub); font-size: 11px; }
.processing-group button { border: 0; background: none; color: inherit; cursor: pointer; padding: 4px; }
.processing-group button:hover { color: var(--ink); }
.processing-group button:disabled { opacity: .5; cursor: default; }
.processing-toggle span { background: var(--selection); border-radius: 4px; padding: 1px 5px; margin-left: 4px; }
.processing-list { position: absolute; z-index: 20; top: 100%; left: 10px; min-width: 320px; max-width: min(520px, 90%); background: var(--surface); border: 1px solid var(--line); box-shadow: 0 8px 20px #425c6b24; padding: 8px; }
.processing-list p { margin: 8px; }
.processing-row { display: flex; align-items: center; gap: 8px; padding: 5px; }
.processing-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.browser-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 190px;
  flex: 0 1 190px;
  padding: 6px 6px 6px 10px;
  border-radius: 5px 5px 0 0;
  color: var(--sub);
  cursor: default;
  white-space: nowrap;
}
.browser-tab > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.browser-tab.active {
  background: var(--low);
  color: var(--ink);
}
.browser-tab:not(.active):hover {
  background: var(--hover);
}
.browser-tab-close {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: inherit;
  opacity: 0.6;
}
.browser-tab-close:hover {
  opacity: 1;
  background: var(--hover);
}
.browser-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: var(--low);
  flex: none;
}
.browser-address {
  flex: 1;
  min-width: 0;
  margin: 0 4px;
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  background: var(--surface, #f7f9fa);
  color: inherit;
  font-size: 12px;
}
.browser-password-prompt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 14px;
  background: color-mix(in srgb, #7a9a7e 9%, var(--surface));
  border-top: 1px solid var(--line);
  flex: none;
}
.browser-password-prompt p {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-password-prompt strong {
  font-weight: 600;
}
.browser-password-prompt > button:not(.icon-button) {
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface, #f7f9fa);
  color: inherit;
  font-size: 12px;
}
.browser-password-prompt > button.primary {
  border-color: #4f7a68;
  background: #4f7a68;
  color: #fff;
}
.browser-auto-login.warn {
  background: #f6eeec;
  color: #7d3f39;
}
.browser-star.on {
  color: #b5874a;
}
.browser-star.on :deep(svg) {
  fill: currentColor;
}
.browser-error {
  margin: 0;
  padding: 7px 14px;
  font-size: 11px;
  color: #9a4b45;
  background: #f7ecea;
  flex: none;
}
.browser-page {
  overflow: hidden;
  position: relative;
  flex: 1;
  min-height: 0;
  border-top: 1px solid var(--line);
  background: #fff;
}
.browser-webview {
  position: absolute;
  inset: 0;
  display: flex;
  width: 100%;
  height: 100%;
  /* In focus mode the page keeps the canvas zoom it was read at (App.vue). */
  zoom: var(--focus-page-zoom, 1);
}
.browser-webview.browser-asleep {
  pointer-events: none;
}
.browser-webview.browser-hidden {
  visibility: hidden;
  pointer-events: none;
}
.browser-discarded {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: var(--low);
  cursor: pointer;
  overflow: hidden;
}
.browser-discarded img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top left;
  filter: grayscale(0.35) opacity(0.75);
}
.browser-discarded span {
  position: relative;
  padding: 7px 14px;
  border-radius: 6px;
  background: #344d5be6;
  color: #fff;
  font-size: 12px;
}
.browser-discarded:hover span,
.browser-discarded:focus-visible span {
  background: #344d5b;
}
.browser-page iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.browser-shield {
  position: absolute;
  inset: 0;
  cursor: pointer;
}
/* AI control: a border around the page and a bar to take it back. The
   overlay takes every pointer event, so the user can't act in the page. */
.browser-ai-lock {
  position: absolute;
  inset: 0;
  z-index: 2;
  box-shadow: inset 0 0 0 2px var(--accent), inset 0 0 18px rgb(111 137 152 / 28%);
  cursor: not-allowed;
}
.ai-lock-bar {
  position: absolute;
  left: 50%;
  bottom: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 4px 0 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  font-size: 12px;
  white-space: nowrap;
  box-shadow: 0 8px 24px rgb(42 71 88 / 16%), 0 2px 6px rgb(42 71 88 / 8%);
  transform: translateX(-50%);
  cursor: default;
}
.ai-lock-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
.ai-lock-take {
  height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.ai-lock-take:hover,
.ai-lock-take:focus-visible {
  background: #5f7988;
}
/* A test run in the tab: REC pill top right, step trail on frost glass. */
.browser-test-run {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
}
.test-rec {
  position: absolute;
  top: 10px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 24px;
  padding: 0 9px 0 8px;
  border-radius: 7px;
  background: #f6e6e1;
  color: #7b3b2d;
  font-size: 11.5px;
  font-weight: 550;
  box-shadow: 0 4px 12px rgb(38 63 85 / 10%);
}
.test-rec i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c25b4a;
  animation: test-blink 1.6s ease-in-out infinite;
}
.test-rec time {
  font: 11px "Cascadia Code", Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
@keyframes test-blink {
  50% { opacity: 0.35; }
}
.test-trail {
  position: absolute;
  right: 14px;
  bottom: 14px;
  width: 290px;
  padding: 9px 12px;
  border-radius: 10px;
  background: rgb(247 250 252 / 80%);
  backdrop-filter: blur(10px) saturate(120%);
  border: 1px solid #ffffffa3;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
  font-size: 12px;
  color: #455968;
}
.test-trail-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.test-trail-head strong {
  overflow: hidden;
  color: #273f50;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.test-trail-head span {
  flex: none;
  color: #8296a2;
  font-size: 11.5px;
}
.test-step {
  display: grid;
  grid-template-columns: 14px 1fr;
  gap: 8px;
  align-items: center;
  height: 24px;
}
.test-step > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.test-step svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.test-step.done {
  color: #5d7381;
}
.test-step.done svg {
  stroke: #4f7d5f;
}
.test-step.bad {
  color: #a0624f;
}
.test-step.bad svg {
  stroke: #a0624f;
}
.test-step.now {
  color: #365f78;
  font-weight: 550;
}
.test-now {
  width: 8px;
  height: 8px;
  margin-left: 2px;
  border-radius: 50%;
  background: #365f78;
  box-shadow: 0 0 0 3px #365f781a;
  animation: test-blink 1.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .test-rec i,
  .test-now {
    animation: none;
  }
}
.ai-lock-enter-active,
.ai-lock-leave-active {
  transition: opacity 0.16s var(--ease);
}
.ai-lock-enter-from,
.ai-lock-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .ai-lock-enter-active,
  .ai-lock-leave-active {
    transition: none;
  }
}
.browser-tab > .tab-ai-mark {
  flex: none;
  width: 7px;
  height: 7px;
  margin: 0 2px;
  border: 1.5px solid var(--accent);
  border-radius: 50%;
}
.tab-ai-mark.controlled {
  background: var(--accent);
}
.browser-tab > .tab-asks {
  flex: none;
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: #365f78;
}
/* Find in page: a small frosted bar at the top right of the page. */
.browser-find {
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 5px 0 10px;
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: rgb(247 250 252 / 86%);
  backdrop-filter: blur(8px) saturate(120%);
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
  color: #6f8998;
  animation: browser-find-in 0.14s ease-out;
}
@keyframes browser-find-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}
.browser-find input {
  width: 200px;
  height: 28px;
  padding: 0 6px;
  border: 0;
  background: none;
  color: #273f50;
  font: inherit;
  font-size: 13px;
  outline: none;
}
.browser-find-count {
  min-width: 56px;
  padding-right: 4px;
  color: #8296a2;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.browser-find-sep {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: #e3eaee;
}
.browser-find button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #5d7381;
}
.browser-find button:hover:not(:disabled) {
  background: #eef3f6;
  color: #273f50;
}
.browser-find button:disabled {
  opacity: 0.45;
}
.browser-find button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px #6f899840;
}
@media (prefers-reduced-motion: reduce) {
  .browser-find {
    animation: none;
  }
}
/* A page's alert/confirm/prompt: a card over that tab only, the page frosted. */
.browser-page-dialog {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: grid;
  place-items: center;
  padding: 16px;
  background: #e9edf0a6;
  backdrop-filter: blur(1.5px) saturate(90%);
}
.page-dialog-card {
  width: min(360px, 100%);
  margin-bottom: 12%;
  padding: 16px 18px;
  border: 1px solid #d3dee5;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
  color: #455968;
  font-size: 13px;
  animation: page-dialog-in 0.16s ease-out;
}
@keyframes page-dialog-in {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
}
.page-dialog-who {
  margin: 0 0 8px;
  color: #8296a2;
  font-size: 11.5px;
}
.page-dialog-who b {
  color: #5d7381;
  font: 400 11.5px "Cascadia Code", Consolas, monospace;
}
.page-dialog-message {
  margin: 0;
  max-height: 40vh;
  overflow: auto;
  color: #273f50;
  font-size: 13.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.page-dialog-input {
  display: block;
  width: 100%;
  height: 30px;
  margin-top: 10px;
  padding: 0 9px;
  border: 1px solid #dbe5eb;
  border-radius: 7px;
  background: #fff;
  color: #273f50;
  font: inherit;
}
.page-dialog-input:focus {
  border-color: #7b97a7;
  outline: none;
}
.page-dialog-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.page-dialog-keys {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  color: #8296a2;
  font-size: 11.5px;
}
.page-dialog-keys kbd {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  color: #5d7381;
  font: 10.5px/1 "Cascadia Code", Consolas, monospace;
}
.page-dialog-keys kbd + span {
  margin-right: 6px;
}
.page-dialog-actions button {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 14px;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  color: #455968;
  font-size: 12.5px;
}
.page-dialog-actions button:hover {
  background: #eef3f6;
}
.page-dialog-actions button.primary {
  border-color: #365f78;
  background: #365f78;
  color: #fff;
}
.page-dialog-actions button.primary:hover {
  background: #2f5469;
}
.page-dialog-actions button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px #6f899840;
}
@media (prefers-reduced-motion: reduce) {
  .page-dialog-card {
    animation: none;
  }
}
.browser-tab.ai-controlled {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.browser-start {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: var(--sub);
  background: var(--surface);
}
.browser-start p {
  margin: 0;
  font-size: 13px;
  color: var(--ink);
}
.browser-start small {
  max-width: 320px;
  font-size: 11px;
  line-height: 1.5;
}
/* Layout: a grid whose rows are the same in every mode. With a sidebar the
   spaces, tabs and bookmarks sit in the first column; in the Chrome-like
   mode the sidebar dissolves (display: contents) and its parts take rows. */
.browser-view {
  --accent: #6e91a6;
  --surface: #f8fafb;
  --line: #d5e1e8;
  --side-bg: #eaf0f4;
  --low: #f1f5f7;
  --hover: #e1eaf0;
  --ink: #425b6c;
  --sub: #6c8594;
  --faint: #96aab6;
  --soft: rgb(121 151 170 / 17%);
  --selection: #d9e7ef;
  --scroll-thumb: rgb(108 143 164 / 35%);
  --floating: 0 22px 56px rgb(52 79 97 / 16%), 0 3px 10px rgb(52 79 97 / 8%);
  --ease: cubic-bezier(0.22, 0.75, 0.25, 1);
  --side: var(--side-wide);
  position: relative;
  display: grid;
  grid-template-columns: var(--side) minmax(0, 1fr);
  /* Row 9 holds docked DevTools (Inspect); empty, it takes no space. */
  grid-template-rows: auto auto auto auto auto auto auto minmax(0, 1fr) auto;
  color: var(--ink);
}
.browser-devtools {
  grid-row: 9;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--line);
  background: var(--surface);
}
.devtools-grip {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  z-index: 2;
  touch-action: none;
}
.devtools-grip:hover {
  background: linear-gradient(to bottom, transparent 2px, var(--accent) 2px 3px, transparent 3px);
}
.devtools-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 28px;
  padding: 0 4px 0 10px;
  border-bottom: 1px solid var(--line);
  font-size: 11px;
  color: var(--faint, #687d8a);
}
.devtools-view {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.browser-view.theme-dark {
  color-scheme: dark;
  --surface: #26343e;
  --line: #3a4e5c;
  --side-bg: #212e38;
  --low: #2d3c47;
  --hover: #344754;
  --ink: #e3edf3;
  --sub: #adc1ce;
  --faint: #8ca2b1;
  --soft: rgb(192 213 225 / 10%);
  --selection: #3a5262;
  --scroll-thumb: rgb(157 185 203 / 33%);
  --floating: 0 22px 56px rgb(0 0 0 / 40%);
}
.browser-view.side-collapsed {
  --side: 65px;
}
.browser-view > * {
  grid-column: 2;
  min-width: 0;
}
.browser-view .icon-button {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: var(--sub);
  transition:
    background 0.18s,
    color 0.18s,
    transform 0.18s;
}
.browser-view .icon-button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--ink);
}
.browser-view .icon-button:active:not(:disabled) {
  transform: scale(0.95);
}
.browser-view .icon-button.on {
  background: var(--selection);
  color: var(--ink);
}
.browser-side {
  position: relative;
  grid-column: 1;
  grid-row: 1 / -1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--side-bg);
  border-right: 1px solid var(--soft);
}
.side-grip {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 3;
  touch-action: none;
}
.side-grip:hover {
  background: linear-gradient(to right, transparent 2px, var(--accent) 2px 3px, transparent 3px);
}
.side-collapsed .side-grip {
  display: none;
}
.side-right:not(.layout-comfortable) {
  grid-template-columns: minmax(0, 1fr) var(--side);
}
.browser-view:where(.side-right:not(.layout-comfortable)) > * {
  grid-column: 1;
}
.side-right:not(.layout-comfortable) > .browser-side {
  grid-column: 2;
  border-right: 0;
  border-left: 1px solid var(--soft);
}
.side-right .side-grip {
  left: -3px;
  right: auto;
}
.processing-group {
  grid-row: 2;
}
.browser-bar {
  grid-row: 3;
}
.browser-netsuite-bar {
  grid-row: 4;
  display: flex;
  padding: 4px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.browser-netsuite-switch {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
  height: 29px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--low);
  color: var(--ink);
  font-size: 12px;
  cursor: pointer;
}
.browser-netsuite-switch:hover,
.browser-netsuite-switch[aria-expanded="true"] {
  background: var(--hover);
}
.browser-netsuite-label {
  font-weight: 600;
  white-space: nowrap;
}
.browser-netsuite-account {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-error {
  grid-row: 6;
}
.browser-password-prompt {
  grid-row: 7;
}
.browser-page {
  grid-row: 8;
  border-top: 0;
}

/* Sidebar head: the current space, then every space as a tile. */
.side-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 12px 10px 0 9px;
  flex: none;
}
.side-spacer {
  flex: 1;
}
.current-space {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 3px 6px 3px 3px;
  border-radius: 8px;
  text-align: left;
  color: var(--ink);
  background: none;
}
.current-space:hover {
  background: var(--hover);
}
.current-space :deep(svg) {
  color: var(--faint);
  flex: none;
}
.space-initial {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  flex: none;
  border-radius: 7px;
  color: var(--space);
  background: color-mix(in srgb, var(--space) 18%, var(--surface));
  font-weight: 690;
  font-size: 11px;
}
.space-label {
  font-size: 13.5px;
  font-weight: 630;
  letter-spacing: -0.32px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-spaces {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 33px;
  padding: 8px 12px 3px;
  flex: none;
  overflow-x: auto;
  scrollbar-width: none;
}
.browser-space {
  display: grid;
  place-items: center;
  width: 30px;
  height: 28px;
  flex: none;
  padding: 0;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 630;
  color: var(--faint);
  background: none;
  transition: background 0.2s;
}
.browser-space:hover {
  background: var(--hover);
}
.browser-space.active {
  color: var(--space);
  background: color-mix(in srgb, var(--space) 20%, var(--surface));
}
.browser-space-add {
  width: 27px;
  border: 1px dashed var(--line);
}
.browser-rename {
  flex: 1;
  min-width: 60px;
  width: 100%;
  padding: 3px 6px;
  border: 0;
  border-radius: 5px;
  background: #f8fafb;
  font-size: 11.5px;
  box-shadow: inset 0 -1.5px 0 var(--accent);
}
.browser-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 7px 10px;
  border: 1px solid var(--soft);
  border-radius: 7px;
  background: rgb(255 255 255 / 30%);
  color: var(--sub);
  font-size: 11.5px;
  text-align: left;
  white-space: nowrap;
  flex: none;
}
.browser-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Sections and rows */
.browser-view:not(.layout-comfortable) .browser-side .browser-tabs {
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 0 12px 10px;
  overflow: hidden auto;
  flex: 0 1 auto;
}
.side-title {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin-top: 12px;
  padding: 0 7px;
  color: var(--faint);
  font-size: 10px;
  font-weight: 620;
  letter-spacing: 0.35px;
  text-transform: uppercase;
  white-space: nowrap;
  flex: none;
}
.side-title-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.side-key {
  font-weight: 450;
  letter-spacing: -0.13px;
  opacity: 0.88;
}
.side-add {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  padding: 0;
  border-radius: 6px;
  color: var(--sub);
  background: none;
  flex: none;
}
.side-add:hover {
  background: var(--selection);
  color: var(--ink);
}
.side-add.new-group {
  width: 23px;
  height: 23px;
  opacity: 0.58;
}
.side-add.new-group:is(:hover, :focus-visible) {
  opacity: 1;
}
.browser-group-empty {
  flex: none;
  margin-left: 8px;
  padding: 7px 12px;
  border-left: 1px solid var(--soft);
  color: var(--faint);
  font-size: 10px;
}
.browser-view:not(.layout-comfortable) .browser-side .browser-tab,
.inline-split .browser-tab {
  position: relative;
  flex: none;
  max-width: none;
  height: 33px;
  margin: 2px 0;
  padding: 0 6px 0 10px;
  gap: 9px;
  border-radius: 7px;
  color: var(--sub);
  background: transparent;
  cursor: pointer;
  transition:
    background 0.16s,
    color 0.16s;
}
.browser-view:not(.layout-comfortable) .browser-side .browser-tab:hover {
  background: rgb(132 162 182 / 10%);
  color: var(--ink);
}
.browser-view:not(.layout-comfortable) .browser-side .browser-tab.active {
  background: var(--selection);
  color: var(--ink);
  font-weight: 570;
}
.browser-view:not(.layout-comfortable) .browser-side .browser-tab.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 10px;
  background: var(--accent);
}
.tab-favicon {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  color: #607f91;
  background: #dbe7ee;
}
.tab-load-shell { position: relative; display: inline-flex; width: 16px; height: 16px; flex: none; }
.tab-favicon.tab-site-loading { border-radius: 50%; transform: scale(0.72); }
.browser-load-button { position: relative; }
.browser-source-button { position: relative; }
.browser-source-count { position: absolute; right: 0; top: 0; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 7px; background: #365f78; color: white; font: 600 9px/13px "Inter Variable", Inter, sans-serif; }
.tab-source-count { display: inline-flex; align-items: center; gap: 3px; flex: none; color: #7897a4; font-size: 10px; font-variant-numeric: tabular-nums; }
.tab-load-ring, .toolbar-load-ring { position: absolute; fill: none; stroke-width: 1.5; stroke-linecap: round; pointer-events: none; animation: browser-load-turn 900ms linear infinite; }
.tab-load-ring { top: -1px; left: -1px; width: 18px; height: 18px; }
.toolbar-load-ring { top: 3px; left: 3px; width: 22px; height: 22px; }
.load-track { stroke: #6e91a638; }
.load-arc { stroke: #365f78; }
.browser-view:not(.browser-in-view) :is(.tab-load-ring, .toolbar-load-ring) { animation-play-state: paused; }
@keyframes browser-load-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tab-load-ring, .toolbar-load-ring { animation: none; } }
.tab-favicon:has(svg) {
  background: transparent;
  color: var(--accent);
}
.browser-tab.pinned .tab-favicon {
  color: #96763f;
  background: #efe5d2;
}
.browser-tab > :is(.tab-favicon, .pane-tag) {
  flex: none;
}
.tab-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-tab.grouped {
  margin-left: 22px !important;
}
.browser-tab.grouped::after {
  content: "";
  position: absolute;
  left: -13px;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: var(--soft);
}
.browser-tab.selected {
  box-shadow: inset 0 0 0 1px #9db6c4;
}
.browser-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.browser-tab .browser-tab-close {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--faint);
  opacity: 0;
  transition: opacity 0.16s;
}
.browser-tab:hover .browser-tab-close,
.browser-tab.active .browser-tab-close,
.browser-tab-close:focus-visible {
  opacity: 1;
}
.browser-tab .browser-tab-close:hover {
  background: rgb(93 122 139 / 14%);
  color: var(--ink);
}
.browser-tab-sound {
  color: var(--accent);
  flex: none;
}
.browser-group {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 31px;
  margin-top: 3px;
  padding: 0 2px 0 5px;
  border-radius: 6px;
  color: var(--sub);
  font-size: 12px;
  font-weight: 565;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
}
.browser-group:hover {
  background: rgb(132 162 182 / 8%);
}
.browser-group-chevron {
  flex: none;
  transition: transform 0.18s;
}
.browser-group.collapsed .browser-group-chevron {
  transform: rotate(-90deg);
}
.browser-group-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--group);
  flex: none;
}
.browser-group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.browser-group small {
  color: var(--faint);
  font-size: 10px;
  font-weight: 450;
}
.browser-group .side-add {
  opacity: 0;
}
.browser-group:hover .side-add,
.browser-group .side-add:focus-visible {
  opacity: 1;
}

/* Split View lives where its tabs live: two choices and one sliding
   highlight that follows the pane in use. */
.inline-split {
  --choice-height: 37px;
  --choice-gap: 2px;
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: var(--choice-gap);
  margin: 3px 0 5px;
  padding: 4px;
  border: 1px solid rgb(120 156 178 / 20%);
  border-radius: 9px;
  background: rgb(119 156 178 / 4.5%);
  flex: none;
  animation: split-reveal 0.21s cubic-bezier(0.16, 0.78, 0.23, 1) both;
}
.inline-split.grouped {
  margin-left: 22px;
}
.inline-split.pane-detached .split-active-highlight {
  display: none;
}
.inline-split::before {
  content: "";
  position: absolute;
  left: -1px;
  top: 11px;
  bottom: 11px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0.62;
}
.split-active-highlight {
  position: absolute;
  z-index: 0;
  left: 4px;
  right: 4px;
  top: 4px;
  height: var(--choice-height);
  border-radius: 6px;
  background: var(--selection);
  pointer-events: none;
  transform: translateY(
    calc(var(--active-pane-index, 0) * (var(--choice-height) + var(--choice-gap)))
  );
  transition: transform 0.34s cubic-bezier(0.2, 0.83, 0.23, 1);
}
.browser-view .browser-side .inline-split .browser-tab {
  z-index: 1;
  height: var(--choice-height);
  margin: 0;
  padding: 0 30px 0 8px;
  border-radius: 6px;
  background: transparent !important;
  font-weight: 560;
  transition: color 0.22s ease;
}
.browser-view .browser-side .inline-split .browser-tab::before {
  display: none;
}
.browser-view .browser-side .inline-split .browser-tab:not(.active):hover {
  background: rgb(132 162 182 / 7.5%) !important;
}
.pane-tag {
  margin-left: auto;
  flex: none;
  font-size: 9px;
  font-weight: 510;
  color: var(--faint);
  transition: color 0.25s ease;
}
.inline-split .browser-tab.active .pane-tag {
  color: var(--sub);
}
.inline-split-exit {
  position: absolute;
  z-index: 3;
  right: 8px;
  top: 8px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 19px;
  padding: 0;
  border-radius: 5px;
  color: var(--faint);
  background: none;
  opacity: 0;
  transition:
    opacity 0.15s,
    background 0.18s;
}
.inline-split:hover .inline-split-exit,
.inline-split-exit:focus-visible {
  opacity: 1;
}
.inline-split-exit:hover {
  background: var(--hover);
  color: var(--ink);
}
@keyframes split-reveal {
  from {
    opacity: 0.75;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Mini player and footer */
.browser-mini {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 12px 8px;
  padding: 3px 3px 3px 10px;
  border: 1px solid var(--soft);
  border-radius: 8px;
  background: rgb(255 255 255 / 30%);
  flex: none;
}
.browser-mini-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  background: none;
  color: var(--sub);
  font-size: 11.5px;
  text-align: left;
  white-space: nowrap;
}
.browser-mini-title span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.browser-foot {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: auto;
  padding: 8px 11px 10px;
  border-top: 1px solid var(--soft);
  flex: none;
}
.foot-link {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  height: 30px;
  padding: 0 9px;
  border-radius: 7px;
  color: var(--sub);
  background: none;
  font-size: 12px;
  text-align: left;
}
.foot-link:hover {
  background: var(--hover);
  color: var(--ink);
}

/* Collapsed, or an app too narrow for a full sidebar: icons only. */
.side-collapsed .browser-side :is(.space-label, .current-space > svg, .side-title-text, .side-key, .tab-text, .browser-tab-close, .pane-tag, .inline-split-exit, .browser-group, .browser-group-empty, .browser-chip span, .browser-mini-title span, .foot-link span, .browser-space-add, .browser-tab-sound) {
  display: none;
}
.side-collapsed .side-head {
  flex-direction: column;
  height: 70px;
  gap: 4px;
  padding: 11px 0 0;
}
.side-collapsed .side-spacer {
  display: none;
}
.side-collapsed .current-space {
  padding: 0;
}
.side-collapsed .browser-spaces {
  flex-direction: column;
  padding: 6px 0 2px;
}
.side-collapsed .browser-side .browser-tabs {
  padding-left: 9px !important;
  padding-right: 9px !important;
}
.side-collapsed .side-title {
  justify-content: center;
  padding: 0;
  margin-top: 4px;
}
.side-collapsed .browser-side :is(.browser-tab, .browser-chip) {
  justify-content: center;
  padding: 0 !important;
  margin-left: 0 !important;
}
.side-collapsed .inline-split {
  --choice-height: 33px;
  padding: 3px;
  margin-left: 0;
}
.side-collapsed .browser-foot {
  flex-direction: column;
  padding: 8px 0 10px;
}
.side-collapsed .foot-link {
  flex: none;
  width: 34px;
  justify-content: center;
  padding: 0;
}
.side-collapsed .browser-tab.grouped::after {
  display: none;
}

/* Toolbar */
.browser-bar {
  height: 48px;
  gap: 2px;
  padding: 0 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--soft);
}
.browser-bar-divider {
  flex: 0 0 1px;
  height: 16px;
  margin-inline: 3px;
  background: var(--soft);
}
.address-shell {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 80px;
  height: 31px;
  margin: 0 6px;
  padding: 0 5px 0 10px;
  border: 1px solid var(--soft);
  border-radius: 7px;
  background: var(--low);
  overflow: hidden;
}
.address-shell > :deep(svg) {
  color: var(--faint);
  flex: none;
}
.address-shell input::placeholder,
.start-search input::placeholder {
  color: var(--faint);
}
.address-shell::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 0;
  height: 1.5px;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0;
  transform: scaleX(0.3);
  transition:
    opacity 0.22s ease,
    transform 0.28s var(--ease);
  pointer-events: none;
}
.address-shell:focus-within::after {
  opacity: 0.75;
  transform: scaleX(1);
}
.address-shell .browser-address,
.address-shell .browser-address:focus {
  margin: 0;
  padding: 0;
  border: 0 !important;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none !important;
  outline: 0 !important;
}
.address-shell .icon-button {
  width: 23px;
  height: 23px;
}

/* Sidebar only: the address bar appears over the page when asked for. */
.layout-performance .browser-bar {
  display: none;
}
.layout-performance.bar-open .browser-bar {
  display: flex;
  position: absolute;
  z-index: 6;
  top: 10px;
  left: 6%;
  right: 6%;
  border: 1px solid var(--line);
  border-radius: 11px;
  box-shadow: var(--floating);
  animation: browser-pop 0.18s var(--ease) both;
}

/* Tabs on top, like Chrome. */
.layout-comfortable {
  grid-template-columns: minmax(0, 1fr) auto auto;
}
.layout-comfortable > * {
  grid-column: 1 / -1;
}
.layout-comfortable .browser-side {
  display: contents;
}
.layout-comfortable :is(.side-head, .side-title, .side-grip, .foot-link span, .pane-tag, .inline-split-exit, .split-active-highlight, .browser-group-empty) {
  display: none;
}
.layout-comfortable .browser-tabs {
  grid-row: 1;
  grid-column: 1;
  background: var(--side-bg);
}
.layout-comfortable .browser-tab .tab-text {
  flex: 1;
}
.layout-comfortable .inline-split {
  display: contents;
}
.layout-comfortable .browser-group {
  flex: none;
  max-width: 140px;
  margin: 0;
}
.layout-comfortable .browser-new-tab {
  order: 99;
}
.layout-comfortable .browser-spaces {
  grid-row: 1;
  grid-column: 2;
  padding: 8px 4px 0;
  background: var(--side-bg);
  align-self: stretch;
}
.layout-comfortable .browser-foot {
  grid-row: 1;
  grid-column: 3;
  margin: 0;
  padding: 8px 10px 0 0;
  border: 0;
  background: var(--side-bg);
  align-self: stretch;
}
.layout-comfortable .foot-link {
  flex: none;
  width: 28px;
  padding: 0;
  justify-content: center;
}
.layout-comfortable .browser-mini {
  grid-row: 5;
  grid-column: 1 / -1;
  margin: 0;
  border-radius: 0;
}

/* Split View panes: a caption over each, and a divider that drags. */
.browser-frame {
  position: absolute;
  inset: 0;
  zoom: var(--focus-page-zoom, 1);
}
.browser-page.split :is(.pane-first, .pane-second) {
  position: absolute;
  inset: auto;
  left: 0;
  top: 27px;
  width: var(--split);
  height: calc(100% - 27px);
}
.browser-page.split .pane-second {
  left: var(--split);
  width: calc(100% - var(--split));
}
.browser-page.split.stacked .pane-first {
  width: 100%;
  height: calc(var(--split) - 27px);
}
.browser-page.split.stacked .pane-second {
  left: 0;
  top: calc(var(--split) + 27px);
  width: 100%;
  height: calc(100% - var(--split) - 27px);
}
.split-chrome {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.split-chrome > * {
  pointer-events: auto;
}
.pane-caption {
  position: absolute;
  z-index: 2;
  left: 0;
  top: 0;
  width: var(--split);
  height: 27px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 9px 0 12px;
  background: var(--low);
  border-bottom: 1px solid var(--soft);
  color: var(--sub);
  font-size: 10.5px;
  cursor: default;
}
.pane-caption.second {
  left: var(--split);
  width: calc(100% - var(--split));
}
.stacked .pane-caption {
  width: 100%;
}
.stacked .pane-caption.second {
  left: 0;
  top: var(--split);
}
.pane-caption.current {
  background: var(--selection);
  box-shadow: inset 0 -2px 0 var(--accent);
  color: var(--ink);
}
.pane-active-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 650;
}
.pane-caption .tab-favicon {
  width: 13px;
  height: 13px;
  font-size: 8px;
}
.caption-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pane-caption button {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 5px;
  color: var(--faint);
  background: none;
}
.pane-caption button:hover {
  background: var(--hover);
  color: var(--ink);
}
.pane-divider {
  position: absolute;
  z-index: 4;
  top: 0;
  bottom: 0;
  left: calc(var(--split) - 1.5px);
  width: 3px;
  cursor: col-resize;
  background: var(--soft);
  touch-action: none;
  transition: background 0.2s;
}
.stacked .pane-divider {
  top: calc(var(--split) - 1.5px);
  bottom: auto;
  left: 0;
  right: 0;
  width: auto;
  height: 3px;
  cursor: row-resize;
}
.pane-divider:is(:hover, :focus-visible) {
  background: var(--accent);
}

/* Start page */
.browser-start {
  position: absolute;
  inset: 0;
  height: auto;
  padding: 30px 24px 60px;
  background:
    radial-gradient(circle at 50% 45%, rgb(197 217 229 / 13%), transparent 55%),
    var(--surface);
  overflow: auto;
}
.start-wrap {
  container: browser-start / inline-size;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(560px, 100%);
}
.start-symbol {
  display: grid;
  place-items: center;
  width: 49px;
  height: 49px;
  margin-bottom: 21px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: var(--low);
  color: var(--accent);
}
.browser-start .start-heading {
  margin: 0 0 8px;
  font-size: 25px;
  font-weight: 530;
  letter-spacing: -1.1px;
  color: var(--ink);
}
.browser-start .start-sub {
  margin: 0 0 26px;
  font-size: 12px;
  color: var(--faint);
}
.start-search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  height: 49px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 3px 17px rgb(65 94 112 / 4.5%);
  overflow: hidden;
}
.start-search :deep(svg) {
  color: var(--faint);
  flex: none;
}
.start-search input,
.start-search input:focus {
  flex: 1;
  min-width: 0;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  outline: 0 !important;
  font-size: 13px;
}
.start-search::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 0;
  height: 1.5px;
  background: var(--accent);
  opacity: 0;
  transform: scaleX(0.3);
  transition:
    opacity 0.22s ease,
    transform 0.28s var(--ease);
}
.start-search:focus-within::after {
  opacity: 0.75;
  transform: scaleX(1);
}
.start-search kbd,
.browser-tip kbd {
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 5px;
  font-family: inherit;
  font-size: 10px;
  color: var(--faint);
}
.quick-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  align-self: stretch;
  margin-top: 34px;
  color: var(--faint);
  font-size: 10px;
  font-weight: 680;
  letter-spacing: 1px;
  text-transform: uppercase;
}
.quick-title small {
  font-size: 10px;
  font-weight: 450;
  letter-spacing: 0;
  text-transform: none;
}
.quick-sites {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
  align-self: stretch;
  margin-top: 11px;
}
@container browser-start (max-width: 415px) {
  .quick-sites {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.quick-site {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px;
  border: 1px solid var(--soft);
  border-radius: 8px;
  background: var(--surface, #f8fafb);
  color: var(--sub);
  font-size: 11px;
  text-align: left;
  overflow: hidden;
  transition:
    border-color 0.2s,
    background 0.2s,
    transform 0.2s;
}
.quick-site:hover {
  border-color: var(--line);
  background: var(--low);
  transform: translateY(-2px);
}
.site-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 6px;
  background: var(--selection);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}
.quick-site span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-start .start-foot {
  max-width: 380px;
  margin-top: 30px;
  font-size: 10px;
  line-height: 1.6;
  color: var(--faint);
}

.browser-embed-hint {
  --hint-width: 100%;
  position: absolute;
  z-index: 1;
  right: 18px;
  bottom: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(430px, calc(var(--hint-width) - 36px));
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 10px 34px rgb(52 79 97 / 10%);
  color: var(--sub);
  font-size: 11px;
  line-height: 1.45;
}
.split:not(.stacked) .browser-embed-hint.hint-first {
  --hint-width: var(--split);
  right: calc(100% - var(--split) + 18px);
}
.split:not(.stacked) .browser-embed-hint.hint-second {
  --hint-width: calc(100% - var(--split));
}
.stacked .browser-embed-hint.hint-first {
  bottom: calc(100% - var(--split) + 18px);
}
.browser-embed-hint button {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 0;
  background: none;
  color: var(--ink);
}
.browser-embed-hint button:first-of-type {
  font-weight: 650;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* Peek: a panel over the page with its controls on a rail. */
.browser-peek-backdrop {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: rgb(79 104 121 / 13%);
  backdrop-filter: blur(2px);
  animation: browser-fade 0.18s ease;
}
.browser-page :is(webview, iframe, .browser-discarded).browser-peeking {
  position: absolute;
  z-index: 3;
  inset: auto;
  top: 6%;
  left: 7%;
  width: calc(86% - 43px);
  height: 88%;
  border-radius: 12px 0 0 12px;
  background: #fff;
  box-shadow: 0 23px 65px rgb(39 63 78 / 18%), 0 4px 16px rgb(39 63 78 / 8%);
  animation: peek-in 0.24s var(--ease) both;
}
.peek-rail {
  position: absolute;
  z-index: 3;
  top: 6%;
  right: 7%;
  width: 43px;
  height: 88%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 9px 4px;
  border-left: 1px solid var(--soft);
  border-radius: 0 12px 12px 0;
  background: var(--surface, #f8fafb);
  box-shadow: 14px 23px 65px rgb(39 63 78 / 14%);
  animation: peek-in 0.24s var(--ease) both;
}
.peek-rail button {
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  padding: 0;
  border-radius: 7px;
  color: var(--sub);
  background: none;
  transition:
    background 0.15s,
    color 0.15s;
}
.peek-rail button:hover {
  background: var(--selection);
  color: var(--ink);
}
.peek-rail-line {
  width: 17px;
  height: 1px;
  margin: 3px 0;
  background: var(--soft);
}
.peek-address {
  position: absolute;
  z-index: 4;
  left: calc(7% + 14px);
  top: calc(6% + 13px);
  max-width: min(410px, calc(86% - 71px));
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: 1px solid var(--soft);
  border-radius: 6px;
  background: var(--surface, #f8fafb);
  box-shadow: 0 2px 6px rgb(60 83 96 / 7%);
  color: var(--sub);
  font-size: 10px;
  pointer-events: none;
  animation: peek-in 0.24s var(--ease) both;
}
.peek-address span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes peek-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.982);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes browser-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes browser-pop {
  from {
    opacity: 0;
    transform: translateY(-5px) scale(0.975);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Area screenshots */
.browser-crop {
  position: absolute;
  inset: 0;
  z-index: 5;
  cursor: crosshair;
  background: rgb(43 63 75 / 12%);
  touch-action: none;
}
.browser-crop-box {
  position: absolute;
  border: 1px solid var(--accent);
  background: rgb(110 145 166 / 15%);
}

/* Menus, command palette, notices and tooltips */
.browser-reorder-move {
  transition: transform 105ms ease-out !important;
}
.browser-tab,
.browser-space {
  user-select: none;
}
.browser-view .drag-source {
  opacity: 0;
}
.browser-view .group-drop-active {
  background: var(--selection);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.browser-tab:is(.attach-before, .attach-after) {
  position: relative;
}
.browser-tab:is(.attach-before, .attach-after)::after {
  content: "";
  position: absolute;
  inset-inline: 4px;
  height: 2px;
  border-radius: 1px;
  background: #4f7b93;
  pointer-events: none;
}
.browser-tab.attach-before::after { top: -2px; }
.browser-tab.attach-after::after { bottom: -2px; }
.layout-comfortable .browser-tab:is(.attach-before, .attach-after)::after {
  inset-block: 4px;
  inset-inline: auto;
  width: 2px;
  height: auto;
}
.layout-comfortable .browser-tab.attach-before::after { left: -2px; }
.layout-comfortable .browser-tab.attach-after::after { right: -2px; }
.browser-drag-preview {
  position: absolute;
  inset: 0 auto auto 0;
  z-index: 11;
  display: flex;
  align-items: center;
  gap: 7px;
  padding-inline: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--selection);
  color: var(--ink);
  box-shadow: 0 2px 6px rgb(32 52 65 / 10%);
  pointer-events: none;
}
.browser-drag-preview.space-preview {
  padding: 0;
  justify-content: center;
  color: var(--space);
  background: color-mix(in srgb, var(--space) 20%, var(--surface));
  font-weight: 630;
}
.browser-drag-preview.detached {
  position: fixed;
  z-index: 250;
  transform-origin: top left;
  border-color: #c8d8e1;
  background: #e4eff5;
  color: #455968;
  font: 600 12px/1.2 "Inter Variable", sans-serif;
  box-shadow: 0 6px 18px rgb(32 52 65 / 18%);
}
.browser-split-drag-shield {
  position: absolute;
  inset: 0;
  z-index: 5;
}
.browser-split-target {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: grid;
  grid-template-columns: var(--split) minmax(0, 1fr);
  pointer-events: none;
}
.stacked .browser-split-target {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: var(--split) minmax(0, 1fr);
}
.browser-split-target .split-drop-zone {
  min-width: 0;
  transition: background 140ms ease, border-color 140ms ease;
}
.browser-split-target-enter-active,
.browser-split-target-leave-active {
  transition: opacity 140ms var(--ease);
}
.browser-split-target-enter-from,
.browser-split-target-leave-to {
  opacity: 0;
}
/* Overlays span the whole app, not just the page column. */
.browser-view > :is(.browser-menu, .browser-scrim, .browser-notice, .browser-tip, .browser-drawer, .browser-drag-preview) {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
}
.browser-menu {
  position: absolute;
  z-index: 8;
  width: min(248px, calc(100% - 8px));
  max-height: calc(100% - 8px);
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--surface);
  box-shadow: var(--floating);
  transform-origin: top left;
  animation: browser-pop 0.18s var(--ease) both;
}
.browser-menu button {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  height: 31px;
  padding: 0 9px;
  border-radius: 6px;
  color: var(--sub);
  background: none;
  font-size: 12px;
  text-align: left;
}
.browser-menu button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--ink);
}
.browser-menu button.chosen {
  color: var(--ink);
}
.browser-menu button :deep(svg) {
  color: var(--accent);
  flex: none;
}
.browser-menu button span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-menu hr {
  height: 1px;
  margin: 5px 4px;
  border: 0;
  background: var(--soft);
}
.browser-menu-label {
  padding: 8px 9px 6px;
  color: var(--sub);
  font-size: 10px;
  font-weight: 680;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}
.browser-menu button .menu-initial {
  display: grid;
  flex: 0 0 19px;
  height: 19px;
  place-items: center;
  border-radius: 5px;
  background: var(--selection);
  font-size: 10px;
}
.browser-menu button.danger:hover:not(:disabled) {
  color: #9d4444;
}
.theme-dark .browser-menu button.danger:hover:not(:disabled) {
  color: #ffabab;
}
.browser-scrim {
  position: absolute;
  inset: 0;
  z-index: 7;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 0 20px;
  align-items: center;
  background: rgb(32 52 65 / 22%);
  backdrop-filter: blur(3px);
  animation: browser-fade 0.15s both;
}
.browser-scrim.quiet {
  background: none;
  backdrop-filter: none;
}
.browser-switcher {
  margin-block: 12px;
  width: min(520px, 100%);
  max-height: calc(100% - 24px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--surface);
  box-shadow: var(--floating);
  overflow: hidden;
  animation: browser-pop 0.18s var(--ease);
}
.browser-dialog {
  overflow: auto;
}
.browser-dialog header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 15px 19px 8px;
}
.browser-dialog h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 660;
}
.browser-dialog-body {
  padding: 8px 19px 18px;
}
.browser-dialog-body label {
  display: grid;
  gap: 7px;
  color: var(--sub);
}
.browser-dialog-body input {
  width: 100%;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--low);
  color: var(--ink);
}
.browser-dialog-body input:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: inset 0 -1px var(--accent);
}
.browser-dialog-body p {
  margin: 0;
  color: var(--sub);
  line-height: 1.5;
}
.browser-dialog-body footer {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  margin-top: 18px;
}
.browser-dialog-body button {
  min-height: 34px;
  padding: 0 13px;
  border-radius: 7px;
  background: var(--low);
  color: var(--sub);
}
.browser-dialog-body button[type="submit"] {
  background: var(--selection);
  color: var(--ink);
}
.browser-dialog-body button.danger {
  background: #893f3f;
  color: #fff;
}
.command-input-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 54px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--soft);
  flex: none;
}
.command-input-row :deep(svg) {
  color: var(--faint);
  flex: none;
}
.command-input-row input,
.command-input-row input:focus {
  flex: 1;
  min-width: 0;
  height: 38px;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  outline: 0 !important;
  font-size: 13px;
}
.command-input-row::after {
  content: "";
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 0;
  height: 1.5px;
  background: var(--accent);
  opacity: 0;
  transform: scaleX(0.3);
  transition:
    opacity 0.22s ease,
    transform 0.28s var(--ease);
}
.command-input-row:focus-within::after {
  opacity: 0.75;
  transform: scaleX(1);
}
.command-list-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.command-scroll-track {
  position: absolute;
  inset: 8px 3px 8px auto;
  width: 8px;
  touch-action: none;
  cursor: pointer;
}
.command-scroll-track span {
  position: absolute;
  inset-inline: 2px;
  border-radius: 8px;
  background: var(--scroll-thumb);
  cursor: grab;
}
.command-scroll-track span:active {
  cursor: grabbing;
}
.command-results {
  min-height: 0;
  max-height: 355px;
  display: flex;
  flex-direction: column;
  padding: 8px 14px 14px 8px;
  overflow: hidden auto;
  scrollbar-width: none;
}
.command-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 37px;
  padding: 0 11px;
  border-radius: 7px;
  color: var(--sub);
  background: none;
  font-size: 12px;
  text-align: left;
  flex: none;
}
.command-row:hover,
.command-row.current {
  background: var(--selection);
  color: var(--ink);
}
.command-row span {
  flex: none;
  max-width: 62%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.command-row small {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-size: 10px;
  color: var(--faint);
}
.command-results p {
  margin: 0;
  padding: 26px;
  text-align: center;
  color: var(--faint);
}
.browser-notice {
  position: absolute;
  z-index: 9;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--ink);
  color: var(--surface);
  box-shadow: var(--floating);
  font-size: 11px;
  white-space: nowrap;
}
.browser-tip {
  position: absolute;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 27px;
  padding: 6px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 8px 24px rgb(50 77 96 / 11%), 0 2px 6px rgb(50 77 96 / 4.5%);
  font-size: 11px;
  line-height: 1.25;
  white-space: nowrap;
  pointer-events: none;
  animation: tip-in 0.17s ease both;
}
@keyframes tip-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .browser-reorder-move,
  .browser-split-target .split-drop-zone,
  .browser-split-target-enter-active,
  .browser-split-target-leave-active {
    transition: none !important;
  }
  .inline-split,
  .split-active-highlight,
  .browser-menu,
  .browser-switcher,
  .browser-tip,
  .peek-rail,
  .peek-address,
  .browser-page .browser-peeking {
    animation: none !important;
    transition: none !important;
  }
}
</style>
