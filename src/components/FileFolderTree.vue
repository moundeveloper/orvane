<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
type Row = Record<string, any>;
type Crumb = { id: number; name: string };
const props = defineProps<{
  folders: Row[];
  children: Record<number, Row[]>;
  expanded: number[];
  path: Crumb[];
  selected?: number;
  filter: string;
  loading: number[];
}>();
const emit = defineEmits<{ toggle: [Row]; navigate: [Crumb[]] }>();
const visible = computed(() =>
  props.folders.filter(
    (f) =>
      !props.filter ||
      `${f.name} ${f.id}`.toLowerCase().includes(props.filter.toLowerCase()) ||
      props.expanded.includes(Number(f.id)),
  ),
);
</script>
<template>
  <div class="folder-tree">
    <div v-for="folder in visible" :key="String(folder.id)">
      <div
        class="folder-tree-row"
        :class="{ selected: Number(folder.id) === selected }"
      >
        <button
          class="folder-tree-toggle"
          :aria-label="`${expanded.includes(Number(folder.id)) ? 'Collapse' : 'Expand'} ${folder.name}`"
          @click="emit('toggle', folder)"
        >
          <Icon
            :name="expanded.includes(Number(folder.id)) ? 'down' : 'right'"
            :size="12"
          /></button
        ><button
          class="folder-tree-name"
          @click="
            emit('navigate', [
              ...path,
              { id: Number(folder.id), name: String(folder.name) },
            ])
          "
        >
          <Icon
            :name="
              expanded.includes(Number(folder.id)) ? 'folder-open' : 'folder'
            "
            :size="13"
          /><span>{{ folder.name }}</span
          ><small v-if="Number(folder.numfolderfiles) > 0">{{
            folder.numfolderfiles
          }}</small>
        </button>
      </div>
      <div
        v-if="expanded.includes(Number(folder.id))"
        class="folder-tree-children"
      >
        <p v-if="loading.includes(Number(folder.id))" class="folder-tree-hint">
          Loading…
        </p>
        <FileFolderTree
          v-else
          :folders="children[Number(folder.id)] || []"
          :children="children"
          :expanded="expanded"
          :path="[
            ...path,
            { id: Number(folder.id), name: String(folder.name) },
          ]"
          :selected="selected"
          :filter="filter"
          :loading="loading"
          @toggle="emit('toggle', $event)"
          @navigate="emit('navigate', $event)"
        />
        <p
          v-if="
            !loading.includes(Number(folder.id)) &&
            !children[Number(folder.id)]?.length
          "
          class="folder-tree-hint"
        >
          No subfolders
        </p>
      </div>
    </div>
  </div>
</template>
<style scoped>
.folder-tree-row {
  display: flex;
  align-items: center;
  border-radius: 4px;
  color: #526b7a;
}
.folder-tree-row:hover {
  background: #eaf1f4;
}
.folder-tree-row.selected {
  background: #dfeaf0;
  color: #344f5e;
}
.folder-tree-toggle {
  flex: none;
  display: grid;
  place-items: center;
  width: 23px;
  height: 27px;
  padding: 0;
  color: inherit;
}
.folder-tree-name {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1;
  text-align: left;
  padding: 6px 4px;
  color: inherit;
}
.folder-tree-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-tree-name small {
  margin-left: auto;
  padding: 0 5px;
  border-radius: 8px;
  background: #e3ecf0;
  color: #718591;
  font-size: 10px;
}
.folder-tree-children {
  padding-left: 16px;
}
.folder-tree-hint {
  color: #718591;
  font-size: 11px;
  padding: 5px 8px;
}
</style>
