// Shared behaviour of Orvane's own pickers: a popover placed by its trigger
// (above when there is no room below), sized for the canvas zoom like
// CustomSelect, and closed by Escape, a press outside, resizing or scrolling.
import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export function usePopover(
  trigger: Ref<HTMLElement | undefined>,
  popover: Ref<HTMLElement | undefined>,
  height: number,
  options: { width?: number; alignEnd?: boolean; preferAbove?: boolean } = {},
) {
  const open = ref(false);
  const style = ref<Record<string, string>>({});
  function place() {
    const el = trigger.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The trigger may sit in a zoomed canvas app: match its on-screen size.
    const scale = el.offsetWidth ? r.width / el.offsetWidth : 1;
    const fontSize = Math.max(10, Math.min(15, 12 * scale));
    const h = height * (fontSize / 12);
    const below = innerHeight - r.bottom;
    const width = (options.width ?? 20) * fontSize;
    const left = options.alignEnd ? r.right - width : r.left;
    const above = (options.preferAbove && r.top >= h + 12) || (below < h + 12 && r.top > below);
    style.value = {
      left: Math.max(8, Math.min(innerWidth - 8 - width, left)) + "px",
      top: (above ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px",
      fontSize: fontSize + "px",
    };
  }
  function show() {
    if (open.value) return close();
    place();
    open.value = true;
    void nextTick(() => popover.value?.focus({ preventScroll: true }));
  }
  function close(refocus = false) {
    open.value = false;
    if (refocus) trigger.value?.focus({ preventScroll: true });
  }
  function outside(e: PointerEvent) {
    if (!open.value) return;
    const target = e.target as Node;
    if (!trigger.value?.contains(target) && !popover.value?.contains(target)) close();
  }
  function dismiss(e: Event) {
    if (open.value && !(e.target instanceof Node && popover.value?.contains(e.target))) close();
  }
  onMounted(() => {
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("wheel", dismiss, { passive: true });
  });
  onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("wheel", dismiss);
  });
  return { open, style, show, close };
}
