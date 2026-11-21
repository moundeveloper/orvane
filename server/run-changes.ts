// Which files an agent run created, changed or deleted: the run folder's Git
// state is read before the run starts and again when the card asks, and the
// difference is the run's work. Counts are against the last commit.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface FileState {
  code: string;
  add: number;
  del: number;
  mtime: number;
}
export type Snapshot = { root: string; files: Map<string, FileState> };
export interface RunChange {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  status: "A" | "M" | "D";
  add: number;
  del: number;
}

const changeLimit = 200;
const diffLineLimit = 400;

function git(args: string[], cwd: string) {
  return new Promise<string>((done, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size < 20_000_000) chunks.push(data);
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(Buffer.concat(chunks).toString("utf8"));
      else reject(Error("git failed"));
    });
  });
}

async function lineCount(file: string) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > 2_000_000) return 0;
  const text = await readFile(file, "utf8").catch(() => "");
  if (text.includes("\0")) return 0;
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}

/** The folder's repository state, or null outside a repository. */
export async function snapshot(folder: string): Promise<Snapshot | null> {
  let root: string;
  try {
    root = resolve((await git(["rev-parse", "--show-toplevel"], folder)).trim());
  } catch {
    return null;
  }
  const files = new Map<string, FileState>();
  // Only the run folder: it may sit inside a much larger repository.
  const scope = relative(root, resolve(folder)) || ".";
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", scope], root);
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    files.set(line.slice(3), { code, add: 0, del: 0, mtime: 0 });
    if (code[0] === "R" || code[0] === "C") i++;
  }
  const numstat = await git(["diff", "--numstat", "HEAD", "--", scope], root).catch(() => "");
  for (const row of numstat.split("\n")) {
    const [add, del, path] = row.split("\t");
    const entry = path && files.get(path);
    if (entry) {
      entry.add = Number(add) || 0;
      entry.del = Number(del) || 0;
    }
  }
  // Line counts for new files are capped so a large untracked tree stays cheap.
  let counted = 0;
  await Promise.all(
    [...files].slice(0, 2000).map(async ([path, entry]) => {
      const info = await stat(resolve(root, path)).catch(() => null);
      entry.mtime = info?.mtimeMs ?? 0;
      if (entry.code === "??" && counted++ < 200) entry.add = await lineCount(resolve(root, path));
    }),
  );
  return { root, files };
}

/** Files whose state differs after the run. */
export function compare(before: Snapshot | null, after: Snapshot): RunChange[] {
  const changes: RunChange[] = [];
  for (const [path, now] of after.files) {
    const then = before?.files.get(path);
    if (then && then.code === now.code && then.add === now.add && then.del === now.del && then.mtime === now.mtime)
      continue;
    const status = now.code === "??" || now.code.includes("A") ? "A" : now.code.includes("D") ? "D" : "M";
    changes.push({ path, status, add: now.add, del: now.del });
    if (changes.length >= changeLimit) break;
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** A unified diff of one changed file against the last commit. */
export async function fileDiff(root: string, change: RunChange) {
  const full = resolve(root, change.path);
  const inside = relative(root, full);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw Error("That file is outside the repository.");
  let text: string;
  if (change.status === "A") {
    const tracked = await git(["ls-files", "--error-unmatch", "--", change.path], root).then(
      () => true,
      () => false,
    );
    text = tracked
      ? await git(["diff", "HEAD", "--", change.path], root).catch(() => "")
      : (await readFile(full, "utf8").catch(() => ""))
          .split("\n")
          .map((line) => "+" + line)
          .join("\n");
  } else text = await git(["diff", "HEAD", "--", change.path], root).catch(() => "");
  const lines = text
    .split("\n")
    .filter((line) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(line));
  return {
    diff: lines.slice(0, diffLineLimit).join("\n"),
    truncated: lines.length > diffLineLimit,
  };
}
