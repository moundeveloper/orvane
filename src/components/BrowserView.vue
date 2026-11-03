<script lang="ts">
// Shared by every Browser app: a budget of live pages. Each <webview> costs
// a renderer process (about 100 MB on a trivial page, far more on NetSuite),
// so beyond the limit the pages nobody has seen for a while are replaced by
// a picture until clicked.
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
// A page can keep unsaved state in JavaScript, outside any form we can
// inspect. Unloading is therefore opt-in; pausing preserves the live page.
function discardEnabled() {
  try {
    return localStorage.getItem("orvane.browser.discardEnabled") === "true";
  } catch {
    return false;
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
import Icon from "./Icon.vue";
import PasswordsPanel from "./PasswordsPanel.vue";

const props = defineProps<{ block: Block; editing: boolean }>();

interface BrowserTab {
  id: string;
  url: string;
  title?: string;
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
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
}
interface ProcessingTab { id: string; label: string; status: string; autoRefresh: boolean; }
interface ProcessingApi {
  list(): Promise<ProcessingTab[]>;
  create(id: number): Promise<ProcessingTab>;
  refresh(origin: string): Promise<ProcessingTab>;
  close(origin: string): Promise<void>;
  onChanged(callback: () => void): () => void;
}
interface OrvaneDesktop {
  processing?: ProcessingApi;
  webview: boolean;
  partition: string;
  setPageDensity(webContentsId: number, density: number): Promise<void>;
  setPageActive?(webContentsId: number, active: boolean): Promise<void>;
  rememberPage?(webContentsId: number): Promise<void>;
  snapshotPage?(
    webContentsId: number,
    picture: boolean,
  ): Promise<{ edited: boolean; image?: string } | null>;
  onGuestInput(
    callback: (
      input:
        | { from: number; kind: "zoom"; x: number; y: number; deltaY: number }
        | { from: number; kind: "zoom"; clientX: number; clientY: number; deltaY: number }
        | { from: number; kind: "pan"; dx: number; dy: number },
    ) => void,
  ): () => void;
  onOpenTab(
    callback: (request: { from: number; url: string; background: boolean }) => void,
  ): () => void;
  passwords?: PasswordsApi;
}

// Inside the Orvane desktop app pages load in <webview>, which sites can't
// refuse like an iframe and which has real history; otherwise an iframe.
const desktop = (window as unknown as { orvaneDesktop?: OrvaneDesktop })
  .orvaneDesktop;
const useWebview = !!desktop?.webview;
const processing = desktop?.processing;
const processingTabs = ref<ProcessingTab[]>([]), processingOpen = ref(false), processingError = ref(''), processingGroup = ref<HTMLElement>();
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
const MAX_TABS = 12;
const MAX_BOOKMARKS = 60;
interface Bookmark {
  id: string;
  url: string;
  title: string;
}
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
    }))
    .slice(0, MAX_BOOKMARKS);
}
function readState() {
  let bookmarks: Bookmark[] = [];
  try {
    const saved = JSON.parse(props.block.value || "{}") as {
      tabs?: unknown;
      active?: unknown;
      bookmarks?: unknown;
    };
    bookmarks = readBookmarks(saved);
    const tabs = Array.isArray(saved.tabs)
      ? saved.tabs
          .filter(
            (t): t is BrowserTab =>
              !!t &&
              typeof t.id === "string" &&
              typeof t.url === "string" &&
              (t.url === START || !!safeUrl(t.url)),
          )
          .map((t) => ({
            id: t.id,
            url: t.url,
            ...(typeof t.title === "string" ? { title: t.title } : {}),
          }))
          .slice(0, MAX_TABS)
      : [];
    if (tabs.length)
      return {
        tabs,
        active: tabs.some((t) => t.id === saved.active)
          ? (saved.active as string)
          : tabs[0]!.id,
        bookmarks,
      };
  } catch {
    // Unreadable state starts a fresh browser.
  }
  const id = uid();
  return { tabs: [{ id, url: START } as BrowserTab], active: id, bookmarks };
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
    url: `https://duckduckgo.com/?q=${encodeURIComponent(value)}`,
  };
}

const state = ref(readState());
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
for (const tab of state.value.tabs) if (tab.url) started[tab.id] = tab.url;
const webviews = new Map<string, WebviewElement>();
/** Tabs whose page was discarded to save memory: a picture until reloaded. */
const discarded = reactive<Record<string, { image: string }>>({});
const webviewNav = reactive<Record<string, { back: boolean; forward: boolean }>>(
  {},
);
const nav = computed(() => {
  void revision.value;
  if (useWebview) {
    const live = webviewNav[activeTab.value.id];
    return { back: !!live?.back, forward: !!live?.forward, reloads: 0 };
  }
  const entry = history(activeTab.value);
  return {
    back: entry.index > 0,
    forward: entry.index < entry.stack.length - 1,
    reloads: entry.reloads,
  };
});
const address = ref(activeTab.value.url);
const error = ref("");

function save() {
  props.block.value = JSON.stringify({
    tabs: state.value.tabs,
    active: state.value.active,
    bookmarks: state.value.bookmarks,
  });
}
function show(url: string) {
  activeTab.value.url = url;
  address.value = url;
  error.value = "";
  revision.value++;
  save();
}
function go(text = address.value) {
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
const bookmarked = computed(() =>
  state.value.bookmarks.find((b) => b.url === activeTab.value.url),
);
function toggleBookmark() {
  const tab = activeTab.value;
  if (!tab.url) return;
  const existing = bookmarked.value;
  if (existing) removeBookmark(existing.id);
  else if (state.value.bookmarks.length < MAX_BOOKMARKS) {
    state.value.bookmarks.push({ id: uid(), url: tab.url, title: label(tab) });
    save();
  }
}
function removeBookmark(id: string) {
  state.value.bookmarks = state.value.bookmarks.filter((b) => b.id !== id);
  save();
}
function openBookmark(bookmark: Bookmark, newTab = false) {
  if (newTab) addTab(bookmark.url);
  else go(bookmark.url);
}
function openExternal() {
  if (activeTab.value.url)
    window.open(activeTab.value.url, "_blank", "noopener,noreferrer");
}
function addTab(url = START, background = false) {
  if (state.value.tabs.length >= MAX_TABS) return;
  const tab: BrowserTab = { id: uid(), url };
  if (url) started[tab.id] = url;
  state.value.tabs.push(tab);
  if (background) save();
  else selectTab(tab.id);
  if (!url) nextTick(() => addressInput.value?.focus());
}
function selectTab(id: string) {
  state.value.active = id;
  // Choosing a tab whose page was discarded is asking for it back.
  if (discarded[id]) restoreTab(id);
  address.value = activeTab.value.url;
  error.value = "";
  save();
}
function closeTab(id: string) {
  const tabs = state.value.tabs;
  const index = tabs.findIndex((t) => t.id === id);
  histories.delete(id);
  webviews.delete(id);
  dropLivePage(id);
  delete discarded[id];
  dismissPrompt(id);
  delete autoLogins[id];
  delete started[id];
  delete webviewNav[id];
  if (tabs.length === 1) {
    tabs[0] = { id: uid(), url: START };
    selectTab(tabs[0].id);
    return;
  }
  tabs.splice(index, 1);
  if (state.value.active === id)
    selectTab(tabs[Math.max(0, index - 1)]!.id);
  else save();
}
function label(tab: BrowserTab) {
  if (tab.title) return tab.title;
  if (!tab.url) return "New tab";
  try {
    return new URL(tab.url).hostname.replace(/^www\./, "");
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
    if (!safeUrl(url)) return;
    tab.url = url;
    if (tab.id === state.value.active && document.activeElement !== addressInput.value)
      address.value = url;
    sync();
    save();
  };
  view.addEventListener("did-navigate", (event) =>
    navigated((event as Event & { url: string }).url),
  );
  view.addEventListener("did-navigate-in-page", (event) => {
    const detail = event as Event & { url: string; isMainFrame: boolean };
    if (detail.isMainFrame) navigated(detail.url);
  });
  view.addEventListener("page-title-updated", (event) => {
    tab.title = (event as Event & { title: string }).title.slice(0, 200);
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
    if (tab.id !== state.value.active) return;
    rememberedAt = 0;
    setTimeout(rememberPicture, 300);
  });
  view.addEventListener("did-start-loading", () => {
    if (tab.id === state.value.active) error.value = "";
  });
  view.addEventListener("dom-ready", () => {
    sync();
    applyZoom(view);
    // A new document starts running: pause it again if nobody sees it.
    if (webviews.get(tab.id) === view) {
      delete pageActive[tab.id];
      updateActivity();
    }
  });
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

let stopOpenTab: (() => void) | undefined, stopGuestInput: (() => void) | undefined;
onMounted(() => {
  stopOpenTab = desktop?.onOpenTab(({ from, url, background }) => {
    if (webviewFor(from) && safeUrl(url)) addTab(url, background);
  });
  // Canvas gestures made over a page arrive from the main process; replay
  // them where the canvas listens, in canvas screen coordinates.
  stopGuestInput = desktop?.onGuestInput((input) => {
    const view = webviewFor(input.from);
    if (!view) return;
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
const frame = ref<HTMLIFrameElement>();
const addressInput = ref<HTMLInputElement>();
const interacting = ref(false);
const pageElement = () =>
  useWebview ? webviews.get(state.value.active) : frame.value;
function focusFrame() {
  interacting.value = true;
  nextTick(() => pageElement()?.focus());
}
function leaveFrame(event: Event) {
  // Events inside the page never reach this document, so any pointer or
  // focus event here means the user is outside the page.
  if (event.target !== pageElement()) interacting.value = false;
}
function shieldDown(event: PointerEvent) {
  if (event.button !== 0 || props.editing) return;
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
  tabId === state.value.active &&
  ((onScreen.value && estimatedScale >= READABLE_SCALE) || interacting.value);
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
}
function updateActivity() {
  if (!useWebview) return;
  const now = Date.now();
  for (const tab of state.value.tabs) {
    if (!webviews.has(tab.id)) continue;
    const seen = seenNow(tab.id);
    // Last seen: now while seen, and the moment it stopped being seen.
    if (seen || wasSeen[tab.id] !== false || seenAt[tab.id] === undefined) seenAt[tab.id] = now;
    wasSeen[tab.id] = seen;
    if (seen) {
      clearTimeout(pauseTimers[tab.id]);
      delete pauseTimers[tab.id];
      if (pageActive[tab.id] !== true) setPageActive(tab.id, true);
    } else if (pageActive[tab.id] !== false && !pauseTimers[tab.id]) {
      pauseTimers[tab.id] = setTimeout(() => {
        delete pauseTimers[tab.id];
        if (webviews.has(tab.id) && !seenNow(tab.id)) setPageActive(tab.id, false);
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
      discarded[tab.id] = { image: snapshot.image || "" };
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
  webviews.delete(tabId);
  delete webviewNav[tabId];
  dropLivePage(tabId);
}
/** Bring a discarded tab back: a new page at the same address. */
function restoreTab(tabId: string) {
  const tab = state.value.tabs.find((t) => t.id === tabId);
  if (!tab || !discarded[tabId]) return;
  delete discarded[tabId];
  if (tab.url) started[tabId] = tab.url;
  if (tabId === state.value.active) focusFrame();
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
// Middle-click closes a tab; keep the press from starting a canvas pan,
// which would capture the pointer before the tab sees the click.
function tabMiddleDown(event: MouseEvent) {
  if (event.button !== 1) return;
  event.preventDefault();
  event.stopPropagation();
}
function browserWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey)) event.stopPropagation();
}
</script>

<template>
  <div class="browser-view" aria-label="Web browser" @wheel="browserWheel">
    <div class="browser-tabs" role="tablist">
      <div
        v-for="tab in state.tabs"
        :key="tab.id"
        class="browser-tab"
        :class="{ active: tab.id === state.active }"
        role="tab"
        :aria-selected="tab.id === state.active"
        tabindex="0"
        @click="selectTab(tab.id)"
        @keydown.enter="selectTab(tab.id)"
        @pointerdown="tabMiddleDown"
        @mousedown="tabMiddleDown"
        @auxclick.prevent="$event.button === 1 && closeTab(tab.id)"
      >
        <Icon name="globe" :size="12" />
        <span>{{ label(tab) }}</span>
        <button
          class="browser-tab-close"
          :aria-label="`Close ${label(tab)}`"
          @click.stop="closeTab(tab.id)"
        >
          <Icon name="close" :size="11" />
        </button>
      </div>
      <button
        v-if="state.tabs.length < MAX_TABS"
        class="icon-button"
        aria-label="New tab"
        @click="addTab()"
      >
        <Icon name="plus" :size="13" />
      </button>
    </div>
    <div v-if="processing" ref="processingGroup" class="processing-group">
      <button class="processing-toggle" :aria-expanded="processingOpen" @click="processingOpen = !processingOpen">Processing tabs <span>{{ processingTabs.length }}</span></button>
      <button class="processing-add" :disabled="!activeTab.url" @click="createProcessing">Use current tab</button>
      <div v-if="processingOpen" class="processing-list">
        <p v-if="!processingTabs.length">No processing tabs yet. Use the current tab to create one.</p>
        <div v-for="tab in processingTabs" :key="tab.id" class="processing-row"><span class="processing-name">{{ tab.label }}</span><span>{{ tab.status }}</span><button @click="processingAction('refresh', tab.id)">Refresh</button><button @click="processingAction('close', tab.id)">Close</button></div>
      </div>
      <p v-if="processingError" role="alert">{{ processingError }}</p>
    </div>
    <form class="browser-bar" @submit.prevent="go()" @keydown.stop>
      <button
        type="button"
        class="icon-button"
        aria-label="Back"
        :disabled="!nav.back"
        @click="step(-1)"
      >
        <Icon name="back" :size="14" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Forward"
        :disabled="!nav.forward"
        @click="step(1)"
      >
        <Icon name="forward" :size="14" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Reload"
        :disabled="!activeTab.url"
        @click="reload"
      >
        <Icon name="refresh" :size="13" />
      </button>
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
      />
      <button
        type="button"
        class="icon-button browser-star"
        :class="{ on: bookmarked }"
        :aria-label="bookmarked ? 'Remove bookmark' : 'Bookmark this page'"
        :aria-pressed="!!bookmarked"
        :disabled="!activeTab.url"
        @click="toggleBookmark"
      >
        <Icon name="star" :size="13" />
      </button>
      <button
        v-if="passwords"
        type="button"
        class="icon-button"
        :class="{ on: showPasswords }"
        aria-label="Saved passwords"
        data-passwords-toggle
        :aria-pressed="showPasswords"
        @click="showPasswords = !showPasswords"
      >
        <Icon name="key" :size="13" />
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Open in your browser"
        :disabled="!activeTab.url"
        @click="openExternal"
      >
        <Icon name="external" :size="13" />
      </button>
    </form>
    <nav
      v-if="state.bookmarks.length"
      class="browser-bookmarks"
      aria-label="Bookmarks"
    >
      <div
        v-for="bookmark in state.bookmarks"
        :key="bookmark.id"
        class="browser-bookmark"
        :class="{ current: bookmark.url === activeTab.url }"
      >
        <button
          type="button"
          :title="bookmark.url"
          @click="openBookmark(bookmark)"
          @pointerdown="tabMiddleDown"
          @mousedown="tabMiddleDown"
          @auxclick.prevent="$event.button === 1 && openBookmark(bookmark, true)"
        >
          <Icon name="globe" :size="11" />
          <span>{{ bookmark.title || bookmark.url }}</span>
        </button>
        <button
          type="button"
          class="browser-bookmark-remove"
          :aria-label="`Remove bookmark ${bookmark.title || bookmark.url}`"
          @click="removeBookmark(bookmark.id)"
        >
          <Icon name="close" :size="10" />
        </button>
      </div>
    </nav>
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
      v-if="autoLogin"
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
    <div ref="pageBox" class="browser-page">
      <PasswordsPanel
        v-if="passwords && showPasswords"
        :api="passwords"
        :origin="activeOrigin"
        :revision="passwordsRevision"
        @close="showPasswords = false"
      />
      <template v-if="useWebview">
        <template v-for="tab in state.tabs" :key="tab.id">
          <button
            v-if="discarded[tab.id]"
            v-show="tab.id === state.active"
            type="button"
            class="browser-discarded"
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
            :class="{ 'browser-hidden': tab.id !== state.active, 'browser-asleep': asleep[tab.id] }"
            :src="started[tab.id]"
            :partition="desktop!.partition"
            allowpopups
          ></webview>
        </template>
      </template>
      <iframe
        v-else-if="activeTab.url"
        ref="frame"
        :key="`${activeTab.id}:${nav.reloads}:${activeTab.url}`"
        :src="activeTab.url"
        :title="`Web page: ${label(activeTab)}`"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
        referrerpolicy="strict-origin-when-cross-origin"
        allow=""
      ></iframe>
      <div v-if="!activeTab.url" class="browser-start">
        <Icon name="globe" :size="22" />
        <p>Search or enter an address above.</p>
        <small v-if="!useWebview"
          >Some sites refuse to be shown inside other apps. If a page stays
          blank, open it in your browser or use the Orvane desktop app.</small
        >
      </div>
      <div
        v-if="activeTab.url && (editing || (!useWebview && !interacting))"
        class="browser-shield"
        :aria-label="editing ? undefined : 'Click to use this page'"
        @pointerdown="shieldDown"
        @mousedown.prevent
      ></div>
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
.processing-group { position: relative; display: flex; align-items: center; gap: 8px; flex: none; padding: 3px 10px; background: #f1f5f7; color: #607482; font-size: 11px; }
.processing-group button { border: 0; background: none; color: inherit; cursor: pointer; padding: 4px; }
.processing-group button:hover { color: #344d5b; }
.processing-group button:disabled { opacity: .5; cursor: default; }
.processing-toggle span { background: #dfeaf0; border-radius: 4px; padding: 1px 5px; margin-left: 4px; }
.processing-list { position: absolute; z-index: 20; top: 100%; left: 10px; min-width: 320px; max-width: min(520px, 90%); background: #f7f9fa; border: 1px solid #d5e1e7; box-shadow: 0 8px 20px #425c6b24; padding: 8px; }
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
  color: #607482;
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
  background: #e7edf0;
  color: #455968;
}
.browser-tab:not(.active):hover {
  background: #eef3f5;
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
  background: #dbe4e9;
}
.browser-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: #e7edf0;
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
  background: #eef4f1;
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
.browser-bookmarks {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px 6px;
  background: #e7edf0;
  overflow-x: auto;
  scrollbar-width: none;
  flex: none;
}
.browser-bookmark {
  display: flex;
  align-items: center;
  flex: none;
  max-width: 180px;
  border-radius: 4px;
  color: #556b78;
}
.browser-bookmark:hover,
.browser-bookmark.current {
  background: #dbe4e9;
  color: #455968;
}
.browser-bookmark > button:first-child {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 4px 4px 8px;
  border: 0;
  background: none;
  color: inherit;
  font-size: 11px;
  white-space: nowrap;
}
.browser-bookmark > button:first-child > span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.browser-bookmark-remove {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-right: 3px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: none;
  color: inherit;
  opacity: 0;
}
.browser-bookmark:hover .browser-bookmark-remove,
.browser-bookmark-remove:focus-visible {
  opacity: 0.7;
}
.browser-bookmark-remove:hover {
  opacity: 1;
  background: #cfdae0;
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
  background: #f1f5f7;
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
.browser-start {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: #607482;
  background: var(--surface);
}
.browser-start p {
  margin: 0;
  font-size: 13px;
  color: #455968;
}
.browser-start small {
  max-width: 320px;
  font-size: 11px;
  line-height: 1.5;
}
</style>
