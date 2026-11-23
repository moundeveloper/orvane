<script setup lang="ts">
// One Claude Code or Codex session's chat outside Agent sessions (AI
// launcher, pinned side panel). It is Agent sessions itself in pane mode, so
// the chat looks and behaves exactly as there.
import { defineAsyncComponent, reactive, watch } from "vue";
import { makeBlock } from "../model";

const AgentSessions = defineAsyncComponent(() => import("./AgentSessions.vue"));
const props = defineProps<{ sessionKey: string; place: string }>();
const block = { ...makeBlock("claude"), id: `session-chat:${props.place}` };
const pane = reactive({ id: props.place, key: props.sessionKey, nonce: 1 });
watch(
  () => props.sessionKey,
  (key) => {
    pane.key = key;
    pane.nonce++;
  },
);
</script>

<template>
  <div class="session-chat">
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
</style>
