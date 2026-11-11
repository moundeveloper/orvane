<script setup lang="ts">
import {
  computed,
  onMounted,
  onBeforeUnmount,
  ref,
  useId,
  watch,
  nextTick,
} from "vue";
import type { ExpositionPart } from "../exposition";
import ExpositionCanvas from "./ExpositionCanvas.vue";
const props = defineProps<{
  part: Extract<ExpositionPart, { type: "flow" }>;
}>();
const root = ref<HTMLElement>();
const arrow = useId();
const paths = ref<{ path: string; x: number; y: number; index: number }[]>([]);
const lanes = computed(() => {
  const order = new Map(
    props.part.nodes.map((node, index) => [node.id, index]),
  );
  const above: number[] = [],
    below: number[] = [];
  const adjacent = new Set<number>();
  const edges = props.part.edges.map((edge, index) => ({
    index,
    from: order.get(edge.from)!,
    to: order.get(edge.to)!,
  }));
  const tracks = edges.map(() => ({ side: 0, lane: 0 }));
  for (const edge of edges.sort(
    (a, b) => Math.min(a.from, a.to) - Math.min(b.from, b.to),
  )) {
    const { from, to, index } = edge;
    if (to === from + 1 && !adjacent.has(from)) {
      adjacent.add(from);
      continue;
    }
    const side = to < from ? 1 : -1;
    const group = side === 1 ? below : above;
    const start = Math.min(from, to);
    const free = group.findIndex((end) => end < start);
    const lane = free === -1 ? group.length : free;
    group[lane] = Math.max(from, to);
    tracks[index] = { side, lane };
  }
  return { tracks, above: above.length, below: below.length };
});
let observer: ResizeObserver;
function draw() {
  const el = root.value;
  if (!el) return;
  const rect = el.getBoundingClientRect(),
    scale = rect.width / el.clientWidth;
  if (!Number.isFinite(scale) || scale <= 0) return;
  const nodes = new Map(
    [...el.querySelectorAll<HTMLElement>("[data-node]")].map((e) => {
      const r = e.getBoundingClientRect();
      return [
        e.dataset.node!,
        {
          left: (r.left - rect.left) / scale,
          right: (r.right - rect.left) / scale,
          top: (r.top - rect.top) / scale,
          bottom: (r.bottom - rect.top) / scale,
        },
      ];
    }),
  );
  paths.value = props.part.edges.flatMap((edge, index) => {
    const source = nodes.get(edge.from),
      target = nodes.get(edge.to);
    if (!source || !target) return [];
    const { side, lane } = lanes.value.tracks[index]!;
    if (!side) {
      const y = (source.top + source.bottom) / 2;
      return [
        {
          index,
          x: (source.right + target.left) / 2,
          y: y - 13,
          path: `M ${source.right + 3} ${y} H ${target.left - 3}`,
        },
      ];
    }
    const self = edge.from === edge.to;
    const a = (source.left + source.right) / 2 - (self ? 22 : 0);
    const b = (target.left + target.right) / 2 + (self ? 22 : 0);
    const start = (side < 0 ? source.top : source.bottom) + side * 3;
    const end = (side < 0 ? target.top : target.bottom) + side * 3;
    const y = start + side * (18 + lane * 22);
    return [
      {
        index,
        x: (a + b) / 2,
        y,
        path: `M ${a} ${start} V ${y} H ${b} V ${end}`,
      },
    ];
  });
}
watch(
  () => props.part,
  () => void nextTick(draw),
  { deep: true },
);
onMounted(() => {
  observer = new ResizeObserver(draw);
  observer.observe(root.value!);
  draw();
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <ExpositionCanvas :label="part.title">
    <div
      ref="root"
      class="ex-flow"
      :style="{
        paddingTop: lanes.above ? 10 + lanes.above * 22 + 'px' : undefined,
        paddingBottom: lanes.below ? 10 + lanes.below * 22 + 'px' : undefined,
      }"
    >
      <svg class="ex-flow-wires" aria-hidden="true">
        <defs>
          <marker
            :id="arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M1 1L7 4L1 7" />
          </marker>
        </defs>
        <g v-for="p in paths" :key="p.index">
          <path :d="p.path" :marker-end="'url(#' + arrow + ')'" />
        </g>
        <g v-for="p in paths" :key="'label-' + p.index">
          <rect
            :x="p.x - (p.index < 9 ? 8 : 11)"
            :y="p.y - 8"
            :width="p.index < 9 ? 16 : 22"
            height="16"
          />
          <text :x="p.x" :y="p.y + 4" text-anchor="middle">
            {{ p.index + 1 }}
          </text>
        </g>
      </svg>
      <div
        v-for="n in part.nodes"
        :key="n.id"
        class="ex-flow-node"
        :data-node="n.id"
      >
        <strong>{{ n.title }}</strong
        ><span v-for="(line, i) in n.lines" :key="i">{{ line }}</span>
        <pre v-if="n.code"><code>{{n.code}}</code></pre>
      </div>
    </div>
  </ExpositionCanvas>
  <details v-if="part.edges.length">
    <summary>Connection labels ({{ part.edges.length }})</summary>
    <ol class="ex-edge-key">
      <li v-for="(e, i) in part.edges" :key="i">
        <span
          >{{ part.nodes.find((n) => n.id === e.from)?.title }} →
          {{ part.nodes.find((n) => n.id === e.to)?.title }}</span
        ><strong>{{ e.label }}</strong>
      </li>
    </ol>
  </details>
</template>
