// Live clips: a real page shown through a window cropped to part of it.
// Scripts here run inside the page (a sandboxed <webview> guest); they talk
// back through console messages with LIVE_CLIP_PREFIX, which the clip reads
// from its own webview only.
import type { ClipRect } from "./workbenchState";

export const LIVE_CLIP_PREFIX = "__orvane_live_clip__";

type PageView = { getWebContentsId(): number; executeJavaScript(code: string): Promise<unknown> };
/**
 * Runs a script in a Browser page now. <webview>.executeJavaScript waits
 * until the page finishes loading, which streaming sites can put off for
 * minutes; the desktop app runs it in the page's main frame at once.
 */
export function runInPage(view: PageView, code: string): Promise<unknown> {
  const desktop = (window as unknown as {
    orvaneDesktop?: { runInPage?(id: number, code: string): Promise<unknown> };
  }).orvaneDesktop;
  if (!desktop?.runInPage) return view.executeJavaScript(code);
  let id: number;
  try {
    id = view.getWebContentsId();
  } catch {
    return Promise.reject(Error("The page is not ready."));
  }
  return desktop.runInPage(id, code);
}
export type PageSize = { width: number; height: number };
export type PickedElement = { selector: string; rect: ClipRect; viewport: PageSize };

const finite = (...values: unknown[]) =>
  values.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e6);

export function readRect(value: unknown, min = 4): ClipRect | null {
  const r = value as Partial<ClipRect> | null;
  if (!r || !finite(r.x, r.y, r.width, r.height) || r.width! < min || r.height! < min) return null;
  return {
    x: Math.round(r.x!),
    y: Math.round(r.y!),
    width: Math.round(Math.min(r.width!, 20000)),
    height: Math.round(Math.min(r.height!, 20000)),
  };
}
export function readSize(value: unknown): PageSize | null {
  const s = value as Partial<PageSize> | null;
  if (!s || !finite(s.width, s.height) || s.width! < 50 || s.height! < 50) return null;
  return { width: Math.round(Math.min(s.width!, 8000)), height: Math.round(Math.min(s.height!, 8000)) };
}
export function readPicked(value: unknown): PickedElement | null {
  const p = value as Partial<PickedElement> | null;
  const rect = readRect(p?.rect);
  const viewport = readSize(p?.viewport);
  if (!p || typeof p.selector !== "string" || !p.selector || p.selector.length > 2000 || !rect || !viewport)
    return null;
  return { selector: p.selector, rect, viewport };
}

/**
 * Lets the user point at an element of the page: it is outlined under the
 * pointer, ↑/↓ (or [ and ]) widen to its parent or narrow back, a click or
 * Enter picks it, Escape cancels. Resolves to a PickedElement or null.
 */
export const PICK_ELEMENT = `(() => {
  window.__orvaneClipPick?.cancel();
  return new Promise((resolve) => {
    const top = "2147483647";
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:" + top + ";border:2px solid #2f7fd0;background:rgba(47,127,208,.14);border-radius:3px;box-sizing:border-box;display:none";
    const tag = document.createElement("div");
    tag.style.cssText = "position:fixed;pointer-events:none;z-index:" + top + ";font:12px/18px system-ui,sans-serif;color:#fff;background:#1f4f7a;padding:0 6px;border-radius:4px;white-space:nowrap;display:none";
    const hint = document.createElement("div");
    hint.textContent = "Click to pin this part · \\u2191 \\u2193 widen or narrow · Esc cancels";
    hint.style.cssText = "position:fixed;left:50%;top:10px;transform:translateX(-50%);pointer-events:none;z-index:" + top + ";font:13px/20px system-ui,sans-serif;color:#fff;background:rgba(24,44,60,.88);padding:5px 12px;border-radius:7px;white-space:nowrap";
    document.documentElement.append(box, tag, hint);
    let base = null, at = null;
    const usable = (el) => el instanceof Element && el !== box && el !== tag && el !== hint &&
      el !== document.documentElement && el !== document.body;
    const show = () => {
      if (!at || !at.isConnected) { box.style.display = tag.style.display = "none"; return; }
      const r = at.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      const classes = typeof at.className === "string" ? at.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
      const name = at.localName + (at.id ? "#" + at.id : "") + (classes.length ? "." + classes.join(".") : "");
      tag.textContent = name.slice(0, 60) + "  " + Math.round(r.width) + " \\u00d7 " + Math.round(r.height);
      tag.style.display = "block";
      tag.style.left = Math.max(0, Math.min(innerWidth - tag.offsetWidth, r.left)) + "px";
      tag.style.top = (r.top >= 22 ? r.top - 20 : Math.min(innerHeight - 18, r.bottom + 2)) + "px";
    };
    const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const move = (event) => {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!usable(el) || el === base) return;
      base = at = el;
      show();
    };
    const press = (event) => {
      if (event.button !== 0) return;
      stop(event);
      if (event.type === "click") done(true);
    };
    const key = (event) => {
      const k = event.key;
      if (k === "Escape") { stop(event); done(false); }
      else if (k === "Enter") { stop(event); done(true); }
      else if ((k === "ArrowUp" || k === "[") && at && usable(at.parentElement)) { stop(event); at = at.parentElement; show(); }
      else if ((k === "ArrowDown" || k === "]") && at && base && at !== base) {
        stop(event);
        let next = base;
        while (next.parentElement && next.parentElement !== at) next = next.parentElement;
        at = next;
        show();
      }
    };
    const selector = (el) => {
      const parts = [];
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        if (node.id) {
          const id = "#" + CSS.escape(node.id);
          try { if (document.querySelectorAll(id).length === 1) { parts.unshift(id); return parts.join(" > "); } } catch {}
        }
        let index = 1;
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling)
          if (sibling.localName === node.localName) index++;
        parts.unshift(CSS.escape(node.localName) + ":nth-of-type(" + index + ")");
      }
      return "html > " + parts.join(" > ");
    };
    const listeners = [["pointermove", move], ["pointerdown", press], ["mousedown", press], ["pointerup", press],
      ["mouseup", press], ["click", press], ["keydown", key], ["scroll", show]];
    function done(pick) {
      for (const [type, listener] of listeners) removeEventListener(type, listener, true);
      box.remove(); tag.remove(); hint.remove();
      window.__orvaneClipPick = undefined;
      if (!pick || !at || !at.isConnected) return resolve(null);
      const r = at.getBoundingClientRect();
      resolve({
        selector: selector(at),
        rect: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
        viewport: { width: innerWidth, height: innerHeight },
      });
    }
    for (const [type, listener] of listeners) addEventListener(type, listener, { capture: true, passive: false });
    window.__orvaneClipPick = { cancel: () => done(false) };
  });
})()`;

export const CANCEL_PICK = "window.__orvaneClipPick?.cancel()";

/**
 * Runs in the clip's page on every load. It keeps the clipped part in view,
 * reports where it is (viewport pixels) whenever that changes, and sends
 * links that would leave the page to Orvane's Browser instead.
 * Area clips track fixed page coordinates; element clips find the element
 * again by its selector (falling back to the saved area while it is missing).
 * "fill" lays the element over the whole page so it resizes with the clip.
 */
export function trackerScript(spec: { selector?: string; rect: ClipRect; fill: boolean }) {
  return `(() => {
  const spec = ${JSON.stringify(spec)};
  const prefix = ${JSON.stringify(LIVE_CLIP_PREFIX)};
  window.__orvaneLiveClip?.stop();
  const style = document.createElement("style");
  // The page can't scroll away from the clipped part; area and element
  // clips keep the scrollbar's room so the page lays out as when pinned.
  style.textContent = "html{overflow:hidden!important" + (spec.fill ? "}" : ";scrollbar-gutter:stable!important}") + (spec.fill ?
    "body{visibility:hidden!important}" +
    "[data-orvane-clip]{visibility:visible!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;" +
    "min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;margin:0!important;" +
    "transform:none!important;z-index:2147483647!important}" +
    "[data-orvane-clip-up]{transform:none!important;filter:none!important;backdrop-filter:none!important;perspective:none!important;" +
    "contain:none!important;will-change:auto!important;container-type:normal!important}" : "");
  (document.head || document.documentElement).append(style);
  const marked = [];
  let el = null, last = "", frame = 0;
  const unmark = () => { for (const node of marked.splice(0)) node.removeAttribute("data-orvane-clip-up"); el?.removeAttribute("data-orvane-clip"); };
  const take = (next) => {
    if (next === el) return;
    unmark();
    el = next;
    if (!el || !spec.fill) return;
    el.setAttribute("data-orvane-clip", "");
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      node.setAttribute("data-orvane-clip-up", "");
      marked.push(node);
    }
    // Players and responsive widgets size themselves on resize.
    setTimeout(() => dispatchEvent(new Event("resize")), 0);
  };
  const outside = (x, y, w, h) => x < 0 || y < 0 || x + w > innerWidth + 1 || y + h > innerHeight + 1;
  const report = () => {
    frame = 0;
    if (spec.selector && !(el && el.isConnected)) {
      let next = null;
      try { next = document.querySelector(spec.selector); } catch {}
      take(next);
    }
    let r;
    if (el) {
      let b = el.getBoundingClientRect();
      if (!spec.fill && outside(b.left, b.top, b.width, b.height) && b.width <= innerWidth && b.height <= innerHeight) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        b = el.getBoundingClientRect();
      }
      r = [b.left, b.top, b.width, b.height];
    } else {
      const a = spec.rect;
      if (outside(a.x - scrollX, a.y - scrollY, a.width, a.height)) scrollTo(a.x, a.y);
      r = [a.x - scrollX, a.y - scrollY, a.width, a.height];
    }
    const message = JSON.stringify({ rect: r.map(Math.round), found: !spec.selector || !!el });
    if (message !== last) { last = message; console.debug(prefix + message); }
  };
  const queue = () => { if (!frame) frame = requestAnimationFrame(report); };
  const click = (event) => {
    if (event.button !== 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element && event.target.closest("a[href]");
    if (!link || !/^https?:/.test(link.href) || link.hasAttribute("download")) return;
    const url = new URL(link.href);
    if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    console.debug(prefix + JSON.stringify({ open: link.href }));
  };
  addEventListener("scroll", queue, true);
  addEventListener("resize", queue);
  addEventListener("click", click, true);
  // Also on a timer, without waiting for a frame: a page that is not
  // painting yet still reports where the clipped part is.
  const timer = setInterval(() => { cancelAnimationFrame(frame); report(); }, 400);
  window.__orvaneLiveClip = {
    stop() {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      removeEventListener("scroll", queue, true);
      removeEventListener("resize", queue);
      removeEventListener("click", click, true);
      style.remove();
      unmark();
    },
  };
  queue();
})()`;
}

/** A message from the clip's page, or null if it is not one. */
export function readTrackerMessage(
  message: unknown,
): { rect: ClipRect; found: boolean } | { open: string } | null {
  if (typeof message !== "string" || !message.startsWith(LIVE_CLIP_PREFIX)) return null;
  let data: { rect?: unknown; found?: unknown; open?: unknown };
  try {
    data = JSON.parse(message.slice(LIVE_CLIP_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof data.open === "string")
    return /^https?:\/\//i.test(data.open) && data.open.length < 8000 ? { open: data.open } : null;
  if (!Array.isArray(data.rect)) return null;
  const [x, y, width, height] = data.rect;
  const rect = readRect({ x, y, width, height }, 1);
  return rect ? { rect, found: data.found !== false } : null;
}
