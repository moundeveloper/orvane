<script setup lang="ts">
// Side-by-side diff for File Cabinet history and Compare, ported from Magic
// NetSuite's DiffViewer/DiffComparator (CodeMirror MergeView). Left is always
// read-only; the right side is editable only when `editable` is set.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { MergeView } from "@codemirror/merge";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { sql } from "@codemirror/lang-sql";
const props = defineProps<{
  left: string;
  right: string;
  name: string;
  editable?: boolean;
}>();
const emit = defineEmits<{ "update:right": [string]; close: [] }>();
const host = ref<HTMLDivElement>();
let view: MergeView | undefined,
  lastRight = props.right;
function language(): Extension {
  const name = props.name.toLowerCase();
  if (props.left.length + props.right.length > 600_000) return [];
  if (/\.(js|mjs|cjs|ts|json)$/.test(name))
    return javascript({ typescript: name.endsWith(".ts") });
  if (/\.(html|htm|xml|ftl)$/.test(name)) return html();
  if (/\.sql$/.test(name)) return sql();
  return [];
}
const theme = EditorView.theme({
  "&": { backgroundColor: "#fff", color: "#344d5b", fontSize: "12px" },
  ".cm-scroller": { fontFamily: "Consolas, monospace", lineHeight: "1.6" },
  ".cm-gutters": {
    backgroundColor: "#fff",
    border: "none",
    color: "#a6b6c0",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-changedLine": { backgroundColor: "#e3efe6 !important" },
  ".cm-deletedChunk, &.cm-merge-a .cm-changedLine": {
    backgroundColor: "#f6e6e1 !important",
  },
  ".cm-changedText": { background: "#c6e0cd !important" },
  "&.cm-merge-a .cm-changedText": { background: "#efcfc5 !important" },
  ".cm-collapsedLines": {
    background: "#f2f6f8",
    color: "#8296a2",
    fontFamily: "Inter, sans-serif",
    fontSize: "11.5px",
  },
});
function sides(left: string, right: string) {
  const common = [basicSetup, language(), theme];
  return {
    a: {
      doc: left,
      extensions: [
        ...common,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": "Left side" }),
      ],
    },
    b: {
      doc: right,
      extensions: [
        ...common,
        EditorState.readOnly.of(!props.editable),
        EditorView.editable.of(!!props.editable),
        EditorView.contentAttributes.of({ "aria-label": "Right side" }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          lastRight = u.state.doc.toString();
          emit("update:right", lastRight);
        }),
      ],
    },
  };
}
function build() {
  view?.destroy();
  lastRight = props.right;
  view = new MergeView({
    ...sides(props.left, props.right),
    parent: host.value!,
    collapseUnchanged: { margin: 3, minSize: 4 },
    gutter: true,
  });
}
onMounted(build);
// A new left side (another version, Swap) rebuilds; typing on the right
// arrives back as the same text and is skipped.
watch(
  () => [props.left, props.right] as const,
  ([, right]) => {
    if (right === lastRight && view?.a.state.doc.toString() === props.left)
      return;
    build();
  },
);
onBeforeUnmount(() => view?.destroy());
</script>
<template
  ><div
    ref="host"
    class="fc-diff"
    @keydown.stop="$event.key === 'Escape' && emit('close')"
/></template>
<style scoped>
.fc-diff {
  flex: 1;
  min-height: 180px;
  overflow: auto;
  background: #fff;
}
.fc-diff :deep(.cm-mergeView) {
  min-height: 100%;
}
.fc-diff :deep(.cm-mergeViewEditor + .cm-mergeViewEditor) {
  border-left: 1px solid #e3eaee;
}
</style>
