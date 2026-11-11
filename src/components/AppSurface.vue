<script setup lang="ts">
import {
  computed,
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  defineAsyncComponent,
  nextTick,
} from "vue";
import {
  flatten,
  appMinimum,
  kinds,
  makeBlock,
  uid,
  type Block,
  type CanvasApp,
  type Rule,
  type Workspace,
  type Kind,
  type ActionGraph,
} from "../model";
import BlockView from "./BlockView.vue";
import Icon from "./Icon.vue";
import CustomSelect from "./CustomSelect.vue";
import CustomNumber from "./CustomNumber.vue";
import { vMotion } from "../motion";
const CodeEditor = defineAsyncComponent(() => import("./CodeEditor.vue"));
const NodeGraph = defineAsyncComponent(() => import("./NodeGraph.vue"));
import RuleControl from "./RuleControl.vue";
const props = defineProps<{
  app: CanvasApp;
  workspace: Workspace;
  enterMotion?: boolean;
}>();
const emit = defineEmits<{
  run: [app: CanvasApp, block: Block];
  archive: [app: CanvasApp];
  duplicate: [app: CanvasApp];
  geometry: [app: CanvasApp];
  error: [message: string];
}>();
const editing = ref(false),
  tab = ref("structure"),
  selected = ref(""),
  adding = ref(false),
  graph = ref(false),
  menu = ref(false),
  collapsed = ref<string[]>([]),
  ruleError = ref("");
const expandedRule = ref<Rule>();
async function openView(view: "settings" | "graph", target: string) {
  editing.value = true;
  await nextTick();
  customGraphOpen.value = false;
  codeTarget.value = null;
  if (view === "graph") {
    const block = flatten(props.app.blocks).find((b) => b.id === target);
    if (!block)
      throw Error("Choose an existing component whose graph should open.");
    selected.value = block.id;
    expandedRule.value = undefined;
    graph.value = true;
  } else {
    graph.value = false;
    tab.value = "style";
  }
}
const ruleDraft = ref<{ rules: Rule[]; graph?: ActionGraph }>();
const ruleGraphSource = computed(() =>
  expandedRule.value && ruleDraft.value
    ? {
        id: expandedRule.value.id,
        kind: "button" as const,
        label: "Rule flow",
        get rules() {
          return ruleDraft.value!.rules;
        },
        set rules(value: Rule[]) {
          ruleDraft.value!.rules = value;
        },
        get graph() {
          return ruleDraft.value!.graph;
        },
        set graph(value: ActionGraph | undefined) {
          ruleDraft.value!.graph = value;
        },
      }
    : undefined,
);
function expandRule(rule: Rule) {
  expandedRule.value = undefined;
  const single = JSON.parse(JSON.stringify(rule));
  delete single.flow;
  ruleDraft.value = JSON.parse(
    JSON.stringify(rule.flow || { rules: [single] }),
  );
  expandedRule.value = rule;
  graph.value = true;
}
watch(
  ruleDraft,
  () => {
    if (expandedRule.value && ruleDraft.value)
      expandedRule.value.flow = JSON.parse(JSON.stringify(ruleDraft.value));
  },
  { deep: true, flush: "sync" },
);
const addedBlockId = ref("");
const blocks = computed(() => flatten(props.app.blocks));
const current = computed(() =>
  blocks.value.find((b) => b.id === selected.value),
);
const root = computed(() => props.app.blocks);
// Browser pages must attach, load and keep their sessions while off screen,
// so their app is never skipped from rendering.
const hasLivePage = computed(() =>
  blocks.value.some((block) => block.kind === "browser"),
);
const codeFills = computed(
  () =>
    current.value?.kind === "code" &&
    (current.value.sizing === "fill" ||
      (!current.value.sizing &&
        props.app.blocks.length === 1 &&
        props.app.blocks[0]?.id === current.value.id)),
);
const codeTarget = ref<"block" | "custom" | null>(null);
const editorWidth = computed(() =>
  Math.min(
    Math.max(180, props.app.editorWidth || 225),
    Math.max(180, props.app.width - 120),
  ),
);
let panelDrag: { x: number; width: number; scale: number } | null = null;
function resizePanelStart(e: PointerEvent) {
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const rect = (e.currentTarget as HTMLElement)
    .closest(".app-surface")!
    .getBoundingClientRect();
  panelDrag = {
    x: e.clientX,
    width: editorWidth.value,
    scale: rect.width / props.app.width,
  };
}
function resizePanelMove(e: PointerEvent) {
  if (panelDrag)
    props.app.editorWidth = Math.round(
      Math.max(
        180,
        Math.min(
          props.app.width - 120,
          panelDrag.width - (e.clientX - panelDrag.x) / panelDrag.scale,
        ),
      ),
    );
}
function resizePanelKey(e: KeyboardEvent) {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    e.stopPropagation();
    props.app.editorWidth = Math.max(
      180,
      Math.min(
        props.app.width - 120,
        editorWidth.value + (e.key === "ArrowLeft" ? 16 : -16),
      ),
    );
  }
}
const menuTrigger = ref<HTMLButtonElement>();
const menuPanel = ref<HTMLDivElement>();
function outsideMenu(event: PointerEvent) {
  const target = event.target as Node;
  if (
    menu.value &&
    !menuTrigger.value?.contains(target) &&
    !menuPanel.value?.contains(target)
  )
    menu.value = false;
}
function escapeMenu(event: KeyboardEvent) {
  if (event.key === "Escape") menu.value = false;
}
function closeMenu() {
  menu.value = false;
}
onMounted(() => {
  document.addEventListener("pointerdown", outsideMenu, true);
  document.addEventListener("keydown", escapeMenu);
  window.addEventListener("blur", closeMenu);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outsideMenu, true);
  document.removeEventListener("keydown", escapeMenu);
  window.removeEventListener("blur", closeMenu);
});
const customName = ref(""),
  customCode = ref("return value.toUpperCase()"),
  customId = ref("");
const customEditing = computed(() =>
  props.workspace.customNodes.find((n) => n.id === customId.value),
);
watch(
  customEditing,
  (node) => {
    if (node) {
      customName.value = node.name;
      customCode.value = node.code;
    }
  },
  { flush: "sync" },
);
const customGraphOpen = ref(false);
const customGraphSource = computed(() => {
  const n = customEditing.value;
  if (!n?.rules) return undefined;
  return {
    id: n.id,
    kind: "button" as const,
    get label() {
      return n.name;
    },
    get rules() {
      return n.rules!;
    },
    set rules(value: Rule[]) {
      n.rules = value;
    },
    get graph() {
      return n.graph;
    },
    set graph(value: Block["graph"]) {
      n.graph = value;
    },
  };
});
function moveRule(rules: Rule[], index: number, direction: number) {
  const target = index + direction;
  if (target >= 0 && target < rules.length)
    rules.splice(target, 0, rules.splice(index, 1)[0]!);
}
watch([customName, customCode], () => {
  if (!customEditing.value) return;
  customEditing.value.name = customName.value.trim() || "Reusable action";
  customEditing.value.code = customCode.value;
});
const availableTargets = (r: Rule) =>
  flatten(
    (r.appId ? props.workspace.apps.find((a) => a.id === r.appId) : props.app)
      ?.blocks || [],
  );
const visibleTree = computed(() => {
  const result: { block: Block; depth: number }[] = [];
  const visit = (list: Block[], depth: number) =>
    list.forEach((block) => {
      result.push({ block, depth });
      if (!collapsed.value.includes(block.id)) visit(block.children, depth + 1);
    });
  visit(root.value, 0);
  return result;
});
function add(kind: Kind) {
  const b = makeBlock(kind);
  addedBlockId.value = b.id;
  if (current.value?.kind === "container") current.value.children.push(b);
  else props.app.blocks.push(b);
  selected.value = b.id;
  adding.value = false;
}
function remove(id: string, list = props.app.blocks): boolean {
  const i = list.findIndex((b) => b.id === id);
  if (i >= 0) {
    list.splice(i, 1);
    return true;
  }
  return list.some((b) => remove(id, b.children));
}
function move(id: string, delta: number, list = props.app.blocks): boolean {
  const i = list.findIndex((b) => b.id === id);
  if (i >= 0) {
    const to = i + delta;
    if (to >= 0 && to < list.length) {
      const b = list.splice(i, 1)[0]!;
      list.splice(to, 0, b);
    }
    return true;
  }
  return list.some((b) => move(id, delta, b.children));
}
function addRule() {
  if (current.value?.graph) {
    graph.value = true;
    return;
  }
  current.value?.rules.push({
    id: uid(),
    action: "add-item",
    target: blocks.value.find((b) => b.kind === "list")?.id || "",
    appId: "",
    value: "",
  });
}
function share() {
  if (!current.value) return;
  const id = uid();
  const block = JSON.parse(JSON.stringify(current.value)) as Block;
  delete block.sharedId;
  props.workspace.library.push({ id, name: block.label, block });
  current.value.sharedId = id;
}
function useShared(id: string) {
  const l = props.workspace.library.find((l) => l.id === id);
  if (!l) return;
  const b = JSON.parse(JSON.stringify(l.block)) as Block;
  const reId = (node: Block) => {
    node.id = uid();
    node.rules = [];
    delete node.graph;
    node.children.forEach(reId);
  };
  reId(b);
  b.sharedId = id;
  props.app.blocks.push(b);
  selected.value = b.id;
}
function publishShared() {
  const b = current.value;
  if (!b?.sharedId) return;
  const l = props.workspace.library.find((l) => l.id === b.sharedId);
  if (!l) return;
  l.block = JSON.parse(JSON.stringify(b));
  l.name = b.label;
  props.workspace.apps.forEach((a) =>
    flatten(a.blocks)
      .filter((n) => n.sharedId === b.sharedId && n.id !== b.id)
      .forEach((n) => {
        n.label = b.label;
        n.layout = b.layout;
        n.gap = b.gap;
        n.code = b.code;
      }),
  );
}
function saveNode() {
  if (!customName.value.trim()) {
    ruleError.value = "Give the reusable action a name.";
    return;
  }
  const existing = props.workspace.customNodes.find(
    (n) => n.id === customId.value,
  );
  if (existing) {
    existing.name = customName.value.trim();
    existing.code = customCode.value;
  } else
    props.workspace.customNodes.push({
      id: uid(),
      name: customName.value.trim(),
      code: customCode.value,
    });
  customName.value = "";
  customId.value = "";
  ruleError.value = "";
}
function groupRules(ids?: string[]) {
  ruleError.value = "";
  const source = customGraphOpen.value
    ? customGraphSource.value
    : ruleGraphSource.value || current.value;
  if (!source?.rules.length) return;
  const selectedIds = Array.isArray(ids) ? ids : source.rules.map((r) => r.id);
  const selectedRules = source.rules.filter((r) => selectedIds.includes(r.id));
  if (!selectedRules.length) return;
  const outer = source.graph;
  if (outer) {
    const crosses = (id: string, seen = new Set<string>()): boolean => {
      if (selectedIds.includes(id)) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return outer.edges
        .filter((e) => e.source === id)
        .some((e) => crosses(e.target, seen));
    };
    if (
      outer.edges.some(
        (e) =>
          selectedIds.includes(e.source) &&
          !selectedIds.includes(e.target) &&
          crosses(e.target),
      )
    ) {
      ruleError.value =
        "Group adjacent nodes so the outer graph stays free of loops.";
      return;
    }
  }
  const nodeId = uid();
  const groupedGraph = outer
    ? {
        positions: Object.fromEntries(
          Object.entries(outer.positions).filter(
            ([id]) => id === "trigger" || selectedIds.includes(id),
          ),
        ),
        edges: outer.edges
          .filter(
            (e) =>
              selectedIds.includes(e.source) && selectedIds.includes(e.target),
          )
          .map((e) => ({ ...e })),
      }
    : undefined;
  if (groupedGraph) {
    const entries = outer!.edges.filter(
      (e) => !selectedIds.includes(e.source) && selectedIds.includes(e.target),
    );
    for (const edge of entries)
      groupedGraph.edges.push({
        id: uid(),
        source: "trigger",
        target: edge.target,
      });
    if (!entries.length)
      groupedGraph.edges.push({
        id: uid(),
        source: "trigger",
        target: selectedRules[0]!.id,
      });
  }
  props.workspace.customNodes.push({
    id: nodeId,
    name: `${source.label} flow`,
    code: "",
    rules: JSON.parse(JSON.stringify(selectedRules)),
    graph: groupedGraph,
  });
  const rule: Rule = {
    id: uid(),
    action: "custom",
    target: "",
    appId: "",
    value: "",
    nodeId,
  };
  const insert = source.rules.findIndex((r) => selectedIds.includes(r.id));
  source.rules = source.rules.filter((r) => !selectedIds.includes(r.id));
  source.rules.splice(insert, 0, rule);
  if (outer) {
    outer.positions[rule.id] = outer.positions[selectedRules[0]!.id] || {
      x: 320,
      y: 120,
    };
    selectedIds.forEach((id) => delete outer.positions[id]);
    const seen = new Set<string>();
    outer.edges = outer.edges
      .filter(
        (e) =>
          !(selectedIds.includes(e.source) && selectedIds.includes(e.target)),
      )
      .map((e) => ({
        ...e,
        source: selectedIds.includes(e.source) ? rule.id : e.source,
        target: selectedIds.includes(e.target) ? rule.id : e.target,
      }))
      .filter((e) => {
        const key = e.source + e.target;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
}
watch(editing, () => {
  adding.value = false;
  menu.value = false;
  graph.value = false;
  customGraphOpen.value = false;
  codeTarget.value = null;
});
defineExpose({
  openView,
  edit: () => {
    editing.value = true;
  },
});
</script>
<template>
  <section
    class="app-surface"
    v-motion="{ kind: 'app', initial: !!enterMotion }"
    :class="{
      'is-editing': editing,
      'app-headerless': app.showName === false && !editing,
      'has-live-page': hasLivePage,
    }"
    :style="{
      '--app-accent': app.accent,
      '--layout-columns': app.width < (app.breakpoint || 440) ? 1 : 2,
      '--app-padding': app.padding + 'px',
      '--app-gap': app.gap + 'px',
      '--app-radius': app.radius + 'px',
    }"
    :aria-label="app.name"
  >
    <div class="app-topline">
      <input
        v-if="editing"
        class="app-name"
        v-model="app.name"
        aria-label="App name"
        placeholder="Untitled app"
        maxlength="80"
      />
      <span v-else class="app-name app-title" :title="app.name">{{
        app.name || "Untitled app"
      }}</span>
      <div class="app-top-actions">
        <button
          v-if="!editing"
          class="subtle-button build-button"
          @click="editing = true"
        >
          <Icon name="edit" :size="13" />Build app</button
        ><button
          v-else
          class="subtle-button done-button"
          @click="editing = false"
        >
          <Icon name="check" :size="14" />Done</button
        ><button
          class="icon-button"
          :aria-label="`Options for ${app.name}`"
          ref="menuTrigger"
          @click="menu = !menu"
        >
          <Icon name="more" />
        </button>
      </div>
      <div
        v-if="menu"
        ref="menuPanel"
        class="app-menu floating-panel"
        v-motion="{ kind: 'popover' }"
      >
        <button
          @click="
            emit('geometry', app);
            menu = false;
          "
        >
          <Icon name="move" />Position & size</button
        ><button
          @click="
            emit('duplicate', app);
            menu = false;
          "
        >
          <Icon name="copy" />Duplicate app</button
        ><button
          @click="
            emit('archive', app);
            menu = false;
          "
        >
          <Icon name="archive" />Archive app
        </button>
      </div>
    </div>
    <div class="app-workarea">
      <NodeGraph
        v-if="customGraphOpen && customGraphSource"
        :key="customGraphSource.id"
        :block="customGraphSource"
        :app="app"
        :workspace="workspace"
        :error="ruleError"
        @close="customGraphOpen = false"
        @run="
          emit('run', app, {
            ...makeBlock('button'),
            rules: customGraphSource.rules,
            graph: customGraphSource.graph,
            label: customGraphSource.label,
          })
        "
        @group="groupRules"
      />
      <NodeGraph
        v-if="graph && current"
        :key="ruleGraphSource?.id || current.id"
        :block="ruleGraphSource || current"
        :app="app"
        :workspace="workspace"
        :error="ruleError"
        @close="
          graph = false;
          expandedRule = undefined;
        "
        @run="
          emit(
            'run',
            app,
            ruleGraphSource
              ? {
                  ...current,
                  rules: ruleGraphSource.rules,
                  graph: ruleGraphSource.graph,
                }
              : current,
          )
        "
        @group="groupRules"
      />
      <div v-if="codeTarget" class="code-workspace" v-motion="{ kind: 'fade' }">
        <CodeEditor
          v-if="codeTarget === 'block' && current"
          :key="current.id"
          v-model="current.code"
          language="html"
          label="HTML / CSS / JavaScript"
          expanded
          @expand="codeTarget = null"
        /><CodeEditor
          v-else
          :key="customId || 'new-action'"
          v-model="customCode"
          language="javascript"
          label="JavaScript"
          expanded
          @expand="codeTarget = null"
        />
      </div>
      <div
        class="app-content"
        v-motion="{
          kind: 'fade',
          show: !graph && !codeTarget && !customGraphOpen,
          initial: false,
        }"
        v-show="!graph && !codeTarget && !customGraphOpen"
        :class="{ 'preview-edit': editing }"
        @click="editing && (selected = '')"
      >
        <BlockView
          v-for="block in app.blocks"
          :key="block.id"
          :block="block"
          :added-block-id="addedBlockId"
          :fill-height="
            block.kind === 'code' &&
            (block.sizing === 'fill' ||
              (app.blocks.length === 1 && block.sizing !== 'fixed'))
          "
          :editing="editing"
          :selected="selected"
          @select="
            selected = $event;
            adding = false;
          "
          @run="emit('run', app, $event)"
          @error="emit('error', $event)"
        /><button
          v-if="editing && !app.blocks.length"
          class="first-component"
          @click.stop="adding = true"
        >
          <Icon name="plus" :size="18" /><span>Add your first component</span>
        </button>
      </div>
      <div
        v-if="editing && !graph && !codeTarget && !customGraphOpen"
        class="editor-splitter"
        role="separator"
        aria-label="Resize builder panel"
        aria-orientation="vertical"
        tabindex="0"
        :aria-valuenow="editorWidth"
        :aria-valuemin="180"
        :aria-valuemax="Math.max(180, app.width - 120)"
        @pointerdown.stop="resizePanelStart"
        @pointermove.stop="resizePanelMove"
        @pointerup.stop="panelDrag = null"
        @pointercancel="panelDrag = null"
        @keydown="resizePanelKey"
      ></div>
      <aside
        v-if="editing"
        v-show="!graph && !codeTarget && !customGraphOpen"
        class="editor"
        v-motion="{
          kind: 'panel',
          show: !graph && !codeTarget && !customGraphOpen,
        }"
        aria-label="App builder"
        :style="{ width: editorWidth + 'px', flexBasis: editorWidth + 'px' }"
      >
        <div class="editor-tabs">
          <button
            :class="{ active: tab === 'structure' }"
            @click="tab = 'structure'"
          >
            Build</button
          ><button :class="{ active: tab === 'style' }" @click="tab = 'style'">
            Style</button
          ><button
            :class="{ active: tab === 'connect' }"
            @click="tab = 'connect'"
          >
            Connect
          </button>
        </div>
        <div
          class="editor-scroll"
          v-motion="{ kind: 'fade', state: tab, initial: false }"
        >
          <template v-if="tab === 'structure'">
            <div class="section-line">
              <span>Structure</span
              ><button
                class="icon-button"
                title="Add component"
                @click="adding = !adding"
              >
                <Icon :name="adding ? 'close' : 'plus'" :size="14" />
              </button>
            </div>
            <div
              v-if="adding"
              class="component-picker"
              v-motion="{ kind: 'fade' }"
            >
              <button
                v-for="k in kinds"
                :key="k.kind"
                @click="add(k.kind)"
                :title="k.description"
              >
                <Icon :name="k.kind" :size="14" />{{ k.name }}</button
              ><template v-if="workspace.library.length"
                ><div class="section-line">Shared components</div>
                <button
                  v-for="l in workspace.library"
                  :key="l.id"
                  @click="
                    useShared(l.id);
                    adding = false;
                  "
                >
                  <Icon name="link" :size="14" />{{ l.name }}
                </button></template
              >
            </div>
            <template v-else>
              <button
                class="tree-root"
                :class="{ selected: !selected }"
                @click="selected = ''"
              >
                <Icon name="app" :size="14" />App layout
              </button>
              <div
                v-for="entry in visibleTree"
                :key="entry.block.id"
                class="tree-item"
                :class="{ selected: selected === entry.block.id }"
                :style="{ paddingLeft: 8 + entry.depth * 12 + 'px' }"
              >
                <button
                  v-if="entry.block.kind === 'container'"
                  class="tree-toggle"
                  :aria-label="`Toggle ${entry.block.label}`"
                  @click="
                    collapsed.includes(entry.block.id)
                      ? collapsed.splice(collapsed.indexOf(entry.block.id), 1)
                      : collapsed.push(entry.block.id)
                  "
                >
                  <Icon
                    :name="
                      collapsed.includes(entry.block.id) ? 'right' : 'down'
                    "
                    :size="12"
                  /></button
                ><button class="tree-select" @click="selected = entry.block.id">
                  <Icon :name="entry.block.kind" :size="13" /><span>{{
                    entry.block.label
                  }}</span
                  ><Icon v-if="entry.block.sharedId" name="link" :size="11" />
                </button>
              </div>
              <button class="add-component" @click="adding = true">
                <Icon name="plus" :size="13" />Add component
              </button>
              <div class="property-section" v-if="current">
                <div class="section-line">
                  <span>{{
                    kinds.find((k) => k.kind === current?.kind)?.name
                  }}</span>
                  <div class="inline-actions">
                    <button
                      class="icon-button"
                      title="Move up"
                      @click="move(current.id, -1)"
                    >
                      ↑</button
                    ><button
                      class="icon-button"
                      title="Move down"
                      @click="move(current.id, 1)"
                    >
                      ↓</button
                    ><button
                      class="icon-button"
                      title="Remove component"
                      @click="
                        remove(current.id);
                        selected = '';
                      "
                    >
                      <Icon name="close" :size="13" />
                    </button>
                  </div>
                </div>
                <label class="property"
                  >Label<input v-model="current.label"
                /></label>
                <p v-if="current.kind === 'git'" class="field-help">
                  Leave Build mode to choose a local repository or switch saved
                  Git workspaces. This viewer reads your Git history and
                  changes.
                </p>
                <template v-if="current.kind === 'container'"
                  ><label class="property"
                    >Arrangement<CustomSelect v-model="current.layout">
                      <option value="column">Stack vertically</option>
                      <option value="row">Side by side</option>
                      <option value="grid">Two-column grid</option>
                    </CustomSelect></label
                  ><label class="property"
                    >Spacing
                    <input
                      type="range"
                      v-model.number="current.gap"
                      min="0"
                      max="48" /></label
                  ><button class="subtle-button" @click="adding = true">
                    <Icon name="plus" :size="13" />Add inside layout
                  </button></template
                >
                <label v-if="current.kind === 'text'" class="property"
                  >Content<textarea v-model="current.label" rows="3"></textarea>
                </label>
                <label v-if="current.kind === 'input'" class="property"
                  >Value<input v-model="current.value"
                /></label>
                <label v-if="current.kind === 'counter'" class="property"
                  >Starting value<CustomNumber
                    aria-label="Starting value"
                    v-model="current.count"
                /></label>
                <label v-if="current.kind === 'code'" class="property"
                  >Frame sizing<CustomSelect
                    aria-label="Code frame sizing"
                    :model-value="codeFills ? 'fill' : 'fixed'"
                    @update:model-value="current.sizing = $event"
                    ><option
                      value="fill"
                      :disabled="!app.blocks.some((b) => b.id === current?.id)"
                    >
                      Fill available app height
                    </option>
                    <option value="fixed">Fixed height</option></CustomSelect
                  ></label
                >
                <label
                  v-if="current.kind === 'code' && !codeFills"
                  class="property"
                  >Frame height<CustomNumber
                    aria-label="Code frame height"
                    :model-value="current.height || 210"
                    :min="60"
                    :max="1600"
                    @update:model-value="current.height = $event"
                /></label>
                <label v-if="current.kind === 'code'" class="property"
                  >HTML / CSS / JavaScript<CodeEditor
                    :key="current.id"
                    v-model="current.code"
                    language="html"
                    label="HTML / CSS / JavaScript"
                    @expand="codeTarget = 'block'"
                  /><span class="field-help"
                    >Runs immediately in an isolated frame. External resources
                    and workspace storage are restricted.</span
                  ></label
                >
                <template
                  v-if="['button', 'checkbox', 'input'].includes(current.kind)"
                >
                  <div class="section-line actions-heading">
                    <span>{{
                      current.kind === "input"
                        ? "On Enter"
                        : current.kind === "checkbox"
                          ? "On change"
                          : "On click"
                    }}</span
                    ><button
                      class="icon-button"
                      title="Add action"
                      @click="addRule"
                    >
                      <Icon name="plus" :size="13" />
                    </button>
                  </div>
                  <p v-if="!current.rules.length" class="field-help">
                    Connect this component to an action.
                  </p>
                  <RuleControl
                    v-for="(rule, i) in current.rules"
                    :key="rule.id"
                    :rule="rule"
                    :app="app"
                    :workspace="workspace"
                    :index="i"
                    :total="current.rules.length"
                    expandable
                    @expand="expandRule(rule)"
                    @remove="current.rules.splice(i, 1)"
                    @move="moveRule(current.rules, i, $event)"
                  />
                  <button
                    class="subtle-button"
                    @click="
                      expandedRule = undefined;
                      graph = !graph;
                    "
                  >
                    <Icon name="workflow" :size="13" />{{
                      graph ? "Hide graph" : "Expand to graph"
                    }}
                  </button>
                </template>
                <div class="shared-actions">
                  <button
                    v-if="!current.sharedId"
                    class="subtle-button"
                    @click="share"
                  >
                    <Icon name="link" :size="13" />Make reusable</button
                  ><template v-else
                    ><span class="field-help">Linked shared component</span
                    ><button class="subtle-button" @click="publishShared">
                      Update all linked copies</button
                    ><button
                      class="subtle-button"
                      @click="delete current.sharedId"
                    >
                      <Icon name="unlink" :size="13" />Detach this copy
                    </button></template
                  >
                </div>
              </div>
              <div v-else class="field-help editor-note">
                Arrange the app with layouts, then select a component to shape
                it. Changes are live.
              </div>
            </template>
          </template>
          <template v-if="tab === 'style'"
            ><div class="section-line">App foundations</div>
            <label class="check-line small"
              ><input
                type="checkbox"
                :checked="app.showName !== false"
                @change="
                  app.showName = ($event.target as HTMLInputElement).checked
                "
              /><span>Show app name</span></label
            ><label class="property"
              >Dock icon<CustomSelect v-model="app.icon">
                <option value="app">App</option>
                <option value="text">Text</option>
                <option value="list">List</option>
                <option value="counter">Counter</option>
                <option value="code">Code</option>
                <option value="box">Box</option>
              </CustomSelect></label
            ><label class="property"
              >Stack grid below<CustomNumber
                :model-value="app.breakpoint || 440"
                :min="180"
                :max="1600"
                aria-label="Responsive breakpoint"
                @update:model-value="app.breakpoint = $event" /></label
            ><label class="property"
              >Minimum width<CustomNumber
                :model-value="appMinimum(app).width"
                :min="180"
                aria-label="Minimum app width"
                @update:model-value="app.minWidth = $event" /></label
            ><label class="property"
              >Minimum height<CustomNumber
                :model-value="appMinimum(app).height"
                :min="160"
                aria-label="Minimum app height"
                @update:model-value="app.minHeight = $event" /></label
            ><label class="property"
              >Component spacing <span>{{ app.gap }}px</span
              ><input
                type="range"
                v-model.number="app.gap"
                min="0"
                max="40" /></label
            ><label class="property"
              >Corner radius <span>{{ app.radius }}px</span
              ><input type="range" v-model.number="app.radius" min="0" max="16"
            /></label>
            <p class="field-help">
              Shared foundations keep your apps feeling at home. Each app can
              make them its own.
            </p></template
          >
          <template v-if="tab === 'connect'"
            ><div class="section-line">App interface</div>
            <label class="check-line small"
              ><input type="checkbox" v-model="app.exposed" /><span
                >Expose data & actions</span
              ></label
            >
            <p class="field-help">
              Other apps can explicitly target these components through an
              action rule. Connections use stable IDs, even after a rename.
            </p>
            <div v-if="app.exposed" class="interface-list">
              <div
                v-for="b in blocks.filter(
                  (b) => b.kind !== 'divider' && b.kind !== 'container',
                )"
                :key="b.id"
              >
                <Icon :name="b.kind" :size="13" /><span>{{ b.label }}</span>
              </div>
            </div>
            <label class="property"
              >Spatial group<CustomSelect
                aria-label="Spatial group"
                :model-value="app.groupId || ''"
                @update:model-value="
                  app.groupId = $event;
                  app.group =
                    workspace.groups?.find((g) => g.id === $event)?.name || '';
                "
                ><option value="">No group</option>
                <option
                  v-for="group in workspace.groups || []"
                  :key="group.id"
                  :value="group.id"
                >
                  {{ group.name || "Untitled group" }}
                </option></CustomSelect
              ></label
            >
            <p class="field-help">
              Drag a group label or border to move its apps together. Moving one
              app leaves the others in place.
            </p>
            <div class="section-line actions-heading">Reusable code action</div>
            <label class="property"
              >Name<input v-model="customName" placeholder="e.g. Uppercase"
            /></label>
            <div v-if="customEditing?.rules" class="grouped-action-editor">
              <button class="subtle-button" @click="customGraphOpen = true">
                <Icon name="workflow" :size="13" />Open node group
              </button>
              <div class="section-line">Grouped action steps</div>
              <RuleControl
                v-for="(r, i) in customEditing.rules"
                :key="r.id"
                :rule="r"
                :app="app"
                :workspace="workspace"
                :index="i"
                :total="customEditing.rules.length"
                @remove="customEditing.rules.splice(i, 1)"
                @move="moveRule(customEditing.rules, i, $event)"
              />
            </div>
            <label v-else class="property"
              >JavaScript<CodeEditor
                :key="customId || 'new-action'"
                v-model="customCode"
                language="javascript"
                label="JavaScript"
                @expand="codeTarget = 'custom'"
              /><span class="field-help"
                >Receives “value”; return the next value in the chain. Isolated
                execution, 2-second timeout.</span
              ></label
            ><button class="subtle-button" @click="saveNode">
              <Icon name="plus" :size="13" />{{
                customId ? "Done editing action" : "Create reusable action"
              }}
            </button>
            <div
              v-for="n in workspace.customNodes"
              :key="n.id"
              class="reusable-node"
            >
              <Icon name="workflow" :size="13" /><button
                class="node-edit-button"
                :aria-label="`Edit ${n.name}`"
                @click="
                  customId = n.id;
                  customName = n.name;
                  customCode = n.code;
                "
              >
                {{ n.name }}</button
              ><button
                class="icon-button"
                title="Delete reusable action"
                @click="
                  workspace.customNodes = workspace.customNodes.filter(
                    (x) => x.id !== n.id,
                  )
                "
              >
                <Icon name="close" :size="12" />
              </button></div
          ></template>
          <p v-if="ruleError" class="inline-error" role="status">
            {{ ruleError }}
          </p>
        </div>
        <div class="editor-footer">
          <span class="live-dot"></span>Live on your canvas
        </div>
      </aside>
    </div>
    <div v-if="!app.blocks.length && !editing" class="blank-footnote">
      <Icon name="box" :size="13" /><span
        >A little space for something of your own.</span
      >
    </div>
  </section>
</template>
