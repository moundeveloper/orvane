<script setup lang="ts">
import { Folder, FolderGit2, X } from "@lucide/vue";
import { computed } from "vue";
import BaseSelect from "./BaseSelect.vue";
import type { Group, Project, SelectOption } from "./types";

const props = defineProps<{
  mode: "move";
  groups: Group[];
  selectedProjects: Project[];
  targetGroupId: string;
  isLoading?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  apply: [];
  "target-change": [value: string];
}>();

const groupOptions = computed<SelectOption[]>(() =>
  props.groups.map((group) => ({
    value: group.id,
    label: group.name,
    description: `${group.projects.length} project${group.projects.length === 1 ? "" : "s"}`,
  })),
);
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="group-action-panel">
      <div class="detail-header">
        <Folder class="folder-icon" aria-hidden="true" />
        <h3>Move To Group</h3>
        <button class="icon-button" aria-label="Close" @click="emit('close')">
          <X aria-hidden="true" />
        </button>
      </div>
      <div class="group-action-body">
        <label>Target group</label>
        <BaseSelect
          class="group-action-select"
          :model-value="targetGroupId"
          :options="groupOptions"
          placeholder="Choose group"
          @update:model-value="emit('target-change', $event)"
        />
        <div class="selected-list">
          <div
            v-for="project in selectedProjects"
            :key="project.path"
            class="selected-list-item"
          >
            <FolderGit2 class="project-icon" aria-hidden="true" />
            <span>{{ project.name }}</span>
          </div>
        </div>
        <button
          class="button primary full"
          :disabled="isLoading || !targetGroupId"
          @click="emit('apply')"
        >
          Move Selected
        </button>
      </div>
    </section>
  </div>
</template>
