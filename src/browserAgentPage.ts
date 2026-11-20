// Scripts the Browser runs inside a page the AI controls. Each returns a
// JSON-safe value. Elements get short refs ("e12") that stay the same for
// the same element across snapshots, kept on a hidden, non-enumerable
// property of the page's window (main world: the only world that runs
// while a page is still loading).

export type AgentTarget = { ref?: string; selector?: string; text?: string };

/** Shared helpers, prepended to every script. */
const HELPERS = String.raw`
const store = (() => {
  const key = Symbol.for("orvane.agent");
  if (!window[key]) Object.defineProperty(window, key, { value: { next: 1, byRef: new Map(), byEl: new WeakMap() } });
  return window[key];
})();
const refOf = (el) => {
  let ref = store.byEl.get(el);
  if (!ref) { ref = "e" + store.next++; store.byEl.set(el, ref); }
  store.byRef.set(ref, new WeakRef(el));
  return ref;
};
const clean = (s, n = 100) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const visible = (el) => {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.02;
};
const roleOf = (el) => {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.split(" ")[0];
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const t = (el.type || "text").toLowerCase();
    if (t === "checkbox" || t === "radio") return t;
    if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
    if (t === "range") return "slider";
    return "textbox";
  }
  if (el.isContentEditable) return "textbox";
  return "generic";
};
const nameOf = (el) => {
  const aria = el.getAttribute("aria-label");
  if (aria) return clean(aria);
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
    if (clean(text)) return clean(text);
  }
  if (el.labels && el.labels.length) return clean([...el.labels].map((l) => l.innerText).join(" "));
  const tag = el.tagName.toLowerCase();
  if (tag === "input" && /^(button|submit|reset)$/i.test(el.type)) return clean(el.value);
  if (tag !== "select" && tag !== "textarea" && !(tag === "input")) {
    const text = clean(el.innerText);
    if (text) return text;
  }
  return clean(el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("name") || "");
};
const INTERACTIVE = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=treeitem],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
const resolve = (target) => {
  if (target.ref) {
    const el = store.byRef.get(target.ref)?.deref();
    if (!el || !el.isConnected) throw new Error("Element " + target.ref + " is gone from the page. Take a new snapshot.");
    return el;
  }
  if (target.selector) {
    const all = [...document.querySelectorAll(target.selector)];
    return all.find(visible) || all[0] || null;
  }
  if (target.text) {
    const want = clean(target.text, 400).toLowerCase();
    const candidates = [...document.querySelectorAll(INTERACTIVE)].filter(visible);
    const exact = candidates.find((el) => nameOf(el).toLowerCase() === want);
    if (exact) return exact;
    const partial = candidates.find((el) => nameOf(el).toLowerCase().includes(want));
    if (partial) return partial;
    // Any visible element whose own text matches: the innermost one.
    let best = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.childElementCount > 20) continue;
      const text = clean(node.innerText, 400).toLowerCase();
      if (text && text.includes(want) && visible(node) && (!best || best.contains(node))) best = node;
    }
    return best;
  }
  throw new Error("Give a ref, selector or text.");
};
const describe = (el) => ({ ref: refOf(el), role: roleOf(el), name: nameOf(el) });
`;

const wrap = (body: string) => `(() => {${HELPERS}\n${body}\n})()`;
const json = (value: unknown) => JSON.stringify(value ?? null);

/** The page's title, address and its interactive elements (plus headings). */
export function snapshotScript(max = 150, textLength = 1500, includeHidden = false) {
  return wrap(`
const out = [];
const seen = new Set();
const nodes = document.querySelectorAll(INTERACTIVE + ",h1,h2,h3,[role=heading],[role=dialog],[role=alert]");
const vw = innerWidth, vh = innerHeight;
let total = 0;
for (const el of nodes) {
  if (seen.has(el) || !visible(el)) continue;
  seen.add(el);
  total++;
  if (out.length >= ${Math.max(10, Math.min(500, max))}) continue;
  const r = el.getBoundingClientRect();
  const item = describe(el);
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    if (el.type === "checkbox" || el.type === "radio") item.checked = el.checked;
    else if (el.type !== "password") item.value = clean(el.value, 200);
    else item.value = el.value ? "••••" : "";
  }
  if (tag === "select") {
    item.value = clean(el.selectedOptions[0]?.text, 100);
    item.options = [...el.options].slice(0, 30).map((o) => clean(o.text, 60));
  }
  const checked = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected") ?? el.getAttribute("aria-expanded");
  if (checked != null && item.checked === undefined) item.state = checked;
  if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
  if (tag === "a") item.href = clean(el.getAttribute("href"), 160);
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) item.offscreen = true;
  out.push(item);
}
// Links hidden in the page (collapsed menus, closed panels): their addresses
// let the AI go straight there instead of opening the menus.
const hidden = [];
if (${includeHidden ? "true" : "false"}) {
  const known = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    if (seen.has(a) || hidden.length >= 300) continue;
    const href = a.href;
    const name = clean(a.textContent || a.getAttribute("aria-label") || a.title, 80);
    if (!name || !/^https?:/.test(href) || known.has(name + href)) continue;
    known.add(name + href);
    hidden.push({ name, href });
  }
}
return {
  url: location.href,
  title: document.title,
  ...(hidden.length ? { hiddenLinks: hidden } : {}),
  loading: document.readyState !== "complete",
  scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: vh },
  elements: out,
  more: Math.max(0, total - out.length),
  text: clean(document.body?.innerText, ${Math.max(0, Math.min(20000, textLength))}),
};`);
}

/** Scrolls the target into view and returns the point to press, or why not. */
export function locateScript(target: AgentTarget) {
  return wrap(`
const el = resolve(${json(target)});
if (!el) return { wait: "No element matches." };
if (!visible(el)) return { wait: "The element is not visible." };
el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
const r = el.getBoundingClientRect();
const x = Math.min(innerWidth - 2, Math.max(1, r.left + r.width / 2));
const y = Math.min(innerHeight - 2, Math.max(1, r.top + r.height / 2));
if (el.disabled || el.getAttribute("aria-disabled") === "true") return { wait: "The element is disabled.", ...describe(el) };
const hit = document.elementFromPoint(x, y);
if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
  // Labels and their controls are the same target.
  const label = hit.closest("label");
  if (!(label && (label.control === el || label.contains(el))))
    return { wait: "Another element covers it: " + clean(hit.tagName.toLowerCase() + " " + nameOf(hit), 80), ...describe(el) };
}
return { x, y, ...describe(el) };`);
}

/** Focuses a text field and selects its contents, so typing replaces them. */
export function focusForFillScript(target: AgentTarget) {
  return wrap(`
const el = resolve(${json(target)});
if (!el) return { wait: "No element matches." };
const tag = el.tagName.toLowerCase();
if (tag === "select") return { select: true, ...describe(el) };
const editable = tag === "textarea" || (tag === "input" && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type)) || el.isContentEditable;
if (!editable) return { error: "That element is not a text field. Use click for buttons and checkboxes, select for lists." };
if (el.disabled || el.readOnly) return { wait: "The field is disabled or read-only.", ...describe(el) };
el.scrollIntoView({ block: "center", behavior: "instant" });
el.focus();
if (el.isContentEditable) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
} else el.select?.();
return { focused: document.activeElement === el || el.contains(document.activeElement), ...describe(el) };`);
}

/** Picks an option of a <select> by value or visible text. */
export function selectScript(target: AgentTarget, choice: { value?: string; label?: string }) {
  return wrap(`
const el = resolve(${json(target)});
if (!el) return { wait: "No element matches." };
if (el.tagName.toLowerCase() !== "select") return { error: "Not a <select>. For custom dropdowns click to open them, then click the option." };
const choice = ${json(choice)};
const options = [...el.options];
const want = (choice.label ?? choice.value ?? "").toLowerCase();
const option = options.find((o) => o.value === choice.value) || options.find((o) => o.text.trim().toLowerCase() === want) || options.find((o) => o.text.toLowerCase().includes(want));
if (!option) return { error: "No such option. Options: " + options.slice(0, 40).map((o) => clean(o.text, 40)).join(" | ") };
el.focus();
const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
setter.call(el, option.value);
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
return { selected: clean(option.text, 100), ...describe(el) };`);
}

/** Text of an element, or of the whole page. */
export function readScript(target: AgentTarget | undefined, maxLength: number) {
  return wrap(`
const target = ${json(target ?? null)};
const el = target ? resolve(target) : document.body;
if (!el) return { wait: "No element matches." };
const tag = el.tagName.toLowerCase();
const text = tag === "input" || tag === "textarea" || tag === "select" ? el.value : el.innerText;
const max = ${Math.max(100, Math.min(50000, maxLength))};
return { url: location.href, title: document.title, text: String(text ?? "").slice(0, max), truncated: String(text ?? "").length > max };`);
}

/** Whether the target (or text) is on the page, visible. */
export function presentScript(target: AgentTarget) {
  return wrap(`
try {
  const el = resolve(${json(target)});
  return { present: !!el && visible(el), loading: document.readyState === "loading" };
} catch (error) {
  return { present: false, error: String(error.message || error) };
}`);
}

/** Scrolls the page, or the nearest scrollable box around the target. */
export function scrollScript(target: AgentTarget | undefined, to: "top" | "bottom" | undefined, dx: number, dy: number) {
  return wrap(`
const target = ${json(target ?? null)};
let box = target ? resolve(target) : null;
if (target && !box) return { wait: "No element matches." };
const scrollable = (el) => { const cs = getComputedStyle(el); return /(auto|scroll|overlay)/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1); };
while (box && box !== document.body && !scrollable(box)) box = box.parentElement;
const el = box && box !== document.body ? box : document.scrollingElement || document.documentElement;
const before = { x: el.scrollLeft, y: el.scrollTop };
const to = ${json(to ?? null)};
if (to === "top") el.scrollTo({ top: 0, behavior: "instant" });
else if (to === "bottom") el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
else el.scrollBy({ left: ${Number(dx) || 0}, top: ${Number(dy) || 0}, behavior: "instant" });
return {
  moved: el.scrollTop !== before.y || el.scrollLeft !== before.x,
  y: Math.round(el.scrollTop),
  atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
};`);
}

/** Runs an expression, or a statement body that uses return, in the page.
 * Built as source (not new Function) so a page's CSP can't refuse it; the
 * caller retries as a body when the expression form is a syntax error. */
export function evalScript(expression: string, asBody = false) {
  const run = asBody ? `(async () => {\n${expression}\n})()` : `(async () => (\n${expression}\n))()`;
  return `${run}.then((value) => { try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return String(value); } })`;
}

/** Resolves once the page stops changing (no DOM mutation for quietMs), or
 * after maxMs on pages that never settle: hover menus and popups that a
 * hover or click opens are then in place. */
export function quietScript(quietMs = 250, maxMs = 2000) {
  return `new Promise((done) => {
  let timer;
  const finish = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(limit); done(true); };
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, ${quietMs}); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  timer = setTimeout(finish, ${quietMs});
  const limit = setTimeout(finish, ${maxMs});
})`;
}
