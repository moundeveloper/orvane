import { createApp, h, nextTick, ref } from "vue";
import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeEditor from "../src/components/CodeEditor.vue";
import SuiteQLEditor from "../src/components/SuiteQLEditor.vue";

export function mountEditorFixture(
  kind: "code" | "sql",
  size = 500_000,
  normalize = false,
) {
  const initial =
    kind === "code"
      ? `//${"x".repeat(size)}\nconst value = 1;`
      : `/*${"x".repeat(size)}*/\nSELECT 1`;
  const model = ref(initial);
  const docId = ref("a");
  let calls = 0,
    characters = 0,
    updates = 0;
  const original = Text.prototype.toString;
  Text.prototype.toString = function () {
    if (this.length >= size) {
      calls++;
      characters += this.length;
    }
    return original.call(this);
  };
  const root = document.createElement("div");
  root.id = "editor-fixture";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;";
  document.body.appendChild(root);
  const app = createApp({
    render: () =>
      h(kind === "code" ? CodeEditor : SuiteQLEditor, {
        modelValue: model.value,
        docId: docId.value,
        "onUpdate:modelValue": (value: string) => {
          updates++;
          model.value = normalize ? value.toUpperCase() : value;
        },
      }),
  });
  app.mount(root);
  const view = () => EditorView.findFromDOM(root.querySelector(".cm-editor")!)!;
  return {
    get stats() {
      return { calls, characters, updates };
    },
    get text() {
      return model.value;
    },
    get docText() {
      return view().state.doc.sliceString(0);
    },
    reset() {
      calls = 0;
      characters = 0;
      updates = 0;
    },
    async edit(count = 10) {
      for (let i = 0; i < count; i++) {
        const editor = view();
        editor.dispatch({
          changes: { from: editor.state.doc.length, insert: "z" },
          userEvent: "input.type",
        });
        await nextTick();
      }
    },
    async replace(value: string) {
      model.value = value;
      await nextTick();
    },
    async switchDoc(id: string, value: string) {
      docId.value = id;
      model.value = value;
      await nextTick();
    },
    unmount() {
      app.unmount();
      root.remove();
      Text.prototype.toString = original;
    },
  };
}
