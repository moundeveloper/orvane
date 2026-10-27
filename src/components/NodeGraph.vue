<script setup lang="ts">
import {
  computed,
  ref,
  shallowRef,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
} from "vue";
import {
  VueFlow,
  Handle,
  Position,
  useVueFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type EdgeUpdateEvent,
} from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import {
  uid,
  type Rule,
  type Block,
  type CanvasApp,
  type Workspace,
  type ActionKind,
  type ActionGraph,
} from "../model";
import RuleControl from "./RuleControl.vue";
import CustomSelect from "./CustomSelect.vue";
import Icon from "./Icon.vue";
import { vMotion } from "../motion";
const props = defineProps<{
  block: Pick<Block, "id" | "kind" | "label" | "rules" | "graph">;
  app: CanvasApp;
  workspace: Workspace;
}>();
const emit = defineEmits<{ close: []; run: []; group: [ids: string[]] }>();
const flowId = `graph-${props.block.id}`;
const { fitView, screenToFlowCoordinate, getSelectedNodes } = useVueFlow({
  id: flowId,
});
const notice = ref(""),
  addOpen = ref(false),
  selectedEdge = ref("");
const addTrigger = ref<HTMLButtonElement>();
const addMenu = ref<HTMLDivElement>();
const ready = ref(false);
async function prepareGraph() {
  if (ready.value) return;
  await fitView({ padding: 0.16, maxZoom: 1, duration: 0 });
  await nextTick();
  ready.value = true;
}
function closeAddMenu() {
  addOpen.value = false;
}
function outsideAddMenu(event: PointerEvent) {
  if (!addOpen.value) return;
  const path = event.composedPath();
  if (!path.includes(addTrigger.value!) && !path.includes(addMenu.value!))
    closeAddMenu();
}
function escapeAddMenu(event: KeyboardEvent) {
  if (event.key !== "Escape" || !addOpen.value) return;
  closeAddMenu();
  addTrigger.value?.focus({ preventScroll: true });
  event.preventDefault();
  event.stopPropagation();
}
onMounted(() => {
  document.addEventListener("pointerdown", outsideAddMenu, true);
  document.addEventListener("keydown", escapeAddMenu, true);
  window.addEventListener("blur", closeAddMenu);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outsideAddMenu, true);
  document.removeEventListener("keydown", escapeAddMenu, true);
  window.removeEventListener("blur", closeAddMenu);
});
const actions: { value: ActionKind; label: string }[] = [
  { value: "add-item", label: "Add item" },
  { value: "clear", label: "Clear field" },
  { value: "increment", label: "Increase counter" },
  { value: "toggle", label: "Toggle checkbox" },
  { value: "set-text", label: "Set text / value" },
  { value: "emit", label: "Send event" },
  { value: "custom", label: "Reusable action" },
];
if (!props.block.graph) {
  const positions: ActionGraph["positions"] = { trigger: { x: 40, y: 140 } };
  const edges: ActionGraph["edges"] = [];
  props.block.rules.forEach((r, i) => {
    positions[r.id] = { x: 320 + i * 280, y: 100 };
    edges.push({
      id: uid(),
      source: i ? props.block.rules[i - 1]!.id : "trigger",
      target: r.id,
    });
  });
  props.block.graph = { positions, edges };
}
const graph = computed(() => props.block.graph!);
const initialNodeIds = new Set(props.block.rules.map((rule) => rule.id));
const nodes = shallowRef<Node[]>([]),
  edges = shallowRef<Edge[]>([]);
function sync() {
  nodes.value = [
    {
      id: "trigger",
      type: "trigger",
      position: graph.value.positions.trigger || { x: 40, y: 140 },
      data: {},
      deletable: false,
      dragHandle: ".node-drag",
    },
    ...props.block.rules.map((r, i) => ({
      id: r.id,
      type: "action",
      position: graph.value.positions[r.id] || { x: 320 + i * 280, y: 100 },
      data: { rule: r },
      dragHandle: ".node-drag",
    })),
  ];
  edges.value = graph.value.edges.map((e) => ({
    ...e,
    type: "default",
    updatable: true,
    style: { stroke: "#8da6b6", strokeWidth: 1.5 },
  }));
}
sync();
watch(() => props.block.rules.map((r) => r.id).join(), sync);
watch(
  () => graph.value.edges.map((e) => e.id + e.source + e.target).join(),
  () => {
    edges.value = graph.value.edges.map((e) => ({
      ...e,
      type: "default",
      updatable: true,
      style: { stroke: "#8da6b6", strokeWidth: 1.5 },
    }));
  },
);
function connect(c: Connection) {
  if (
    c.target === "trigger" ||
    c.source === c.target ||
    graph.value.edges.some(
      (e) => e.source === c.source && e.target === c.target,
    )
  )
    return false;
  const visit = (id: string, seen = new Set<string>()): boolean => {
    if (id === c.source) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return graph.value.edges
      .filter((e) => e.source === id)
      .some((e) => visit(e.target, seen));
  };
  if (visit(c.target)) {
    notice.value = "That connection would create a loop.";
    return false;
  }
  graph.value.edges.push({ id: uid(), source: c.source, target: c.target });
  notice.value = "";
  return true;
}
function updateWire(event: EdgeUpdateEvent) {
  const old = graph.value.edges.find((e) => e.id === event.edge.id);
  if (!old) return;
  graph.value.edges = graph.value.edges.filter((e) => e.id !== old.id);
  if (!connect(event.connection)) graph.value.edges.push(old);
}
function nodeChanges(changes: NodeChange[]) {
  for (const change of changes) {
    if (change.type === "position" && change.position)
      graph.value.positions[change.id] = { ...change.position };
    if (change.type === "remove") remove(change.id);
  }
}
function edgeChanges(changes: EdgeChange[]) {
  for (const change of changes)
    if (change.type === "remove")
      graph.value.edges = graph.value.edges.filter((e) => e.id !== change.id);
}
function remove(id: string) {
  if (id === "trigger") return;
  const index = props.block.rules.findIndex((r) => r.id === id);
  if (index < 0) return;
  props.block.rules.splice(index, 1);
  graph.value.edges = graph.value.edges.filter(
    (e) => e.source !== id && e.target !== id,
  );
  delete graph.value.positions[id];
}
function add(action: ActionKind) {
  const rule: Rule = { id: uid(), action, target: "", appId: "", value: "" };
  props.block.rules.push(rule);
  const bounds = document
    .querySelector(`[data-flow-id="${flowId}"]`)
    ?.getBoundingClientRect();
  graph.value.positions[rule.id] = bounds
    ? screenToFlowCoordinate({
        x: bounds.x + bounds.width * 0.5,
        y: bounds.y + bounds.height * 0.4,
      })
    : { x: 320, y: 100 };
  const position = graph.value.positions[rule.id]!;
  while (
    nodes.value.some(
      (n) =>
        Math.abs(n.position.x - position.x) < 260 &&
        Math.abs(n.position.y - position.y) < 250,
    )
  )
    position.y += 260;
  addOpen.value = false;
  nextTick(() => {
    sync();
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        fitView({ padding: 0.16, duration: 160, maxZoom: 1 }),
      ),
    );
  });
}
function group() {
  const ids = getSelectedNodes.value
    .filter((n) => n.id !== "trigger")
    .map((n) => n.id);
  if (!ids.length) {
    notice.value = "Shift-click the nodes you want to group.";
    return;
  }
  emit("group", ids);
}
function deleteWire() {
  graph.value.edges = graph.value.edges.filter(
    (e) => e.id !== selectedEdge.value,
  );
  selectedEdge.value = "";
}
function disconnectInput(id: string) {
  graph.value.edges = graph.value.edges.filter((e) => e.target !== id);
}
</script>
<template>
  <div
    class="node-workspace"
    v-motion="{ kind: 'workspace', show: ready, initial: false }"
    :style="{ opacity: ready ? undefined : 0 }"
    :data-ready="ready"
    @pointerdown.stop
    @wheel.stop
  >
    <header class="node-toolbar">
      <button class="subtle-button" @click="emit('close')">
        <Icon name="back" :size="13" />Layout</button
      ><span class="node-context"
        >{{ block.label }} <span>· Actions</span></span
      >
      <div class="node-toolbar-actions">
        <button
          class="subtle-button"
          @click="fitView({ padding: 0.18, duration: 180 })"
        >
          <Icon name="resize" :size="13" />Frame</button
        ><button class="subtle-button" @click="group">
          <Icon name="layers" :size="13" />Group</button
        ><button class="subtle-button" @click="emit('run')">
          <Icon name="play" :size="13" />Test</button
        ><button
          ref="addTrigger"
          class="subtle-button"
          :aria-expanded="addOpen"
          @click="addOpen = !addOpen"
        >
          <Icon name="plus" :size="13" />Add node
        </button>
      </div>
    </header>
    <div class="node-stage" :data-flow-id="flowId">
      <VueFlow
        :id="flowId"
        v-model:nodes="nodes"
        v-model:edges="edges"
        :min-zoom="0.25"
        :max-zoom="1.8"
        :default-viewport="{ x: 24, y: 24, zoom: 0.75 }"
        :delete-key-code="['Backspace', 'Delete']"
        :selection-key-code="'Shift'"
        :multi-selection-key-code="'Shift'"
        :pan-on-drag="[1, 2]"
        :zoom-on-scroll="true"
        :nodes-connectable="true"
        :elevate-nodes-on-select="true"
        @connect="connect"
        @edge-update="updateWire"
        @nodes-change="nodeChanges"
        @edges-change="edgeChanges"
        @edge-click="selectedEdge = $event.edge.id"
        @pane-click="selectedEdge = ''"
        @nodes-initialized="prepareGraph"
        ><Background
          :gap="20"
          :size="0.65"
          pattern-color="#b3c4cf"
          bg-color="#eaf0f4" /><template #node-trigger
          ><div class="flow-node trigger-node">
            <div class="node-drag">
              <Icon name="button" :size="14" /><strong>{{
                block.kind === "input"
                  ? "On Enter"
                  : block.kind === "checkbox"
                    ? "On change"
                    : "On click"
              }}</strong>
            </div>
            <div class="trigger-detail">{{ block.label }}</div>
            <div class="socket-label">
              Value <Handle type="source" :position="Position.Right" />
            </div></div></template
        ><template #node-action="{ data, id }"
          ><div
            class="flow-node action-node"
            v-motion="{ kind: 'fade', initial: !initialNodeIds.has(id) }"
          >
            <div class="node-drag">
              <Icon name="workflow" :size="14" /><strong>{{
                actions.find((a) => a.value === data.rule.action)?.label
              }}</strong
              ><button
                class="icon-button"
                aria-label="Delete node"
                @click="remove(id)"
              >
                <Icon name="close" :size="12" />
              </button>
            </div>
            <div class="node-sockets">
              <span
                ><Handle
                  type="target"
                  :position="Position.Left"
                  title="Input · Double-click to disconnect"
                  @dblclick.stop="disconnectInput(id)"
                />Input</span
              ><span
                >Output<Handle type="source" :position="Position.Right"
              /></span>
            </div>
            <div class="node-properties nodrag nowheel">
              <RuleControl
                :rule="data.rule"
                :app="app"
                :workspace="workspace"
                :index="0"
                :total="1"
                @remove="remove(id)"
              />
            </div></div></template
      ></VueFlow>
      <div
        v-if="addOpen"
        ref="addMenu"
        class="node-add-menu floating-panel"
        v-motion="{ kind: 'popover' }"
      >
        <span>Add an action</span
        ><button v-for="a in actions" :key="a.value" @click="add(a.value)">
          <Icon name="workflow" :size="13" />{{ a.label }}
        </button>
      </div>
      <button
        v-if="selectedEdge"
        class="wire-delete subtle-button"
        @click="deleteWire"
      >
        <Icon name="unlink" :size="13" />Disconnect selected wire
      </button>
    </div>
    <footer class="node-status">
      <span v-motion="{ kind: 'fade', state: notice, initial: false }">{{
        notice ||
        "Drag a socket to connect · Drag a node header to move · Shift-click to select · Middle-drag to pan"
      }}</span
      ><span
        >{{ block.rules.length }} nodes ·
        {{ graph.edges.length }} connections</span
      >
    </footer>
  </div>
</template>
