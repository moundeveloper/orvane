<script setup lang="ts">
import { computed, ref, watch } from "vue";

type Row = Record<string, any>;
const props = defineProps<{
  rows: Row[];
  openRecord: (kind: string, id: unknown) => unknown;
}>();
const pageSize = 100;
const page = ref(0);
const pages = computed(() => Math.ceil(props.rows.length / pageSize));
const start = computed(() => page.value * pageSize);
const shown = computed(() =>
  props.rows.slice(start.value, start.value + pageSize),
);
watch(
  () => props.rows,
  () => {
    page.value = 0;
  },
);
</script>

<template>
  <div class="script-deployments">
    <nav
      v-if="pages > 1"
      class="ns-deployment-pages"
      aria-label="Deployment pages"
    >
      <span role="status"
        >Showing {{ start + 1 }}–{{
          Math.min(start + pageSize, rows.length)
        }}
        of {{ rows.length }} deployments</span
      >
      <button class="subtle-button" :disabled="page === 0" @click="page--">
        Previous deployments
      </button>
      <button
        class="subtle-button"
        :disabled="page + 1 >= pages"
        @click="page++"
      >
        Next deployments
      </button>
    </nav>
    <div v-for="d in shown" :key="String(d.primarykey)" class="ns-deployment">
      <button
        class="ns-record-link"
        @click="openRecord('deployment', d.primarykey)"
      >
        {{ d.scriptid }}
      </button>
      <span
        >{{ d.status }} · {{ d.recordtype || "All records" }} ·
        {{
          d.isdeployed === "T" || d.isdeployed === true
            ? "Deployed"
            : "Not deployed"
        }}
        · {{ d.loglevel || "—" }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.ns-deployment-pages {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 10px;
  color: #455968;
}
.ns-deployment-pages span {
  flex-basis: 100%;
}
.ns-deployment {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #dce6ea;
}
.ns-deployment span {
  color: #657b89;
}
.ns-record-link {
  border: 0;
  padding: 0;
  background: none;
  color: #547589;
  cursor: pointer;
}
.ns-record-link:hover {
  text-decoration: underline;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
