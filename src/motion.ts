import type { ObjectDirective } from "vue";

type MotionKind =
  "popover" | "panel" | "app" | "reveal" | "value" | "workspace" | "fade";
interface MotionOptions {
  kind: MotionKind;
  state?: unknown;
  show?: boolean;
  enabled?: boolean;
  initial?: boolean;
}
const running = new WeakMap<HTMLElement, Animation>();
const durations: Record<MotionKind, number> = {
  popover: 160,
  panel: 180,
  app: 170,
  reveal: 160,
  value: 130,
  workspace: 240,
  fade: 130,
};

function cancel(element: HTMLElement) {
  running.get(element)?.cancel();
  running.delete(element);
}
function animate(element: HTMLElement, options: MotionOptions) {
  if (
    options.enabled === false ||
    options.show === false ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  const previous = running.get(element),
    interrupted = previous?.playState === "running";
  const current = interrupted ? getComputedStyle(element) : undefined;
  const fromOpacity = current?.opacity,
    fromTransform = current?.transform;
  cancel(element);
  let frames: Keyframe[];
  {
    const offset =
      options.kind === "popover"
        ? "translateY(-3px)"
        : options.kind === "panel"
          ? "translateX(4px)"
          : options.kind === "app"
            ? "translateY(5px)"
            : options.kind === "workspace"
              ? "translateX(8px)"
              : options.kind === "reveal"
                ? "translateY(3px)"
                : "none";
    frames = [
      {
        opacity:
          fromOpacity ||
          (options.kind === "workspace"
            ? 0
            : options.kind === "value"
              ? 0.5
              : 0.2),
        transform: fromTransform || offset,
      },
      { opacity: 1, transform: "none" },
    ];
  }
  const animation = element.animate(frames, {
    duration: durations[options.kind],
    easing: "cubic-bezier(.16,1,.3,1)",
  });
  running.set(element, animation);
  animation.onfinish = () => {
    if (running.get(element) === animation) running.delete(element);
  };
}

/** Local visual feedback only: never animates layout, gates input, or touches the camera. */
export const vMotion: ObjectDirective<HTMLElement, MotionOptions> = {
  mounted(element, binding) {
    if (binding.value.initial !== false) animate(element, binding.value);
  },
  updated(element, binding) {
    const next = binding.value,
      previous = binding.oldValue;
    if (next.show === false || next.enabled === false) {
      cancel(element);
      return;
    }
    if (previous?.show === false) {
      animate(element, next);
      return;
    }
    if (previous?.enabled === false) return;
    if (previous && !Object.is(next.state, previous.state))
      animate(element, next);
  },
  beforeUnmount: cancel,
};
