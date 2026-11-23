// Mounts the NetSuite File Cabinet (or Scripts app) against a small in-memory
// NetSuite, for the Magic NetSuite parity specs. The fake applies writes like
// NetSuite does: deleting a folder that still holds anything fails.
import { createApp, h, reactive } from "vue";
import Cabinet from "../src/components/NetSuiteFileCabinet.vue";
import Scripts from "../src/components/NetSuiteScripts.vue";
import type { Block } from "../src/model";

type Folder = {
  id: number;
  name: string;
  parent: number | null;
  foldertype: string;
};
type File = {
  id: number;
  name: string;
  folder: number;
  filetype: string;
  content: string;
  binary?: boolean;
};
export type FakeState = { folders: Folder[]; files: File[]; next: number };

function seed(): FakeState {
  return {
    next: 100,
    folders: [
      { id: 1, name: "SuiteScripts", parent: null, foldertype: "SUITESCRIPTS" },
      { id: 6, name: "SuiteBundles", parent: null, foldertype: "SUITEBUNDLES" },
      { id: 2, name: "CTK", parent: 1, foldertype: "DEFAULT" },
      { id: 3, name: "Old", parent: 2, foldertype: "DEFAULT" },
      { id: 4, name: "Deep", parent: 3, foldertype: "DEFAULT" },
      { id: 5, name: "Target", parent: 1, foldertype: "DEFAULT" },
    ],
    files: [
      {
        id: 10,
        name: "ctk_ue_invoice.js",
        folder: 2,
        filetype: "JAVASCRIPT",
        content: "const a = 1;\nconst b = 2;",
      },
      { id: 11, name: "a.js", folder: 3, filetype: "JAVASCRIPT", content: "alpha" },
      { id: 12, name: "b.txt", folder: 4, filetype: "PLAINTEXT", content: "beta" },
      {
        id: 13,
        name: "logo.png",
        folder: 4,
        filetype: "PNGIMAGE",
        content: "",
        binary: true,
      },
    ],
  };
}

function fakeNetSuite(state: FakeState) {
  const calls: { op: string; args: Record<string, any> }[] = [];
  const folderRow = (f: Folder) => ({
    ...f,
    numfolderfiles: state.files.filter((x) => x.folder === f.id).length,
    foldersize: 1,
  });
  const fileRow = (f: File) => ({
    id: f.id,
    name: f.name,
    folder: f.folder,
    filetype: f.filetype,
    filesize: f.content.length || 10,
    url: `/core/media/media.nl?id=${f.id}`,
  });
  const pathOf = (id: number) => {
    const chain: { id: number; name: string }[] = [];
    for (let f = state.folders.find((x) => x.id === id); f; ) {
      chain.unshift({ id: f.id, name: f.name });
      const parent = f.parent;
      f = state.folders.find((x) => x.id === parent);
    }
    return chain;
  };
  const request = async (op: string, args: Record<string, any> = {}) => {
    calls.push({ op, args: JSON.parse(JSON.stringify(args)) });
    switch (op) {
      case "folders":
        return { rows: state.folders.filter((f) => f.parent === null).map(folderRow) };
      case "folder":
        return {
          folders: state.folders.filter((f) => f.parent === args.id).map(folderRow),
          files: state.files.filter((f) => f.folder === args.id).map(fileRow),
          path: pathOf(args.id),
        };
      case "file": {
        const f = state.files.find((x) => x.id === args.id);
        if (!f) throw Error("File not found");
        return f.binary
          ? { ...fileRow(f), binary: true, base64: "AP8=" }
          : { ...fileRow(f), content: f.content, binary: false, base64: btoa(f.content) };
      }
      case "save-file": {
        const f = state.files.find((x) => x.id === args.id)!;
        f.content = args.content;
        return { id: f.id, content: f.content };
      }
      case "upload-file": {
        if (!state.folders.some((f) => f.id === args.folderId))
          throw Error("Folder does not exist");
        const id = state.next++;
        state.files.push({
          id,
          name: args.name,
          folder: args.folderId,
          filetype: /\.js$/.test(args.name) ? "JAVASCRIPT" : "PLAINTEXT",
          content: decodeURIComponent(escape(atob(args.base64))),
        });
        return { id };
      }
      case "create-folder": {
        const id = state.next++;
        state.folders.push({
          id,
          name: args.name,
          parent: args.folderId,
          foldertype: "DEFAULT",
        });
        return { id };
      }
      case "move-items": {
        for (const f of state.files)
          if (args.fileIds.includes(f.id)) f.folder = args.targetId;
        for (const f of state.folders)
          if (args.folderIds.includes(f.id)) f.parent = args.targetId;
        return { moved: args.fileIds.length + args.folderIds.length };
      }
      case "delete-items": {
        const errors: string[] = [];
        for (const id of args.fileIds) {
          const f = state.files.find((x) => x.id === id);
          if (f && f.folder === args.folderId)
            state.files = state.files.filter((x) => x !== f);
          else errors.push(`File ${id}: wrong folder`);
        }
        for (const id of args.folderIds) {
          const busy =
            state.files.some((x) => x.folder === id) ||
            state.folders.some((x) => x.parent === id);
          if (busy) errors.push(`Folder ${id}: folder is not empty`);
          else state.folders = state.folders.filter((x) => x.id !== id);
        }
        const remaining = [
          ...args.fileIds
            .filter((id: number) => state.files.some((x) => x.id === id))
            .map((id: number) => `File ${id}`),
          ...args.folderIds
            .filter((id: number) => state.folders.some((x) => x.id === id))
            .map((id: number) => `Folder ${id}`),
        ];
        return {
          deleted: args.fileIds.length + args.folderIds.length - remaining.length,
          remaining,
          errors,
        };
      }
      case "search-files": {
        const term = String(args.search).toLowerCase();
        return {
          folders: state.folders
            .filter((f) => f.name.toLowerCase().includes(term))
            .map(folderRow),
          files: [],
        };
      }
      case "query": {
        const sql = String(args.sql);
        let m: RegExpMatchArray | null;
        if ((m = sql.match(/COUNT\(\*\) AS n FROM MediaItemFolder WHERE parent IN \(([\d,]+)\)/)))
          return {
            rows: [
              {
                n: state.folders.filter((f) => m![1]!.split(",").map(Number).includes(Number(f.parent))).length,
              },
            ],
          };
        if ((m = sql.match(/SELECT id FROM MediaItemFolder WHERE id = (\d+)/)))
          return { rows: state.folders.filter((f) => f.id === Number(m![1])).map((f) => ({ id: f.id })) };
        if ((m = sql.match(/SELECT folder FROM file WHERE id = (\d+)/)))
          return {
            rows: state.files
              .filter((f) => f.id === Number(m![1]))
              .map((f) => ({ folder: f.folder })),
          };
        if ((m = sql.match(/SELECT id(?:, name)? FROM (file|MediaItemFolder) WHERE id IN \(([\d,]+)\)/))) {
          const ids = m[2]!.split(",").map(Number),
            list: { id: number; name: string }[] = m[1] === "file" ? state.files : state.folders;
          return {
            rows: list.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, name: x.name })),
          };
        }
        if (/FROM script WHERE scriptfile = 10/.test(sql))
          return {
            rows: [
              {
                id: 501,
                scriptid: "customscript_ctk_ue_invoice",
                name: "CTK UE Invoice",
                scripttype: "USEREVENT",
              },
            ],
          };
        return { rows: [] };
      }
      case "scripts":
        return {
          rows: [
            { id: 500, scriptid: "customscript_ctk_other", name: "CTK Other", scripttype: "SCHEDULED" },
            { id: 501, scriptid: "customscript_ctk_ue_invoice", name: "CTK UE Invoice", scripttype: "USEREVENT" },
          ],
        };
      case "deployments":
        return { rows: [] };
    }
    return { rows: [] };
  };
  return { calls, request };
}

function host() {
  const root = document.createElement("div");
  root.id = "parity-fixture";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;display:flex;flex-direction:column;";
  document.body.appendChild(root);
  return root;
}

export function mountCabinet(options: { state?: Record<string, unknown> } = {}) {
  const root = host();
  const state = seed();
  const { calls, request } = fakeNetSuite(state);
  const block = reactive({
    id: "parity",
    kind: "netsuite",
    value: JSON.stringify({
      filePanes: {
        fixture: {
          active: "main",
          panes: [
            {
              id: "main",
              path: [
                { id: 1, name: "SuiteScripts" },
                { id: 2, name: "CTK" },
              ],
            },
          ],
        },
      },
      ...options.state,
    }),
  }) as unknown as Block;
  const emitted: { event: string; args: unknown[] }[] = [];
  const app = createApp({
    render: () =>
      h(Cabinet, {
        block,
        environment: "fixture",
        request,
        openRecord: () => {},
        onOpenScript: (...args: unknown[]) => emitted.push({ event: "open-script", args }),
      }),
  });
  app.mount(root);
  return {
    state,
    calls,
    emitted,
    block,
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

export function mountScripts(initialScript?: { id: number; scriptid: string }) {
  const root = host();
  const { calls, request } = fakeNetSuite(seed());
  const block = reactive({ id: "parity", kind: "netsuite", value: "{}" }) as unknown as Block;
  const emitted: string[] = [];
  const app = createApp({
    render: () =>
      h(Scripts, {
        block,
        environment: "fixture",
        request,
        openRecord: () => {},
        status: "ready",
        initialScript,
        onOpenedInitial: () => emitted.push("opened-initial"),
      }),
  });
  app.mount(root);
  return { calls, emitted, unmount: () => (app.unmount(), root.remove()) };
}
