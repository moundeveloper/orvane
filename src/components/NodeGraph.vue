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
const props = withDefaults(
  defineProps<{
    block: Pick<Block, "id" | "kind" | "label" | "rules" | "graph">;
    app: CanvasApp;
    workspace: Workspace;
    error?: string;
    allowGroup?: boolean;
  }>(),
  { allowGroup: true },
);
const emit = defineEmits<{ close: []; run: []; group: [ids: string[]] }>();
const flowId = `graph-${props.block.id}`;
const {
  fitView,
  getSelectedNodes,
  findNode,
  vueFlowRef,
  viewport,
  startConnection,
  updateConnection,
  endConnection,
} = useVueFlow({
  id: flowId,
});
const notice = ref(""),
  addOpen = ref(false),
  selectedEdge = ref("");
const addTrigger = ref<HTMLButtonElement>();
const addMenu = ref<HTMLDivElement>();
const ready = ref(false);
const connectionsOpen = ref(false);
const connectionsButton = ref<HTMLButtonElement>();
function toggleConnections() {
  connectionsOpen.value = !connectionsOpen.value;
}
function connectionsKey(event: KeyboardEvent) {
  if (
    event.key !== "Escape" ||
    (event.target as Element).closest('[role="combobox"][aria-expanded="true"]')
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  connectionsOpen.value = false;
  connectionsButton.value?.focus();
}
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
  { value: "workspace-action", label: "Run workspace action" },
  { value: "navigate", label: "Go to app" },
  { value: "open-view", label: "Open app view" },
  { value: "read-field", label: "Read exposed field" },
  { value: "message", label: "Show message" },
];
const draftGraph = ref<ActionGraph>({ positions: {}, edges: [] });
function resetDraftGraph() {
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
  draftGraph.value = { positions, edges };
}
if (!props.block.graph) resetDraftGraph();
const graph = computed(() => props.block.graph || draftGraph.value);
function commitGraph() {
  if (!props.block.graph)
    props.block.graph = JSON.parse(JSON.stringify(draftGraph.value));
}
const connectionSource = ref("trigger"),
  connectionTarget = ref(""),
  connectionKind = ref<"success" | "failure">("success");
const disconnectedCount = computed(() => {
  const reached = new Set(["trigger"]);
  for (let i = 0; i <= props.block.rules.length; i++)
    graph.value.edges.forEach((e) => {
      if (reached.has(e.source)) reached.add(e.target);
    });
  return props.block.rules.filter((r) => !reached.has(r.id)).length;
});
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
    label: e.on === "failure" ? "On failure" : undefined,
    style: { stroke: "#8da6b6", strokeWidth: 1.5 },
  }));
}
sync();
watch(() => props.block.rules.map((r) => r.id).join(), sync);
watch(
  () => props.block,
  () => {
    if (!props.block.graph) resetDraftGraph();
    sync();
  },
);
watch(
  () => graph.value.edges.map((e) => e.id + e.source + e.target).join(),
  () => {
    edges.value = graph.value.edges.map((e) => ({
      ...e,
      type: "default",
      updatable: true,
      label: e.on === "failure" ? "On failure" : undefined,
      style: { stroke: "#8da6b6", strokeWidth: 1.5 },
    }));
  },
);
function connect(c: Connection) {
  const ids = new Set(props.block.rules.map((rule) => rule.id));
  if ((c.source !== "trigger" && !ids.has(c.source)) || !ids.has(c.target)) {
    notice.value = "Choose an available source and target.";
    return false;
  }
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
  commitGraph();
  graph.value.edges.push({
    id: uid(),
    source: c.source,
    target: c.target,
    on: connectionKind.value,
  });
  notice.value = "";
  return true;
}
function updateWire(event: EdgeUpdateEvent) {
  replaceWire(event.edge.id, event.connection);
}
function replaceWire(id: string, connection: Connection) {
  commitGraph();
  const old = graph.value.edges.find((e) => e.id === id);
  if (!old) return;
  graph.value.edges = graph.value.edges.filter((e) => e.id !== old.id);
  if (!connect(connection)) graph.value.edges.push(old);
  else Object.assign(graph.value.edges.at(-1)!, { id: old.id, on: old.on });
}
// Vue Flow's pointer math assumes an unscaled ancestor. The app canvas applies
// its own transform, so convert client coordinates into unscaled viewport space
// before using Vue Flow's public connection API. Hit testing stays in screen space.
function viewportPoint(clientX: number, clientY: number) {
  const element = vueFlowRef.value!;
  const rect = element.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) * element.offsetWidth) / rect.width,
    y: ((clientY - rect.top) * element.offsetHeight) / rect.height,
  };
}
let wireDrag:
  { pointerId: number; handle: HTMLElement; edgeId?: string } | undefined;
function handleDetails(handle: HTMLElement) {
  return {
    nodeId: handle.dataset.nodeid!,
    id: handle.getAttribute("data-handleid"),
    type: handle.classList.contains("source")
      ? ("source" as const)
      : ("target" as const),
    position: handle.getAttribute("data-handlepos") as Position,
  };
}
function startWire(event: PointerEvent) {
  const target = event.target as Element;
  const updater = target.closest(".vue-flow__edgeupdater");
  let handle = target.closest<HTMLElement>(".vue-flow__handle");
  let edgeId: string | undefined;
  if (updater) {
    edgeId =
      updater.closest(".vue-flow__edge")?.getAttribute("data-id") || undefined;
    const edge = graph.value.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    const movingSource = updater.classList.contains(
      "vue-flow__edgeupdater-source",
    );
    const fixedId = movingSource ? edge.target : edge.source;
    handle =
      vueFlowRef.value?.querySelector<HTMLElement>(
        `.vue-flow__node[data-id="${CSS.escape(fixedId)}"] .vue-flow__handle.${movingSource ? "target" : "source"}`,
      ) || null;
  }
  if (!handle || event.button !== 0 || wireDrag) return;
  event.preventDefault();
  event.stopPropagation();
  measureSockets(handle.dataset.nodeid!);
  wireDrag = { pointerId: event.pointerId, handle, edgeId };
  const point = viewportPoint(event.clientX, event.clientY);
  startConnection({ ...handleDetails(handle), ...point }, point);
  document.addEventListener("pointermove", moveWire, true);
  document.addEventListener("pointerup", finishWire, true);
  document.addEventListener("pointercancel", cancelWire, true);
  document.addEventListener("keydown", wireKey, true);
  window.addEventListener("blur", cancelWire);
}
function wireTarget(event: PointerEvent) {
  const target = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>(".vue-flow__handle");
  if (!target || !vueFlowRef.value?.contains(target) || !wireDrag) return;
  const from = handleDetails(wireDrag.handle),
    to = handleDetails(target);
  if (from.type === to.type || from.nodeId === to.nodeId) return;
  return {
    target,
    connection: {
      source: from.type === "source" ? from.nodeId : to.nodeId,
      sourceHandle: from.type === "source" ? from.id : to.id,
      target: from.type === "target" ? from.nodeId : to.nodeId,
      targetHandle: from.type === "target" ? from.id : to.id,
    },
  };
}
function moveWire(event: PointerEvent) {
  if (!wireDrag || event.pointerId !== wireDrag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  // Keep the live endpoint exactly under the pointer; completed edges snap to
  // socket bounds after drop, using the same node-local geometry as other edges.
  const candidate = wireTarget(event);
  updateConnection(
    viewportPoint(event.clientX, event.clientY),
    null,
    candidate ? "valid" : null,
  );
}
function finishWire(event: PointerEvent) {
  if (!wireDrag || event.pointerId !== wireDrag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  const candidate = wireTarget(event),
    edgeId = wireDrag.edgeId;
  cancelWire();
  if (candidate) {
    if (edgeId) replaceWire(edgeId, candidate.connection);
    else connect(candidate.connection);
  }
}
function cancelWire() {
  wireDrag = undefined;
  endConnection();
  document.removeEventListener("pointermove", moveWire, true);
  document.removeEventListener("pointerup", finishWire, true);
  document.removeEventListener("pointercancel", cancelWire, true);
  document.removeEventListener("keydown", wireKey, true);
  window.removeEventListener("blur", cancelWire);
}
function wireKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelWire();
  }
}
function blockNativeWire(event: MouseEvent | TouchEvent) {
  if (
    (event.target as Element).closest(
      ".vue-flow__handle,.vue-flow__edgeupdater",
    )
  ) {
    event.preventDefault();
    event.stopPropagation();
  }
}
onBeforeUnmount(cancelWire);
// Vue Flow divides screen-space handle offsets by its internal zoom only.
// Our canvas also scales the entire editor, so measure against the node's
// actual screen scale to keep socket coordinates in unscaled node space.
function measureSockets(id: string) {
  const node = findNode(id);
  const element = vueFlowRef.value?.querySelector<HTMLElement>(
    `.vue-flow__node[data-id="${CSS.escape(id)}"]`,
  );
  if (!node || !element?.offsetWidth || !element.offsetHeight) return;
  const box = element.getBoundingClientRect();
  const scaleX = box.width / element.offsetWidth;
  const scaleY = box.height / element.offsetHeight;
  if (!scaleX || !scaleY) return;
  for (const type of ["source", "target"] as const) {
    const handles = [
      ...element.querySelectorAll<HTMLElement>(`.vue-flow__handle.${type}`),
    ];
    for (const bounds of node.handleBounds[type] || []) {
      const handle = handles.find(
        (handle) => handle.getAttribute("data-handleid") === bounds.id,
      );
      if (!handle) continue;
      const handleBox = handle.getBoundingClientRect();
      bounds.x = (handleBox.left - box.left) / scaleX;
      bounds.y = (handleBox.top - box.top) / scaleY;
      bounds.width = handle.offsetWidth;
      bounds.height = handle.offsetHeight;
    }
  }
}
function nodeChanges(changes: NodeChange[]) {
  for (const change of changes) {
    if (change.type === "dimensions") measureSockets(change.id);
    if (change.type === "position" && change.position && change.dragging) {
      commitGraph();
      graph.value.positions[change.id] = { ...change.position };
    }
    if (change.type === "remove") remove(change.id);
  }
}
function edgeChanges(changes: EdgeChange[]) {
  if (changes.some((c) => c.type === "remove")) commitGraph();
  for (const change of changes)
    if (change.type === "remove")
      graph.value.edges = graph.value.edges.filter((e) => e.id !== change.id);
}
function remove(id: string) {
  commitGraph();
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
  commitGraph();
  const rule: Rule = { id: uid(), action, target: "", appId: "", value: "" };
  props.block.rules.push(rule);
  const bounds = document
    .querySelector(`[data-flow-id="${flowId}"]`)
    ?.getBoundingClientRect();
  graph.value.positions[rule.id] = bounds
    ? (() => {
        const point = viewportPoint(
          bounds.x + bounds.width * 0.5,
          bounds.y + bounds.height * 0.4,
        );
        return {
          x: (point.x - viewport.value.x) / viewport.value.zoom,
          y: (point.y - viewport.value.y) / viewport.value.zoom,
        };
      })()
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
  commitGraph();
  emit("group", ids);
}
function deleteWire() {
  commitGraph();
  graph.value.edges = graph.value.edges.filter(
    (e) => e.id !== selectedEdge.value,
  );
  selectedEdge.value = "";
}
function disconnectInput(id: string) {
  commitGraph();
  graph.value.edges = graph.value.edges.filter((e) => e.target !== id);
}
</script>
<template>
  <div
    class="node-workspace"
    v-motion="{ kind: 'workspace', show: ready, initial: false }"
    :style="{ opacity: ready ? undefined : 0 }"
    :data-ready="ready"
    @pointerdown.capture="startWire"
    @mousedown.capture="blockNativeWire"
    @touchstart.capture="blockNativeWire"
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
          ref="connectionsButton"
          class="subtle-button"
          :aria-expanded="connectionsOpen"
          :aria-controls="`${flowId}-connections`"
          @click="toggleConnections"
        >
          <Icon name="link" :size="13" />Connections
        </button>
        <button
          class="subtle-button"
          @click="fitView({ padding: 0.18, duration: 180 })"
        >
          <Icon name="resize" :size="13" />Frame</button
        ><button
          v-if="allowGroup !== false"
          class="subtle-button"
          @click="group"
        >
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
    <div
      v-if="connectionsOpen"
      :id="`${flowId}-connections`"
      class="graph-connections"
      aria-label="Graph connections"
      @keydown.capture="connectionsKey"
    >
      <div class="connection-create-row">
        <label class="connection-field"
          ><span>Source</span>
          <CustomSelect
            v-model="connectionSource"
            aria-label="Connection source"
            ><option value="trigger">Trigger</option>
            <option v-for="r in block.rules" :key="r.id" :value="r.id">
              {{ actions.find((a) => a.value === r.action)?.label }}
              {{ block.rules.indexOf(r) + 1 }}
            </option></CustomSelect
          ></label
        >
        <label class="connection-field connection-outcome"
          ><span>Outcome</span>
          <CustomSelect v-model="connectionKind" aria-label="Connection outcome"
            ><option value="success">On success</option>
            <option value="failure">On failure</option></CustomSelect
          ></label
        >
        <label class="connection-field"
          ><span>Target</span>
          <CustomSelect
            v-model="connectionTarget"
            aria-label="Connection target"
            ><option value="">Choose target</option>
            <option v-for="r in block.rules" :key="r.id" :value="r.id">
              {{ actions.find((a) => a.value === r.action)?.label }}
              {{ block.rules.indexOf(r) + 1 }}
            </option></CustomSelect
          ></label
        >
        <button
          class="subtle-button"
          :disabled="!connectionTarget"
          @click="
            connect({
              source: connectionSource,
              target: connectionTarget,
              sourceHandle: null,
              targetHandle: null,
            })
          "
        >
          Connect
        </button>
      </div>
      <div class="connection-remove-row">
        <label class="connection-field"
          ><span>Existing connection</span>
          <CustomSelect v-model="selectedEdge" aria-label="Select connection"
            ><option value="">Choose connection</option>
            <option
              v-for="(edge, i) in graph.edges"
              :key="edge.id"
              :value="edge.id"
            >
              Connection {{ i + 1 }} / {{ edge.on || "success" }}
            </option></CustomSelect
          ></label
        >
        <button
          class="subtle-button"
          :disabled="!selectedEdge"
          @click="deleteWire"
        >
          Disconnect
        </button>
      </div>
    </div>
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
                app.id === "__workspace__"
                  ? "Action invoked"
                  : block.kind === "input"
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
        error ||
        (disconnectedCount
          ? `${disconnectedCount} disconnected actions will not run. Connect them to a trigger or an action.`
          : "") ||
        "Drag a socket to connect · Drag a node header to move · Shift-click to select · Middle-drag to pan"
      }}</span
      ><span
        >{{ block.rules.length }} nodes ·
        {{ graph.edges.length }} connections</span
      >
    </footer>
  </div>
</template>
