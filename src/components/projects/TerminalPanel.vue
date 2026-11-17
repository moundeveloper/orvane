<script setup lang="ts">
import { nextTick, onMounted, reactive, ref, watch } from "vue";
import Icon from "../Icon.vue";
import TerminalView from "../terminal/TerminalView.vue";
import { uid, type Block } from "../../model";
import type { TerminalState as LiveLayout, TerminalTab } from "../../terminalLayout";
import type { TerminalState } from "./types";

const props = defineProps<{ block: Block; initialCwd: string; state?: TerminalState }>();
const emit = defineEmits<{ stateChange: [state: TerminalState] }>();

function migrateLayout(state?: TerminalState) {
  if (state?.layout !== undefined) return state.layout;
  if (!state?.tabs?.length) return "";
  const tabs = state.tabs.map<TerminalTab>(({ cwd, title }) => {
    const id = uid();
    return { id: uid(), name: title, focus: id, root: { type: "pane", id, profile: "", cwd } };
  });
  const active = tabs.find((tab) => tab.root.type === "pane" && tab.root.cwd === state.activeCwd);
  return JSON.stringify({ tabs, active: (active ?? tabs[0])!.id } satisfies LiveLayout);
}

const terminal = reactive<Block>({ ...props.block, kind: "terminal", value: migrateLayout(props.state) });
const view = ref<InstanceType<typeof TerminalView>>();
const isOpen = ref(props.state?.isOpen ?? true);
const maximized = ref(props.state?.isMaximized ?? false);
const height = ref(Math.min(520, Math.max(150, props.state?.height ?? 230)));

function save() {
  emit("stateChange", {
    isOpen: isOpen.value,
    isMaximized: maximized.value,
    height: height.value,
    layout: terminal.value || undefined,
  });
}

watch([isOpen, maximized, () => terminal.value], save);
onMounted(() => {
  if (props.state?.layout === undefined && terminal.value) save();
});
watch(() => props.state?.layout, (layout) => {
  if (layout !== undefined && layout !== terminal.value) terminal.value = layout;
});

let resize: { y: number; height: number; scale: number } | undefined;
function startResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  resize = { y: event.clientY, height: height.value, scale: handle.getBoundingClientRect().width / handle.offsetWidth || 1 };
  handle.setPointerCapture(event.pointerId);
}
function moveResize(event: PointerEvent) {
  if (!resize) return;
  height.value = Math.min(520, Math.max(150, resize.height + (resize.y - event.clientY) / resize.scale));
}
function endResize() {
  if (!resize) return;
  resize = undefined;
  save();
}
async function addTab(cwd = props.initialCwd, title?: string) {
  isOpen.value = true;
  await nextTick();
  view.value?.openTab(cwd, title);
}
defineExpose({ addTab });
</script>

<template>
  <section v-show="isOpen" class="terminal-panel" :class="{ maximized }" :style="{ height: height + 'px' }">
    <div class="terminal-resize-handle"
      @pointerdown.prevent="startResize" @pointermove="moveResize"
      @lostpointercapture="endResize"></div>
    <TerminalView ref="view" :block="terminal" :initial-cwd="initialCwd" :visible="isOpen">
      <template #actions>
        <button type="button" class="icon-button" :aria-label="maximized ? 'Restore terminal' : 'Maximize terminal'"
          @click="maximized = !maximized">
          <Icon name="resize" :size="14" />
        </button>
        <button type="button" class="icon-button" aria-label="Hide terminal" @click="isOpen = false">
          <Icon name="minus" :size="14" />
        </button>
      </template>
    </TerminalView>
  </section>
  <button v-if="!isOpen" type="button" class="terminal-restore" aria-label="Show terminal" @click="isOpen = true">
    <Icon name="terminal" :size="16" />
  </button>
</template>
