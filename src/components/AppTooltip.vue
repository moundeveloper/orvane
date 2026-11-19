<script setup lang="ts">
// Orvane's own tooltip for every `title` in the workspace, in place of the
// system tooltip. While an element is hovered its title is set aside (so the
// system one never appears) and put back on leave, so markup, accessible
// names and tests that read titles stay as they are. "Label (Ctrl+X)" shows
// the shortcut as a key; "Label · detail" shows the detail in small text.
// The Browser app draws its own (data-tip) tooltips that follow its zoom.
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

const tip = ref<{ text: string; meta: string; shortcut: boolean; x: number; y: number }>();
const box = ref<HTMLElement>();
let owner: HTMLElement | SVGElement | undefined;
let stashed: string | undefined;
let keyboard = false;
let point = { x: 0, y: 0 };
let timer: ReturnType<typeof setTimeout> | undefined;

function restore() {
  if (owner && stashed !== undefined && !owner.hasAttribute("title")) owner.setAttribute("title", stashed);
  stashed = undefined;
}
function hide() {
  clearTimeout(timer);
  restore();
  owner = undefined;
  tip.value = undefined;
}
function place() {
  const el = box.value, anchor = owner, shown = tip.value;
  if (!el || !anchor?.isConnected || !shown) return;
  const rect = anchor.getBoundingClientRect();
  const right = innerWidth - el.offsetWidth - 6, bottom = innerHeight - el.offsetHeight - 6;
  let x = keyboard ? rect.left : point.x + 14;
  let y = keyboard ? rect.bottom + 8 : point.y + 22;
  if (x > right && !keyboard) x = point.x - el.offsetWidth - 16;
  if (y > bottom) y = (keyboard ? rect.top : point.y) - el.offsetHeight - 10;
  shown.x = Math.max(6, Math.min(right, x));
  shown.y = Math.max(6, Math.min(bottom, y));
}
function plan(target: HTMLElement | SVGElement | undefined, byKeyboard: boolean) {
  if (target === owner && keyboard === byKeyboard) return;
  hide();
  const text = target?.getAttribute("title")?.trim();
  if (!target || !text || target.matches(":disabled")) return;
  owner = target;
  keyboard = byKeyboard;
  stashed = target.getAttribute("title")!;
  target.removeAttribute("title");
  timer = setTimeout(() => {
    if (!target.isConnected) return;
    const [label, detail] = text.split(/ · (.+)/s);
    const keys = label?.match(/^(.*?)\s+\(((?:Ctrl|Alt|Shift|Cmd|Command|Esc|Enter|F\d+|Tab)[^()]*)\)$/);
    tip.value = {
      text: keys?.[1] || label || text,
      meta: keys?.[2] || detail || "",
      shortcut: !!keys,
      x: 0,
      y: 0,
    };
    void nextTick(place);
  }, byKeyboard ? 240 : 500);
}
const titled = (target: EventTarget | null) =>
  target instanceof Element
    ? (target.closest("[title]") as HTMLElement | SVGElement | null) ?? undefined
    : undefined;

function over(event: PointerEvent) {
  if (event.pointerType === "touch" || event.buttons) return;
  point = { x: event.clientX, y: event.clientY };
  // Still inside the element whose title is set aside: keep the plan.
  if (keyboard === false && owner?.contains(event.target as Node)) return;
  plan(titled(event.target), false);
}
function move(event: PointerEvent) {
  point = { x: event.clientX, y: event.clientY };
  if (tip.value && !keyboard) place();
}
function focus(event: FocusEvent) {
  const target = titled(event.target);
  if (target?.matches(":focus-visible")) plan(target, true);
}
function leaveWindow(event: PointerEvent) {
  if (!event.relatedTarget) hide();
}

const events: [string, (event: never) => void, boolean][] = [
  ["pointerover", over, true],
  ["pointermove", move, true],
  ["pointerout", leaveWindow, true],
  ["focusin", focus, true],
  ["focusout", hide, true],
  ["pointerdown", hide, true],
  ["keydown", hide, true],
  ["wheel", hide, true],
  ["scroll", hide, true],
];
onMounted(() => {
  for (const [name, handler, capture] of events)
    document.addEventListener(name, handler as EventListener, { capture, passive: true });
  window.addEventListener("blur", hide);
});
onBeforeUnmount(() => {
  hide();
  for (const [name, handler, capture] of events)
    document.removeEventListener(name, handler as EventListener, { capture });
  window.removeEventListener("blur", hide);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="tip"
      ref="box"
      class="app-tooltip"
      role="tooltip"
      :style="{ left: tip.x + 'px', top: tip.y + 'px' }"
    >
      <span>{{ tip.text }}</span><kbd v-if="tip.meta && tip.shortcut">{{ tip.meta }}</kbd>
      <small v-else-if="tip.meta">{{ tip.meta }}</small>
    </div>
  </Teleport>
</template>

<style>
/* Matches the Browser app's tooltip (.browser-tip). */
.app-tooltip {
  position: fixed;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: min(360px, calc(100vw - 12px));
  min-height: 27px;
  padding: 6px 9px;
  border: 1px solid var(--line, #dde4e8);
  border-radius: 7px;
  background: var(--surface, #f7f9fa);
  color: #455968;
  box-shadow: 0 8px 24px rgb(50 77 96 / 11%), 0 2px 6px rgb(50 77 96 / 4.5%);
  font: 11px/1.25 "Inter Variable", Inter, system-ui, sans-serif;
  white-space: pre-line;
  overflow-wrap: anywhere;
  pointer-events: none;
  animation: app-tooltip-in 0.17s ease both;
}
.app-tooltip kbd {
  flex: none;
  padding: 2px 6px;
  border: 1px solid var(--line, #dde4e8);
  border-radius: 5px;
  font-family: inherit;
  font-size: 10px;
  color: var(--muted, #687d8a);
  white-space: nowrap;
}
.app-tooltip small {
  font-size: 10px;
  color: var(--muted, #687d8a);
}
@keyframes app-tooltip-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .app-tooltip {
    animation: none;
  }
}
</style>
