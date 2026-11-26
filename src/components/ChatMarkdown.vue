<script setup lang="ts">
import { computed, ref } from "vue";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { api as fileRequest } from "./files/explorer";
import ImagePeek, { type PeekImage } from "./ImagePeek.vue";
import { replyPictureUrl, isReplyPicture } from "../agentSessions";

// base: the session folder, for paths the agent wrote relative to it.
const props = defineProps<{ text: string; base?: string }>();
// Two roots (the text and the picture viewer): classes go on the text.
defineOptions({ inheritAttrs: false });

// File and folder names in a reply become links into the File Explorer, but
// only once the path is known to exist. Shared by every message.
const known = new Map<string, boolean | null>();
const version = ref(0);
let pending = new Set<string>();
let checking: ReturnType<typeof setTimeout> | undefined;
function check(path: string) {
  if (known.has(path) || pending.has(path)) return;
  pending.add(path);
  checking ??= setTimeout(async () => {
    const batch = [...pending];
    pending = new Set();
    checking = undefined;
    try {
      const { entries } = await fileRequest<{
        entries: { dir: boolean | null }[];
      }>("exists", { paths: batch });
      batch.forEach((path, index) => known.set(path, entries[index]?.dir ?? null));
    } catch {
      for (const path of batch) known.set(path, null);
    }
    version.value++;
  }, 60);
}
const absolutePath = /^(?:[a-z]:[\\/]|\\\\)/i;
function localPath(raw: string) {
  let text = raw.trim();
  if (!text || /^(?:https?|mailto):/i.test(text) || text.startsWith("#"))
    return null;
  if (/^file:/i.test(text)) text = text.replace(/^file:\/*/i, "");
  try {
    text = decodeURI(text);
  } catch {
    /* Keep it as written. */
  }
  text = text
    .replace(/^\/(?=[a-z]:[\\/])/i, "")
    .replace(/#L\d+(?:-L?\d+)?$/i, "")
    .replace(/:\d+(?::\d+)?$/, "");
  if (/[<>"|?*\n]/.test(text) || /^[a-z][\w+.-]*:\/\//i.test(text)) return null;
  if (absolutePath.test(text)) return text.replace(/\//g, "\\");
  if (!props.base || /^~/.test(text)) return null;
  const parts = props.base.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const part of text.replace(/^\.[\\/]/, "").split(/[\\/]+/)) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("\\");
}
// Inline code that reads like a file name or path, e.g. `src/App.vue:12`.
const codePath =
  /^(?:[a-z]:[\\/]|\.{1,2}[\\/])?[\w@.-]+(?:[\\/][\w@ .()-]+)*[\\/]?(?::\d+(?::\d+)?)?$/i;
function codeCandidate(text: string) {
  if (!codePath.test(text) || text.length > 260) return null;
  const bare = text.replace(/:\d+(?::\d+)?$/, "");
  if (!/[\\/]/.test(bare) && !/[\w-]\.[a-z0-9]{1,6}$/i.test(bare)) return null;
  return localPath(bare);
}
function markPath(element: Element, path: string) {
  const dir = known.get(path);
  if (dir === undefined) return check(path);
  if (dir === null) return;
  element.classList.add("md-path");
  element.setAttribute("data-path", path);
  element.setAttribute("data-dir", String(dir));
  element.setAttribute("title", dir ? "Open folder in Orvane" : "Show file in Orvane");
  element.setAttribute("role", "link");
  element.setAttribute("tabindex", "0");
}
// Pictures open full-window; ← → step through this message's pictures.
const peek = ref<{ items: PeekImage[]; index: number } | null>(null);
let peekTrigger: HTMLElement | null = null;
function openPicture(event: Event) {
  const picture = (event.target as Element).closest<HTMLImageElement>("img[data-picture]");
  if (!picture) return false;
  event.preventDefault();
  const all = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLImageElement>("img[data-picture]")];
  peekTrigger = picture;
  peek.value = {
    items: all.map((img) => ({ src: img.src, title: img.alt || img.dataset.picture!.split(/[\\/]/).pop()!, source: img.dataset.picture })),
    index: Math.max(0, all.indexOf(picture)),
  };
  return true;
}
// ImagePeek's step is ±1 (arrows, Previous/Next); it wraps like the
// composer's picture viewer. pick is an index (thumbnails).
function stepPicture(by: number) {
  if (!peek.value) return;
  const count = peek.value.items.length;
  peek.value.index = (peek.value.index + by + count) % count;
}
function closePicture() {
  peek.value = null;
  peekTrigger?.focus();
  peekTrigger = null;
}
function openPath(event: Event) {
  if (openPicture(event)) return;
  // Web links open in Orvane's Browser (the system browser only when the
  // workspace has no Browser app), not straight in the system browser.
  const web = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (web && /^https?:/i.test(web.getAttribute("href") || "")) {
    event.preventDefault();
    const url = web.href;
    window.dispatchEvent(
      new CustomEvent("orvane:open-link", {
        detail: { external: true, link: { kind: "page", target: url, label: url } },
      }),
    );
    return;
  }
  const element = (event.target as Element).closest<HTMLElement>("[data-path]");
  if (!element) return;
  event.preventDefault();
  const target = element.dataset.path!;
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: {
        link: {
          kind: element.dataset.dir === "true" ? "folder" : "file",
          target,
          label: target.split("\\").pop() || target,
        },
      },
    }),
  );
}
function openPathKey(event: KeyboardEvent) {
  if (event.key === "Enter") openPath(event);
  else if (event.key === " ") openPicture(event);
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const markdown = new Marked({
  gfm: true,
  renderer: {
    // Transcripts are content, not app markup. Raw HTML stays visible as text.
    html: ({ text }) => escape(text),
    // A local picture (![caption](C:\path\shot.png), absolute or relative to
    // the session folder) shows inline. Web images stay a text label: replies
    // never load remote content.
    image: ({ href, text, raw }) => {
      // Markdown unescapes "\." and the like, which breaks Windows paths
      // (…\orvane\.orvane\…): take the destination as written.
      const written = /\]\(\s*<?(.*?)>?(?:\s+"[^"]*")?\s*\)$/s.exec(raw)?.[1];
      const path = localPath(written || href || "");
      if (!path || !isReplyPicture(path))
        return `<span class="md-image">Image: ${escape(text)}</span>`;
      return `<span class="md-figure"><img class="md-picture" src="${escape(replyPictureUrl(path))}" alt="${escape(text)}" data-picture="${escape(path)}" loading="lazy">${text ? `<span class="md-caption">${escape(text)}</span>` : ""}</span>`;
    },
  },
});
const html = computed(() => {
  void version.value;
  const fragment = DOMPurify.sanitize(
    markdown.parse(props.text, { async: false }),
    {
      ALLOWED_TAGS: [
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "li",
        "pre",
        "code",
        "blockquote",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "em",
        "strong",
        "del",
        "br",
        "hr",
        "a",
        "input",
        "span",
        "img",
      ],
      ALLOWED_ATTR: [
        "href",
        "title",
        "class",
        "align",
        "start",
        "type",
        "checked",
        "disabled",
        "src",
        "alt",
        "loading",
      ],
      RETURN_DOM_FRAGMENT: true,
    },
  );
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    if (!/^(https?:|mailto:|#)/i.test(href)) {
      link.removeAttribute("href");
      const path = localPath(href);
      if (path) markPath(link, path);
    } else if (!href.startsWith("#")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }
  for (const code of fragment.querySelectorAll(":not(pre) > code")) {
    if (code.closest("a")) continue;
    const path = codeCandidate(code.textContent || "");
    if (path) markPath(code, path);
  }
  // Only pictures this component made, from Orvane's own picture route.
  for (const img of fragment.querySelectorAll("img")) {
    const path = img.dataset.picture;
    if (!path || img.getAttribute("src") !== replyPictureUrl(path)) {
      img.replaceWith(Object.assign(document.createElement("span"), {
        className: "md-image", textContent: `Image: ${img.getAttribute("alt") || ""}`,
      }));
      continue;
    }
    img.setAttribute("role", "button");
    img.setAttribute("tabindex", "0");
    img.setAttribute("title", "Open full window");
  }
  for (const input of fragment.querySelectorAll("input")) {
    input.type = "checkbox";
    input.disabled = true;
  }
  for (const table of fragment.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "md-table";
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Message table");
    scroll.tabIndex = 0;
    table.replaceWith(scroll);
    scroll.append(table);
  }
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
});
</script>
<template>
  <div
    v-bind="$attrs"
    class="chat-markdown"
    @click="openPath"
    @keydown="openPathKey"
    v-html="html"
  ></div>
  <ImagePeek v-if="peek" :items="peek.items" :index="peek.index" :thumbnails="peek.items.length > 1"
    @close="closePicture" @step="stepPicture" @pick="peek.index = $event" />
</template>
<style scoped>
.chat-markdown {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  line-height: 1.65;
}
.chat-markdown :deep(> :first-child) {
  margin-top: 0;
}
.chat-markdown :deep(> :last-child) {
  margin-bottom: 0;
}
.chat-markdown :deep(p) {
  margin: 0 0 12px;
  max-width: 75ch;
}
.chat-markdown :deep(:is(h1, h2, h3, h4, h5, h6)) {
  font-weight: 500;
  line-height: 1.4;
  margin: 20px 0 10px;
  color: #3d5362;
}
.chat-markdown :deep(h1) {
  font-size: 21px;
}
.chat-markdown :deep(h2) {
  font-size: 18px;
}
.chat-markdown :deep(h3) {
  font-size: 16px;
}
.chat-markdown :deep(:is(h4, h5, h6)) {
  font-size: 14px;
}
.chat-markdown :deep(:is(ul, ol)) {
  padding-left: 24px;
  margin: 8px 0 14px;
}
.chat-markdown :deep(li) {
  margin: 5px 0;
}
.chat-markdown :deep(li > p) {
  margin-bottom: 5px;
}
.chat-markdown :deep(li > input) {
  margin-right: 7px;
  vertical-align: middle;
}
.chat-markdown :deep(li:has(> input[type="checkbox"])) {
  list-style: none;
}
.chat-markdown :deep(strong) {
  font-weight: 600;
}
.chat-markdown :deep(a[href]) {
  color: #385d76;
  text-decoration: underline;
  text-underline-offset: 3px;
}
/* Files and folders the reply names: open them in the File Explorer. */
.chat-markdown :deep(.md-path) {
  color: #385d76;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: #9fb6c3;
  text-underline-offset: 3px;
}
.chat-markdown :deep(.md-path:hover) {
  color: #274a61;
  text-decoration-color: currentColor;
}
.chat-markdown :deep(code.md-path) {
  text-decoration: none;
  box-shadow: inset 0 -1px #9fb6c3;
}
.chat-markdown :deep(code.md-path:hover) {
  background: #dde7ed;
}
.chat-markdown :deep(.md-path:focus-visible),
.chat-markdown :deep(a:focus-visible) {
  outline: 1px solid #7a96a6;
  outline-offset: 2px;
}
.chat-markdown :deep(code) {
  font:
    12px/1.6 Consolas,
    monospace;
  background: #e7edf1;
  border-radius: 2px;
  padding: 2px 4px;
  white-space: break-spaces;
  overflow-wrap: anywhere;
}
.chat-markdown :deep(pre) {
  margin: 12px 0;
  padding: 12px 14px;
  border: 1px solid #d4dfe6;
  border-radius: 3px;
  background: #edf1f3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-markdown :deep(pre > code) {
  padding: 0;
  background: none;
  border-radius: 0;
}
.chat-markdown :deep(blockquote) {
  margin: 14px 0;
  padding: 2px 0 2px 14px;
  border-left: 1px solid #9fb4c2;
  color: #526976;
}
.chat-markdown :deep(blockquote p:last-child) {
  margin: 0;
}
.chat-markdown :deep(hr) {
  border: 0;
  border-top: 1px solid #d6e0e6;
  margin: 18px 0;
}
.chat-markdown :deep(.md-table) {
  max-width: 100%;
  overflow-x: auto;
  margin: 14px 0;
  scrollbar-gutter: stable;
}
.chat-markdown :deep(.md-table:focus-visible) {
  outline: 1px solid #7a96a6;
  outline-offset: 2px;
}
.chat-markdown :deep(table) {
  border-collapse: collapse;
  min-width: 100%;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.chat-markdown :deep(:is(th, td)) {
  text-align: left;
  vertical-align: top;
  padding: 9px 12px;
  min-width: 85px;
  overflow-wrap: anywhere;
  border-bottom: 1px solid #d6e0e6;
}
.chat-markdown :deep(th) {
  font-weight: 500;
  background: #e7eef2;
  color: #3d5362;
}
.chat-markdown :deep(td) {
  background: #f7f9fa;
}
.chat-markdown :deep([align="right"]) {
  text-align: right;
}
.chat-markdown :deep([align="center"]) {
  text-align: center;
}
.chat-markdown :deep(.md-figure) {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  max-width: 100%;
  margin: 4px 0;
  vertical-align: top;
}
.chat-markdown :deep(.md-picture) {
  display: block;
  max-width: 100%;
  max-height: 420px;
  object-fit: contain;
  border: 1px solid #dde4e8;
  border-radius: 8px;
  background: #fff;
  cursor: zoom-in;
}
.chat-markdown :deep(.md-picture:focus-visible) {
  outline: 2px solid #7b97a7;
  outline-offset: 2px;
}
.chat-markdown :deep(.md-caption) {
  color: #526976;
  font-size: 11.5px;
  line-height: 1.4;
}
.chat-markdown :deep(.md-image) {
  color: #526976;
  font-size: 12px;
}
</style>
