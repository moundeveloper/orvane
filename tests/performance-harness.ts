import { createApp, h, reactive } from "vue";
import Cabinet from "../src/components/NetSuiteFileCabinet.vue";
import NetSuite from "../src/components/NetSuiteView.vue";
import type { Block } from "../src/model";

export function mountPerformanceFixture(kind: "cabinet" | "netsuite") {
  const calls: { op: string; args: any }[] = [];
  let writes = 0;
  const environment = "https://performance.app.netsuite.com";
  const layout = {
    tabs: ["a", "b", "c"],
    active: "a",
    left: ["a", "c"],
    right: ["b"],
    leftActive: "a",
    rightActive: "b",
    ratio: 50,
  };
  const state =
    kind === "cabinet"
      ? {
          filePanes: {
            [environment]: {
              active: "a",
              layout,
              panes: ["a", "b", "c"].map((id, i) => ({
                id,
                path: [{ id: i + 1, name: `Folder ${id}` }],
                file: { id: i + 10, name: `${id}.js` },
              })),
            },
          },
        }
      : {
          viewTabs: {
            tabs: [
              { id: "a", view: "scripts" },
              { id: "b", view: "files" },
              { id: "c", view: "query" },
            ],
            layout,
          },
        };
  let value = JSON.stringify(state);
  const block = reactive({
    id: "fixture",
    kind: "netsuite",
    get value() {
      return value;
    },
    set value(next: string) {
      writes++;
      value = next;
    },
  }) as unknown as Block;
  const request = async (op: string, args: any = {}) => {
    calls.push({ op, args });
    if (op === "folders") return { rows: [] };
    if (op === "folder") return { folders: [], files: [] };
    if (op === "file")
      return {
        id: args.id,
        name: `${String.fromCharCode(97 + args.id - 10)}.js`,
        content: "",
        base64: "",
      };
    return { rows: [] };
  };
  (window as any).orvaneDesktop = {
    netsuite: {
      tabs: async () => [
        { id: environment, label: "Fixture", status: "ready", count: 1 },
      ],
      run: (_id: string, op: string, args: any) => request(op, args),
    },
  };
  const root = document.createElement("div");
  root.id = "performance-fixture";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;";
  document.body.appendChild(root);
  const app = createApp({
    render: () =>
      kind === "cabinet"
        ? h(Cabinet, { block, environment, request })
        : h(NetSuite, { block }),
  });
  app.mount(root);
  return {
    calls,
    get writes() {
      return writes;
    },
    get state() {
      return JSON.parse(value);
    },
    resetWrites() {
      writes = 0;
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

export async function exerciseNotesViews() {
  const { createPinia, disposePinia } = await import("pinia");
  const { createOwnedWorkspaceStore } =
    await import("../src/components/notes/stores/workspace");
  const pinia = createPinia();
  const a = createOwnedWorkspaceStore("same-tab", pinia);
  const b = createOwnedWorkspaceStore("same-tab", pinia);
  try {
    await Promise.all([a.store.load(), b.store.load()]);
    await Promise.all([a.store.openPage("shared"), b.store.openPage("shared")]);
    a.store.snapshot();
    b.store.snapshot();
    await a.store.updateBlock("body", { html: "Edited" });
    await b.store.refreshBlocks("shared");
    const synchronized = b.store.blocks[0]?.html;
    const historiesIndependent =
      a.store.undoStack !== b.store.undoStack &&
      b.store.undoStack[0]?.[0]?.html === "Initial";
    await a.store.undo();
    const undone = a.store.blocks[0]?.html;
    await a.store.redo();
    const redone = a.store.blocks[0]?.html;
    a.dispose();
    const reopened = createOwnedWorkspaceStore("same-tab", pinia);
    try {
      await reopened.store.load();
      await reopened.store.openPage("shared");
      const reopenedText = reopened.store.blocks[0]?.html;
      const otherViewStillOpen = b.store.currentPageId;
      await reopened.store.deletePagePermanently("shared");
      await b.store.refreshPages();
      return {
        synchronized,
        historiesIndependent,
        undone,
        redone,
        reopened: reopenedText,
        otherViewStillOpen,
        deletedInOtherView: b.store.currentPageId === null && b.store.blocks.length === 0,
      };
    } finally {
      reopened.dispose();
    }
  } finally {
    a.dispose();
    b.dispose();
    disposePinia(pinia);
  }
}
