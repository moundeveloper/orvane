<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { uid, type Block } from "../model";
import Icon from "./Icon.vue";

const props = defineProps<{ block: Block; editing: boolean }>();

interface BrowserTab {
  id: string;
  url: string;
}
interface TabHistory {
  stack: string[];
  index: number;
  reloads: number;
}

const START = "";
function readState() {
  try {
    const saved = JSON.parse(props.block.value || "{}") as {
      tabs?: unknown;
      active?: unknown;
    };
    const tabs = Array.isArray(saved.tabs)
      ? saved.tabs
          .filter(
            (t): t is BrowserTab =>
              !!t &&
              typeof t.id === "string" &&
              typeof t.url === "string" &&
              (t.url === START || !!safeUrl(t.url)),
          )
          .slice(0, 12)
      : [];
    if (tabs.length)
      return {
        tabs,
        active: tabs.some((t) => t.id === saved.active)
          ? (saved.active as string)
          : tabs[0]!.id,
      };
  } catch {
    // Unreadable state starts a fresh browser.
  }
  const id = uid();
  return { tabs: [{ id, url: START }], active: id };
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
const nav = computed(() => {
  void revision.value;
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
  const entry = history(activeTab.value);
  const index = entry.index + delta;
  if (index < 0 || index >= entry.stack.length) return;
  entry.index = index;
  show(entry.stack[index]!);
}
function reload() {
  history(activeTab.value).reloads++;
  revision.value++;
}
function openExternal() {
  if (activeTab.value.url)
    window.open(activeTab.value.url, "_blank", "noopener,noreferrer");
}
function addTab() {
  const tab = { id: uid(), url: START };
  state.value.tabs.push(tab);
  selectTab(tab.id);
  nextTick(() => addressInput.value?.focus());
}
function selectTab(id: string) {
  state.value.active = id;
  address.value = activeTab.value.url;
  error.value = "";
  save();
}
function closeTab(id: string) {
  const tabs = state.value.tabs;
  const index = tabs.findIndex((t) => t.id === id);
  histories.delete(id);
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
function label(url: string) {
  if (!url) return "New tab";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// A cross-origin page swallows every pointer and wheel event, which would
// stop canvas panning and zooming over it. A shield covers the page until
// it is clicked, and returns as soon as focus leaves the frame.
const frame = ref<HTMLIFrameElement>();
const addressInput = ref<HTMLInputElement>();
const interacting = ref(false);
function focusFrame() {
  interacting.value = true;
  nextTick(() => frame.value?.focus());
}
function leaveFrame(event: Event) {
  // Events inside the cross-origin page never reach this document, so any
  // pointer or focus event here means the user is outside the page.
  if (event.target !== frame.value) interacting.value = false;
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
        @auxclick.prevent="$event.button === 1 && closeTab(tab.id)"
      >
        <Icon name="globe" :size="12" />
        <span>{{ label(tab.url) }}</span>
        <button
          class="browser-tab-close"
          :aria-label="`Close ${label(tab.url)}`"
          @click.stop="closeTab(tab.id)"
        >
          <Icon name="close" :size="11" />
        </button>
      </div>
      <button
        v-if="state.tabs.length < 12"
        class="icon-button"
        aria-label="New tab"
        @click="addTab"
      >
        <Icon name="plus" :size="13" />
      </button>
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
        class="icon-button"
        aria-label="Open in your browser"
        :disabled="!activeTab.url"
        @click="openExternal"
      >
        <Icon name="external" :size="13" />
      </button>
    </form>
    <p v-if="error" class="browser-error" role="alert">{{ error }}</p>
    <div class="browser-page">
      <iframe
        v-if="activeTab.url"
        ref="frame"
        :key="`${activeTab.id}:${nav.reloads}:${activeTab.url}`"
        :src="activeTab.url"
        :title="`Web page: ${label(activeTab.url)}`"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
        referrerpolicy="strict-origin-when-cross-origin"
        allow=""
      ></iframe>
      <div v-else class="browser-start">
        <Icon name="globe" :size="22" />
        <p>Search or enter an address above.</p>
        <small
          >Some sites refuse to be shown inside other apps. If a page stays
          blank, open it in your browser.</small
        >
      </div>
      <div
        v-if="activeTab.url && (!interacting || editing)"
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
.browser-error {
  margin: 0;
  padding: 7px 14px;
  font-size: 11px;
  color: #9a4b45;
  background: #f7ecea;
  flex: none;
}
.browser-page {
  position: relative;
  flex: 1;
  min-height: 0;
  border-top: 1px solid var(--line);
  background: #fff;
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
