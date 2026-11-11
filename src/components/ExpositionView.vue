<script setup lang="ts">
import { computed } from "vue";
import type { VisualRecord } from "../exposition";
import ExpositionPart from "./ExpositionPart.vue";
import "../exposition.css";
const props = defineProps<{ visual: VisualRecord; expanded?: boolean }>();
defineEmits<{ expand: [visual: VisualRecord] }>();
const overview = computed(() =>
  props.visual.view.parts.filter((part) => !part.detail),
);
const details = computed(() =>
  props.visual.view.parts.filter((part) => part.detail),
);
</script>
<template>
  <article class="exposition" :aria-label="visual.view.title">
    <header class="ex-header">
      <div>
        <h3>{{ visual.view.title }}</h3>
        <span class="ex-caption"
          >{{ visual.view.status }} · revision {{ visual.revision }}</span
        >
      </div>
      <button v-if="!expanded" type="button" @click="$emit('expand', visual)">
        Expand
      </button>
    </header>
    <p v-if="visual.view.summary" class="ex-summary">
      {{ visual.view.summary }}
    </p>
    <ExpositionPart
      v-for="part in overview"
      :key="`${visual.revision}:${part.id}`"
      :part="part"
    />
    <details v-for="part in details" :key="part.id" class="ex-part-detail">
      <summary>{{ part.title }}</summary>
      <ExpositionPart :key="visual.revision" :part="part" />
    </details>
    <details v-if="visual.view.sources.length">
      <summary>Sources</summary>
      <ul>
        <li v-for="(s, i) in visual.view.sources" :key="i">{{ s }}</li>
      </ul>
    </details>
  </article>
</template>
