import { createApp, h, reactive } from "vue";
import Hub from "../src/components/projects/ProjectsHub.vue";
import type { Block } from "../src/model";

export function mountProjectsWindowFixture() {
  const root = document.createElement("div");
  root.id = "projects-window-fixture";
  root.className = "app-content";
  root.style.cssText =
    "position:fixed;left:20px;top:20px;width:1200px;height:820px;z-index:99999;display:flex;transform-origin:0 0;background:#f7f9fa";
  const host = document.createElement("div");
  host.className = "block-projects";
  root.appendChild(host);
  document.body.appendChild(root);
  const block = reactive({
    id: "projects-window-test",
    kind: "projects",
    value: "C:\\fixture",
  }) as Block;
  const app = createApp({ render: () => h(Hub, { block, editing: false }) });
  app.mount(host);
  return {
    resize(width: number, height = 820) {
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
    },
    scale(value: number) {
      root.style.transform = `scale(${value})`;
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}
