<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { sql } from "@codemirror/lang-sql";
const props = defineProps<{
  modelValue: string;
  name: string;
  readonly?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [string]; save: [] }>();
const host = ref<HTMLDivElement>();
const access = new Compartment();
const accessFor = (readonly: boolean) => [
  EditorState.readOnly.of(readonly),
  EditorView.editable.of(!readonly),
];
// Large files skip syntax parsing and report edits in batches: emitting a
// multi-MB string per keystroke is what made typing lag.
const LARGE = 300_000;
const large = props.modelValue.length > LARGE;
let editor: EditorView | undefined,
  lastEmitted = props.modelValue,
  pending: ReturnType<typeof setTimeout> | undefined;
function emitNow() {
  clearTimeout(pending);
  pending = undefined;
  if (!editor) return;
  lastEmitted = editor.state.doc.toString();
  emit("update:modelValue", lastEmitted);
}
onMounted(() => {
  const name = props.name.toLowerCase();
  const language = large
    ? []
    : /\.(js|mjs|cjs|ts|json)$/.test(name)
    ? javascript({ typescript: name.endsWith(".ts") })
    : /\.(html|htm|xml|ftl)$/.test(name)
      ? html()
      : /\.sql$/.test(name)
        ? sql()
        : [];
  editor = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        language,
        access.of(accessFor(!!props.readonly)),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              if (pending) emitNow();
              emit("save");
              return true;
            },
          },
        ]),
        EditorView.contentAttributes.of({
          "aria-label": "File content",
          "aria-multiline": "true",
          role: "textbox",
          spellcheck: "false",
        }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          if (u.state.doc.length > LARGE) {
            clearTimeout(pending);
            pending = setTimeout(emitNow, 250);
          } else emitNow();
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            backgroundColor: "#eff4f6",
            color: "#344d5b",
            fontSize: "12px",
          },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "Consolas, monospace",
            lineHeight: "1.6",
          },
          ".cm-gutters": {
            backgroundColor: "#e8f0f3",
            border: "none",
            color: "#718894",
          },
          ".cm-content": { padding: "12px 0" },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    }),
  });
});
watch(
  () => props.modelValue,
  (value) => {
    if (value === lastEmitted) return;
    lastEmitted = value;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
  },
);
watch(
  () => props.readonly,
  (readonly) =>
    editor?.dispatch({ effects: access.reconfigure(accessFor(!!readonly)) }),
);
onBeforeUnmount(() => {
  if (pending) emitNow();
  editor?.destroy();
});
</script>
<template><div ref="host" class="file-editor" @keydown.stop /></template>
<style scoped>
.file-editor {
  height: calc(100% - 30px);
  min-height: 180px;
  overflow: hidden;
}
</style>
