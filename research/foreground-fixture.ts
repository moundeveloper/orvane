import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LocalDatabase } from "../server/database.ts";
import { NotesService } from "../server/notes.ts";
import {
  emptyWorkspace,
  makeBlock,
  type CanvasApp,
  type Kind,
} from "../src/model.ts";

export const workload = {
  notes: 12,
  netsuite: 20,
  git: 10,
  projects: 8,
  pages: 500,
  blocksPerDocument: 100,
  scripts: 1000,
  folders: 1000,
  projectsPerRoot: 100,
  savedTerminals: 20,
};
export function seedForegroundFixture(
  directory: string,
  options: { appCount?: number; innerTabs?: boolean } = {},
) {
  const count = options.appCount ?? 50;
  if (![5, 10, 20, 35, 50].includes(count))
    throw Error("Unsupported fixture app count.");
  const weights = [
    workload.notes,
    workload.netsuite,
    workload.git,
    workload.projects,
  ];
  const allocated = weights.map((weight) => Math.floor((count * weight) / 50));
  const order = weights
    .map((weight, i) => ({
      i,
      remainder: (count * weight) / 50 - allocated[i]!,
    }))
    .sort((a, b) => b.remainder - a.remainder);
  const remaining = count - allocated.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < remaining; i++) allocated[order[i]!.i]!++;
  const [notesCount, netsuiteCount, gitCount, projectsCount] = allocated as [
    number,
    number,
    number,
    number,
  ];
  const workspace = emptyWorkspace();
  const kinds: Kind[] = [
    ...Array<Kind>(notesCount).fill("notes"),
    ...Array<Kind>(netsuiteCount).fill("netsuite"),
    ...Array<Kind>(gitCount).fill("git"),
    ...Array<Kind>(projectsCount).fill("projects"),
  ];
  workspace.apps = kinds.map((kind, i): CanvasApp => {
    const block = makeBlock(kind);
    block.id = `block-${i}`;
    if (kind === "notes")
      block.value = JSON.stringify({ active: "page-0", tabs: ["page-0"] });
    if (kind === "netsuite") {
      const view = i % 3 === 0 ? "scripts" : i % 3 === 1 ? "files" : "query";
      const extra = options.innerTabs && i === notesCount;
      const tabs = extra
        ? [
            { id: "main", view: "scripts" },
            { id: "files", view: "files" },
            { id: "query", view: "query" },
          ]
        : [{ id: "main", view }];
      block.value = JSON.stringify({
        ...(extra
          ? {
              filePanes: {
                "fixture#files": {
                  active: "cold",
                  panes: [
                    {
                      id: "cold",
                      path: [{ id: 1, name: "Folder 1" }],
                      file: { id: 42, name: "fixture.js" },
                    },
                  ],
                },
              },
            }
          : {}),
        viewTabs: {
          tabs,
          layout: {
            tabs: tabs.map((tab) => tab.id),
            active: "main",
            left: [],
            right: [],
            leftActive: "",
            rightActive: "",
            ratio: 50,
          },
        },
      });
    }
    if (kind === "git") block.gitWorkspaceId = "fixture";
    if (kind === "projects") block.value = "C:\\foreground-fixture";
    return {
      id: `app-${i}`,
      name: `${kind} ${i}`,
      icon: "app",
      x: i === 0 ? 40 : 1400 + ((i - 1) % 7) * 1240,
      y: i === 0 ? 90 : 90 + Math.floor((i - 1) / 7) * 800,
      width: 1200,
      height: 760,
      blocks: [block],
      archived: false,
      group: "",
      exposed: false,
      accent: "#6f8998",
      padding: 12,
      gap: 12,
      radius: 8,
    };
  });
  const database = new LocalDatabase(join(directory, "workspace.sqlite"));
  const owner = randomUUID();
  try {
    database.acquire(owner);
    database.write(owner, 0, workspace);
    if (options.innerTabs) database.learn(owner, "orvane.examples.v1");
    database.release(owner);
  } finally {
    database.close();
  }
  const notes = new NotesService(directory);
  try {
    notes.invoke("data", {
      collection: "pages",
      action: "bulkPut",
      rows: Array.from({ length: workload.pages }, (_, i) => ({
        id: `page-${i}`,
        parentId: null,
        position: i,
        title: `Page ${String(i).padStart(4, "0")}`,
        type: "page",
        icon: null,
        isFavorite: false,
        trashedAt: null,
        createdAt: "2026-11-02",
        updatedAt: "2026-11-02",
      })),
    });
    for (let page = 0; page < 2; page++)
      notes.invoke("data", {
        collection: "blocks",
        action: "replaceBlocks",
        pageId: `page-${page}`,
        rows: Array.from({ length: workload.blocksPerDocument }, (_, i) => ({
          id: `body-${page}-${i}`,
          pageId: `page-${page}`,
          type: "paragraph",
          html:
            i === workload.blocksPerDocument - 1
              ? ""
              : `Document ${page} paragraph ${i}: ${"fixture text ".repeat(30)}`,
          indent: 0,
          position: i,
          createdAt: "2026-11-02",
          updatedAt: "2026-11-02",
        })),
      });
  } finally {
    notes.close();
  }
  const views = workspace.apps
    .filter((app) => app.blocks[0]?.kind === "netsuite")
    .map((app) => JSON.parse(app.blocks[0]!.value).viewTabs.tabs[0].view);
  return {
    apps: count,
    notes: notesCount,
    netsuite: netsuiteCount,
    git: gitCount,
    projects: projectsCount,
    scripts: views.filter((view) => view === "scripts").length,
    cabinets: views.filter((view) => view === "files").length,
    queryViews: views.filter((view) => view === "query").length,
    terminals: projectsCount,
  };
}

export function assertForegroundDocuments(directory: string) {
  const notes = new NotesService(directory);
  try {
    for (let page = 0; page < 2; page++) {
      const rows = notes.invoke("data", {
        collection: "blocks",
        action: "list",
        pageId: `page-${page}`,
      }) as { position: number; html: string }[];
      if (
        rows.length !== workload.blocksPerDocument ||
        !rows
          .find((row) => row.position === 0)
          ?.html.startsWith(`Document ${page} paragraph 0`)
      )
        throw Error(
          `Foreground fixture document ${page} was modified unexpectedly.`,
        );
    }
  } finally {
    notes.close();
  }
}

// Only fixed fixture responses are supported; unexpected operations fail instead
// of reaching a user's repository, filesystem or command execution endpoint.
export function externalRead(path: string): unknown {
  if (path === "/__orvane/projects/terminal/run")
    return { stdOut: "Controlled fixture output\n", stdErr: "", exitCode: 0 };
  // Terminal layout persistence is acknowledged only in this disposable
  // fixture; no terminal command or filesystem operation is implemented.
  if (path === "/__orvane/projects/terminal/state") return { saved: true };
  if (path === "/__orvane/git/git_workspace_list")
    return [
      {
        id: "fixture",
        name: "Fixture repository",
        path: "C:\\foreground-fixture\\repo",
      },
    ];
  if (path === "/__orvane/git/git_status") return { files: [] };
  if (path === "/__orvane/git/git_history")
    return {
      commits: Array.from({ length: 150 }, (_, i) => ({
        hash: String(i).padStart(40, "0"),
        parents: i < 149 ? [String(i + 1).padStart(40, "0")] : [],
        author: "Fixture",
        date: "2026-11-02",
        subject: `Commit ${i}`,
      })),
      refs: [],
      head: "0".repeat(40),
      branch: "main",
      hasMore: false,
    };
  if (path === "/__orvane/projects/workspace")
    return {
      rootPath: "C:\\foreground-fixture",
      projects: Array.from({ length: workload.projectsPerRoot }, (_, i) => ({
        name: `Project ${i}`,
        path: `C:\\foreground-fixture\\project-${i}`,
        modifiedAt: "2026-11-02",
      })),
      groups: [],
      terminalState: {
        isOpen: true,
        height: 230,
        activeCwd: "C:\\foreground-fixture\\project-0",
        tabs: Array.from({ length: workload.savedTerminals }, (_, i) => ({
          title: `Terminal ${i}`,
          cwd: `C:\\foreground-fixture\\project-${i}`,
        })),
      },
    };
  throw Error(`Unsupported external fixture operation: ${path}`);
}
