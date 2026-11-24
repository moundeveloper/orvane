<script setup>
// UI Maker Lab: the variants of one round side by side as tabs, live and
// interactive. Agents write rounds and variants through the uimaker_lab_*
// MCP tools; picking a variant saves it as the component's next iteration.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { labUrl } from './editor.js';
import { forwardCanvasZoom } from './overlay.js';
import { adoptScrollbars } from '../../scrollbars';

const props = defineProps({ model: Object, editor: Object, zoom: Number });
const ui = props.model.ui;
const rounds = computed(() => props.model.lab[ui.c] ?? []);
const open = computed(() => rounds.value.find(r => r.status === 'open'));
const round = computed(() => rounds.value.find(r => r.id === ui.labRound));
const variant = computed(() => round.value?.variants.find(v => v.id === ui.labVariant));

// Follow the work: a newly opened round is shown as soon as it appears, and
// a round always has a tab selected once it has variants.
watch(() => [ui.c, open.value?.id], ([c, openId], previous) => {
  const [lastC, lastOpen] = previous ?? [];
  if (c !== lastC || !round.value || (openId && openId !== lastOpen)) ui.labRound = openId ?? rounds.value[0]?.id ?? null;
}, { immediate: true });
watch(() => [round.value?.id, round.value?.variants.length], () => {
  if (round.value && !variant.value) ui.labVariant = round.value.variants[0]?.id ?? null;
}, { immediate: true });

// A picked round is a snapshot: later versions (a delivered brief, another
// round's pick) live in Review, so the chip says which one is newest.
const latest = computed(() => (props.model.versions[ui.c] ?? []).at(-1)?.n);
const newer = computed(() => round.value?.status === 'picked' && latest.value > round.value.pickedAs ? latest.value : null);

const src = computed(() => variant.value && labUrl(ui.c, round.value.id, variant.value.id, variant.value.mtime));
const picking = ref(false);
let stopPreviewPan;
watch(src, () => stopPreviewPan?.());
onBeforeUnmount(() => stopPreviewPan?.());

function loadPreview(frame) {
  stopPreviewPan?.();
  const doc = frame.contentDocument;
  if (!doc) return;
  adoptScrollbars(doc);
  forwardCanvasZoom(frame);

  // Live previews receive these gestures in their own document. Use the
  // same canvas events as other embedded apps.
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  let drag;
  doc.addEventListener('pointerdown', event => {
    if (event.button !== 1) return;
    event.preventDefault();
    doc.documentElement.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY };
  }, options);
  doc.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId || !(event.buttons & 4)) return;
    const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY };
    if (dx || dy) window.dispatchEvent(new CustomEvent('orvane-canvas-pan', { detail: { dx, dy } }));
  }, options);
  doc.addEventListener('lostpointercapture', event => {
    if (drag?.id === event.pointerId) drag = undefined;
  }, options);
  doc.addEventListener('auxclick', event => {
    if (event.button === 1) event.preventDefault();
  }, options);

  let spaceHeld = false;
  function releaseSpace() {
    if (!spaceHeld) return;
    spaceHeld = false;
    window.dispatchEvent(new CustomEvent('orvane:space', { detail: false }));
  }
  doc.addEventListener('keydown', event => {
    if (spaceHeld || event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey ||
        event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false])')) return;
    spaceHeld = true;
    window.dispatchEvent(new CustomEvent('orvane:space', { detail: true }));
  }, options);
  doc.addEventListener('keyup', event => {
    if (event.code === 'Space') releaseSpace();
  }, options);
  doc.defaultView?.addEventListener('blur', releaseSpace, { signal: listeners.signal });
  stopPreviewPan = () => {
    releaseSpace();
    listeners.abort();
    stopPreviewPan = undefined;
  };
}
async function pick() {
  picking.value = true;
  try { await props.editor.labPick(round.value.id, variant.value.id); }
  finally { picking.value = false; }
}
</script>

<template>
<section class="lab" aria-label="Lab">
  <header v-if="round" class="lab-bar">
    <span class="lab-kind">{{ round.kind === 'new' ? 'New' : 'Redesign' }}</span>
    <b class="lab-title" :title="round.title">{{ round.title }}</b>
    <div v-if="round.variants.length" class="pills lab-tabs" role="tablist" aria-label="Variants">
      <button v-for="(item, index) in round.variants" :key="item.id" role="tab" :class="{ on: item.id === ui.labVariant }"
        :aria-selected="item.id === ui.labVariant" :title="index < 9 ? `${item.label} (${index + 1})` : item.label"
        @click="ui.labVariant = item.id">{{ item.label }}<span v-if="item.id === round.picked" class="lab-won" aria-label="picked"></span></button>
    </div>
    <div class="spacer"></div>
    <span v-if="round.status === 'picked'" class="chip green">Picked as v{{ round.pickedAs }}</span>
    <span v-if="newer" class="chip lab-newer" :title="`v${newer} is newer than this round. Open it in Review.`">Now v{{ newer }}</span>
    <span v-else-if="round.status === 'closed'" class="chip">Closed</span>
    <button v-else class="btn primary" :disabled="!variant || picking" @click="pick">Pick</button>
  </header>
  <div class="lab-stage" :style="{ '--lab-zoom': zoom }">
    <div v-if="src" class="lab-scroll">
      <div class="lab-preview">
        <iframe :key="src" :src="src" :title="variant.label" @load="loadPreview($event.target)"></iframe>
      </div>
    </div>
    <p v-else class="lab-empty">{{ round ? 'No variants yet' : 'No rounds yet' }}</p>
  </div>
</section>
</template>
