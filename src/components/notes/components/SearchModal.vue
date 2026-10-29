<script setup lang="ts">
import { inject, onMounted, ref, watch } from "vue";
import { useNotesWorkspace } from "../stores/workspace";
import type { Page } from "../types";

const emit = defineEmits<{ (e: "close"): void }>();
const ws = useNotesWorkspace();
const navigatePage = inject<(id: string) => void>("navigatePage")!;

const query = ref("");
const results = ref<{ page: Page; excerpt: string }[]>([]);
const selected = ref(0);
const input = ref<HTMLInputElement>();

let debounce: number | undefined;
watch(query, () => {
  clearTimeout(debounce);
  debounce = window.setTimeout(async () => {
    results.value = await ws.searchAll(query.value);
    selected.value = 0;
  }, 120);
});

function open(page: Page) {
  navigatePage(page.id);
  emit("close");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if (e.key === "ArrowDown") {
    e.preventDefault();
    selected.value = Math.min(results.value.length - 1, selected.value + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selected.value = Math.max(0, selected.value - 1);
  } else if (e.key === "Enter") {
    const r = results.value[selected.value];
    if (r) open(r.page);
  }
}

function pathOf(page: Page): string {
  const parts: string[] = [];
  let cur: Page | undefined = ws.pages.find((p) => p.id === page.parentId);
  while (cur) {
    parts.unshift(cur.title || "Untitled");
    cur = ws.pages.find((p) => p.id === cur!.parentId);
  }
  return parts.join(" / ");
}

onMounted(() => input.value?.focus());
</script>

<template>
  <Teleport to="body">
    <div
      class="overlay notes-portal"
      @click.self="emit('close')"
      @keydown="onKeydown"
    >
      <div class="search-box">
        <input
          ref="input"
          v-model="query"
          class="notes-search-input"
          placeholder="Search pages and content…"
        />
        <div class="notes-search-results" v-if="query">
          <button
            v-for="(r, i) in results"
            :key="r.page.id"
            class="result"
            :class="{ selected: i === selected }"
            @click="open(r.page)"
            @mousemove="selected = i"
          >
            <span class="r-icon">{{
              r.page.icon ?? (r.page.type === "database" ? "▦" : "📄")
            }}</span>
            <span class="r-body">
              <span class="r-title">{{ r.page.title || "Untitled" }}</span>
              <span v-if="pathOf(r.page)" class="r-path">{{
                pathOf(r.page)
              }}</span>
              <span v-if="r.excerpt" class="r-excerpt">{{ r.excerpt }}</span>
            </span>
            <span class="r-date">{{
              new Date(r.page.updatedAt).toLocaleDateString()
            }}</span>
          </button>
          <div v-if="!results.length" class="r-empty">
            No results for “{{ query }}”
          </div>
        </div>
        <div v-else class="r-hint">
          Type to search · ↑↓ to navigate · Enter to open · Esc to close
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 950;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
}
.search-box {
  width: 560px;
  max-width: 92vw;
  background: var(--notes-bg-modal);
  border-radius: 10px;
  box-shadow: var(--notes-shadow);
  overflow: hidden;
}
.notes-search-input {
  width: 100%;
  padding: 16px 18px;
  border: none;
  outline: none;
  background: transparent;
  font-size: 17px;
}
.notes-search-results {
  border-top: 1px solid var(--notes-border);
  max-height: 46vh;
  overflow-y: auto;
  padding: 6px;
}
.result {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 6px;
  text-align: left;
}
.result.selected {
  background: var(--notes-bg-hover);
}
.r-icon {
  font-size: 16px;
  margin-top: 1px;
}
.r-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.r-title {
  font-weight: 500;
}
.r-path {
  font-size: 11px;
  color: var(--notes-text-faint);
}
.r-excerpt {
  font-size: 12px;
  color: var(--notes-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.r-date {
  font-size: 11px;
  color: var(--notes-text-faint);
  margin-top: 3px;
}
.r-empty,
.r-hint {
  padding: 18px;
  text-align: center;
  color: var(--notes-text-faint);
  font-size: 13px;
}
.r-hint {
  border-top: 1px solid var(--notes-border);
}
</style>
