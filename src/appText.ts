// What an app on the canvas can hand to an agent session: the selected text,
// its readable text and a picture. Apps whose content is not plain DOM text
// (Terminal draws on a canvas, Browser pages live in a separate process)
// register their own source on their root element; other apps fall back to
// the DOM selection and their surface's text.
export interface AppTextSource {
  selection?(): string | Promise<string>;
  text?(): string | Promise<string>;
  /** A PNG data URL. */
  picture?(): Promise<string>;
  /** Where the text comes from, e.g. a command or a page address. */
  detail?(): string;
}

const sources = new Map<Element, AppTextSource>();

export function registerAppText(element: Element, source: AppTextSource) {
  sources.set(element, source);
  return () => {
    if (sources.get(element) === source) sources.delete(element);
  };
}

/** The source registered on `element` or its nearest ancestor. */
export function appTextAt(element: Element | null): AppTextSource | undefined {
  for (let node = element; node; node = node.parentElement) {
    const source = sources.get(node);
    if (source) return source;
  }
  return undefined;
}

/** Sources inside an app; the one holding focus first. */
export function appTextIn(app: Element): AppTextSource | undefined {
  const focused = document.activeElement;
  if (focused && app.contains(focused)) {
    const own = appTextAt(focused);
    if (own) return own;
  }
  for (const [element, source] of sources) if (app.contains(element)) return source;
  return undefined;
}
