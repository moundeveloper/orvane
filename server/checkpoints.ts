// Checkpoints: the project's files saved before each agent turn, in a shadow
// Git repository Orvane keeps under .orvane/checkpoints. The project's own
// Git history is never touched. Rewinding first saves the current files, so a
// rewind can itself be undone from the newer checkpoint.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import type { AgentCheckpoint } from "../src/agentSessions.ts";

export interface CheckpointFile {
  path: string;
  status: "A" | "M" | "D";
  add: number;
  del: number;
}

const fileLimit = 200;

export class Checkpoints {
  constructor(private directory: string) {}

  private gitDir(folder: string) {
    const id = createHash("sha1").update(resolve(folder).toLowerCase()).digest("hex").slice(0, 16);
    return join(this.directory, "checkpoints", `${id}.git`);
  }

  private git(folder: string, args: string[], timeout = 20_000) {
    const gitDir = this.gitDir(folder);
    return new Promise<string>((done, reject) => {
      const child = spawn("git", args, {
        cwd: folder,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: folder,
          GIT_AUTHOR_NAME: "Orvane",
          GIT_AUTHOR_EMAIL: "checkpoints@orvane.local",
          GIT_COMMITTER_NAME: "Orvane",
          GIT_COMMITTER_EMAIL: "checkpoints@orvane.local",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      const out: Buffer[] = [];
      let size = 0;
      let error = "";
      child.stdout.on("data", (data: Buffer) => {
        size += data.length;
        if (size < 10_000_000) out.push(data);
      });
      child.stderr.on("data", (data: Buffer) => (error = (error + data).slice(-2000)));
      const timer = setTimeout(() => child.kill(), timeout);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) done(Buffer.concat(out).toString("utf8"));
        else reject(Error(error.trim() || "git failed"));
      });
    });
  }

  /** Folders too broad to snapshot: a drive root or the home folder itself. */
  static allowed(folder: string) {
    const full = resolve(folder);
    return parse(full).root.toLowerCase() !== full.toLowerCase() &&
      full.toLowerCase() !== resolve(homedir()).toLowerCase();
  }

  private async ready(folder: string) {
    const gitDir = this.gitDir(folder);
    if (existsSync(join(gitDir, "HEAD"))) return;
    await mkdir(gitDir, { recursive: true });
    await this.git(folder, ["init", "-q"]);
    // Written directly: each git process costs about a third of a second on Windows.
    await appendFile(join(gitDir, "config"), "[core]\n\tautocrlf = false\n\tlongpaths = true\n[gc]\n\tauto = 0\n");
  }

  /** The commit HEAD points at, read from the ref file (loose refs, gc is off). */
  private async head(folder: string) {
    const gitDir = this.gitDir(folder);
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    const commit = ref ? (await readFile(join(gitDir, ...ref.split("/")), "utf8").catch(() => "")).trim() : head;
    return /^[0-9a-f]{40}$/.test(commit) ? commit : (await this.git(folder, ["rev-parse", "HEAD"])).trim();
  }

  /** Save the folder's files now. Null when the folder is too broad or Git fails. */
  async create(folder: string, label: string): Promise<AgentCheckpoint | null> {
    if (!Checkpoints.allowed(folder)) return null;
    try {
      await this.ready(folder);
      await this.git(folder, ["add", "-A", "--ignore-errors", "."], 60_000).catch(() => "");
      await this.git(folder, ["commit", "-q", "--allow-empty", "--no-verify", "-m", label.slice(0, 200)]);
      const commit = await this.head(folder);
      return { commit, at: new Date().toISOString() };
    } catch {
      return null;
    }
  }

  private async changedSince(folder: string, commit: string, tree: string) {
    const [names, counts] = await Promise.all([
      this.git(folder, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", commit, tree]),
      this.git(folder, ["diff-tree", "-r", "--no-renames", "--numstat", "-z", commit, tree]),
    ]);
    const files: CheckpointFile[] = [];
    const parts = names.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i]!;
      const path = parts[i + 1]!;
      if (!code || !path) continue;
      // Compared from the checkpoint to now: a file added since is "A".
      files.push({ path, status: code === "A" ? "A" : code === "D" ? "D" : "M", add: 0, del: 0 });
    }
    const stat = counts.split("\0");
    for (const row of stat) {
      const [add, del, path] = row.split("\t");
      const file = path && files.find((item) => item.path === path);
      if (file) {
        file.add = Number(add) || 0;
        file.del = Number(del) || 0;
      }
    }
    return files;
  }

  private check(commit: string) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw Error("Unknown checkpoint.");
  }

  /** Files that differ between the checkpoint and the folder now. */
  async preview(folder: string, commit: string) {
    this.check(commit);
    if (!existsSync(join(this.gitDir(folder), "HEAD"))) throw Error("This folder has no checkpoints.");
    await this.git(folder, ["add", "-A", "--ignore-errors", "."], 60_000).catch(() => "");
    const tree = (await this.git(folder, ["write-tree"])).trim();
    const files = await this.changedSince(folder, commit, tree);
    return { files: files.slice(0, fileLimit), more: Math.max(0, files.length - fileLimit) };
  }

  /** Put the folder's files back as they were at the checkpoint. */
  async restore(folder: string, commit: string) {
    this.check(commit);
    await this.git(folder, ["cat-file", "-e", `${commit}^{commit}`]).catch(() => {
      throw Error("That checkpoint is no longer available.");
    });
    const safety = await this.create(folder, "Before rewind");
    if (!safety) throw Error("The current files could not be saved, so nothing was rewound.");
    const files = await this.changedSince(folder, commit, safety.commit);
    const back: string[] = [];
    for (const file of files) {
      const full = resolve(folder, file.path);
      const inside = relative(folder, full);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue;
      if (file.status === "A") await rm(full, { force: true });
      else back.push(file.path);
    }
    for (let i = 0; i < back.length; i += 100)
      await this.git(folder, ["checkout", commit, "--", ...back.slice(i, i + 100)], 60_000);
    return { files, safety };
  }
}
