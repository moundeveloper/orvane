import {
  inject,
  onBeforeUnmount,
  provide,
  ref,
  watch,
  type InjectionKey,
  type Ref,
} from "vue";

/**
 * Anchored Notes menus live in a body-level layer that mirrors the Notes app's
 * on-screen box and canvas zoom, so they pan and scale with the app instead of
 * staying at fixed screen pixels. Menu coordinates are app-local (unscaled).
 */
export interface NotesPortal {
  target: Ref<HTMLElement | undefined>;
  /** Screen point → layer-local point. */
  local(x: number, y: number): { x: number; y: number };
  /** Visible browser viewport in layer-local units. */
  viewport(): { left: number; top: number; right: number; bottom: number };
}

const key: InjectionKey<NotesPortal> = Symbol("notes-portal");

function frame(root: HTMLElement | null | undefined) {
  if (!root || !root.offsetWidth) return { left: 0, top: 0, scale: 1 };
  const rect = root.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    scale: rect.width / root.offsetWidth || 1,
  };
}

export function provideNotesPortal(root: Ref<HTMLElement | null | undefined>) {
  const target = ref<HTMLElement>();
  let raf = 0;
  let observer: MutationObserver | undefined;
  const sync = () => {
    const layer = target.value,
      el = root.value;
    if (!layer || !el) return;
    const { left, top, scale } = frame(el);
    layer.style.width = `${el.offsetWidth}px`;
    layer.style.height = `${el.offsetHeight}px`;
    layer.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  };
  // Follow camera motion only while a menu is open.
  const loop = () => {
    sync();
    raf = target.value?.childElementCount ? requestAnimationFrame(loop) : 0;
  };
  const wake = () => {
    if (!raf && target.value?.childElementCount) loop();
  };
  watch(target, (layer) => {
    observer?.disconnect();
    if (!layer) return;
    observer = new MutationObserver(wake);
    observer.observe(layer, { childList: true });
  });
  onBeforeUnmount(() => {
    observer?.disconnect();
    cancelAnimationFrame(raf);
  });
  const portal: NotesPortal = {
    target,
    local(x, y) {
      sync();
      const { left, top, scale } = frame(root.value);
      return { x: (x - left) / scale, y: (y - top) / scale };
    },
    viewport() {
      const { left, top, scale } = frame(root.value);
      return {
        left: -left / scale,
        top: -top / scale,
        right: (innerWidth - left) / scale,
        bottom: (innerHeight - top) / scale,
      };
    },
  };
  provide(key, portal);
  return portal;
}

export function useNotesPortal(): NotesPortal {
  return (
    inject(key, null) ?? {
      target: ref(),
      local: (x, y) => ({ x, y }),
      viewport: () => ({
        left: 0,
        top: 0,
        right: innerWidth,
        bottom: innerHeight,
      }),
    }
  );
}
