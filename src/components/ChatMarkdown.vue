<script setup lang="ts">
import { computed } from "vue";
import { Marked } from "marked";
import DOMPurify from "dompurify";

const props = defineProps<{ text: string }>();
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
    image: ({ text }) => `<span class="md-image">Image: ${escape(text)}</span>`,
  },
});
const html = computed(() => {
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
      ],
      RETURN_DOM_FRAGMENT: true,
    },
  );
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    if (!/^(https?:|mailto:|#)/i.test(href)) link.removeAttribute("href");
    else if (!href.startsWith("#")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
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
<template><div class="chat-markdown" v-html="html"></div></template>
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
.chat-markdown :deep(.md-image) {
  color: #526976;
  font-size: 12px;
}
</style>
