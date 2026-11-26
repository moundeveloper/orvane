<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import type { BrowserSources } from "../browserHighlights";
const props = defineProps<{ sources: BrowserSources; open: boolean; checking?: boolean; problem?: string }>();
const emit = defineEmits<{ jump: [id: string]; clear: []; "update:open": [open: boolean] }>();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const list = ref<HTMLElement>();
const bounds = ref({ width: 320, height: 410 });
let resize: ResizeObserver | undefined;
const index = computed(() => props.sources.passages.findIndex((p) => p.id === props.sources.selected));
const found = computed(() => props.sources.passages.filter((p) => p.found));
function step(delta: number) {
  const at = found.value.findIndex((p) => p.id === props.sources.selected);
  const next = found.value[(at + delta + found.value.length) % found.value.length];
  if (next) emit("jump", next.id);
}
function toggle() {
  emit("update:open", !props.open);
  if (!props.open) void nextTick(() => list.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
}
function close(focus = false) { emit("update:open", false); if (focus) trigger.value?.focus(); }
function outside(event: Event) { if (!root.value?.contains(event.target as Node)) close(); }
function guestOutside() { close(); }
function key(event: KeyboardEvent) {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const items = [...list.value?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
    (at + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true); window.addEventListener("orvane:guest-pointer-down", guestOutside);
  const parent = root.value?.parentElement;
  if (parent) { resize = new ResizeObserver(() => { bounds.value = { width: Math.min(320, parent.clientWidth - 32), height: Math.max(80, Math.min(410, parent.clientHeight - 74)) }; }); resize.observe(parent); }
});
onBeforeUnmount(() => { resize?.disconnect(); document.removeEventListener("pointerdown", outside, true); window.removeEventListener("orvane:guest-pointer-down", guestOutside); });
</script>
<template>
  <div ref="root" class="browser-sources" @pointerdown.stop @wheel.stop @keydown="key">
    <section v-if="open" class="sources-popover select-popover" aria-label="Source passages" :style="{ width: `${bounds.width}px`, maxHeight: `${bounds.height}px` }">
      <header><b>Sources</b><small>{{ sources.passages.length }} passages</small><span />
        <button type="button" aria-label="Clear source highlights" data-tip="Clear this tab's highlights" @click="emit('clear')"><Icon name="eraser" :size="13" /></button>
        <button type="button" aria-label="Close sources" @click="close(true)"><Icon name="close" :size="12" /></button>
      </header>
      <div class="source-page"><Icon name="file" :size="14" /><div><b>{{ sources.title }}</b><code>{{ sources.url }}</code></div></div>
      <p v-if="problem" class="source-problem" role="alert">{{ problem }}</p>
      <div ref="list" class="source-items" role="listbox" aria-label="Highlighted passages">
        <button v-for="(passage, i) in sources.passages" :key="passage.id" type="button" role="option"
          :aria-selected="passage.id === sources.selected" :disabled="!passage.found || checking || !!problem"
          :class="{ missing: !passage.found }" @click="emit('jump', passage.id)">
          <span class="source-number">{{ i + 1 }}</span><span class="source-label">{{ passage.label || `Passage ${i + 1}` }}</span>
          <q>{{ passage.text || passage.quote }}</q>
          <small v-if="checking">Looking on page…</small><small v-else-if="!passage.found && !problem">No longer found</small>
          <small v-else-if="passage.matches > 1">{{ passage.matches }} matches · first shown</small>
        </button>
      </div>
      <footer><span>Exact page text</span><kbd>↑</kbd><kbd>↓</kbd>move<kbd>Enter</kbd>jump</footer>
    </section>
    <div class="sources-stepper">
      <button ref="trigger" type="button" class="sources-open" :aria-expanded="open" aria-label="Source passages" @click="toggle">
        <Icon name="edit" :size="14" />Sources <b>{{ index + 1 }} of {{ sources.passages.length }}</b>
      </button><span class="source-sep" />
      <button type="button" aria-label="Previous source passage" :disabled="!found.length || checking || !!problem" @click="step(-1)"><Icon name="up" :size="12" /></button>
      <button type="button" aria-label="Next source passage" :disabled="!found.length || checking || !!problem" @click="step(1)"><Icon name="down" :size="12" /></button>
    </div>
  </div>
</template>
<style scoped>
.browser-sources { position: absolute; right: 16px; bottom: 16px; z-index: 30; max-width: calc(100% - 32px); color: #425b6c; font: 12px/1.5 "Inter Variable", Inter, sans-serif; }
.browser-sources button { display: inline-flex; align-items: center; justify-content: center; border: 0; background: none; color: #6c8594; font: inherit; cursor: pointer; }
.browser-sources button:focus-visible { outline: 2px solid #6e91a6; outline-offset: -2px; }
.browser-sources button:disabled { cursor: default; }
.sources-stepper { display: flex; align-items: center; gap: 2px; width: max-content; margin-left: auto; padding: 4px; border: 1px solid #d5e1e8; border-radius: 11px; background: #f8fafb; box-shadow: 0 2px 5px #263f5512, 0 8px 22px #263f5517; }
.sources-stepper > button { height: 28px; min-width: 26px; border-radius: 6px; }
.sources-stepper .sources-open { gap: 8px; padding: 0 9px 0 7px; color: #425b6c; font-weight: 550; white-space: nowrap; }
.sources-open[aria-expanded="true"], .sources-stepper button:hover:not(:disabled) { background: #e4edf2; }
.sources-open b { font-weight: 550; font-variant-numeric: tabular-nums; }
.source-sep { width: 1px; height: 18px; margin: 0 3px; background: #e3eaee; }
.sources-popover { position: absolute; right: 0; bottom: 48px; display: flex; flex-direction: column; padding: 0; overflow: hidden; border: 1px solid #d5e1e8; border-radius: 11px; background: #f8fafb; box-shadow: 0 2px 5px #263f5512, 0 8px 22px #263f5517; }
header { display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 4px 8px 4px 12px; }
header b { font-weight: 550; color: #273f50; }
header small { color: #8296a2; font-size: 11px; } header > span { flex: 1; }
header button { width: 26px; height: 26px; border-radius: 6px; } header button:hover { background: #e4edf2; }
.source-page { display: flex; gap: 8px; padding: 0 12px 10px; border-bottom: 1px solid #e3eaee; color: #6e91a6; }
.source-page > div { min-width: 0; } .source-page b { display: block; color: #425b6c; font-size: 11px; font-weight: 550; }
.source-page code { display: block; overflow: hidden; color: #8296a2; text-overflow: ellipsis; white-space: nowrap; font: 10.5px/1.5 "Cascadia Code", Consolas, monospace; }
.source-items { min-height: 0; overflow: auto; padding: 6px; }
.source-problem { margin: 0; padding: 8px 12px; color: #8a6430; font-size: 11px; }
.source-items > button { display: grid; grid-template-columns: 19px minmax(0, 1fr); justify-content: initial; align-items: start; gap: 3px 9px; width: 100%; padding: 8px; border-radius: 7px; text-align: left; }
.source-items > button:hover:not(:disabled), .source-items > button[aria-selected="true"] { background: #e4edf2; }
.source-items > button:disabled { opacity: 1; }
.source-number { display: grid; place-items: center; width: 19px; height: 19px; border-radius: 6px; background: #e1eef0; color: #456d7c; font-size: 10.5px; font-weight: 600; }
[aria-selected="true"] .source-number { background: #365f78; color: white; }
.source-label { color: #6c8594; font-size: 11px; }
q { grid-column: 2; color: #425b6c; font-size: 11.5px; overflow-wrap: anywhere; white-space: pre-line; } q::before, q::after { content: none; }
.source-items small { grid-column: 2; color: #8a6430; font-size: 11px; }
.missing .source-number { background: transparent; border: 1px dashed #b9a183; color: #8a6c42; }
.missing q { color: #5d7381; }
footer { display: flex; align-items: center; gap: 5px; min-height: 32px; padding: 4px 10px; border-top: 1px solid #e3eaee; color: #738894; font-size: 11px; white-space: nowrap; }
footer span { margin-right: auto; } kbd { padding: 0 4px; border: 1px solid #d6e0e6; border-radius: 4px; background: #fbfcfd; color: #5d7381; font: 10.5px/17px Consolas, monospace; }
</style>
