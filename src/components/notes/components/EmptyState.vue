<script setup lang="ts">
import { inject } from "vue";
import { useNotesWorkspace } from "../stores/workspace";

const ws = useNotesWorkspace();
const openPageTab =
  inject<(id: string, activate?: boolean) => void>("openPageTab")!;

async function newPage(type: "page" | "database" = "page") {
  const p = await ws.createPage(null, "", type);
  openPageTab(p.id, true);
}
</script>

<template>
  <div class="empty">
    <h1>Notes</h1>
    <p>Your local-first workspace. Everything stays on this machine.</p>
    <div class="empty-actions">
      <button class="empty-btn primary" @click="newPage()">＋ New page</button>
      <button class="empty-btn" @click="newPage('database')">
        ▦ New database
      </button>
    </div>
    <div class="empty-tips">
      <span><kbd>Ctrl+K</kbd> search</span>
      <span><kbd>/</kbd> block menu</span>
      <span><kbd>Ctrl+\</kbd> sidebar</span>
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--notes-text-secondary);
}
.empty-logo {
  font-size: 48px;
  color: var(--notes-accent);
}
h1 {
  color: var(--notes-text);
  font-size: 28px;
}
.empty-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
.empty-btn {
  padding: 8px 18px;
  border-radius: 6px;
  border: 1px solid var(--notes-border);
  font-size: 14px;
}
.empty-btn:hover {
  background: var(--notes-bg-hover);
}
.empty-btn.primary {
  background: var(--notes-accent);
  color: white;
  border-color: var(--notes-accent);
}
.empty-btn.primary:hover {
  opacity: 0.9;
}
.empty-tips {
  display: flex;
  gap: 18px;
  margin-top: 20px;
  font-size: 12px;
  color: var(--notes-text-faint);
}
kbd {
  background: var(--notes-bg-code);
  border: 1px solid var(--notes-border);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
}
</style>
