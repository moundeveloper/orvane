<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import {
  syntaxTree,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { linter, lintGutter } from "@codemirror/lint";
import Icon from "./Icon.vue";
const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: "javascript" | "html";
    label?: string;
    expanded?: boolean;
  }>(),
  { language: "javascript", label: "Code editor", expanded: false },
);
const emit = defineEmits<{
  "update:modelValue": [value: string];
  expand: [];
}>();
const host = ref<HTMLDivElement>(),
  cursor = ref("1:1");
let view: EditorView | undefined;
const languageConfig = new Compartment();
let escapeTab = false;
function editorKeys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    escapeTab = true;
    return;
  }
  if (event.key === "Tab" && escapeTab) {
    event.stopPropagation();
    escapeTab = false;
    return;
  }
  escapeTab = false;
}
const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "#455968",
    backgroundColor: "#f3f7f9",
    fontSize: "11px",
  },
  ".cm-scroller": {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    lineHeight: "1.8",
    overflow: "auto",
  },
  ".cm-content": { padding: "12px 0", caretColor: "#547589" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": {
    backgroundColor: "#edf3f6",
    color: "#7b909e",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "#e2ecf2", color: "#476779" },
  ".cm-activeLine": { backgroundColor: "#e7f0f67a" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground,&.cm-focused .cm-selectionBackground": {
    backgroundColor: "#d4e3ec",
  },
  ".cm-cursor": { borderLeftColor: "#547589" },
  ".cm-matchingBracket": { backgroundColor: "#d7e5ed", outline: "none" },
  ".cm-panels": { background: "#eaf1f5", color: "#455968" },
  ".cm-tooltip": {
    background: "#f7f9fa",
    border: "1px solid #d8e3ea",
    borderRadius: "5px",
    boxShadow: "0 6px 18px -8px #43576440",
  },
  ".cm-tooltip-autocomplete>ul>li[aria-selected]": {
    background: "#dce9f1",
    color: "#455968",
  },
});
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#756b93" },
  { tag: [tags.string, tags.attributeValue], color: "#638172" },
  { tag: [tags.number, tags.bool], color: "#987853" },
  { tag: [tags.function(tags.variableName), tags.tagName], color: "#527d97" },
  { tag: tags.comment, color: "#88969e", fontStyle: "italic" },
  { tag: tags.attributeName, color: "#7a7597" },
  { tag: tags.operator, color: "#667c8c" },
]);
// Very large documents skip parsing and lint, which otherwise block typing.
const LARGE = 300_000;
onMounted(() => {
  if (!host.value) return;
  const large = props.modelValue.length > LARGE;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        theme,
        syntaxHighlighting(highlight),
        languageConfig.of(
          large ? [] : props.language === "html" ? html() : javascript(),
        ),
        keymap.of([indentWithTab]),
        large ? [] : lintGutter(),
        large ? [] : linter((v) => {
          const diagnostics: {
            from: number;
            to: number;
            severity: "error";
            message: string;
          }[] = [];
          syntaxTree(v.state).iterate({
            enter(node) {
              if (node.type.isError)
                diagnostics.push({
                  from: node.from,
                  to: node.to,
                  severity: "error",
                  message: "Check the syntax here.",
                });
            },
          });
          return diagnostics;
        }),
        EditorView.contentAttributes.of({
          "aria-label": props.label,
          "aria-multiline": "true",
          role: "textbox",
          spellcheck: "false",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged)
            emit("update:modelValue", update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const pos = update.state.selection.main.head,
              line = update.state.doc.lineAt(pos);
            cursor.value = `${line.number}:${pos - line.from + 1}`;
          }
        }),
      ],
    }),
  });
});
watch(
  () => props.modelValue,
  (value) => {
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
  },
);
watch(
  () => props.language,
  (value) =>
    view?.dispatch({
      effects: languageConfig.reconfigure(
        value === "html" ? html() : javascript(),
      ),
    }),
);
onBeforeUnmount(() => view?.destroy());
</script>
<template>
  <div
    class="code-editor"
    :class="{ 'code-expanded': expanded }"
    @keydown.capture="editorKeys"
    @keydown.stop
  >
    <div class="code-editor-bar">
      <span>{{ language === "html" ? "index.html" : "action.js" }}</span
      ><button
        class="icon-button"
        :aria-label="expanded ? 'Close expanded editor' : 'Expand code editor'"
        @click="emit('expand')"
      >
        <Icon :name="expanded ? 'close' : 'resize'" :size="13" />
      </button>
    </div>
    <div ref="host" class="code-editor-host"></div>
    <div class="code-editor-status">
      <span>{{
        language === "html" ? "HTML · CSS · JavaScript" : "JavaScript"
      }}</span
      ><span>{{ cursor }} · Changes are live</span>
    </div>
  </div>
</template>
