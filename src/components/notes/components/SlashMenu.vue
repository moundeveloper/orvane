<script setup lang="ts">
import { useNotesPortal } from "../portal";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties,
} from "vue";
import type { BlockType } from "../types";

const props = defineProps<{
  x: number;
  y: number;
  anchorTop: number;
  blockId: string;
  query?: string;
}>();
const emit = defineEmits<{
  (e: "pick", type: BlockType | "page"): void;
  (e: "close"): void;
}>();

interface Cmd {
  type: BlockType | "page";
  label: string;
  icon: string;
  group: string;
  aliases: string[];
}

const COMMANDS: Cmd[] = [
  {
    type: "paragraph",
    label: "Text",
    icon: "¶",
    group: "Basic",
    aliases: ["text", "p", "paragraph"],
  },
  {
    type: "heading1",
    label: "Heading 1",
    icon: "H1",
    group: "Basic",
    aliases: ["h1", "heading", "title"],
  },
  {
    type: "heading2",
    label: "Heading 2",
    icon: "H2",
    group: "Basic",
    aliases: ["h2", "subheading"],
  },
  {
    type: "heading3",
    label: "Heading 3",
    icon: "H3",
    group: "Basic",
    aliases: ["h3"],
  },
  {
    type: "callout",
    label: "Callout",
    icon: "💡",
    group: "Basic",
    aliases: ["callout", "note"],
  },
  {
    type: "quote",
    label: "Quote",
    icon: "❝",
    group: "Basic",
    aliases: ["quote", "blockquote"],
  },
  {
    type: "divider",
    label: "Divider",
    icon: "—",
    group: "Basic",
    aliases: ["divider", "hr", "separator"],
  },
  {
    type: "bulleted",
    label: "Bulleted list",
    icon: "•",
    group: "Lists",
    aliases: ["bullet", "ul", "list"],
  },
  {
    type: "numbered",
    label: "Numbered list",
    icon: "1.",
    group: "Lists",
    aliases: ["numbered", "ol", "ordered"],
  },
  {
    type: "todo",
    label: "To-do",
    icon: "☑",
    group: "Lists",
    aliases: ["todo", "task", "checkbox"],
  },
  {
    type: "toggle",
    label: "Toggle",
    icon: "▸",
    group: "Lists",
    aliases: ["toggle", "collapse"],
  },
  {
    type: "code",
    label: "Code",
    icon: "‹›",
    group: "Media",
    aliases: ["code", "snippet"],
  },
  {
    type: "image",
    label: "Image",
    icon: "🖼",
    group: "Media",
    aliases: ["image", "img", "photo", "picture"],
  },
  {
    type: "page",
    label: "Page",
    icon: "📄",
    group: "Navigation",
    aliases: ["page", "subpage"],
  },
];

const selected = ref(0);
const menuEl = ref<HTMLElement>();
const portal = useNotesPortal();
const positioned = ref(false);
const menuPosition = ref({ left: 8, top: 8, maxHeight: 320 });
let menuResizeObserver: ResizeObserver | null = null;

const menuStyle = computed<CSSProperties>(() => ({
  left: `${menuPosition.value.left}px`,
  top: `${menuPosition.value.top}px`,
  maxHeight: `${menuPosition.value.maxHeight}px`,
  visibility: positioned.value ? "visible" : "hidden",
}));

watch(
  () => props.query,
  () => {
    selected.value = 0;
  },
);

const filtered = computed(() => {
  const q = (props.query ?? "").toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter(
    (c) =>
      c.label.toLowerCase().includes(q) || c.aliases.some((a) => a.includes(q)),
  );
});

const grouped = computed(() => {
  const map = new Map<string, Cmd[]>();
  for (const c of filtered.value) {
    if (!map.has(c.group)) map.set(c.group, []);
    map.get(c.group)!.push(c);
  }
  return map;
});

function updatePosition() {
  const menu = menuEl.value;
  if (!menu) return;

  const viewportGap = 8;
  const anchorGap = 4;
  // Props and viewport are in the Notes portal's app-local units.
  const viewport = portal.viewport();
  const minLeft = viewport.left + viewportGap;
  const minTop = viewport.top + viewportGap;
  const viewportWidth = viewport.right - viewport.left;
  const viewportHeight = viewport.bottom - viewport.top;
  const maxHeight = Math.max(
    0,
    Math.min(320, viewportHeight - viewportGap * 2),
  );
  const menuHeight = Math.min(menu.scrollHeight, maxHeight);
  const menuWidth = Math.min(
    menu.offsetWidth,
    Math.max(0, viewportWidth - viewportGap * 2),
  );
  const maxLeft = Math.max(minLeft, viewport.right - viewportGap - menuWidth);
  const maxTop = Math.max(minTop, viewport.bottom - viewportGap - menuHeight);

  const belowTop = props.y;
  const aboveTop = props.anchorTop - anchorGap - menuHeight;
  let top = belowTop;
  if (
    belowTop + menuHeight > viewport.bottom - viewportGap &&
    aboveTop >= minTop
  ) {
    top = aboveTop;
  }

  menuPosition.value = {
    left: Math.min(Math.max(props.x, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
    maxHeight,
  };
  positioned.value = true;
}

watch(
  [
    () => props.x,
    () => props.y,
    () => props.anchorTop,
    () => filtered.value.length,
  ],
  () => nextTick(updatePosition),
  { flush: "post" },
);

function flatIndex(cmd: Cmd): number {
  return filtered.value.indexOf(cmd);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("close");
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    selected.value = Math.min(filtered.value.length - 1, selected.value + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    selected.value = Math.max(0, selected.value - 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    const cmd = filtered.value[selected.value];
    if (cmd) emit("pick", cmd.type);
  }
}

function onClickOutside(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".slash-menu")) emit("close");
}

function onViewportScroll(e: Event) {
  const target = e.target;
  if (target instanceof Element && target.closest(".slash-menu")) return;
  emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("mousedown", onClickOutside);
  window.addEventListener("scroll", onViewportScroll, true);
  window.addEventListener("resize", updatePosition);
  menuResizeObserver = new ResizeObserver(updatePosition);
  if (menuEl.value) menuResizeObserver.observe(menuEl.value);
  nextTick(updatePosition);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("mousedown", onClickOutside);
  window.removeEventListener("scroll", onViewportScroll, true);
  window.removeEventListener("resize", updatePosition);
  menuResizeObserver?.disconnect();
});
</script>

<template>
  <Teleport :to="portal.target.value ?? 'body'">
    <div ref="menuEl" class="menu slash-menu notes-portal" :style="menuStyle">
      <template v-for="[group, cmds] in grouped" :key="group">
        <div class="menu-label">{{ group }}</div>
        <button
          v-for="c in cmds"
          :key="c.label"
          class="menu-item"
          :class="{ selected: flatIndex(c) === selected }"
          @mousemove="selected = flatIndex(c)"
          @click="emit('pick', c.type)"
        >
          <span class="mi-icon">{{ c.icon }}</span>
          {{ c.label }}
          <span class="mi-hint">/{{ c.aliases[0] }}</span>
        </button>
      </template>
      <div v-if="!filtered.length" class="slash-empty">No matching blocks</div>
    </div>
  </Teleport>
</template>

<style scoped>
.slash-menu {
  width: 292px;
  max-width: calc(100vw - 16px);
  box-sizing: border-box;
}
.slash-empty {
  padding: 12px;
  text-align: center;
  color: var(--notes-text-faint);
  font-size: 13px;
}
</style>
