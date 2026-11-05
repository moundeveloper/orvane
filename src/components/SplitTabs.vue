<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { uid } from "../model";
import {
  activate,
  isSplit as splitActive,
  moveToGroup,
  reorder,
  splitWith,
  type SplitLayout,
  type SplitSide,
} from "../splitTabs";
type TabInfo = { label: string; icon?: string; title?: string };
const props = defineProps<{
  layout: SplitLayout;
  info: (id: string) => TabInfo;
  label: string;
  canReopen?: boolean;
  accept?: string;
  lazy?: boolean;
}>();
const emit = defineEmits<{
  add: [SplitSide | null];
  close: [string];
  reopen: [];
  reload: [string];
  duplicate: [string];
  changed: [];
  external: [DragEvent, SplitSide | null];
  resizeStart: [];
  resizeEnd: [];
}>();
const owner = uid(),
  MIME = "application/x-orvane-tab";
const root = ref<HTMLElement>(),
  panes = ref<HTMLElement>(),
  dragging = ref(""),
  marker = ref<{ id: string; side: "before" | "after" } | null>(null),
  splitZone = ref<SplitSide | null>(null),
  barZone = ref<SplitSide | "single" | null>(null),
  menu = ref<{ id: string; x: number; y: number } | null>(null);
const split = computed(() => splitActive(props.layout));
const initialized = ref(new Set<string>());
watch(
  () => [
    props.layout.tabs,
    props.layout.active,
    props.layout.leftActive,
    props.layout.rightActive,
    split.value,
  ],
  () => {
    const visible = split.value
      ? [props.layout.leftActive, props.layout.rightActive]
      : [props.layout.active];
    initialized.value = new Set(
      props.layout.tabs.filter(
        (id) => initialized.value.has(id) || visible.includes(id),
      ),
    );
  },
  { immediate: true, deep: true, flush: "sync" },
);
const groups = computed(() =>
  split.value
    ? ([
        ["left", props.layout.left, props.layout.leftActive],
        ["right", props.layout.right, props.layout.rightActive],
      ] as const)
    : ([[null, props.layout.tabs, props.layout.active]] as const),
);
function changed() {
  emit("changed");
}
function select(id: string) {
  activate(props.layout, id);
  changed();
}
function paneStyle(id: string) {
  const l = props.layout;
  if (!split.value)
    return id === l.active ? { left: "0", right: "0" } : { display: "none" };
  if (id === l.leftActive) return { left: "0", width: `calc(${l.ratio}% - 2px)` };
  if (id === l.rightActive) return { left: `calc(${l.ratio}% + 2px)`, right: "0" };
  return { display: "none" };
}
function payload(event: DragEvent) {
  try {
    const data = JSON.parse(event.dataTransfer?.getData(MIME) || "null");
    return data?.owner === owner ? String(data.id) : "";
  } catch {
    return "";
  }
}
function ownDrag(event: DragEvent) {
  return !!dragging.value && !!event.dataTransfer?.types.includes(MIME);
}
function external(event: DragEvent) {
  return !!props.accept && !!event.dataTransfer?.types.includes(props.accept);
}
function dragStart(event: DragEvent, id: string) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(MIME, JSON.stringify({ owner, id }));
  dragging.value = id;
  menu.value = null;
}
function dragEnd() {
  dragging.value = "";
  marker.value = null;
  splitZone.value = null;
  barZone.value = null;
}
function tabOver(event: DragEvent, id: string) {
  if (!ownDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  marker.value = {
    id,
    side: event.clientX < box.left + box.width / 2 ? "before" : "after",
  };
}
function tabDrop(event: DragEvent, id: string) {
  const source = payload(event),
    place = marker.value?.side ?? "before";
  dragEnd();
  if (!source || source === id) return;
  reorder(props.layout, source, id, place);
  changed();
}
function barOver(event: DragEvent, group: SplitSide | null) {
  if (ownDrag(event) || external(event)) {
    event.preventDefault();
    barZone.value = group ?? "single";
  }
}
function barDrop(event: DragEvent, group: SplitSide | null) {
  const source = payload(event);
  barZone.value = null;
  if (!source) {
    if (external(event)) emit("external", event, group);
    return dragEnd();
  }
  dragEnd();
  if (group) {
    moveToGroup(props.layout, source, group);
    changed();
  }
}
function zoneDrop(event: DragEvent, side: SplitSide) {
  const source = payload(event);
  dragEnd();
  if (!source) return;
  splitWith(props.layout, source, side);
  changed();
}
function wheel(event: WheelEvent) {
  const bar = event.currentTarget as HTMLElement;
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    bar.scrollLeft += event.deltaY;
    event.preventDefault();
  }
}
let stopResize: (() => void) | undefined;
function startResize(event: PointerEvent) {
  stopResize?.();
  const box = panes.value?.getBoundingClientRect();
  if (!box) return;
  emit("resizeStart");
  const move = (e: PointerEvent) => {
    props.layout.ratio = Math.min(
      80,
      Math.max(20, ((e.clientX - box.left) / box.width) * 100),
    );
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    window.removeEventListener("blur", up);
    stopResize = undefined;
    emit("resizeEnd");
    changed();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  window.addEventListener("blur", up);
  stopResize = up;
}
function resizeKey(event: KeyboardEvent) {
  const step = event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : 0;
  if (!step) return;
  event.preventDefault();
  props.layout.ratio = Math.min(80, Math.max(20, props.layout.ratio + step));
  changed();
}
function showMenu(event: MouseEvent, id: string) {
  const box = root.value;
  if (!box) return;
  const bounds = box.getBoundingClientRect(),
    scale = bounds.width / box.offsetWidth || 1;
  menu.value = {
    id,
    x: Math.max(
      0,
      Math.min(box.offsetWidth - 220, (event.clientX - bounds.left) / scale),
    ),
    y: Math.max(
      0,
      Math.min(box.offsetHeight - 300, (event.clientY - bounds.top) / scale),
    ),
  };
}
function closeMany(ids: string[]) {
  for (const id of ids) emit("close", id);
}
function run(action: string) {
  const id = menu.value?.id;
  menu.value = null;
  if (!id) return;
  const l = props.layout,
    group = l.left.includes(id) ? l.left : l.right.includes(id) ? l.right : l.tabs;
  if (action === "reload") emit("reload", id);
  else if (action === "duplicate") emit("duplicate", id);
  else if (action === "left" || action === "right") {
    splitWith(l, id, action);
    changed();
  } else if (action === "others") closeMany(group.filter((x) => x !== id));
  else if (action === "right-of") closeMany(group.slice(group.indexOf(id) + 1));
  else if (action === "close") emit("close", id);
}
function keys(event: KeyboardEvent) {
  if (!event.ctrlKey || !event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "t" && props.canReopen) emit("reopen");
  else if (key === "n") emit("add", null);
  else return;
  event.preventDefault();
  event.stopPropagation();
}
function outside(event: PointerEvent) {
  if (!(event.target as Element)?.closest?.(".st-menu")) menu.value = null;
}
onMounted(() => document.addEventListener("pointerdown", outside, true));
onBeforeUnmount(() => {
  stopResize?.();
  document.removeEventListener("pointerdown", outside, true);
});
</script>
<template>
  <div ref="root" class="st-root" @keydown="keys">
    <div class="st-bars" :class="{ split }">
      <div
        v-for="[group, ids, current] in groups"
        :key="group ?? 'single'"
        class="st-bar"
        :class="{ 'drop-active': barZone === (group ?? 'single') }"
        :style="
          split && group === 'left'
            ? { width: `calc(${layout.ratio}% - 2px)` }
            : undefined
        "
        role="tablist"
        :aria-label="group ? `${label} (${group})` : label"
        @dragover="barOver($event, group)"
        @dragleave.self="barZone = null"
        @drop.prevent="barDrop($event, group)"
      >
        <div class="st-scroll" @wheel="wheel">
          <div
            v-for="id in ids"
            :key="id"
            class="st-tab"
            :class="{
              active: id === current,
              focused: split && id === layout.active,
              dragging: id === dragging,
              'drop-before': marker?.id === id && marker.side === 'before',
              'drop-after': marker?.id === id && marker.side === 'after',
            }"
            draggable="true"
            :title="info(id).title || info(id).label"
            @pointerdown.middle.stop.prevent
            @mousedown.middle.stop.prevent
            @auxclick.middle.stop.prevent="emit('close', id)"
            @contextmenu.prevent.stop="showMenu($event, id)"
            @dragstart="dragStart($event, id)"
            @dragend="dragEnd"
            @dragover="tabOver($event, id)"
            @dragleave="marker?.id === id && (marker = null)"
            @drop.prevent.stop="tabDrop($event, id)"
          >
            <button
              role="tab"
              :aria-selected="id === current"
              @click="select(id)"
            >
              <Icon v-if="info(id).icon" :name="info(id).icon!" :size="12" />
              <span>{{ info(id).label }}</span></button
            ><button
              v-if="layout.tabs.length > 1"
              class="st-close"
              :aria-label="`Close ${info(id).label} tab`"
              title="Close tab"
              @click.stop="emit('close', id)"
            >
              <Icon name="close" :size="11" />
            </button>
          </div>
          <button
            class="st-add"
            :aria-label="`New ${label} tab`"
            title="New tab (Ctrl+Alt+N)"
            @click="emit('add', group)"
          >
            <Icon name="plus" :size="13" />
          </button>
          <button
            v-if="canReopen"
            class="st-add"
            :aria-label="`Reopen closed ${label} tab`"
            title="Reopen closed tab (Ctrl+Alt+T)"
            @click="emit('reopen')"
          >
            <Icon name="undo" :size="13" />
          </button>
          <slot v-if="group !== 'left'" name="actions" />
        </div>
      </div>
    </div>
    <div ref="panes" class="st-panes">
      <template v-if="dragging && !split && layout.tabs.length > 1">
        <div
          v-for="side in ['left', 'right'] as const"
          :key="side"
          class="st-zone"
          :class="[side, { active: splitZone === side }]"
          @dragover.prevent="splitZone = side"
          @dragleave="splitZone = null"
          @drop.prevent="zoneDrop($event, side)"
        >
          <Icon name="layers" :size="15" />Split {{ side === "left" ? "Left" : "Right" }}
        </div>
      </template>
      <div
        v-if="split"
        class="st-handle"
        role="separator"
        tabindex="0"
        aria-label="Resize split"
        :aria-valuenow="Math.round(layout.ratio)"
        :style="{ left: `calc(${layout.ratio}% - 3px)` }"
        @pointerdown.prevent="startResize"
        @keydown="resizeKey"
      />
      <div
        v-for="id in layout.tabs"
        :key="id"
        class="st-pane"
        :class="{ focused: split && id === layout.active }"
        :style="paneStyle(id)"
        @pointerdown.capture="split && layout.active !== id && select(id)"
      >
        <slot
          v-if="!lazy || initialized.has(id)"
          name="pane"
          :id="id"
          :focused="id === layout.active"
          :visible="paneStyle(id).display !== 'none'"
        />
      </div>
    </div>
    <div
      v-if="menu"
      class="st-menu"
      role="menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
    >
      <button role="menuitem" @click="run('reload')">
        <Icon name="refresh" :size="13" />Reload tab
      </button>
      <button role="menuitem" @click="run('duplicate')">
        <Icon name="copy" :size="13" />Duplicate
      </button>
      <button
        role="menuitem"
        :disabled="layout.tabs.length < 2"
        @click="run('left')"
      >
        <Icon name="layers" :size="13" />Open in left split
      </button>
      <button
        role="menuitem"
        :disabled="layout.tabs.length < 2"
        @click="run('right')"
      >
        <Icon name="layers" :size="13" />Open in right split
      </button>
      <hr />
      <button role="menuitem" @click="run('others')">
        <Icon name="close" :size="13" />Close others
      </button>
      <button role="menuitem" @click="run('right-of')">
        <Icon name="forward" :size="13" />Close tabs to the right
      </button>
      <button role="menuitem" @click="run('close')">
        <Icon name="close" :size="13" />Close tab
      </button>
    </div>
  </div>
</template>
<style scoped>
.st-root {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.st-bars {
  display: flex;
  flex: none;
  border-bottom: 1px solid #dce5e9;
  background: #f0f4f6;
}
.st-bars.split .st-bar:first-child {
  flex: none;
  border-right: 4px solid #e3eaee;
}
.st-bar {
  flex: 1;
  min-width: 0;
}
.st-bar.drop-active {
  background: #e2edf2;
  box-shadow: inset 0 -2px #6f9ab0;
}
.st-scroll {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 4px 8px 0;
  min-height: 34px;
  overflow-x: auto;
  scrollbar-width: none;
}
.st-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 2px;
  padding: 0 4px 0 8px;
  border-radius: 5px 5px 0 0;
  color: #607583;
}
.st-tab:hover:not(.active) {
  background: #e6eef2;
  color: #455968;
}
.st-tab.active {
  background: #fff;
  color: #344f5e;
  box-shadow: 0 1px #fff;
}
.st-tab.focused {
  box-shadow:
    inset 0 2px #4f7b93,
    0 1px #fff;
}
.st-bars:not(.split) .st-tab.active {
  box-shadow:
    inset 0 2px #7895a5,
    0 1px #fff;
}
.st-tab.dragging {
  opacity: 0.5;
}
.st-tab.drop-before::before,
.st-tab.drop-after::after {
  content: "";
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: #4f7b93;
}
.st-tab.drop-before::before {
  left: -2px;
}
.st-tab.drop-after::after {
  right: -2px;
}
.st-tab > button:first-child {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  padding: 7px 3px;
  color: inherit;
  white-space: nowrap;
}
/* The global button hover would paint a box inside the tab. */
.st-tab > button:first-child,
.st-tab > button:first-child:hover {
  background: transparent;
}
.st-tab > button:first-child span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-close {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 3px;
  color: inherit;
  background: transparent;
  opacity: 0;
}
.st-tab:hover .st-close,
.st-tab.active .st-close,
.st-close:focus-visible {
  opacity: 0.6;
}
.st-tab .st-close:hover {
  opacity: 1;
  background: #d5e3ea;
}
.st-add {
  display: grid;
  place-items: center;
  flex: none;
  width: 25px;
  height: 25px;
  margin-bottom: 3px;
  border-radius: 4px;
  color: #607583;
}
.st-add {
  background: transparent;
}
.st-add:hover {
  background: #e2ebef;
}
.st-panes {
  position: relative;
  flex: 1;
  min-height: 0;
}
.st-pane {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.st-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 6;
  width: 6px;
  cursor: col-resize;
  background: #e3eaee;
}
.st-handle:hover,
.st-handle:focus-visible {
  background: #8ca7b5;
  outline: none;
}
.st-zone {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 20;
  width: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #4f7b93;
  font-weight: 600;
  background: #eef5f880;
  border: 2px dashed transparent;
}
.st-zone.left {
  left: 0;
}
.st-zone.right {
  right: 0;
}
.st-zone.active {
  background: #d8e9f1d9;
  border-color: #6f9ab0;
}
.st-menu {
  position: absolute;
  z-index: 60;
  width: 220px;
  padding: 4px;
  border: 1px solid #dce5e9;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 8px 22px #425c6b2e;
}
.st-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 4px;
  color: #455968;
  font-size: 12px;
  text-align: left;
}
.st-menu button:hover:not(:disabled) {
  background: #e8f0f4;
}
.st-menu button:disabled {
  opacity: 0.45;
}
.st-menu hr {
  margin: 4px 2px;
  border: 0;
  border-top: 1px solid #e8eef1;
}
</style>
