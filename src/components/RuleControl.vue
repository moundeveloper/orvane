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
  expandable?: boolean;
}>();
const emit = defineEmits<{
  remove: [];
  move: [direction: number];
  expand: [];
}>();
const targets = computed(() =>
  flatten(
    (props.rule.appId
      ? props.workspace.apps.find((a) => a.id === props.rule.appId)
      : props.app
    )?.blocks || [],
  ),
);
const sourceFields = computed(() =>
  flatten(props.app.blocks).filter((b) =>
    ["input", "text", "counter", "checkbox"].includes(b.kind),
  ),
);
const missingInputs = computed(() =>
  props.rule.action === "workspace-action"
    ? (
        props.workspace.actions?.find((a) => a.id === props.rule.nodeId)
          ?.inputs || []
      ).filter((name) => !(name in (props.rule.bindings || {})))
    : [],
);
</script>
<template>
  <div class="rule graph-rule">
    <button v-if="expandable" class="subtle-button" @click="emit('expand')">
      {{ rule.flow ? "Edit advanced flow" : "Expand this rule" }}
    </button>
    <p v-if="rule.flow" class="field-help">
      Advanced flow: {{ rule.flow.rules.length }} actions. Expand to edit
      connections; collapsing keeps its behavior.
    </p>
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
    <template v-if="!rule.flow">
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
          <option value="workspace-action">Run workspace action</option>
          <option value="navigate">Go to app</option>
          <option value="open-view">Open app settings / graph</option>
          <option value="read-field">Read exposed field</option>
          <option value="message">Show message</option>
        </CustomSelect></label
      >
      <template v-if="rule.action === 'workspace-action'">
        <CustomSelect v-model="rule.nodeId" aria-label="Workspace action"
          ><option value="">Choose an action</option>
          <option
            v-for="action in workspace.actions || []"
            :key="action.id"
            :value="action.id"
          >
            {{ action.name }}
          </option></CustomSelect
        >
        <label
          v-for="input in workspace.actions?.find((a) => a.id === rule.nodeId)
            ?.inputs || []"
          :key="input"
          class="property"
          ><span>{{ input }}</span>
          <CustomSelect
            :model-value="
              sourceFields.find((b) => rule.bindings?.[input] === `{${b.id}}`)
                ?.id || ''
            "
            :aria-label="`Source for ${input}`"
            :options="[
              { value: '', label: 'Configured value' },
              ...sourceFields.map((b) => ({ value: b.id, label: b.label })),
            ]"
            @update:model-value="
              (rule.bindings ||= {})[input] = $event ? `{${$event}}` : ''
            "
          />
          <input
            v-if="
              !sourceFields.some((b) => rule.bindings?.[input] === `{${b.id}}`)
            "
            :value="rule.bindings?.[input] || ''"
            :aria-label="`Input ${input}`"
            placeholder="Value or {input name}"
            @input="
              (rule.bindings ||= {})[input] = (
                $event.target as HTMLInputElement
              ).value
            "
          />
        </label>
        <p v-if="missingInputs.length" class="field-help" role="status">
          Configure inputs: {{ missingInputs.join(", ") }}.
        </p>
      </template>
      <template
        v-else-if="
          ['navigate', 'open-view', 'read-field'].includes(rule.action)
        "
      >
        <CustomSelect
          v-model="rule.appId"
          aria-label="Target app"
          @change="rule.target = ''"
          ><option value="">Choose an app</option>
          <option
            v-for="a in workspace.apps.filter(
              (a) =>
                !a.archived &&
                !a.deleted &&
                (rule.action !== 'read-field' || a.exposed),
            )"
            :key="a.id"
            :value="a.id"
          >
            {{ a.name }}
          </option></CustomSelect
        >
        <CustomSelect
          v-if="rule.action === 'open-view'"
          v-model="rule.view"
          aria-label="App view"
          ><option value="settings">Settings</option>
          <option value="graph">Component graph</option></CustomSelect
        >
        <CustomSelect
          v-if="
            rule.action === 'read-field' ||
            (rule.action === 'open-view' && rule.view === 'graph')
          "
          v-model="rule.target"
          aria-label="Target component"
          ><option value="">Choose a component</option>
          <option v-for="b in targets" :key="b.id" :value="b.id">
            {{ b.label }}
          </option></CustomSelect
        >
      </template>
      <input
        v-else-if="rule.action === 'message'"
        v-model="rule.value"
        aria-label="Message"
        class="rule-value"
        placeholder="Text, {input name}, or blank for previous result"
      />
      <template v-else-if="rule.action !== 'custom'"
        ><CustomSelect
          v-model="rule.appId"
          aria-label="Target app"
          @change="rule.target = ''"
        >
          <option v-if="app.id !== '__workspace__'" value="">This app</option>
          <option v-else value="">Choose an exposed app</option>
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
    </template>
  </div>
</template>
