<script setup lang="ts">
// Read-only, syntax-highlighted code for File Explorer peek.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorView, lineNumbers, highlightActiveLine, highlightSpecialChars } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { foldGutter, HighlightStyle, syntaxHighlighting, bracketMatching } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { sql } from "@codemirror/lang-sql";
import { tags } from "@lezer/highlight";
import type { CodeLanguage } from "./explorer";

const props = defineProps<{ text: string; language: CodeLanguage; label: string }>();
const host = ref<HTMLDivElement>();
let view: EditorView | undefined;
const theme = EditorView.theme({
  "&": { height: "100%", color: "#455968", backgroundColor: "#fbfcfd", fontSize: "12px" },
  ".cm-scroller": { fontFamily: 'Consolas, "Cascadia Code", monospace', lineHeight: "1.7", overflow: "auto" },
  ".cm-content": { padding: "12px 0" },
  ".cm-line": { padding: "0 14px" },
  ".cm-gutters": { backgroundColor: "#f1f5f7", color: "#93a3ad", border: "none" },
  ".cm-activeLine": { backgroundColor: "#e7f0f67a" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground,&.cm-focused .cm-selectionBackground": { backgroundColor: "#d4e3ec" },
  ".cm-matchingBracket": { backgroundColor: "#d7e5ed", outline: "none" },
  ".cm-panels": { background: "#eaf1f5", color: "#455968" },
  ".cm-searchMatch": { backgroundColor: "#f3e3b5" },
});
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#756b93" },
  { tag: [tags.string, tags.attributeValue], color: "#638172" },
  { tag: [tags.number, tags.bool], color: "#987853" },
  { tag: [tags.function(tags.variableName), tags.tagName], color: "#527d97" },
  { tag: [tags.comment, tags.meta], color: "#88969e", fontStyle: "italic" },
  { tag: [tags.attributeName, tags.propertyName], color: "#7a7597" },
  { tag: tags.operator, color: "#667c8c" },
]);
// Very large files skip parsing so opening them stays instant.
function language() {
  if (props.text.length > 400_000) return [];
  switch (props.language) {
    case "javascript":
      return javascript();
    case "typescript":
      return javascript({ typescript: true });
    case "jsx":
      return javascript({ typescript: true, jsx: true });
    case "html":
      return html();
    case "xml":
      return html({ matchClosingTags: false, autoCloseTags: false, selfClosingTags: true });
    case "sql":
      return sql();
    default:
      return [];
  }
}
function mount() {
  view?.destroy();
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.text,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightSpecialChars(),
        highlightActiveLine(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of(searchKeymap),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": props.label, tabindex: "0" }),
        theme,
        syntaxHighlighting(highlight),
        language(),
      ],
    }),
  });
}
onMounted(mount);
watch(() => [props.text, props.language], mount);
onBeforeUnmount(() => view?.destroy());
</script>
<template>
  <div ref="host" class="peek-code"></div>
</template>
<style scoped>
.peek-code {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
