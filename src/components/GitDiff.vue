<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";

const props = defineProps<{ patch: string }>();
const host = ref<HTMLElement>();
let view: EditorView | undefined;

function diffLines(view: EditorView): DecorationSet {
  const lines = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = view.state.doc.lineAt(position);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        const kind = line.text.startsWith("@@")
          ? "hunk"
          : line.text.startsWith("+") && !line.text.startsWith("+++")
            ? "added"
            : line.text.startsWith("-") && !line.text.startsWith("---")
              ? "removed"
              : "";
        if (kind) lines.push(Decoration.line({ class: kind }).range(line.from));
      }
      position = line.to + 1;
    }
  }
  return Decoration.set(lines, true);
}
const colors = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = diffLines(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = diffLines(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function state(patch: string) {
  return EditorState.create({
    doc: patch,
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({
        role: "textbox",
        "aria-label": "Git diff text",
        "aria-readonly": "true",
        tabindex: "0",
      }),
      drawSelection(),
      keymap.of([...searchKeymap, ...defaultKeymap]),
      search({ top: true }),
      colors,
      EditorView.theme({
        "&": {
          flex: "1",
          minHeight: "0",
          minWidth: "0",
          height: "100%",
          color: "inherit",
          backgroundColor: "#f9fbfc",
        },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": {
          font: "11px/1.7 ui-monospace, Consolas, monospace",
          padding: "0",
          overflow: "auto",
        },
        ".cm-content": { padding: "8px 0", minWidth: "100%" },
        ".cm-line": { padding: "0 12px" },
        ".cm-cursor, .cm-dropCursor": { display: "none" },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: "#d4e3ec",
        },
        "&.cm-focused .cm-scroller": {
          outline: "1px solid #bacbd5",
          outlineOffset: "-1px",
        },
        ".cm-panels": {
          backgroundColor: "#edf3f6",
          color: "inherit",
          borderColor: "#dce5e9",
        },
        ".cm-panel.cm-search": {
          fontFamily: "inherit",
          fontSize: "11px",
          lineHeight: "1.7",
          padding: "6px 10px",
        },
        ".cm-textfield": {
          font: "inherit",
          color: "inherit",
          backgroundColor: "#f7f9fa",
          border: "0",
          borderBottom: "1px solid #c4d4de",
          padding: "3px 6px",
        },
        ".cm-button": {
          font: "inherit",
          color: "inherit",
          background: "#e7eff3",
          border: "0",
          borderRadius: "3px",
          padding: "3px 6px",
        },
      }),
    ],
  });
}
onMounted(() => {
  view = new EditorView({ parent: host.value, state: state(props.patch) });
  // Keep the existing public scroll viewport and label for users and tests.
  view.scrollDOM.classList.add("git-patch");
  view.scrollDOM.setAttribute("aria-label", "Git diff");
});
watch(
  () => props.patch,
  (patch) => {
    if (!view) return;
    view.setState(state(patch));
    view.scrollDOM.scrollTop = 0;
    view.scrollDOM.scrollLeft = 0;
  },
);
onBeforeUnmount(() => view?.destroy());
</script>

<template><div ref="host" class="git-diff-view" /></template>

<style scoped>
.git-diff-view {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
</style>
