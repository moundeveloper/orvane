<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { sql } from "@codemirror/lang-sql";
import { closeCompletion } from "@codemirror/autocomplete";
const props = defineProps<{
  modelValue: string;
  docId?: string;
  readonly?: boolean;
  schema?: Record<string, string[]>;
  defaultTable?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [string]; run: [] }>();
const host = ref<HTMLDivElement>();
const language = new Compartment(),
  access = new Compartment();
// One state per query file keeps undo history, selection and scroll separate,
// like Magic NetSuite's one-editor-per-tab layout.
const states = new Map<
  string,
  { state: EditorState; scroll: ReturnType<EditorView["scrollSnapshot"]> }
>();
let forgottenDoc: string | undefined;
const languageFor = (schema?: Record<string, string[]>) =>
  sql({
    schema: schema || {},
    defaultTable:
      props.defaultTable && schema?.[props.defaultTable]
        ? props.defaultTable
        : undefined,
    upperCaseKeywords: true,
  });
const accessFor = (readonly: boolean) => [
  EditorState.readOnly.of(readonly),
  EditorView.editable.of(!readonly),
];
let editor: EditorView | undefined;
let lastEmitted = props.modelValue;
function createState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      language.of(languageFor(props.schema)),
      access.of(accessFor(!!props.readonly)),
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            emit("run");
            return true;
          },
        },
      ]),
      EditorView.contentAttributes.of({
        "aria-label": "SuiteQL editor",
        "aria-multiline": "true",
        role: "textbox",
        spellcheck: "false",
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          lastEmitted = update.state.doc.toString();
          emit("update:modelValue", lastEmitted);
        }
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          backgroundColor: "#f0f5f7",
          color: "#344d5b",
          fontSize: "12px",
        },
        ".cm-scroller": {
          fontFamily: "Consolas, monospace",
          lineHeight: "1.6",
          overflow: "auto",
        },
        ".cm-content": { padding: "12px 0" },
        ".cm-gutters": {
          backgroundColor: "#eaf1f4",
          border: "none",
          color: "#718894",
        },
        "&.cm-focused": { outline: "none" },
      }),
    ],
  });
}
onMounted(() => {
  editor = new EditorView({
    parent: host.value,
    state: createState(props.modelValue),
  });
});
watch(
  () => [props.docId, props.modelValue] as const,
  ([id, value], [previous]) => {
    if (!editor) return;
    // Process identity and text together: a text watcher must not replace the
    // outgoing document before its state (including undo) has been saved.
    if (id === previous) {
      // Parent echoes already have a current document snapshot.
      if (value === lastEmitted) return;
      lastEmitted = value;
      if (editor.state.doc.toString() !== value)
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: value },
          annotations: Transaction.addToHistory.of(false),
        });
      return;
    }
    // A document anchor survives layout remeasurement when restoring a state.
    const scroll = editor.scrollSnapshot();
    // Completion belongs to the outgoing view, not the saved document. Clear
    // its anchors before setState so queued tooltip measurements cannot read
    // an old position against the next (possibly empty) document.
    closeCompletion(editor);
    lastEmitted = value;
    if (previous !== undefined && previous !== forgottenDoc)
      states.set(previous, {
        state: editor.state,
        scroll,
      });
    forgottenDoc = undefined;
    const saved = id === undefined ? undefined : states.get(id);
    if (id !== undefined) states.delete(id);
    if (saved && saved.state.doc.toString() === value) {
      editor.setState(saved.state);
      // Settings may have changed while this file was in the background.
      editor.dispatch({
        effects: [
          language.reconfigure(languageFor(props.schema)),
          access.reconfigure(accessFor(!!props.readonly)),
          saved.scroll,
        ],
      });
    } else editor.setState(createState(value));
  },
);
watch(
  () => [props.schema, props.defaultTable] as const,
  ([schema]) =>
    editor?.dispatch({ effects: language.reconfigure(languageFor(schema)) }),
);
watch(
  () => props.readonly,
  (readonly) =>
    editor?.dispatch({ effects: access.reconfigure(accessFor(!!readonly)) }),
);
onBeforeUnmount(() => {
  states.clear();
  editor?.destroy();
});
defineExpose({
  insert(text: string) {
    if (!editor) return;
    editor.dispatch(editor.state.replaceSelection(text));
    editor.focus();
  },
  // Undoable whole-document replacement, used by Format.
  replace(text: string) {
    if (!editor || editor.state.doc.toString() === text) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
    });
  },
  forget(id: string) {
    states.delete(id);
    // A pending docId watcher must not save the deleted active document back.
    if (id === props.docId) forgottenDoc = id;
  },
});
</script>
<template><div ref="host" class="suiteql-editor" @keydown.stop /></template>
<style scoped>
.suiteql-editor {
  height: var(--suiteql-editor-height, 35%);
  min-height: 100px;
  border-top: 1px solid #dce5e9;
  border-bottom: 1px solid #dce5e9;
  overflow: hidden;
}
</style>
