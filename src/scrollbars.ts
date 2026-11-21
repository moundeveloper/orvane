// Orvane's scrollbar look (scrollbars.css) for documents Orvane renders in
// iframes, where the app's own stylesheet doesn't reach.
import scrollbarCss from "./scrollbars.css?raw";

export { scrollbarCss };

/** Adds Orvane's scrollbars to a same-origin document. The style goes first
 * in <head>, so a page that styles its own scrollbars keeps them. */
export function adoptScrollbars(doc: Document | null | undefined) {
  if (!doc?.head || doc.getElementById("orvane-scrollbars")) return;
  const style = doc.createElement("style");
  style.id = "orvane-scrollbars";
  style.textContent = scrollbarCss;
  doc.head.prepend(style);
}
