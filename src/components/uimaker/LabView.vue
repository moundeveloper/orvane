<script setup>
// UI Maker Lab: the variants of one round side by side as tabs, live and
// interactive. Agents write rounds and variants through the uimaker_lab_*
// MCP tools; picking a variant saves it as the component's next iteration.
import { computed, ref, watch } from 'vue';
import { labUrl } from './editor.js';
import { adoptScrollbars } from '../../scrollbars';

const props = defineProps({ model: Object, editor: Object });
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

const src = computed(() => variant.value && labUrl(ui.c, round.value.id, variant.value.id, variant.value.mtime));
const picking = ref(false);
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
    <span v-else-if="round.status === 'closed'" class="chip">Closed</span>
    <button v-else class="btn primary" :disabled="!variant || picking" @click="pick">Pick</button>
  </header>
  <div class="lab-stage">
    <iframe v-if="src" :key="src" :src="src" :title="variant.label" @load="adoptScrollbars($event.target.contentDocument)"></iframe>
    <p v-else class="lab-empty">{{ round ? 'No variants yet' : 'No rounds yet' }}</p>
  </div>
</section>
</template>
