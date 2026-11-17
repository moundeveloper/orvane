<script setup lang="ts">
// A pane, or two children split side by side / one above the other with a
// draggable divider. Recursive.
import { ref } from "vue";
import TerminalPane from "./TerminalPane.vue";
import type { LayoutNode } from "../../terminalLayout";

defineOptions({ name: "TerminalSplit" });
const props = defineProps<{
  node: LayoutNode;
  movable?: boolean;
  drop?: { id: string; edge: "left" | "right" | "top" | "bottom" };
}>();
const emit = defineEmits<{ resized: [] }>();
const box = ref<HTMLDivElement>();
function drag(event: PointerEvent) {
  if (props.node.type !== "split" || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const node = props.node;
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    const r = box.value!.getBoundingClientRect();
    const ratio = node.dir === "row" ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    node.ratio = Math.round(Math.max(0.1, Math.min(0.9, ratio)) * 1000) / 1000;
  };
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    emit("resized");
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}
</script>

<template>
  <TerminalPane v-if="node.type === 'pane'" :key="node.id" :pane="node"
    :movable="movable" :drop-edge="drop?.id === node.id ? drop.edge : undefined" />
  <div v-else ref="box" class="terminal-split" :class="node.dir">
    <div class="terminal-split-part" :style="{ flexBasis: node.ratio * 100 + '%' }">
      <TerminalSplit :node="node.a" :drop="drop" movable @resized="emit('resized')" />
    </div>
    <div
      class="terminal-divider"
      role="separator"
      :aria-orientation="node.dir === 'row' ? 'vertical' : 'horizontal'"
      @pointerdown="drag"
    ></div>
    <div class="terminal-split-part" :style="{ flexBasis: (1 - node.ratio) * 100 + '%' }">
      <TerminalSplit :node="node.b" :drop="drop" movable @resized="emit('resized')" />
    </div>
  </div>
</template>

<style scoped>
.terminal-split {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.terminal-split.column {
  flex-direction: column;
}
.terminal-split-part {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
.terminal-divider {
  flex: none;
  position: relative;
}
.row > .terminal-divider {
  width: 6px;
  cursor: col-resize;
}
.column > .terminal-divider {
  height: 6px;
  cursor: row-resize;
}
.terminal-divider::after {
  content: "";
  position: absolute;
  background: rgb(69 89 104 / 14%);
  border-radius: 1px;
}
.row > .terminal-divider::after {
  inset: 6px 2px;
  width: 2px;
}
.column > .terminal-divider::after {
  inset: 2px 6px;
  height: 2px;
}
</style>
