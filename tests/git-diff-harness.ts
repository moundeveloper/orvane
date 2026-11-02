import { createApp, h, nextTick, ref } from "vue";
import { EditorView } from "@codemirror/view";
import GitDiff from "../src/components/GitDiff.vue";
import { patchFixture } from "./large-lists-harness";
import "../src/git.css";

export function mountGitDiffFixture(wide = false) {
  const lines = patchFixture().split("\n");
  if (wide) lines[4] = "+WIDE_START " + "wide ".repeat(4000) + " WIDE_END";
  const patch = ref(lines.join("\n"));
  const root = document.createElement("div");
  root.id = "git-diff-fixture";
  root.className = "git-viewer";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;";
  document.body.appendChild(root);
  const app = createApp({ render: () => h(GitDiff, { patch: patch.value }) });
  app.mount(root);
  const view = () => EditorView.findFromDOM(root.querySelector(".cm-editor")!)!;
  return {
    get text() {
      return patch.value;
    },
    get displayed() {
      return view().state.doc.toString();
    },
    get selection() {
      const selection = view().state.selection.main;
      return { from: selection.from, to: selection.to };
    },
    async replace(text: string) {
      patch.value = text;
      await nextTick();
    },
    resize() {
      root.style.width = "900px";
      root.style.height = "550px";
      root.style.transform = "scale(.6)";
      root.style.transformOrigin = "top left";
      view().requestMeasure();
    },
    hide(hidden: boolean) {
      root.style.display = hidden ? "none" : "flex";
      view().requestMeasure();
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}
