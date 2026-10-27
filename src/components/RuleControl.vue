<script setup lang="ts">
import { computed } from "vue";
import { flatten, type CanvasApp, type Rule, type Workspace } from "../model";
import Icon from "./Icon.vue";
import CustomSelect from "./CustomSelect.vue";
const props = defineProps<{
  rule: Rule;
  app: CanvasApp;
  workspace: Workspace;
  index: number;
  total: number;
}>();
const emit = defineEmits<{ remove: []; move: [direction: number] }>();
const targets = computed(() =>
  flatten(
    (props.rule.appId
      ? props.workspace.apps.find((a) => a.id === props.rule.appId)
      : props.app
    )?.blocks || [],
  ),
);
</script>
<template>
  <div class="rule graph-rule">
    <div class="rule-order">
      <span>Step {{ index + 1 }}</span>
      <div class="inline-actions">
        <button
          class="icon-button"
          :disabled="index === 0"
          aria-label="Move action earlier"
          @click="emit('move', -1)"
        >
          ↑</button
        ><button
          class="icon-button"
          :disabled="index === total - 1"
          aria-label="Move action later"
          @click="emit('move', 1)"
        >
          ↓</button
        ><button
          class="icon-button"
          aria-label="Remove action"
          @click="emit('remove')"
        >
          <Icon name="close" :size="12" />
        </button>
      </div>
    </div>
    <label class="property"
      ><span class="sr-only">Action</span
      ><CustomSelect v-model="rule.action" aria-label="Action">
        <option value="add-item">Add item to list</option>
        <option value="clear">Clear field</option>
        <option value="increment">Increase counter</option>
        <option value="toggle">Toggle checkbox</option>
        <option value="set-text">Set text / value</option>
        <option value="emit">Send event</option>
        <option value="custom">Reusable action</option>
      </CustomSelect></label
    >
    <template v-if="rule.action !== 'custom'"
      ><CustomSelect
        v-model="rule.appId"
        aria-label="Target app"
        @change="rule.target = ''"
      >
        <option value="">This app</option>
        <option
          v-for="a in workspace.apps.filter(
            (a) => a.id !== app.id && !a.archived && a.exposed,
          )"
          :key="a.id"
          :value="a.id"
        >
          {{ a.name }}
        </option></CustomSelect
      ><CustomSelect v-model="rule.target" aria-label="Target component">
        <option value="" disabled>Choose a component</option>
        <option v-for="b in targets" :key="b.id" :value="b.id">
          {{ b.label }}
        </option></CustomSelect
      ><input
        v-if="!['clear', 'toggle'].includes(rule.action)"
        v-model="rule.value"
        aria-label="Action value"
        placeholder="Text, or {field label}"
        class="rule-value"
    /></template>
    <CustomSelect v-else v-model="rule.nodeId" aria-label="Reusable action">
      <option value="">Choose an action</option>
      <option v-for="n in workspace.customNodes" :key="n.id" :value="n.id">
        {{ n.name }}
      </option>
    </CustomSelect>
  </div>
</template>
