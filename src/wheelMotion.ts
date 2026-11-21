// Motion for the action wheel (Halo · Glow).
// A gentle curve: no jump in the first frame, no overshoot.
export const WHEEL_EASE = "cubic-bezier(.3,.1,.2,1)";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Opening: the ring fades in while growing gently into place, and the
// backdrop tint fades in with it.
export function openWheel(overlay: HTMLElement | undefined, ring: HTMLElement | undefined) {
  if (!ring || reduced()) return;
  const timing = { duration: 280, easing: WHEEL_EASE };
  ring.animate([{ opacity: 0, scale: 0.92 }, { opacity: 1, scale: 1 }], timing);
  overlay?.animate([{ backgroundColor: "rgb(69 89 104 / 0)" }, {}], timing);
}

// How the wheel closed decides how it leaves:
// "slot"   an item was chosen: its icon lifts a little while the wheel fades away;
// "center" Edit config was chosen: the center disc grows outward as it fades,
//          opening toward the config;
// "cancel" nothing was chosen: a quick, quiet fade.
export type WheelExit = "slot" | "center" | "cancel";
export function closeWheel(overlay: Element, exit: WheelExit, done: () => void) {
  // The closing wheel is only a picture: no clicks, focus or accessibility.
  overlay.setAttribute("inert", "");
  overlay.setAttribute("aria-hidden", "true");
  if (reduced()) return done();
  const ring = overlay.querySelector<HTMLElement>(".radial-wheel");
  const fade = (duration: number, extra: KeyframeAnimationOptions = {}) => ({
    duration, easing: WHEEL_EASE, fill: "forwards" as const, ...extra,
  });
  let ms = 160;
  if (exit === "slot") {
    ms = 300;
    overlay
      .querySelector(".radial-layer:not(.leaving) .radial-entry.selected .radial-icon")
      ?.animate([{ scale: 1 }, { scale: 1.12 }], fade(300));
    ring?.animate([{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.97 }], fade(220, { delay: 80 }));
  } else if (exit === "center") {
    ms = 280;
    overlay
      .querySelector(".radial-center")
      ?.animate([{ scale: 1, opacity: 1 }, { scale: 1.18, opacity: 0 }], fade(280));
    ring?.animate([{ opacity: 1 }, { opacity: 0 }], fade(260));
  } else {
    ring?.animate([{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.98 }], fade(160));
  }
  overlay.animate([{ opacity: 1 }, { opacity: 0 }], fade(ms));
  setTimeout(done, ms);
}

// Changing level (entering a group or going back): the ring and the center disc
// stay put. The old level drifts slightly away and fades while the new one
// settles in its place. `direction` is 1 when entering a group, -1 going back.
// `scale` is off for the center text, which only crossfades.
export function wheelLevelHooks(
  direction: () => number,
  { duration, scale }: { duration: number; scale: boolean },
) {
  const timing = { duration, easing: WHEEL_EASE };
  const far = (d: number) => (d > 0 ? 1.035 : 0.965);
  return {
    enter(el: Element, done: () => void) {
      if (reduced()) return done();
      const d = direction();
      const from: Keyframe = { opacity: 0 };
      if (scale) from.scale = 2 - far(d);
      el.animate([from, { opacity: 1, ...(scale ? { scale: 1 } : {}) }], timing)
        .onfinish = () => done();
    },
    leave(el: Element, done: () => void) {
      // The fading level is only a picture: no clicks, focus or accessibility.
      el.classList.add("leaving");
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
      if (reduced()) return done();
      // An interrupted level leaves from where it is now, not from full view.
      const style = getComputedStyle(el);
      const from: Keyframe = { opacity: style.opacity };
      if (scale) from.scale = style.scale === "none" ? 1 : style.scale;
      el.getAnimations().forEach((a) => a.cancel());
      const to: Keyframe = { opacity: 0 };
      if (scale) to.scale = far(direction());
      el.animate([from, to], { ...timing, fill: "forwards" }).onfinish = () =>
        done();
    },
  };
}
