<script setup lang="ts">
// One Claude Code or Codex session's chat outside Agent sessions (AI
// launcher, pinned side panel). It is Agent sessions itself in pane mode, so
// the chat looks and behaves exactly as there. Opening a session here leaves
// focus where it is; focus() goes to its composer.
import { defineAsyncComponent, reactive, ref, watch } from "vue";
import { makeBlock } from "../model";

const AgentSessions = defineAsyncComponent(() => import("./AgentSessions.vue"));
const props = defineProps<{ sessionKey: string; place: string }>();
const emit = defineEmits<{ leave: [] }>();
const block = { ...makeBlock("claude"), id: `session-chat:${props.place}` };
const pane = reactive({ id: props.place, key: props.sessionKey, nonce: 1, quiet: true });
const root = ref<HTMLElement>();
watch(
  () => props.sessionKey,
  (key) => {
    pane.key = key;
    pane.nonce++;
  },
);
function composer() {
  return root.value?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
}
/** Esc in the composer (Agent sessions blurs it) hands focus back to the host. */
function key(event: KeyboardEvent) {
  if (event.key === "Escape" && event.target === composer()) setTimeout(() => emit("leave"));
}
defineExpose({ focus: () => composer()?.focus({ preventScroll: true }) });
</script>

<template>
  <div ref="root" class="session-chat" :data-place="place" @keydown.capture="key">
    <AgentSessions :block="block" :pane="pane" focused />
  </div>
</template>

<style scoped>
.session-chat {
  display: flex;
  min-height: 0;
  flex: 1;
}
.session-chat > :deep(*) {
  flex: 1;
  min-width: 0;
}
/* The host lists the sessions, so the chat's own "Sessions" back button goes. */
.session-chat :deep(.agent-sessions-app .cs-session-header .cs-back) {
  display: none;
}
</style>
