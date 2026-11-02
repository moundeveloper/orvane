import { createApp, h, reactive } from "vue";
import { createPinia, disposePinia } from "pinia";
import Notes from "../src/components/notes/NotesView.vue";
import { makeBlock } from "../src/model";

export function mountNotesLoadingFixture() {
  const root = document.createElement("div");
  root.id = "notes-loading-fixture";
  root.style.cssText = "position:fixed;inset:0;z-index:99999;background:white";
  document.body.appendChild(root);
  const block = reactive(makeBlock("notes"));
  block.value = JSON.stringify({ active: "a", tabs: ["a", "b", "empty"] });
  const pinia = createPinia();
  const app = createApp({ render: () => h(Notes, { block, editing: false }) });
  app.use(pinia);
  app.mount(root);
  return {
    unmount() {
      app.unmount();
      disposePinia(pinia);
      root.remove();
    },
  };
}
