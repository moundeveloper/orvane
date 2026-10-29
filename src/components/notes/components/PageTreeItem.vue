<script setup lang="ts">
import { useNotesPortal } from "../portal";
import { computed, inject, ref, type ComputedRef } from "vue";
import { useNotesWorkspace } from "../stores/workspace";
import type { Page } from "../types";

const props = defineProps<{ page: Page; depth: number; flat?: boolean }>();
const ws = useNotesWorkspace();
const activePageId = inject<ComputedRef<string | null>>("notesActivePageId");
const openPageTab =
  inject<(id: string, activate?: boolean) => void>("openPageTab");
const navigatePage = inject<(id: string) => void>("navigatePage");

const expanded = ref(false);
const menuPos = ref<{ x: number; y: number } | null>(null);
const portal = useNotesPortal();
const dragOver = ref<"inside" | "above" | null>(null);

const children = computed(() =>
  props.flat ? [] : ws.childrenOf(props.page.id),
);
const isActive = computed(() => activePageId?.value === props.page.id);

function open(e?: MouseEvent) {
  navigatePage?.(props.page.id);
}

function openMiddle(e: MouseEvent) {
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  openPageTab?.(props.page.id, false);
}

function preventMiddle(e: MouseEvent) {
  if (e.button !== 1) return;
  e.preventDefault();
  e.stopPropagation();
}

async function addChild() {
  const p = await ws.createPage(props.page.id, "");
  expanded.value = true;
  openPageTab?.(p.id, true);
}

function openMenu(e: MouseEvent) {
  e.preventDefault();
  menuPos.value = portal.local(e.clientX, e.clientY);
  const close = () => {
    menuPos.value = null;
    window.removeEventListener("click", close);
  };
  setTimeout(() => window.addEventListener("click", close));
}

async function duplicate() {
  const copy = await ws.createPage(
    props.page.parentId,
    props.page.title + " (copy)",
    props.page.type,
  );
  copy.icon = props.page.icon;
  if (props.page.dbSchema)
    copy.dbSchema = JSON.parse(JSON.stringify(props.page.dbSchema));
  await ws.savePage(copy);
  const { db, uid, now } = await import("../db");
  const blocks = await db.blocks
    .where("pageId")
    .equals(props.page.id)
    .toArray();
  for (const b of blocks)
    await db.blocks.add({
      ...b,
      id: uid(),
      pageId: copy.id,
      createdAt: now(),
      updatedAt: now(),
    });
  openPageTab?.(copy.id, true);
}

async function exportMd() {
  const md = await ws.exportPageMarkdown(props.page.id);
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (props.page.title || "untitled") + ".md";
  a.click();
  URL.revokeObjectURL(a.href);
}

// drag & drop
function onDragStart(e: DragEvent) {
  e.dataTransfer?.setData("slate/page-id", props.page.id);
  e.dataTransfer!.effectAllowed = "move";
}
function onDragOver(e: DragEvent) {
  if (props.flat) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dragOver.value = e.clientY < rect.top + rect.height / 3 ? "above" : "inside";
}
function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  const mode = dragOver.value;
  dragOver.value = null;
  const id = e.dataTransfer?.getData("slate/page-id");
  if (!id || id === props.page.id || props.flat) return;
  if (mode === "above") {
    const siblings = ws.childrenOf(props.page.parentId);
    const idx = siblings.findIndex((s) => s.id === props.page.id);
    ws.movePage(id, props.page.parentId, Math.max(0, idx));
  } else {
    ws.movePage(id, props.page.id, ws.childrenOf(props.page.id).length);
    expanded.value = true;
  }
}
</script>

<template>
  <div>
    <div
      class="pt-row"
      :class="{
        active: isActive,
        'drop-inside': dragOver === 'inside',
        'drop-above': dragOver === 'above',
      }"
      :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
      draggable="true"
      @click="open"
      @mousedown="preventMiddle"
      @pointerdown="preventMiddle"
      @mouseup="openMiddle"
      @auxclick.stop.prevent="openMiddle"
      @contextmenu="openMenu"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="dragOver = null"
      @drop="onDrop"
    >
      <button
        v-if="!flat && children.length"
        class="pt-leading pt-toggle"
        :class="{ expanded }"
        :aria-expanded="expanded"
        :aria-label="expanded ? 'Collapse subpages' : 'Expand subpages'"
        @click.stop="expanded = !expanded"
      >
        <span class="pt-page-icon">{{
          page.icon ?? (page.type === "database" ? "▦" : "📄")
        }}</span>
        <span class="pt-arrow">▸</span>
      </button>
      <span v-else class="pt-leading pt-page-icon">
        {{ page.icon ?? (page.type === "database" ? "▦" : "📄") }}
      </span>
      <span class="pt-title" :aria-label="page.title || 'Untitled'">{{
        page.title || "Untitled"
      }}</span>
      <span class="pt-actions" v-if="!flat">
        <button
          class="icon-btn"
          aria-label="Add subpage"
          @click.stop="addChild"
        >
          ＋
        </button>
        <button
          class="icon-btn"
          aria-label="Menu"
          @click.stop="openMenu($event)"
        >
          ⋯
        </button>
      </span>
    </div>

    <template v-if="expanded && !flat">
      <PageTreeItem
        v-for="c in children"
        :key="c.id"
        :page="c"
        :depth="depth + 1"
      />
    </template>

    <Teleport :to="portal.target.value ?? 'body'">
      <div
        v-if="menuPos"
        class="menu notes-portal"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
      >
        <button class="menu-item" @click="ws.toggleFavorite(page.id)">
          <span class="mi-icon">{{ page.isFavorite ? "★" : "☆" }}</span>
          {{ page.isFavorite ? "Remove favorite" : "Add to favorites" }}
        </button>
        <button class="menu-item" @click="duplicate">
          <span class="mi-icon">⧉</span> Duplicate
        </button>
        <button class="menu-item" @click="exportMd">
          <span class="mi-icon">📤</span> Export Markdown
        </button>
        <button class="menu-item" @click="addChild">
          <span class="mi-icon">＋</span> Add subpage
        </button>
        <div class="menu-sep" />
        <button
          class="menu-item"
          style="color: var(--notes-danger)"
          @click="ws.trashPage(page.id)"
        >
          <span class="mi-icon">🗑</span> Move to trash
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pt-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 2px 8px;
  margin: 0 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  color: var(--notes-text-secondary);
  position: relative;
}
.pt-row:hover {
  background: var(--notes-bg-hover);
}
.pt-row.active {
  background: var(--notes-bg-active);
  color: var(--notes-text);
  font-weight: 500;
}
.pt-row.drop-inside {
  box-shadow: inset 0 0 0 2px var(--notes-accent);
}
.pt-row.drop-above {
  box-shadow: inset 0 2px 0 0 var(--notes-accent);
}
.pt-leading {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 20px;
  flex-shrink: 0;
}
.pt-page-icon {
  font-size: 13px;
  line-height: 1;
  text-align: center;
}
.pt-toggle {
  border-radius: 4px;
  color: var(--notes-text-faint);
}
.pt-toggle:hover {
  background: color-mix(in srgb, var(--notes-text) 8%, transparent);
}
.pt-toggle .pt-arrow {
  display: none;
  font-size: 10px;
  line-height: 1;
  transition: transform 0.15s;
}
.pt-row:hover .pt-toggle .pt-page-icon,
.pt-toggle:focus-visible .pt-page-icon {
  display: none;
}
.pt-row:hover .pt-toggle .pt-arrow,
.pt-toggle:focus-visible .pt-arrow {
  display: inline;
}
.pt-toggle.expanded .pt-arrow {
  transform: rotate(90deg);
}
.pt-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-actions {
  display: inline-flex;
  gap: 0;
  width: 48px;
  flex-shrink: 0;
  visibility: hidden;
}
.pt-row:hover .pt-actions {
  visibility: visible;
}
</style>
