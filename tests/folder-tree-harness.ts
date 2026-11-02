import { createApp, h, reactive } from "vue";
import Tree from "../src/components/FileFolderTree.vue";

export function mountTreeFixture() {
  const root = document.createElement("div");
  root.id = "tree-fixture";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;";
  document.body.appendChild(root);
  const state = reactive({
    folders: [
      { id: 1, name: "Parent", numfolderfiles: 7 },
      { id: 2, name: "Other" },
    ],
    children: {
      1: Array.from({ length: 500 }, (_, i) => ({
        id: 1000 + i,
        name: `Child ${String(i).padStart(4, "0")}`,
      })),
      1400: [{ id: 9999, name: "Leaf" }],
    } as Record<number, Record<string, any>[]>,
    expanded: [1],
    loading: [] as number[],
    filter: "",
    selected: 9999,
  });
  const navigations: { id: number; name: string }[][] = [];
  const app = createApp({
    render: () =>
      h(
        "aside",
        {
          class: "fc-sidebar",
          style: "width:200px;height:700px;overflow:auto;padding:12px 10px;",
        },
        [
          h("div", { style: "height:180px" }, "Actions and folder information"),
          h("input", {
            "aria-label": "Filter fixture",
            value: state.filter,
            onInput: (event: Event) => {
              state.filter = (event.target as HTMLInputElement).value;
            },
          }),
          h(Tree, {
            ...state,
            path: [],
            onToggle: (row) => {
              const id = Number(row.id);
              state.expanded = state.expanded.includes(id)
                ? state.expanded.filter((value) => value !== id)
                : [...state.expanded, id];
            },
            onNavigate: (path) => navigations.push(path),
          }),
          h("button", { id: "tree-footer" }, "Bookmarks"),
        ],
      ),
  });
  app.mount(root);
  return {
    state,
    navigations,
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}
