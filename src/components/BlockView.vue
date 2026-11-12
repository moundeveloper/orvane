<script setup lang="ts">
import {
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
  defineAsyncComponent,
} from "vue";
const GitViewer = defineAsyncComponent(() => import("./GitViewer.vue"));
const NotesView = defineAsyncComponent(() => import("./notes/NotesView.vue"));
const NetSuiteView = defineAsyncComponent(() => import("./NetSuiteView.vue"));
const BrowserView = defineAsyncComponent(() => import("./BrowserView.vue"));
const ProjectsHub = defineAsyncComponent(
  () => import("./projects/ProjectsHub.vue"),
);
import { uid, type Block } from "../model";
import Icon from "./Icon.vue";
import { vMotion } from "../motion";
import { APP_RUNTIME } from "../appRuntime";
const props = defineProps<{
  block: Block;
  editing: boolean;
  selected: string;
  fillHeight?: boolean;
  addedBlockId?: string;
}>();
const emit = defineEmits<{
  select: [id: string];
  run: [block: Block];
  error: [message: string];
}>();
const initialItems = new Set(props.block.items.map((item) => item.id));
function addItem(b: Block, e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.value.trim()) {
    b.items.push({
      id: uid(),
      text: input.value.trim(),
      done: false,
    });
    input.value = "";
  }
}
const frame = ref<HTMLIFrameElement>();
const frameError = ref("");
// The longest stall a code app reported; shown to its author in Build mode.
const frameSlow = ref(0);
function onMessage(event: MessageEvent) {
  if (!frame.value || event.source !== frame.value.contentWindow) return;
  if (typeof event.data?.orvaneCodeError === "string")
    frameError.value = event.data.orvaneCodeError.slice(0, 240);
  else if (Number.isFinite(event.data?.orvaneCodeSlow))
    frameSlow.value = Math.max(frameSlow.value, event.data.orvaneCodeSlow);
}
// A code app is told when it is on screen, so its runtime can idle its
// timers while nobody can see it (see appRuntimeSource.js).
let frameVisible: boolean | undefined;
const frameWatch =
  props.block.kind === "code"
    ? new IntersectionObserver((entries) => {
        frameVisible = entries.at(-1)?.isIntersecting;
        announceFrame();
      })
    : undefined;
function announceFrame() {
  if (frameVisible !== undefined)
    frame.value?.contentWindow?.postMessage(
      { orvaneVisible: frameVisible },
      "*",
    );
}
onMounted(() => {
  window.addEventListener("message", onMessage);
  if (frame.value) frameWatch?.observe(frame.value);
});
onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
  frameWatch?.disconnect();
});
const runningCode = ref(props.block.code);
let codeTimer: ReturnType<typeof setTimeout>;
watch(
  () => props.block.code,
  (code) => {
    clearTimeout(codeTimer);
    codeTimer = setTimeout(() => {
      runningCode.value = code;
      frameError.value = "";
      frameSlow.value = 0;
    }, 450);
  },
);
onBeforeUnmount(() => clearTimeout(codeTimer));
const sandboxDocument = (code: string) => {
  const scrollbars = `<style>:root{color-scheme:light;scrollbar-width:thin;scrollbar-color:#b8cbd6 transparent}*{scrollbar-width:thin;scrollbar-color:#b8cbd6 transparent}::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#b8cbd6;border-radius:3px}::-webkit-scrollbar-button{display:none;width:0;height:0}</style>`;
  const gutter = `<style>html.orvane-scroll-y{box-sizing:border-box;padding-inline-end:10px}</style><script>(()=>{let pending=false;const update=()=>{pending=false;const root=document.documentElement;const needed=root.scrollHeight>innerHeight+1;if(root.classList.contains('orvane-scroll-y')!==needed)root.classList.toggle('orvane-scroll-y',needed)};const schedule=()=>{if(!pending){pending=true;requestAnimationFrame(update)}};addEventListener('DOMContentLoaded',()=>{new ResizeObserver(schedule).observe(document.body);new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});schedule()});addEventListener('resize',schedule)})();<\/script>`;
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">${scrollbars}${gutter}<script>window.onerror=(message)=>parent.postMessage({orvaneCodeError:String(message)},'*');window.onunhandledrejection=(e)=>parent.postMessage({orvaneCodeError:String(e.reason?.message||e.reason)},'*');<\/script>${APP_RUNTIME}${code}`;
};
</script>
<template>
  <div
    class="block"
    v-motion="{ kind: 'fade', initial: block.id === addedBlockId }"
    :class="[
      {
        'block-edit': editing,
        'block-selected': editing && selected === block.id,
        'block-fill': fillHeight,
      },
      `block-${block.kind}`,
    ]"
    :data-block-id="block.id"
    @click="editing && (emit('select', block.id), $event.stopPropagation())"
  >
    <div
      v-if="editing"
      class="block-hit"
      @click.stop="emit('select', block.id)"
      :aria-label="`Edit ${block.label}`"
    ></div>
    <NotesView
      v-if="block.kind === 'notes'"
      :block="block"
      :editing="editing"
    />
    <NetSuiteView v-else-if="block.kind === 'netsuite'" :block="block" />
    <BrowserView
      v-else-if="block.kind === 'browser'"
      :block="block"
      :editing="editing"
    />
    <ProjectsHub
      v-else-if="block.kind === 'projects'"
      :block="block"
      :editing="editing"
    />
    <GitViewer
      v-else-if="block.kind === 'git'"
      :block="block"
      :editing="editing"
    />
    <h2
      v-else-if="block.kind === 'text'"
      class="app-text"
      v-motion="{
        kind: 'fade',
        state: block.label,
        initial: false,
        enabled: !editing,
      }"
    >
      {{ block.label }}
    </h2>
    <label v-else-if="block.kind === 'input'" class="runtime-field"
      ><span>{{ block.label }}</span
      ><input
        v-model="block.value"
        :placeholder="block.label"
        @keydown.enter="emit('run', block)"
        :aria-label="block.label"
    /></label>
    <button
      v-else-if="block.kind === 'button'"
      class="action-button"
      @click="emit('run', block)"
    >
      {{ block.label }}<Icon name="arrow" :size="14" />
    </button>
    <label v-else-if="block.kind === 'checkbox'" class="check-line"
      ><input
        type="checkbox"
        v-model="block.checked"
        @change="emit('run', block)"
      /><span :class="{ completed: block.checked }">{{
        block.label
      }}</span></label
    >
    <div v-else-if="block.kind === 'list'" class="runtime-list">
      <div class="list-title">
        {{ block.label
        }}<span
          v-motion="{
            kind: 'value',
            state: block.items.length,
            initial: false,
            enabled: !editing,
          }"
          >{{ block.items.length }}</span
        >
      </div>
      <label
        v-for="item in block.items"
        :key="item.id"
        class="list-item"
        v-motion="{
          kind: 'reveal',
          initial: !initialItems.has(item.id),
          enabled: !editing,
        }"
        ><input type="checkbox" v-model="item.done" /><span
          :class="{ completed: item.done }"
          >{{ item.text }}</span
        ><button
          class="icon-button remove-item"
          title="Remove item"
          @click.prevent="
            block.items = block.items.filter((i) => i.id !== item.id)
          "
        >
          <Icon name="close" :size="13" /></button></label
      ><input
        class="list-add"
        placeholder="Add an item, then press Enter"
        @keydown.enter="addItem(block, $event)"
        :aria-label="`Add to ${block.label}`"
      />
    </div>
    <div v-else-if="block.kind === 'counter'" class="runtime-counter">
      <span>{{ block.label }}</span>
      <div>
        <button
          class="icon-button"
          :aria-label="`Decrease ${block.label}`"
          @click="block.count--"
        >
          <Icon name="divider" /></button
        ><output
          v-motion="{
            kind: 'value',
            state: block.count,
            initial: false,
            enabled: !editing,
          }"
          >{{ block.count }}</output
        ><button
          class="icon-button"
          :aria-label="`Increase ${block.label}`"
          @click="block.count++"
        >
          <Icon name="plus" />
        </button>
      </div>
    </div>
    <hr v-else-if="block.kind === 'divider'" />
    <div
      v-else-if="block.kind === 'container'"
      class="runtime-container"
      :class="`layout-${block.layout}`"
      :style="{ gap: block.gap + 'px' }"
    >
      <BlockView
        v-for="child in block.children"
        :key="child.id"
        :block="child"
        :added-block-id="addedBlockId"
        :editing="editing"
        :selected="selected"
        @select="emit('select', $event)"
        @run="emit('run', $event)"
        @error="emit('error', $event)"
      /><span
        v-if="!block.children.length && editing"
        class="layout-placeholder"
        >Select this layout to add components</span
      >
    </div>
    <template v-else-if="block.kind === 'code'"
      ><iframe
        ref="frame"
        :title="block.label"
        sandbox="allow-scripts"
        :srcdoc="sandboxDocument(runningCode)"
        class="custom-frame"
        @load="announceFrame"
        :style="
          !fillHeight && block.height
            ? { height: block.height + 'px' }
            : undefined
        "
      ></iframe>
      <p
        v-if="frameError"
        class="inline-error"
        role="alert"
        v-motion="{ kind: 'fade', state: frameError }"
      >
        {{ frameError }}
      </p>
      <p v-if="editing && frameSlow" class="field-help" role="status">
        This app froze for {{ frameSlow }} ms. Move heavy work into
        orvane.idle, or draw long lists with orvane.list.
      </p></template
    >
  </div>
</template>
