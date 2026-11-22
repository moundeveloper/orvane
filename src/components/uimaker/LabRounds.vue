<script setup>
// The component's lab rounds, newest first: the one being worked on now,
// then the past redesigns and new designs with what was picked.
import { computed, ref } from 'vue';
import { ago } from './editor.js';

const props = defineProps({ model: Object });
const ui = props.model.ui;
const rounds = computed(() => props.model.lab[ui.c] ?? []);
const label = (round, id) => round.variants.find(v => v.id === id)?.label ?? id;
// The agent's explanation of the selected variant, under the rounds list.
// Folded, it shows one line; the choice is remembered.
const variant = computed(() => rounds.value.find(r => r.id === ui.labRound)?.variants.find(v => v.id === ui.labVariant));
const aboutOpen = ref((() => { try { return localStorage.getItem('orvane.lab-about') !== 'folded'; } catch { return true; } })());
function toggleAbout() {
  aboutOpen.value = !aboutOpen.value;
  try { localStorage.setItem('orvane.lab-about', aboutOpen.value ? 'open' : 'folded'); } catch {}
}
function show(round) {
  ui.labRound = round.id;
  ui.labVariant = round.picked ?? round.variants[0]?.id ?? null;
}
</script>

<template>
<div class="lab-rounds">
  <h3>Rounds</h3>
  <nav v-if="rounds.length" aria-label="Lab rounds">
    <button v-for="round in rounds" :key="round.id" class="lab-round" :class="{ on: round.id === ui.labRound }"
      :aria-current="round.id === ui.labRound ? 'true' : undefined" @click="show(round)">
      <span class="lab-round-top">
        <b>{{ round.title }}</b>
        <small v-if="round.status === 'open'" class="lab-now">Now</small>
      </span>
      <span class="lab-round-meta">
        <span>{{ round.kind === 'new' ? 'New' : 'Redesign' }}</span>
        <span v-if="round.status === 'picked'">{{ label(round, round.picked) }} → v{{ round.pickedAs }}</span>
        <span v-else>{{ round.variants.length }} {{ round.variants.length === 1 ? 'variant' : 'variants' }}</span>
        <span>{{ ago(round.at) }}</span>
      </span>
    </button>
  </nav>
  <p v-else class="lab-none">No rounds yet</p>
  <section v-if="variant?.about" class="lab-about" :class="{ folded: !aboutOpen }" role="note" aria-label="About this variant">
    <header>
      <h3>About {{ variant.label }}</h3>
      <button class="btn" type="button" :aria-expanded="aboutOpen" @click="toggleAbout">{{ aboutOpen ? 'Fold' : 'More' }}</button>
    </header>
    <p>{{ variant.about }}</p>
  </section>
</div>
</template>
