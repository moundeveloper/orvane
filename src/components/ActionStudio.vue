<script setup lang="ts">
import { computed, defineAsyncComponent, ref, onMounted } from "vue";
import {
  makeBlock,
  uid,
  type Workspace,
  type CanvasApp,
  type ActionGraph,
  type Rule,
} from "../model";
import Icon from "./Icon.vue";
import CustomSelect from "./CustomSelect.vue";
const NodeGraph = defineAsyncComponent(() => import("./NodeGraph.vue"));
const props = defineProps<{
  workspace: Workspace;
  initialId: string;
  writable: boolean;
  notice: string;
  running: boolean;
  openingFrom?: { x: number; y: number; width: number; height: number };
}>();
const emit = defineEmits<{
  close: [];
  created: [id: string];
  run: [id: string, inputs: Record<string, string>];
}>();
const selected = ref(props.initialId || props.workspace.actions?.[0]?.id || "");
const action = computed(() =>
  props.workspace.actions?.find((a) => a.id === selected.value),
);
const inputs = ref<Record<string, string>>({});
const studio = ref<HTMLElement>();
onMounted(() => {
  const element = studio.value;
  if (!element || matchMedia("(prefers-reduced-motion: reduce)").matches)
    return;
  const target = element.getBoundingClientRect(),
    source = props.openingFrom;
  const x = source
    ? source.x + source.width / 2 - target.x - target.width / 2
    : 0;
  const y = source
    ? source.y + source.height / 2 - target.y - target.height / 2
    : 0;
  const scale = source
    ? Math.max(0.15, Math.min(0.65, source.width / target.width))
    : 0.85;
  element.animate(
    [
      { opacity: 0.15, transform: `translate(${x}px, ${y}px) scale(${scale})` },
      { opacity: 1, transform: "none" },
    ],
    { duration: 240, easing: "cubic-bezier(.16,1,.3,1)" },
  );
});
const error = ref("");
function create(navigation = false) {
  if (!props.writable) return;
  props.workspace.actions ||= [];
  const id = uid();
  const rules = navigation
    ? [
        {
          id: uid(),
          action: "navigate" as const,
          appId: "",
          target: "",
          value: "",
        },
      ]
    : [];
  props.workspace.actions.push({
    id,
    name: navigation ? "Open app" : "New action",
    icon: navigation ? "arrow" : "workflow",
    inputs: [],
    rules,
  });
  selected.value = id;
  emit("created", id);
}
function setInputs(event: Event) {
  if (!action.value) return;
  const names = (event.target as HTMLInputElement).value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    names.some((n) => !/^[a-zA-Z][\w -]{0,49}$/.test(n)) ||
    new Set(names).size !== names.length
  ) {
    error.value =
      "Use unique input names beginning with a letter, separated by commas.";
    return;
  }
  action.value.inputs = names;
  error.value = "";
}
const source = computed(() =>
  action.value
    ? {
        id: action.value.id,
        kind: "button" as const,
        get label() {
          return action.value!.name;
        },
        get rules() {
          return action.value!.rules;
        },
        set rules(value) {
          action.value!.rules = value;
        },
        get graph() {
          return action.value!.graph;
        },
        set graph(value: ActionGraph | undefined) {
          action.value!.graph = value;
        },
      }
    : undefined,
);
const context = computed<CanvasApp>(() => ({
  id: "__workspace__",
  name: "Workspace action",
  icon: "workflow",
  x: 0,
  y: 0,
  width: 600,
  height: 500,
  blocks: (action.value?.inputs || []).map((name) => ({
    ...makeBlock("input"),
    id: name,
    label: name,
    value: "",
  })),
  archived: false,
  exposed: false,
  group: "",
  accent: "#6f8998",
  padding: 20,
  gap: 12,
  radius: 6,
}));
function duplicate() {
  if (!action.value || !props.writable) return;
  const copy = JSON.parse(JSON.stringify(action.value));
  copy.id = uid();
  copy.name += " copy";
  props.workspace.actions!.push(copy);
  selected.value = copy.id;
}
function groupNodes(ids: string[]) {
  const parent = action.value;
  if (!parent || !props.writable) return;
  const selectedRules = parent.rules.filter((r) => ids.includes(r.id));
  if (!selectedRules.length) return;
  const outer = parent.graph;
  if (!outer) return;
  const returns = (id: string, seen = new Set<string>()): boolean => {
    if (ids.includes(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return outer.edges
      .filter((e) => e.source === id)
      .some((e) => returns(e.target, seen));
  };
  if (
    outer.edges.some(
      (e) =>
        ids.includes(e.source) && !ids.includes(e.target) && returns(e.target),
    )
  ) {
    error.value = "Group adjacent nodes so the graph stays free of loops.";
    return;
  }
  const groupId = uid();
  const graph: ActionGraph = {
    positions: Object.fromEntries(
      Object.entries(outer.positions).filter(
        ([id]) => id === "trigger" || ids.includes(id),
      ),
    ),
    edges: outer.edges
      .filter((e) => ids.includes(e.source) && ids.includes(e.target))
      .map((e) => ({ ...e })),
  };
  const entries = outer.edges.filter(
    (e) => !ids.includes(e.source) && ids.includes(e.target),
  );
  for (const edge of entries)
    graph.edges.push({ id: uid(), source: "trigger", target: edge.target });
  if (!entries.length)
    graph.edges.push({
      id: uid(),
      source: "trigger",
      target: selectedRules[0]!.id,
    });
  props.workspace.actions!.push({
    id: groupId,
    name: `${parent.name} group`,
    icon: "layers",
    inputs: [...parent.inputs],
    rules: JSON.parse(JSON.stringify(selectedRules)),
    graph,
  });
  const call: Rule = {
    id: uid(),
    action: "workspace-action",
    target: "",
    appId: "",
    value: "",
    nodeId: groupId,
    bindings: Object.fromEntries(
      parent.inputs.map((name) => [name, `{${name}}`]),
    ),
  };
  const at = parent.rules.findIndex((r) => ids.includes(r.id));
  parent.rules = parent.rules.filter((r) => !ids.includes(r.id));
  parent.rules.splice(at, 0, call);
  outer.positions[call.id] = outer.positions[selectedRules[0]!.id] || {
    x: 320,
    y: 120,
  };
  ids.forEach((id) => delete outer.positions[id]);
  const seen = new Set<string>();
  outer.edges = outer.edges
    .filter((e) => !(ids.includes(e.source) && ids.includes(e.target)))
    .map((e) => ({
      ...e,
      source: ids.includes(e.source) ? call.id : e.source,
      target: ids.includes(e.target) ? call.id : e.target,
    }))
    .filter((e) => {
      const key = `${e.source}:${e.target}:${e.on || "success"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
</script>
<template>
  <section
    class="action-studio floating-panel"
    ref="studio"
    aria-label="Workspace action library"
    @pointerdown.stop
  >
    <header class="action-studio-header">
      <div>
        <h1>Workspace actions</h1>
        <p class="field-help">
          Build once. Run from a wheel slot or an app button.
        </p>
      </div>
      <button
        class="icon-button action-studio-close"
        aria-label="Close action library"
        @click="emit('close')"
      >
        <Icon name="close" />
      </button>
    </header>
    <aside class="action-studio-sidebar">
      <div class="workspace-action-row">
        <button class="subtle-button" :disabled="!writable" @click="create()">
          <Icon name="plus" :size="13" />New action</button
        ><button
          class="subtle-button"
          :disabled="!writable"
          @click="create(true)"
        >
          Go to app preset
        </button>
      </div>
      <nav aria-label="Shared actions">
        <button
          v-for="item in workspace.actions || []"
          :key="item.id"
          class="action-library-item"
          :class="{ active: selected === item.id }"
          @click="
            selected = item.id;
            inputs = {};
            error = '';
          "
        >
          <Icon :name="item.icon" :size="15" /><span>{{ item.name }}</span>
        </button>
      </nav>
      <template v-if="action">
        <div class="action-properties" :inert="!writable">
          <label class="property"
            ><span>Action name</span
            ><input v-model="action.name" aria-label="Action name"
          /></label>
          <label class="property"
            ><span>Icon</span
            ><CustomSelect
              v-model="action.icon"
              aria-label="Action icon"
              :options="[
                { value: 'workflow', label: 'Flow' },
                { value: 'arrow', label: 'Navigate' },
                { value: 'app', label: 'App' },
                { value: 'settings', label: 'Settings' },
                { value: 'list', label: 'List' },
                { value: 'link', label: 'Connection' },
              ]"
          /></label>
          <label class="property"
            ><span>Named inputs</span
            ><input
              :key="action.id"
              :value="action.inputs.join(', ')"
              aria-label="Action inputs"
              placeholder="task text, title"
              @change="setInputs"
          /></label>
          <p class="field-help">
            Use {input name} in node values. App buttons map fields to these
            names; wheel slots provide configured values. Blank node values pass
            the previous result.
          </p>
          <button class="subtle-button" @click="duplicate">
            <Icon name="copy" :size="13" />Duplicate action
          </button>
        </div>
        <div class="action-test-inputs">
          <label v-for="input in action.inputs" :key="input" class="property"
            ><span>Test: {{ input }}</span
            ><input
              v-model="inputs[input]"
              :aria-label="`Test input ${input}`" /></label
          ><button
            class="subtle-button"
            :disabled="!writable || running"
            @click="emit('run', action.id, { ...inputs })"
          >
            <Icon name="play" :size="13" />{{
              running ? "Running…" : "Run action"
            }}
          </button>
        </div>
      </template>
      <p v-else class="field-help">
        Create an action, add nodes, then connect them from the trigger.
        Navigation needs no inputs.
      </p>
      <p v-if="error || notice" class="action-studio-notice" role="status">
        {{ error || notice }}
      </p>
    </aside>
    <div class="action-studio-graph" :inert="!writable">
      <NodeGraph
        v-if="source"
        :key="source.id"
        :block="source"
        :app="context"
        :workspace="workspace"
        :error="error"
        @group="groupNodes"
        @close="emit('close')"
        @run="action && emit('run', action.id, { ...inputs })"
      />
      <div v-else class="action-graph-empty">
        <Icon name="workflow" :size="30" />
        <h2>Give your action a flow</h2>
        <p>
          Read data, update an app, then bring it into view.<br />Each step and
          its failure path lives in the graph.
        </p>
      </div>
    </div>
  </section>
</template>
