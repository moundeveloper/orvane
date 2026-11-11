<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import type { ExpositionPart } from "../exposition";
const props = defineProps<{
  part: Extract<ExpositionPart, { type: "sequence" }>;
}>();
const root = ref<HTMLElement>(),
  width = ref(600),
  focus = ref(-1);
let observer: ResizeObserver;
const compact = computed(
  () => width.value / props.part.participants.length < 95,
);
const x = (id: string) =>
  ((props.part.participants.findIndex((p) => p.id === id) + 0.5) *
    width.value) /
  props.part.participants.length;
const name = (id: string) =>
  props.part.participants.find((p) => p.id === id)?.name || id;
function route(from: string, to: string) {
  const a = x(from),
    b = x(to);
  return a === b ? `M ${a} 6 H ${a + 22} V 28 H ${a}` : `M ${a} 28 H ${b}`;
}
function head(from: string, to: string) {
  const b = x(to),
    dir = from === to ? -1 : Math.sign(b - x(from));
  return `M ${b - dir * 6} 24 L ${b} 28 L ${b - dir * 6} 32`;
}
onMounted(() => {
  observer = new ResizeObserver(() => {
    width.value = root.value?.clientWidth || 600;
  });
  observer.observe(root.value!);
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <div ref="root" class="ex-sequence" :class="{ compact }">
    <div
      class="ex-participants"
      :style="{
        gridTemplateColumns: compact
          ? 'repeat(2,minmax(0,1fr))'
          : `repeat(${part.participants.length},minmax(0,1fr))`,
      }"
    >
      <span v-for="p in part.participants" :key="p.id">{{ p.name }}</span>
    </div>
    <div
      v-for="(m, i) in part.messages"
      :key="i"
      class="ex-message"
      :class="{ focused: focus === i }"
    >
      <div class="ex-life" aria-hidden="true" v-if="!compact">
        <i
          v-for="p in part.participants"
          :key="p.id"
          :style="{ left: x(p.id) + 'px' }"
        ></i>
      </div>
      <button
        class="ex-message-label"
        type="button"
        :aria-pressed="focus === i"
        @click="focus = focus === i ? -1 : i"
      >
        {{ m.label }}
      </button>
      <div v-if="compact || focus === i" class="ex-caption">
        {{ name(m.from) }} {{ m.reply ? "← reply to →" : "→" }} {{ name(m.to) }}
      </div>
      <svg
        v-if="!compact"
        class="ex-seq-wire"
        :width="width"
        height="40"
        role="img"
        :aria-label="`${name(m.from)} to ${name(m.to)}${m.reply ? ', reply' : ''}`"
      >
        <path
          :d="route(m.from, m.to)"
          :stroke-dasharray="m.reply ? '4 4' : undefined"
        />
        <path :d="head(m.from, m.to)" />
      </svg>
    </div>
  </div>
</template>
