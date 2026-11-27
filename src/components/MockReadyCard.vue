<script setup lang="ts">
// A "mock ready" card at the end of an agent's reply (UI Maker "UI mock
// ready" v2, Preview card): the render, the component and its Lab round or
// iteration, the agent's summary, one chip per Lab variant (1-9 when the card
// is focused) and Open in UI Maker (Alt+M from anywhere in this chat for the
// newest card). Narrow hosts (the pinned chat) stack it.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { MOCK_READY_OPEN, type MockReady, type MockReadyOpen } from "../mockReady";

const props = defineProps<{ card: MockReady; latest?: boolean }>();
const root = ref<HTMLElement>();
const state = ref<"idle" | "opening" | "opened" | "error">("idle");
const where = ref("");
const thumbFailed = ref(false);
const thumbSrc = computed(() =>
  props.card.thumb && !thumbFailed.value ? `/__orvane/uimaker/files/c/${props.card.thumb.split("/").map(encodeURIComponent).join("/")}` : "",
);
const tag = computed(() =>
  props.card.mode === "lab"
    ? `Lab ${props.card.round} · ${props.card.variants?.length ?? 0} ${props.card.variants?.length === 1 ? "variant" : "variants"}`
    : `v${props.card.version}`,
);
const hint = computed(() =>
  state.value === "error" ? where.value : state.value === "opened" ? where.value : props.card.mode === "lab" ? "Lab · pick a variant there" : `Review · v${props.card.version}`,
);

async function open(variant?: { id: string; label: string }) {
  if (state.value === "opening") return;
  const detail: MockReadyOpen = {
    component: props.card.component,
    mode: props.card.mode,
    ...(props.card.mode === "lab" ? { lab: { round: props.card.round!, ...(variant ? { variant: variant.id } : {}) } } : { version: props.card.version }),
  };
  state.value = "opening";
  window.dispatchEvent(new CustomEvent<MockReadyOpen>(MOCK_READY_OPEN, { detail }));
  try {
    if (!detail.opened) throw Error("UI Maker is not available here.");
    await detail.opened;
    state.value = "opened";
    where.value =
      props.card.mode === "lab" ? `Lab ${props.card.round}${variant ? ` · ${variant.label}` : ""} focused on the canvas` : `v${props.card.version} focused on the canvas`;
  } catch (error) {
    state.value = "error";
    where.value = error instanceof Error ? error.message : String(error);
  }
}
function keys(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey || (event.target as Element | null)?.closest?.("button") && event.key === "Enter") return;
  const n = Number(event.key);
  const variant = Number.isInteger(n) && n > 0 ? props.card.variants?.[n - 1] : undefined;
  if (variant) {
    event.preventDefault();
    void open(variant);
  } else if (event.key === "Enter" && event.target === root.value) {
    event.preventDefault();
    void open();
  }
}
// Alt+M: the newest card in the chat that has focus or was last pressed.
function altM(event: KeyboardEvent) {
  if (!props.latest || !event.altKey || event.ctrlKey || event.metaKey || event.key.toLowerCase() !== "m") return;
  const app = root.value?.closest(".agent-sessions-app");
  const target = event.target instanceof Element ? event.target : null;
  if (!app || !target || (target !== document.body && !app.contains(target))) return;
  if (target === document.body && !app.closest(".side-chat, .canvas-app.focused-app, .canvas-app.scroll-owner")) return;
  event.preventDefault();
  void open();
}
onMounted(() => window.addEventListener("keydown", altM, true));
onBeforeUnmount(() => window.removeEventListener("keydown", altM, true));
</script>

<template>
  <div class="mr-wrap">
  <div
    ref="root"
    class="mr-card"
    tabindex="0"
    role="group"
    :aria-label="`Mock ready: ${card.name}, ${tag}`"
    @keydown="keys"
  >
    <button type="button" class="mr-thumb" tabindex="-1" :aria-label="`Open ${card.name} in UI Maker`" @click="open()">
      <img v-if="thumbSrc" :src="thumbSrc" alt="" @error="thumbFailed = true" />
      <Icon v-else name="edit" :size="18" />
    </button>
    <div class="mr-info">
      <div class="mr-title">
        <Icon name="edit" :size="13" /><b :title="card.name">{{ card.name }}</b><span class="mr-tag">{{ tag }}</span>
      </div>
      <p v-if="card.summary" class="mr-sum">{{ card.summary }}</p>
      <div v-if="card.variants?.length" class="mr-vars" role="list" aria-label="Variants">
        <button
          v-for="(variant, index) in card.variants"
          :key="variant.id"
          type="button"
          class="mr-var"
          role="listitem"
          :title="`Open ${variant.label}`"
          @click="open(variant)"
        >
          <kbd>{{ index + 1 }}</kbd>{{ variant.id }}
        </button>
      </div>
      <div class="mr-act">
        <button type="button" class="mr-open" :class="{ done: state === 'opened' }" :disabled="state === 'opening'" @click="open()">
          <span v-if="state === 'opening'" class="mr-spin" aria-hidden="true" />
          <Icon v-else :name="state === 'opened' ? 'check' : 'external'" :size="13" />
          <span>{{ state === "opening" ? "Opening…" : state === "opened" ? "Opened in UI Maker" : "Open in UI Maker" }}</span>
          <kbd v-if="latest">Alt M</kbd>
        </button>
        <span class="mr-hint" :class="{ err: state === 'error' }" :title="hint">{{ hint }}</span>
      </div>
    </div>
  </div>
  </div>
</template>

<style scoped>
.mr-wrap {
  container-type: inline-size;
  max-width: 640px;
  margin-top: 10px;
}
.mr-card {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 14px;
  padding: 12px;
  border: 1px solid #dbe5eb;
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5510;
  outline: none;
  transition: border-color 0.15s ease-out, box-shadow 0.15s ease-out;
}
.mr-card:focus-visible {
  border-color: #9fb6c3;
  box-shadow: 0 0 0 3px #6f89981a;
}
.mr-thumb {
  display: grid;
  place-items: center;
  height: 94px;
  padding: 0;
  overflow: hidden;
  border: 1px solid #dfe7ec;
  border-radius: 7px;
  background: #e9edf0;
  color: #8296a2;
  cursor: pointer;
}
.mr-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
}
.mr-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}
.mr-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: #6f8998;
}
.mr-title b {
  overflow: hidden;
  color: #273f50;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mr-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 6px;
  background: #e8eff3;
  color: #5d7381;
  font-size: 11px;
}
.mr-sum {
  margin: 0;
  color: #455968;
  font-size: 12.5px;
}
.mr-vars {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mr-var {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: #e6eef3;
  color: #385d76;
  font: 11.5px "Cascadia Code", Consolas, monospace;
  cursor: pointer;
  transition: background-color 0.13s ease-out;
}
.mr-var:hover,
.mr-var:focus-visible {
  background: #dae6ed;
  outline: none;
}
.mr-act {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.mr-open {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 11px;
  border: 0;
  border-radius: 8px;
  background: #365f78;
  color: #fff;
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
  transition: background-color 0.13s ease-out;
}
.mr-open:hover:not(:disabled) {
  background: #2f566e;
  color: #fff;
}
.mr-open:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px #365f7840;
}
.mr-open.done {
  background: #e4edf2;
  color: #273f50;
}
/* Opened: a light button, so its hover stays light and the text dark. */
.mr-open.done:hover:not(:disabled) {
  background: #dae6ed;
  color: #273f50;
}
.mr-open.done :deep(svg) {
  color: #4f7d5f;
}
kbd {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  color: #5d7381;
  font: 10.5px/1 "Cascadia Code", Consolas, monospace;
}
.mr-var kbd {
  min-width: 15px;
  height: 15px;
  font-size: 9.5px;
}
.mr-open kbd {
  border-color: #ffffff40;
  background: #ffffff22;
  color: #e8f0f5;
}
.mr-open.done kbd {
  border-color: #d6e0e6;
  background: #fbfcfd;
  color: #5d7381;
}
.mr-hint {
  overflow: hidden;
  color: #8296a2;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mr-hint.err {
  color: #a0624f;
}
.mr-spin {
  width: 12px;
  height: 12px;
  border: 1.6px solid #ffffff66;
  border-top-color: #fff;
  border-radius: 50%;
  animation: mr-spin 0.8s linear infinite;
}
@keyframes mr-spin {
  to {
    transform: rotate(360deg);
  }
}
/* The pinned chat (and other narrow hosts) stack the picture above. */
@container (max-width: 440px) {
  .mr-card {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
  .mr-thumb {
    height: 120px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mr-card,
  .mr-var,
  .mr-open {
    transition: none;
  }
  .mr-spin {
    animation: none;
  }
}
</style>
