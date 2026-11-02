import { createApp, h, reactive, ref } from "vue";
import Cabinet from "../src/components/NetSuiteFileCabinet.vue";
import Git from "../src/components/GitViewer.vue";
import type { Block } from "../src/model";

export function patchFixture(count = 10_000) {
  return [
    "diff --git a/fixture.txt b/fixture.txt",
    "--- a/fixture.txt",
    "+++ b/fixture.txt",
    "@@ -1,1 +1,9999 @@",
    ...Array.from(
      { length: count },
      (_, i) =>
        `${i % 3 === 0 ? "+" : i % 3 === 1 ? "-" : " "}fixture row ${i.toString().padStart(5, "0")}${i === count - 1 ? " FINAL_MATCH" : ""}`,
    ),
  ].join("\n");
}
export function mountLargeListFixture(
  kind: "git" | "cabinet" | "cabinet-files",
  count = kind === "git" ? 10_000 : 5000,
  patchOverride?: string,
) {
  const root = document.createElement("div");
  root.id = "large-list-fixture";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;display:flex;flex-direction:column;";
  document.body.appendChild(root);
  const block = reactive({
    id: "large",
    kind: kind === "git" ? "git" : "netsuite",
    value: "{}",
    gitWorkspaceId: "fixture",
  }) as unknown as Block;
  if (kind === "cabinet-files")
    block.value = JSON.stringify({
      filePanes: {
        fixture: {
          active: "main",
          panes: [{ id: "main", path: [{ id: 1, name: "Large folder" }] }],
        },
      },
    });
  const environment = ref("fixture");
  const original = window.fetch;
  const text = patchOverride ?? patchFixture(count);
  if (kind === "git")
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith("/__orvane/git/")) return original(input, init);
      const operation = url.split("/").at(-1);
      const result =
        operation === "git_workspace_list"
          ? [{ id: "fixture", name: "Fixture", path: "C:\\fixture" }]
          : operation === "git_history"
            ? {
                commits: [
                  {
                    hash: "a".repeat(40),
                    parents: [],
                    author: "Fixture",
                    date: "2026-11-02",
                    subject: "Large fixture diff",
                  },
                ],
                refs: [],
                head: "a".repeat(40),
                branch: "main",
                hasMore: false,
              }
            : operation === "git_status"
              ? { files: [] }
              : operation === "git_commit"
                ? {
                    hash: "a".repeat(40),
                    parents: [],
                    message: "Large fixture diff",
                    files: [{ path: "fixture.txt", status: "M" }],
                  }
                : { patch: text, truncated: false };
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    };
  const rows = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `${kind === "cabinet-files" ? "File" : "Folder"} ${i.toString().padStart(5, "0")}${kind === "cabinet-files" ? ".txt" : ""}`,
    numfolderfiles: 0,
    foldersize: 0,
    filesize: 600000,
    filetype: "PLAINTEXT",
    folder: 1,
  }));
  const calls: { op: string; args: Record<string, any> }[] = [];
  const request = async (op: string, args: Record<string, any> = {}) => {
    calls.push({ op, args });
    if (op === "rename-item") {
      const row = rows.find((row) => row.id === args.id);
      if (row) row.name = args.name;
      return {};
    }
    if (op === "file")
      return {
        id: args.id,
        name: rows.find((row) => row.id === args.id)?.name,
        content: "Fixture content",
        base64: btoa("Fixture content"),
      };
    if (op === "folder") return { folders: [], files: rows };
    return {
      rows: kind === "cabinet-files" ? [{ id: 1, name: "Large folder" }] : rows,
    };
  };
  const app = createApp({
    render: () =>
      kind === "git"
        ? h(Git, { block, editing: false })
        : h(Cabinet, {
            block,
            environment: environment.value,
            request,
          }),
  });
  app.mount(root);
  return {
    text,
    calls,
    changeEnvironment() {
      environment.value = "other";
    },
    resize(width: number, height: number, zoom = 1) {
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
      root.style.transform = `scale(${zoom})`;
      root.style.transformOrigin = "top left";
    },
    unmount() {
      app.unmount();
      root.remove();
      window.fetch = original;
    },
  };
}
