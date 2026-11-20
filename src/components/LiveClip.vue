<script setup lang="ts">
// A live clip: the real page in a <webview>, shown through a window cropped
// to the pinned area or element. It updates with the live page and retries
// if loading or tracking the clipped area fails.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { Block } from "../model";
import { activateApp, appOf } from "../canvasScroll";
import { readWidget, workbenchEditable, type BrowserClip, type ClipRect } from "../workbenchWidgets";
import { readRect, readSize, readTrackerMessage, runInPage, trackerScript } from "../liveClip";
import Icon from "./Icon.vue";

interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
  executeJavaScript(code: string): Promise<unknown>;
  setAudioMuted(muted: boolean): void;
  loadURL(url: string): Promise<void>;
}
type GuestInput =
  | { from: number; kind: "zoom"; x: number; y: number; deltaY: number }
  | { from: number; kind: "zoom"; clientX: number; clientY: number; deltaY: number }
  | { from: number; kind: "pan"; dx: number; dy: number }
  | { from: number; kind: "focus" }
  | { from: number; kind: "pointer-down" }
  | { from: number; kind: "peek"; url: string }
  | { from: number; kind: "split"; url: string }
  | { from: number; kind: "key"; name: string };
interface LiveDesktop {
  webview: boolean;
  partition: string;
  setPageDensity(id: number, density: number): Promise<void>;
  setPageActive?(id: number, active: boolean): Promise<void>;
  reloadClip?(id: number, url: string): Promise<void>;
  onGuestInput(callback: (input: GuestInput) => void): () => void;
  onOpenTab(callback: (request: { from: number; url: string }) => void): () => void;
}
const desktop = (window as unknown as { orvaneDesktop?: LiveDesktop }).orvaneDesktop;

const props = defineProps<{ block: Block }>();
const editable = inject(workbenchEditable);
const clip = computed(() => readWidget<BrowserClip>(props.block.value));
const url = computed(() =>
  typeof clip.value.url === "string" && /^https?:\/\//i.test(clip.value.url) ? clip.value.url : "",
);
const saved = computed(() => readRect(clip.value.rect));
const isElement = computed(() => clip.value.pick === "element" && typeof clip.value.selector === "string");
const fill = computed(() => isElement.value && clip.value.fill === true);
// The page is laid out at the size it had when pinned (at least as large
// as the clipped part), so the clipped part looks the same.
const pageSize = computed(() => {
  const size = readSize(clip.value.viewport) ?? { width: 1280, height: 800 };
  const rect = saved.value;
  return {
    width: Math.min(8000, Math.max(size.width, rect?.width ?? 0)),
    height: Math.min(8000, Math.max(size.height, rect?.height ?? 0)),
  };
});
// Set once: the page navigates on its own after that (in-page apps).
const startUrl = url.value;
const available = !!desktop?.webview && !!startUrl && !!saved.value;

const root = ref<HTMLElement>();
const stage = ref<HTMLElement>();
const view = ref<WebviewElement>();
const box = reactive({ width: 0, height: 0 });
/** Where the clipped part is in the page's viewport, as the page reports. */
const target = ref<ClipRect>();
const found = ref(true);
const muted = ref(false);
const interacting = ref(false);

const layout = computed(() => {
  const { width, height } = box;
  if (!width || !height) return null;
  if (fill.value) return { scale: 1, window: { left: 0, top: 0, width, height }, page: { left: 0, top: 0 } };
  const part = target.value;
  if (!part) return null;
  const scale = Math.min(4, width / part.width, height / part.height);
  const shown = { width: part.width * scale, height: part.height * scale };
  return {
    scale,
    window: { left: (width - shown.width) / 2, top: (height - shown.height) / 2, ...shown },
    page: { left: -part.x * scale, top: -part.y * scale },
  };
});
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const windowStyle = computed(() => {
  const l = layout.value;
  return l
    ? { left: px(l.window.left), top: px(l.window.top), width: px(l.window.width), height: px(l.window.height) }
    : // Until the page reports, it loads (invisibly) at full size: a page in
      // a zero-size box would count as hidden and might not run.
      { left: "0", top: "0", width: "100%", height: "100%" };
});
const pageStyle = computed(() => {
  const l = layout.value;
  if (fill.value) return { left: "0", top: "0", width: px(box.width || 1), height: px(box.height || 1) };
  return {
    left: px(l?.page.left ?? 0),
    top: px(l?.page.top ?? 0),
    width: `${pageSize.value.width}px`,
    height: `${pageSize.value.height}px`,
    transform: `scale(${l?.scale ?? 1})`,
  };
});

function guestId() {
  try {
    return view.value?.getWebContentsId();
  } catch {
    return undefined; // Not attached yet.
  }
}
function track() {
  const rect = saved.value;
  if (!view.value || !rect) return;
  runInPage(
    view.value,
    trackerScript({ selector: isElement.value ? clip.value.selector : undefined, rect, fill: fill.value }),
  ).catch(() => undefined);
}
watch(fill, () => {
  if (!fill.value) target.value = undefined;
  track();
});

// Sharp text at any canvas zoom: the page renders at its on-screen density.
let densityTimer: ReturnType<typeof setTimeout> | undefined;
function applyDensity() {
  clearTimeout(densityTimer);
  densityTimer = setTimeout(() => {
    const id = guestId();
    const el = stage.value;
    if (id === undefined || !el?.offsetWidth || !desktop) return;
    const canvas = el.getBoundingClientRect().width / el.offsetWidth;
    const density = devicePixelRatio * canvas * (layout.value?.scale ?? 1);
    void desktop.setPageDensity(id, Math.min(8, Math.max(0.5, density))).catch(() => undefined);
  }, 150);
}
watch(() => layout.value?.scale, applyDensity);
function cameraChanged(event: Event) {
  if (!(event as CustomEvent<{ moving?: boolean }>).detail?.moving) applyDensity();
}

// Off screen and silent: the page pauses like a hidden Browser tab. It
// never pauses before it has shown the clipped part (a paused page can't
// report where that is). A paused page stays paused across loads, so after
// each load the wanted state is sent again rather than assumed.
let onScreen = true,
  hasShown = false,
  playing = false,
  sent: boolean | undefined,
  pauseTimer: ReturnType<typeof setTimeout> | undefined;
function setActive(want: boolean) {
  const id = guestId();
  if (id === undefined || !desktop?.setPageActive || sent === want) return;
  sent = want;
  void desktop.setPageActive(id, want).catch(() => undefined);
}
function updateActivity() {
  clearTimeout(pauseTimer);
  if (onScreen || playing || !hasShown) setActive(true);
  else pauseTimer = setTimeout(() => setActive(false), 5000);
}

// A page that has not said where the clipped part is: wake it and ask again
// a few times, then say so instead of loading forever.
const silent = ref(false);
const failed = ref(false);
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
function retryWhenVisible() {
  if (!onScreen || retryTimer !== undefined || retries >= 3 || !(failed.value || silent.value)) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (!onScreen || !(failed.value || silent.value)) return;
    retries++;
    void reloadPage();
  }, 2000 * 2 ** retries);
}
let askTimer: ReturnType<typeof setTimeout> | undefined,
  asked = 0;
function askAgain() {
  clearTimeout(askTimer);
  askTimer = setTimeout(() => {
    if (target.value || !onScreen) return;
    if (asked++ >= 3) {
      silent.value = true;
      retryWhenVisible();
      return;
    }
    sent = undefined;
    setActive(true);
    track();
    askAgain();
  }, 4000);
}

function openLink(link: string) {
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: { external: true, sourceBlockId: clip.value.blockId, link: { kind: "page", target: link, label: link } },
    }),
  );
}
function openOriginal() {
  if (url.value) openLink(url.value);
}
let reloadGeneration = 0;
async function reloadPage() {
  const page = view.value;
  if (!page) return;
  const generation = ++reloadGeneration;
  clearTimeout(askTimer);
  target.value = undefined;
  found.value = true;
  silent.value = false;
  failed.value = false;
  const id = guestId();
  setActive(true);
  try {
    if (id !== undefined && desktop?.reloadClip) await desktop.reloadClip(id, startUrl);
    else await page.loadURL(startUrl);
  } catch (error) {
    if (generation !== reloadGeneration || view.value !== page || String(error).includes("ERR_ABORTED")) return;
    failed.value = true;
    retryWhenVisible();
  }
}
function reload() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retries = 0;
  void reloadPage();
}
function toggleMute() {
  muted.value = !muted.value;
  view.value?.setAudioMuted(muted.value);
}
function toggleFill() {
  if (!editable?.() || !isElement.value) return;
  props.block.value = JSON.stringify({ ...clip.value, fill: !fill.value });
}

// A page swallows pointer and wheel events, which would stop canvas
// panning over it: a shield covers it until clicked, like Browser pages.
function shieldDown(event: PointerEvent) {
  if (event.button !== 0) return;
  interacting.value = true;
  activateApp(appOf(root.value));
  nextTick(() => view.value?.focus());
}
function leave(event: Event) {
  if (event.target !== view.value) interacting.value = false;
}

let stopInput: (() => void) | undefined,
  stopOpenTab: (() => void) | undefined,
  resize: ResizeObserver | undefined,
  visible: IntersectionObserver | undefined;
function bind(element: WebviewElement) {
  function loadFailed() {
    clearTimeout(askTimer);
    target.value = undefined;
    failed.value = true;
    retryWhenVisible();
  }
  element.addEventListener("did-fail-load", (event) => {
    const { isMainFrame, errorCode } = event as Event & { isMainFrame: boolean; errorCode: number };
    if (!isMainFrame || errorCode === -3) return; // Chromium reports cancelled navigations as failures.
    loadFailed();
  });
  element.addEventListener("render-process-gone", loadFailed);
  element.addEventListener("did-start-navigation", (event) => {
    const { isMainFrame, isInPlace } = event as Event & { isMainFrame: boolean; isInPlace: boolean };
    if (!isMainFrame || isInPlace) return;
    clearTimeout(askTimer);
    clearTimeout(retryTimer);
    retryTimer = undefined;
    target.value = undefined;
    failed.value = false;
    silent.value = false;
  });
  element.addEventListener("dom-ready", () => {
    if (failed.value) return;
    sent = undefined;
    updateActivity();
    track();
    applyDensity();
    if (muted.value) element.setAudioMuted(true);
    asked = 0;
    askAgain();
  });
  element.addEventListener("console-message", (event) => {
    const message = readTrackerMessage((event as Event & { message: string }).message);
    if (!message) return;
    if ("open" in message) return openLink(message.open);
    target.value = message.rect;
    hasShown = true;
    found.value = message.found;
    silent.value = false;
    failed.value = false;
    retries = 0;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    clearTimeout(askTimer);
  });
  element.addEventListener("media-started-playing", () => ((playing = true), updateActivity()));
  element.addEventListener("media-paused", () => ((playing = false), updateActivity()));
}
onMounted(() => {
  if (!available) return;
  if (view.value) bind(view.value);
  resize = new ResizeObserver(() => {
    if (!stage.value) return;
    box.width = stage.value.clientWidth;
    box.height = stage.value.clientHeight;
  });
  if (stage.value) resize.observe(stage.value);
  visible = new IntersectionObserver(([entry]) => {
    onScreen = !!entry?.isIntersecting;
    updateActivity();
    if (onScreen) {
      retryWhenVisible();
      if (!target.value && !failed.value && !silent.value) askAgain();
    }
  });
  if (root.value) visible.observe(root.value);
  window.addEventListener("orvane-camera", cameraChanged);
  document.addEventListener("focusin", leave);
  document.addEventListener("pointerdown", leave, true);
  // Canvas gestures made over the page come back from the main process.
  stopInput = desktop!.onGuestInput((input) => {
    if (input.from !== guestId() || input.kind === "pointer-down") return;
    if (input.kind === "focus") return activateApp(appOf(root.value));
    if (input.kind === "peek" || input.kind === "split") return openLink(input.url);
    if (input.kind === "key") {
      if (input.name === "space-down" || input.name === "space-up")
        window.dispatchEvent(new CustomEvent("orvane:space", { detail: input.name === "space-down" }));
      return;
    }
    if (input.kind === "pan") {
      window.dispatchEvent(new CustomEvent("orvane-canvas-pan", { detail: { dx: input.dx, dy: input.dy } }));
      return;
    }
    const el = view.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const scale = el.offsetWidth ? rect.width / el.offsetWidth : 1;
    const at =
      "clientX" in input
        ? { clientX: input.clientX, clientY: input.clientY }
        : { clientX: rect.left + input.x * scale, clientY: rect.top + input.y * scale };
    el.dispatchEvent(
      new WheelEvent("wheel", { ...at, deltaY: input.deltaY, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  stopOpenTab = desktop!.onOpenTab((request) => {
    if (request.from === guestId()) openLink(request.url);
  });
});
onBeforeUnmount(() => {
  clearTimeout(densityTimer);
  clearTimeout(pauseTimer);
  clearTimeout(askTimer);
  clearTimeout(retryTimer);
  resize?.disconnect();
  visible?.disconnect();
  stopInput?.();
  stopOpenTab?.();
  window.removeEventListener("orvane-camera", cameraChanged);
  document.removeEventListener("focusin", leave);
  document.removeEventListener("pointerdown", leave, true);
});
</script>

<template>
  <div ref="root" class="workbench-widget live-clip-view">
    <div class="workbench-actions">
      <button
        v-if="isElement"
        type="button"
        class="subtle-button"
        :aria-pressed="fill"
        :disabled="!editable?.() || !available"
        :title="fill ? 'Show the element as it sits on the page' : 'Let the element fill the whole clip'"
        @click="toggleFill"
      >
        <Icon :name="fill ? 'shrink' : 'expand'" :size="14" />{{ fill ? "Fit to page" : "Fill clip" }}
      </button>
      <button type="button" class="subtle-button" :disabled="!available" @click="toggleMute">
        <Icon :name="muted ? 'mute' : 'sound'" :size="14" />{{ muted ? "Unmute" : "Mute" }}
      </button>
      <button type="button" class="subtle-button" :disabled="!available" @click="reload">
        <Icon name="refresh" :size="14" />Reload
      </button>
      <button type="button" class="subtle-button" :disabled="!url" @click="openOriginal">
        <Icon name="external" :size="14" />Open original
      </button>
      <span v-if="url" class="clip-url" :title="url">{{ url }}</span>
    </div>
    <p v-if="available && !found" class="workbench-status" role="status">
      The picked element isn't on the page right now; showing the area it was in.
    </p>
    <div ref="stage" class="live-clip-stage">
      <template v-if="available">
        <div class="live-clip-window" :style="windowStyle" :class="{ ready: !!layout }">
          <webview
            ref="view"
            class="live-clip-page"
            :style="pageStyle"
            :src="startUrl"
            :partition="desktop!.partition"
            allowpopups
          ></webview>
        </div>
        <p v-if="!layout" class="live-clip-note">
          {{ failed ? "The clipped page could not load. You can also retry with Reload." : silent ? "The page isn't showing the clipped part. Try Reload." : "Loading the page…" }}
        </p>
        <div
          v-if="!interacting"
          class="live-clip-shield"
          :style="windowStyle"
          role="button"
          tabindex="-1"
          aria-label="Use the live clip"
          @pointerdown="shieldDown"
        ></div>
      </template>
      <p v-else class="live-clip-note">
        {{ desktop?.webview ? "This live clip has no page to show." : "Live clips need the Orvane desktop app." }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.live-clip-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.live-clip-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.live-clip-window {
  position: absolute;
  overflow: hidden;
  border-radius: 4px;
  opacity: 0;
}
.live-clip-window.ready {
  opacity: 1;
}
.live-clip-page {
  position: absolute;
  transform-origin: 0 0;
  border: 0;
}
.live-clip-shield {
  position: absolute;
  cursor: pointer;
}
.live-clip-note {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: #526b79;
  pointer-events: none;
}
/* Buttons and the address on one line (the shared toolbar aligns form
   fields by their bottom edge). */
.live-clip-view .workbench-actions {
  align-items: center;
}
.clip-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 120px;
  color: #526b79;
}
</style>
