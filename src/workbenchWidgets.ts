import type { InjectionKey } from "vue";
import type { BrowserClip } from "./workbenchState";
export { readWidget, type BrowserClip, type ClipRect } from "./workbenchState";

export const WORKBENCH_WIDGET = "orvane:workbench-widget";
export type WorkbenchKind = "browser-clip" | "folder-compare" | "test-results";
export const REFRESH_BROWSER_CLIP = "orvane:refresh-browser-clip";
export type BrowserClipRequest = BrowserClip & {
  anySource?: boolean;
  respond?: Promise<string>;
};
export const workbenchEditable: InjectionKey<() => boolean> =
  Symbol("workbench-editable");

export function addWorkbenchWidget(
  kind: WorkbenchKind,
  value: object,
  title?: string,
) {
  window.dispatchEvent(
    new CustomEvent(WORKBENCH_WIDGET, { detail: { kind, value, title } }),
  );
}

export function revealWorkbenchDetail(element?: HTMLElement) {
  if (element) element.parentElement?.scrollTo({ top: element.offsetTop });
}
