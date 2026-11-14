// Who gets two-finger scroll: the canvas pans everywhere except over the app
// you are working in (the last one you clicked or typed in). Clicking empty
// canvas or pressing Esc gives scrolling back to the canvas.
import { reactive } from "vue";

// `panning` is true while a scroll pan is in progress: until it pauses, all
// scroll goes to the canvas, even over the app being worked in, so turning
// mid-gesture keeps panning instead of switching to whatever is underneath.
export const canvasScroll = reactive({ owner: "", panning: false });
/** The canvas app an element belongs to, or "". */
export function appOf(element: Element | null | undefined) {
  return element?.closest<HTMLElement>(".canvas-app")?.dataset.appId ?? "";
}
// Sent by content that runs elsewhere (code-app frames, Browser pages):
// a press inside it (detail: { appId }) and scroll it passes on (detail:
// { dx, dy, shift } in screen pixels).
export const ACTIVATE_EVENT = "orvane:activate-app";
export const WHEEL_EVENT = "orvane:canvas-wheel";
export function activateApp(appId: string) {
  if (appId) window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: { appId } }));
}
export function passWheel(dx: number, dy: number, shift = false) {
  window.dispatchEvent(new CustomEvent(WHEEL_EVENT, { detail: { dx, dy, shift } }));
}
