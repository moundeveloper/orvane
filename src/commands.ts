// Command registry for the Ctrl+K palette. The canvas and each mounted app
// register a function that lists their commands; the palette asks for them
// when it opens, so commands always reflect the app's current state.
import { shallowReactive } from "vue";
import type { ReferenceReviewRequest, ReferenceReviewResult } from "./uimakerReferenceReview";

export type Command = {
  id: string;
  title: string;
  /** Shown under the title, e.g. the app it belongs to. */
  detail?: string;
  icon: string;
  keywords?: string;
  hint?: string;
  /** The block that owns the command; its app is focused before it runs. */
  blockId?: string;
  run: () => unknown;
};
const providers = shallowReactive(new Map<string, () => Command[]>());
export function registerCommands(owner: string, list: () => Command[]) {
  providers.set(owner, list);
  return () => void providers.delete(owner);
}
export function allCommands() {
  const out: Command[] = [];
  for (const list of providers.values()) {
    try {
      out.push(...list());
    } catch {
      // A failing app never breaks the palette.
    }
  }
  return out;
}

// Requests for an app to show something, sent by the palette. The app whose
// block id matches handles it (or the first one, when no id is given).
export type OpenRequest =
  | { kind: "notes-page"; blockId?: string; pageId: string }
  | { kind: "browser-url"; blockId?: string; url: string; reuse?: boolean }
  | { kind: "git-commit"; blockId?: string; workspaceId: string; hash: string }
  | { kind: "explorer-path"; blockId?: string; path: string; select?: string }
  | {
      kind: "uimaker";
      blockId: string;
      component: string;
      mode: "review" | "inspect" | "lab";
      version?: number;
      reference?: { mime: string; data: string; caption: string };
      review?: ReferenceReviewRequest;
      opened?: Promise<{ component: string; mode: string; version: number; referenceAdded?: true } | ReferenceReviewResult>;
    };
export const OPEN_EVENT = "orvane:open-request";
/** Drag data of a Browser tab: { url, title }. */
export const PAGE_DRAG_MIME = "application/x-orvane-page";
export function requestOpen(request: OpenRequest) {
  window.dispatchEvent(new CustomEvent<OpenRequest>(OPEN_EVENT, { detail: request }));
}
// Subscribe in an app: `handler` returns true when it handled the request.
export function onOpenRequest(handler: (request: OpenRequest) => boolean | void) {
  const listener = (event: Event) => {
    const request = (event as CustomEvent<OpenRequest>).detail;
    if ((event as CustomEvent & { handled?: boolean }).handled) return;
    if (handler(request)) (event as CustomEvent & { handled?: boolean }).handled = true;
  };
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}
