import { execFile } from "node:child_process";
import { access, readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { LocalDatabase } from "./database.ts";
import type { GitCommit, GitFile, GitRef, GitWorkspace } from "../src/git.ts";
const execute = promisify(execFile);
const id = z.string().uuid();
const hash = z.string().regex(/^[a-f\d]{40}(?:[a-f\d]{24})?$/i);
export const gitSchemas = {
  git_folders: z.object({ path: z.string().max(32768).optional() }).strict(),
  git_workspace_list: z.object({}).strict(),
  git_workspace_add: z
    .object({
      path: z.string().min(1).max(32768),
      name: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  git_workspace_rename: z
    .object({ workspaceId: id, name: z.string().trim().min(1).max(100) })
    .strict(),
  git_workspace_remove: z.object({ workspaceId: id }).strict(),
  git_history: z
    .object({
      workspaceId: id,
      ref: z.string().max(1024).optional(),
      order: z.enum(["date", "topo"]).default("date"),
      limit: z.number().int().min(1).max(500).default(150),
      offset: z.number().int().min(0).max(100000).default(0),
    })
    .strict(),
  git_commit: z.object({ workspaceId: id, hash }).strict(),
  git_status: z.object({ workspaceId: id }).strict(),
  git_diff: z
    .object({
      workspaceId: id,
      hash: hash.optional(),
      file: z.string().min(1).max(32768).optional(),
      mode: z.enum(["worktree", "index"]).default("worktree"),
    })
    .strict(),
};
export type GitOperation = keyof typeof gitSchemas;
export const gitDescriptions: Record<GitOperation, string> = {
  git_folders:
    "Browse local directories to choose a repository. Omit path for the home folder. Returns directories, parent and local drive roots; never file contents.",
  git_workspace_list:
    "List saved local Git repository workspaces from Orvane SQLite. These IDs configure Git viewer components through component_create/component_update.gitWorkspaceId.",
  git_workspace_add:
    "Validate a user-selected local Git folder and save it as a workspace. Canonicalizes repository/worktree roots and deduplicates paths. Never modifies Git files.",
  git_workspace_rename:
    "Rename a saved Git workspace label without moving or renaming its local folder.",
  git_workspace_remove:
    "Forget a saved Git workspace. Does not delete any folder or change the repository.",
  git_history:
    "Read paginated local Git history and branch/tag refs for a saved workspace. Date order is the default; order=topo groups branch topology. Omit ref for all refs. No fetch or repository changes.",
  git_commit:
    "Read a commit message, its parents and changed files. Merge commits compare against their first parent.",
  git_status:
    "Read staged, unstaged and untracked local changes, with optional index writes disabled.",
  git_diff:
    "Read a commit or working-tree/index diff. External diff drivers and text conversion are disabled. Untracked files have no diff. No stage, commit, checkout or network operations.",
};
let executable: Promise<string> | undefined;
async function gitExecutable() {
  return (executable ||= (async () => {
    for (const directory of (process.env.PATH || "").split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      const candidate = join(
        directory,
        process.platform === "win32" ? "git.exe" : "git",
      );
      try {
        if ((await stat(candidate)).isFile()) return await realpath(candidate);
      } catch {
        /* Next trusted PATH entry. */
      }
    }
    throw Error(
      "Git could not be found on PATH. Install Git or add your existing Git installation to PATH, then restart Orvane.",
    );
  })());
}
async function git(path: string, args: string[]) {
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    // The selected repository, not the server's launch shell, owns Git context.
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CEILING_DIRECTORIES",
      "GIT_NAMESPACE",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_EXTERNAL_DIFF",
    ])
      delete env[key];
    const result = await execute(
      await gitExecutable(),
      [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "color.ui=false",
        ...args,
      ],
      {
        cwd: path,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 8_000_000,
        env,
      },
    );
    return result.stdout;
  } catch (error) {
    const failure = error as {
      stderr?: string;
      code?: string;
      message?: string;
    };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw Error(
        "This Git result is too large. Choose a specific file or a smaller history page.",
      );
    throw Error(
      (
        failure.stderr ||
        failure.message ||
        "Git could not read this repository."
      )
        .trim()
        .slice(0, 1500),
    );
  }
}
function files(output: string): GitFile[] {
  const fields = output.split("\0");
  const result: GitFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    if (fields[i]) result.push({ status: fields[i]!, path: fields[i + 1]! });
  return result;
}
export class GitService {
  private db?: LocalDatabase;
  constructor(
    private directory: string,
    private filename = "workspace.sqlite",
  ) {}
  private get database() {
    return (this.db ||= new LocalDatabase(join(this.directory, this.filename)));
  }
  private workspace(id: string): GitWorkspace {
    const workspace = this.database.gitWorkspaces().find((w) => w.id === id);
    if (!workspace)
      throw Error(
        "This saved Git workspace is unavailable. Choose another workspace or add the folder again.",
      );
    return workspace;
  }
  async invoke(operation: GitOperation, input: unknown): Promise<unknown> {
    const args = gitSchemas[operation].parse(input);
    switch (operation) {
      case "git_workspace_list":
        return this.database.gitWorkspaces();
      case "git_workspace_add": {
        const p = gitSchemas.git_workspace_add.parse(args);
        if (!isAbsolute(p.path))
          throw Error("Enter an absolute local folder path.");
        const folder = await realpath(resolve(p.path));
        const root = (
          await git(folder, ["rev-parse", "--show-toplevel"])
        ).trim();
        const canonical = await realpath(root);
        return this.database.registerGitWorkspace(
          randomUUID(),
          p.name || basename(canonical),
          canonical,
        );
      }
      case "git_workspace_rename": {
        const p = gitSchemas.git_workspace_rename.parse(args);
        this.workspace(p.workspaceId);
        this.database.renameGitWorkspace(p.workspaceId, p.name);
        return this.workspace(p.workspaceId);
      }
      case "git_workspace_remove": {
        const p = gitSchemas.git_workspace_remove.parse(args);
        this.workspace(p.workspaceId);
        this.database.removeGitWorkspace(p.workspaceId);
        return { removed: true };
      }
      case "git_folders": {
        const p = gitSchemas.git_folders.parse(args);
        if (p.path && !isAbsolute(p.path))
          throw Error("Enter an absolute local folder path.");
        const folder = await realpath(p.path ? resolve(p.path) : homedir());
        if (!(await stat(folder)).isDirectory())
          throw Error("Choose a folder, rather than a file.");
        const entries = await readdir(folder, { withFileTypes: true });
        const roots =
          process.platform === "win32"
            ? (
                await Promise.all(
                  Array.from({ length: 26 }, async (_, i) => {
                    const path = `${String.fromCharCode(65 + i)}:\\`;
                    try {
                      await access(path);
                      return path;
                    } catch {
                      return "";
                    }
                  }),
                )
              ).filter(Boolean)
            : ["/"];
        return {
          path: folder,
          parent: dirname(folder) === folder ? null : dirname(folder),
          roots,
          folders: entries
            .filter((e) => e.isDirectory() && e.name !== ".git")
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 500)
            .map((e) => ({ name: e.name, path: join(folder, e.name) })),
        };
      }
      case "git_history": {
        const p = gitSchemas.git_history.parse(args),
          workspace = this.workspace(p.workspaceId);
        const [head, branch, output] = await Promise.all([
          git(workspace.path, ["rev-parse", "--verify", "HEAD"]).catch(
            () => "",
          ),
          git(workspace.path, [
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD",
          ]).catch(() => ""),
          git(workspace.path, [
            "for-each-ref",
            "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(refname:short)",
          ]),
        ]);
        const refs: GitRef[] = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [object, peeled, fullName, name] = line.split("\0");
            return {
              hash: peeled || object!,
              fullName: fullName!,
              name: name!,
              kind: fullName!.startsWith("refs/heads/")
                ? "branch"
                : fullName!.startsWith("refs/tags/")
                  ? "tag"
                  : "remote",
            };
          });
        const remoteDefault = (
          await git(workspace.path, [
            "symbolic-ref",
            "--quiet",
            "refs/remotes/origin/HEAD",
          ]).catch(() => "")
        ).trim();
        const mainRef =
          refs.find((ref) => ref.fullName === remoteDefault) ||
          refs.find((ref) => ref.fullName === "refs/heads/main") ||
          refs.find((ref) => ref.fullName === "refs/heads/master") ||
          refs.find((ref) =>
            /^refs\/remotes\/[^/]+\/(main|master)$/.test(ref.fullName),
          );
        const mainline = mainRef
          ? (
              await git(workspace.path, [
                "rev-list",
                "--first-parent",
                `--max-count=${p.offset + p.limit + 1}`,
                mainRef.hash,
                "--",
              ])
            )
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
          : [];
        let revision = "--all";
        if (p.ref)
          revision = (
            await git(workspace.path, [
              "rev-parse",
              "--verify",
              "--end-of-options",
              `${p.ref}^{commit}`,
            ])
          ).trim();
        const log =
          head.trim() || refs.length
            ? await git(workspace.path, [
                "log",
                p.order === "topo" ? "--topo-order" : "--date-order",
                "--no-show-signature",
                `--max-count=${p.limit + 1}`,
                `--skip=${p.offset}`,
                "-z",
                "--format=%H%x00%P%x00%an%x00%aI%x00%s",
                revision,
                "--",
              ])
            : "";
        const fields = log.split("\0");
        const commits: GitCommit[] = [];
        for (let i = 0; i + 4 < fields.length; i += 5)
          commits.push({
            hash: fields[i]!.trim(),
            parents: fields[i + 1]!.split(" ").filter(Boolean),
            author: fields[i + 2]!,
            date: fields[i + 3]!,
            subject: fields[i + 4]!,
          });
        return {
          commits: commits.slice(0, p.limit),
          refs,
          head: head.trim(),
          branch:
            branch.trim() || (head.trim() ? "Detached HEAD" : "No commits yet"),
          hasMore: commits.length > p.limit,
          mainBranch: mainRef?.name,
          mainRef: mainRef?.fullName,
          mainline,
        };
      }
      case "git_status": {
        const p = gitSchemas.git_status.parse(args),
          workspace = this.workspace(p.workspaceId);
        const output = await git(workspace.path, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=normal",
          "--ignore-submodules=all",
        ]);
        const fields = output.split("\0");
        const changed = [];
        for (let i = 0; i < fields.length; i++) {
          const item = fields[i]!;
          if (!item) continue;
          changed.push({
            index: item[0]!,
            worktree: item[1]!,
            path: item.slice(3),
          });
          if (/[RC]/.test(item.slice(0, 2))) i++;
        }
        return { files: changed };
      }
      case "git_commit": {
        const p = gitSchemas.git_commit.parse(args),
          workspace = this.workspace(p.workspaceId);
        const [ancestry, message] = await Promise.all([
          git(workspace.path, [
            "rev-list",
            "--parents",
            "-n",
            "1",
            p.hash,
            "--",
          ]),
          git(workspace.path, [
            "show",
            "-s",
            "--no-show-signature",
            "--format=%B",
            p.hash,
            "--",
          ]),
        ]);
        const parents = ancestry.trim().split(" ").slice(1);
        const changed = parents.length
          ? await git(workspace.path, [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              "--name-status",
              "-z",
              parents[0]!,
              p.hash,
              "--",
            ])
          : await git(workspace.path, [
              "diff-tree",
              "--root",
              "--no-commit-id",
              "-r",
              "--no-renames",
              "--name-status",
              "-z",
              p.hash,
              "--",
            ]);
        return {
          hash: p.hash,
          parents,
          message: message.trimEnd(),
          files: files(changed),
        };
      }
      case "git_diff": {
        const p = gitSchemas.git_diff.parse(args),
          workspace = this.workspace(p.workspaceId);
        let command: string[];
        if (p.hash) {
          const ancestry = (
            await git(workspace.path, [
              "rev-list",
              "--parents",
              "-n",
              "1",
              p.hash,
              "--",
            ])
          )
            .trim()
            .split(" ");
          command =
            ancestry.length > 1
              ? [
                  "diff",
                  "--no-ext-diff",
                  "--no-textconv",
                  "--no-renames",
                  "--no-color",
                  ancestry[1]!,
                  p.hash,
                ]
              : [
                  "diff-tree",
                  "--root",
                  "--no-commit-id",
                  "-p",
                  "--no-ext-diff",
                  "--no-textconv",
                  "--no-renames",
                  "--no-color",
                  p.hash,
                ];
        } else
          command = [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--no-color",
            ...(p.mode === "index" ? ["--cached"] : []),
          ];
        const patch = await git(workspace.path, [
          ...command,
          "--",
          ...(p.file ? [p.file] : []),
        ]);
        return {
          patch: patch.slice(0, 500_000),
          truncated: patch.length > 500_000,
        };
      }
    }
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
}
