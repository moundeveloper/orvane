<script setup lang="ts">
import { computed, ref } from "vue";
import { useNotesWorkspace } from "../stores/workspace";

const emit = defineEmits<{ (e: "close"): void }>();
const ws = useNotesWorkspace();
const query = ref("");

const items = computed(() =>
  ws.trashedPages
    .filter((p) =>
      (p.title || "Untitled").toLowerCase().includes(query.value.toLowerCase()),
    )
    .sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? "")),
);

function fmt(d: string | null) {
  return d ? new Date(d).toLocaleString() : "";
}

async function empty() {
  await ws.emptyTrash();
}

async function delOne(id: string) {
  await ws.deletePagePermanently(id);
}
</script>

<template>
  <Teleport to="body">
    <div class="overlay notes-portal" @click.self="emit('close')">
      <div class="panel">
        <div class="panel-head">
          <strong>Trash</strong>
          <button
            v-if="items.length"
            class="empty-trash-btn"
            aria-label="Permanently delete every item"
            @click="empty"
          >
            <i class="pi pi-trash" />
            <span>Empty trash</span>
          </button>
          <button
            class="icon-btn"
            aria-label="Close trash"
            @click="emit('close')"
          >
            ✕
          </button>
        </div>
        <input
          v-model="query"
          class="panel-search"
          placeholder="Search trash…"
        />
        <div class="panel-list">
          <div v-for="p in items" :key="p.id" class="trash-row">
            <span class="t-icon">{{ p.icon ?? "📄" }}</span>
            <span class="t-info">
              <span class="t-title">{{ p.title || "Untitled" }}</span>
              <span class="t-date">Deleted {{ fmt(p.trashedAt) }}</span>
            </span>
            <button
              class="icon-btn"
              aria-label="Restore"
              @click="ws.restorePage(p.id)"
            >
              ↩
            </button>
            <button
              class="icon-btn"
              aria-label="Delete forever"
              style="color: var(--notes-danger)"
              @click="delOne(p.id)"
            >
              ✕
            </button>
          </div>
          <div v-if="!items.length" class="t-empty">Trash is empty</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
}
.panel {
  width: 480px;
  max-width: 92vw;
  background: var(--notes-bg-modal);
  border-radius: 8px;
  box-shadow: var(--notes-shadow);
  overflow: hidden;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
}
.panel-head strong {
  flex: 1;
}
.empty-trash-btn {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 6px;
  border: 1px solid
    color-mix(in srgb, var(--notes-danger) 35%, var(--notes-border));
  border-radius: 4px;
  background: transparent;
  color: var(--notes-danger);
  padding: 3px 8px;
  font-size: 12px;
  white-space: nowrap;
}
.empty-trash-btn:hover {
  background: color-mix(in srgb, var(--notes-danger) 8%, transparent);
}
.empty-trash-btn i {
  font-size: 11px;
}
.panel-search {
  width: calc(100% - 32px);
  margin: 0 16px 8px;
  padding: 6px 10px;
  border: 1px solid var(--notes-border);
  border-radius: 4px;
  background: var(--notes-bg);
  outline: none;
}
.panel-list {
  max-height: 50vh;
  overflow-y: auto;
  padding: 0 8px 8px;
}
.trash-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 4px;
}
.trash-row:hover {
  background: var(--notes-bg-hover);
}
.t-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.t-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-date {
  font-size: 11px;
  color: var(--notes-text-faint);
}
.t-empty {
  padding: 24px;
  text-align: center;
  color: var(--notes-text-faint);
}
</style>
