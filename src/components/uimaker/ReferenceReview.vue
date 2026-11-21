<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { ReferenceCandidate } from "../../uimakerReferenceReview";
import ImagePeek from "../ImagePeek.vue";

const props = defineProps<{ name: string; candidates: ReferenceCandidate[]; busy: boolean; error: string }>();
const emit = defineEmits<{ accept: [sources: string[]]; alternatives: [feedback: string]; close: [] }>();
const selected = ref<string[]>([]);
const feedback = ref("");
const root = ref<HTMLElement>();
const imageOf = (candidate: ReferenceCandidate) => 'data:' + candidate.mime + ';base64,' + candidate.data;
function toggle(source: string) {
  selected.value = selected.value.includes(source) ? selected.value.filter(item => item !== source) : [...selected.value, source];
}
// Peek: a candidate full window, to pan and zoom before choosing.
const peek = ref<number | null>(null);
const peekItems = computed(() => props.candidates.map(candidate => ({ src: imageOf(candidate), title: candidate.title, source: candidate.source })));
function step(by: number) {
  if (peek.value === null) return;
  peek.value = (peek.value + by + props.candidates.length) % props.candidates.length;
}
function closePeek() {
  const index = peek.value;
  peek.value = null;
  void nextTick(() => root.value?.querySelectorAll<HTMLElement>('.reference-candidate > button:not(.candidate-peek)')[index ?? 0]?.focus({ preventScroll: true }));
}
function candidateKey(event: KeyboardEvent, index: number) {
  if (event.key !== ' ' || event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  peek.value = index;
}
</script>

<template>
  <section ref="root" class="reference-review select-popover" role="dialog" aria-label="Review visual references" tabindex="-1"
    @keydown.esc.stop.prevent="emit('close')" @wheel.stop>
    <header>
      <div><h2>Review visual references</h2><p>{{ name }}</p></div>
      <button type="button" class="btn" aria-label="Close reference review" @click="emit('close')">×</button>
    </header>
    <div class="reference-candidates" role="group" aria-label="Reference candidates">
      <article v-for="(candidate, index) in candidates" :key="candidate.source" class="reference-candidate">
        <button type="button" :disabled="busy" :aria-label="candidate.title" :aria-pressed="selected.includes(candidate.source)"
          aria-keyshortcuts="Space" @click="toggle(candidate.source)" @keydown="candidateKey($event, index)">
          <img :src="imageOf(candidate)" alt="" decoding="async" />
          <span class="candidate-label"><span>{{ candidate.title }}</span><span class="candidate-check" aria-hidden="true">{{ selected.includes(candidate.source) ? '✓' : '' }}</span></span>
        </button>
        <button type="button" class="candidate-peek" :aria-label="'Peek ' + candidate.title" title="Peek (Space)" @click="peek = index">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>
        </button>
        <a :href="candidate.source" target="_blank" rel="noopener noreferrer" :aria-label="'Open source for ' + candidate.title">View source ↗</a>
      </article>
    </div>
    <footer>
      <p v-if="error" class="review-error" role="alert">{{ error }}</p>
      <input v-model="feedback" type="text" maxlength="400" aria-label="Feedback for alternatives" placeholder="What should be different? (optional)" :disabled="busy" />
      <div class="review-actions">
        <button type="button" class="btn" :disabled="busy" @click="emit('alternatives', feedback.trim())">Reject and find others</button>
        <button type="button" class="btn primary" :disabled="busy || !selected.length" @click="emit('accept', selected)">
          {{ busy ? 'Adding…' : selected.length ? 'Add selected (' + selected.length + ')' : 'Add selected' }}
        </button>
      </div>
    </footer>
    <ImagePeek v-if="peek !== null" :items="peekItems" :index="peek" :selected="selected.includes(candidates[peek]!.source)"
      @close="closePeek" @step="step" @toggle="toggle(candidates[peek!]!.source)" />
  </section>
</template>

<style scoped>
.uimaker .reference-review {
  position: absolute; inset: 53px 12px auto auto; z-index: 75;
  display: flex; flex-direction: column; gap: 10px; width: min(650px, calc(100% - 24px)); max-height: calc(100% - 65px);
  overflow: auto; padding: 12px; background: var(--um-surface); color: var(--um-ink);
  border: 1px solid var(--um-line2); border-radius: 9px; box-shadow: var(--um-shadow);
  overscroll-behavior: contain;
}
.reference-review header, .review-actions { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
.reference-review h2 { margin: 0; font-size: 14px; color: var(--um-strong); }
.reference-review p { margin: 2px 0 0; color: var(--um-mut); }
.reference-candidates { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(125px, 100%), 1fr)); gap: 8px; }
.reference-candidate { position: relative; min-width: 0; }
.reference-candidate .candidate-peek {
  position: absolute; top: 5px; right: 5px; display: grid; place-items: center; width: 26px; height: 26px; padding: 0;
  border: 1px solid var(--um-line2); border-radius: 6px; background: color-mix(in srgb, var(--um-card) 88%, transparent);
  color: var(--um-ink); opacity: 0; transition: opacity .12s ease;
}
.reference-candidate:hover .candidate-peek, .reference-candidate:focus-within .candidate-peek { opacity: 1; }
.candidate-peek svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.reference-candidate > button:not(.candidate-peek) { width: 100%; border: 1px solid var(--um-line2); border-radius: 7px; background: var(--um-card); overflow: hidden; text-align: left; }
.reference-candidate > button:not(.candidate-peek):hover { border-color: var(--um-accent); }
.reference-candidate > button[aria-pressed="true"] { border-color: var(--um-accent); background: var(--um-hover); }
.reference-candidate img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; background: var(--um-well); }
.candidate-label { display: flex; justify-content: space-between; align-items: start; gap: 6px; min-height: 32px; padding: 6px; overflow-wrap: anywhere; }
.candidate-check { display: grid; place-items: center; flex: 0 0 15px; height: 15px; border: 1px solid var(--um-accent); border-radius: 4px; }
[aria-pressed="true"] .candidate-check { background: var(--um-accent); color: white; }
.reference-candidate a { display: inline-block; padding: 3px 2px 0; color: var(--um-mut); }
.reference-review footer { display: grid; gap: 8px; }
.reference-review input { width: 100%; padding: 6px 8px; border: 1px solid var(--um-line2); border-radius: 6px; background: var(--um-card); }
.reference-review .review-error { color: var(--um-red); }
</style>
