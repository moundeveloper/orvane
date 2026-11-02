import { createApp, h, nextTick, ref } from "vue";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView, repositionTooltips } from "@codemirror/view";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import { undo, redo } from "@codemirror/commands";
import SuiteQLEditor from "../src/components/SuiteQLEditor.vue";

export function mountTooltipFixture(initial = "SELECT * FROM c") {
  const root = document.createElement("div");
  root.id = "tooltip-fixture";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;";
  document.body.appendChild(root);
  const text = ref(initial),
    id = ref("a"),
    readonly = ref(false);
  const schema = ref<Record<string, string[]>>({
    customer: ["id", "entityid"],
    currency: ["id", "name"],
  });
  const errors: string[] = [];
  const reportErrors = EditorView.exceptionSink.of((error) =>
    errors.push(String(error)),
  );
  const app = createApp({
    render: () =>
      h(SuiteQLEditor, {
        modelValue: text.value,
        docId: id.value,
        readonly: readonly.value,
        schema: schema.value,
        defaultTable: "customer",
        "onUpdate:modelValue": (value: string) => {
          text.value = value;
        },
      }),
  });
  app.mount(root);
  const view = () => EditorView.findFromDOM(root.querySelector(".cm-editor")!)!;
  view().dispatch({
    effects: StateEffect.appendConfig.of(reportErrors),
  });
  let resolve: ((value: any) => void) | undefined;
  let requested = 0;
  const delayed = new Compartment();
  const delayedConfig = autocompletion({
    activateOnTyping: false,
    override: [
      () => {
        requested++;
        return new Promise<any>((done) => {
          resolve = done;
        });
      },
    ],
  });
  return {
    errors,
    get text() {
      return text.value;
    },
    get selection() {
      return view().state.selection.main.head;
    },
    get scroll() {
      return view().scrollDOM.scrollTop;
    },
    get scrollLeft() {
      return view().scrollDOM.scrollLeft;
    },
    get completion() {
      return completionStatus(view().state);
    },
    get requested() {
      return requested;
    },
    open() {
      const editor = view();
      editor.focus();
      editor.dispatch({
        selection: { anchor: editor.state.doc.length },
        scrollIntoView: true,
      });
      return startCompletion(editor);
    },
    queueTooltipMeasure() {
      repositionTooltips(view());
    },
    async switchDoc(nextId: string, value: string) {
      id.value = nextId;
      text.value = value;
      await nextTick();
      // Each newly created state also reports caught CodeMirror measure errors.
      view().dispatch({
        effects: StateEffect.appendConfig.of(reportErrors),
      });
    },
    async replace(value: string) {
      text.value = value;
      await nextTick();
    },
    async edit(value: string) {
      const editor = view();
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: value },
        selection: { anchor: editor.state.doc.length + value.length },
        userEvent: "input.type",
      });
      await nextTick();
    },
    async accept() {
      const accepted = acceptCompletion(view());
      await nextTick();
      return accepted;
    },
    undo() {
      return undo(view());
    },
    redo() {
      return redo(view());
    },
    close() {
      closeCompletion(view());
    },
    async settings(locked: boolean) {
      readonly.value = locked;
      schema.value = { employee: ["id", "email"] };
      await nextTick();
    },
    delayedCompletion() {
      if (!delayed.get(view().state)) {
        view().dispatch({
          effects: StateEffect.appendConfig.of(delayed.of(delayedConfig)),
        });
      }
      startCompletion(view());
    },
    resolveCompletion() {
      resolve?.({ from: 0, options: [{ label: "Late completion" }] });
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}
