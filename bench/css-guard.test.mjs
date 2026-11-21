// Rejects selectors that restyle a whole subtree whenever an ancestor's
// state changes: a universal rightmost part ("*", or a bare pseudo-element)
// under :hover/:active/:focus or under a class the canvas toggles at runtime.
// One such rule (".is-panning:active *") made every click on a 50-app
// workspace cost more than a second of style recalculation.
//
//   node --test bench/css-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src", import.meta.url));
const STATE = /:(hover|active|focus|focus-within|focus-visible|target)\b/;
// Classes switched on elements that contain most of the document.
const TOGGLED = /\.(is-panning|camera-moving|is-editing|armed|dragging)\b/;

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|vue)$/.test(name) ? [path] : [];
  });
}
function styles(path) {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".css")) return text;
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join("\n");
}
/** Splits on a separator that is outside (), [] and quotes. */
function split(text, separator) {
  const parts = [];
  let depth = 0,
    quote = "",
    current = "";
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    if (!quote && !depth && separator.test(character)) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts;
}
export function offending(css) {
  const found = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1].trim();
    if (!prelude || prelude.startsWith("@") || /^(from|to|[\d.]+%)/.test(prelude))
      continue;
    for (const selector of split(prelude, /,/)) {
      const compounds = split(
        selector.trim().replace(/\s*([>+~])\s*/g, " "),
        /\s/,
      ).filter(Boolean);
      if (compounds.length < 2) continue;
      const last = compounds.at(-1);
      // "*", "*::selection", "::-webkit-scrollbar-thumb": nothing narrows it.
      if (!/^(\*|::)/.test(last) || /[.#\[]/.test(last)) continue;
      const ancestors = compounds.slice(0, -1).join(" ");
      if (STATE.test(ancestors) || TOGGLED.test(ancestors))
        found.push(selector.trim());
    }
  }
  return found;
}

test("the guard recognises the selectors it exists for", () => {
  assert.deepEqual(
    offending(
      ".is-panning *{cursor:grab}.a:hover > *{color:red}.pane:active ::-webkit-scrollbar-thumb{}" +
        ".topbar > *{pointer-events:auto}.row:hover .name{color:red}.a:hover *.b{}",
    ),
    [".is-panning *", ".a:hover > *", ".pane:active ::-webkit-scrollbar-thumb"],
  );
});

test("no stylesheet restyles every descendant from a state or toggled class", () => {
  const found = files(root).flatMap((path) =>
    offending(styles(path)).map(
      (selector) => `${relative(root, path)}: ${selector}`,
    ),
  );
  assert.deepEqual(found, []);
});

// Scrollbars have one look, defined in src/scrollbars.css. In Chromium any
// non-auto scrollbar-width or scrollbar-color brings back the native Windows
// bar with arrow buttons, and per-area ::-webkit-scrollbar rules drift apart.
function sources(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(css|vue|ts|js|mjs)$/.test(name) ? [path] : [];
  });
}
// A scrollbar rule elsewhere may only hide the bar or inset its track.
const ALLOWED = /^(display:none|width:0(px)?|height:0(px)?|margin(-[a-z]+)?:.+)$/;
export function scrollbarProblems(text) {
  const found = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of code.matchAll(/scrollbar-(width|color)\s*:\s*([^;}"'`]+)/g)) {
    const value = match[2].replace(/!important/, "").trim();
    if (!["auto", ...(match[1] === "width" ? ["none"] : [])].includes(value))
      found.push(`scrollbar-${match[1]}: ${value}`);
  }
  for (const match of code.matchAll(/([^{}]*::-webkit-scrollbar[^{}]*)\{([^{}]*)\}/g)) {
    for (const declaration of match[2].split(";")) {
      const compact = declaration.replace(/!important/, "").replace(/\s+/g, "");
      if (compact && !ALLOWED.test(compact))
        found.push(`${match[1].trim().split("\n").at(-1)} { ${declaration.trim()} }`);
    }
  }
  return found;
}

test("the scrollbar guard recognises what it exists for", () => {
  assert.deepEqual(
    scrollbarProblems(
      ".a{scrollbar-width:thin;scrollbar-color:#ccc transparent}.b{scrollbar-width:none;scrollbar-color:auto}" +
        ".c::-webkit-scrollbar{width:10px}.d::-webkit-scrollbar{display:none !important}.e::-webkit-scrollbar-track{margin-top:50px}",
    ),
    ["scrollbar-width: thin", "scrollbar-color: #ccc transparent", ".c::-webkit-scrollbar { width:10px }"],
  );
});

test("scrollbars are styled only in src/scrollbars.css", () => {
  const found = sources(root)
    .filter((path) => relative(root, path) !== "scrollbars.css")
    .flatMap((path) =>
      scrollbarProblems(readFileSync(path, "utf8")).map(
        (problem) => `${relative(root, path)}: ${problem}`,
      ),
    );
  assert.deepEqual(found, []);
});
