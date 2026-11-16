// The app you are working in (the last one you clicked or typed in), shown
// with a faint outline. Clicking empty canvas or pressing Esc clears it.
import { reactive } from "vue";

export const canvasScroll = reactive({ owner: "" });
/** The canvas app an element belongs to, or "". */
export function appOf(element: Element | null | undefined) {
  return element?.closest<HTMLElement>(".canvas-app")?.dataset.appId ?? "";
}
// Sent by content that runs elsewhere (code-app frames, Browser pages):
// a press inside it (detail: { appId }).
export const ACTIVATE_EVENT = "orvane:activate-app";
// A Browser shortcut pressed while its app is in use but focus is on the
// canvas (detail: { blockId, name }).
export const BROWSER_SHORTCUT = "orvane:browser-shortcut";
export function activateApp(appId: string) {
  if (appId) window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: { appId } }));
}
