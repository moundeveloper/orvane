// Local file system operations for the File Explorer app. Every path is
// absolute and normalized here; the HTTP layer (files-api.ts) only accepts
// same-origin loopback requests.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { readSheet } from "./sheets.ts";
import { createImageStore } from "./images.ts";
import { unzip, zip } from "./archive.ts";
import { compareFolders, copyComparedFile, diffComparedFile } from "./folderCompare.ts";
import { importPlaywrightReport, runPlaywright } from "./playwrightResults.ts";

// ---- Git status badges ---------------------------------------------------------
// One `git status` per repository, cached briefly; folders inherit the most
// notable state of anything changed inside them.
function git(args: string[], cwd: string) {
  return new Promise<string>((resolveGit, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size < 20_000_000) chunks.push(d);
    });
    const timer = setTimeout(() => child.kill(), 8000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolveGit(Buffer.concat(chunks).toString("utf8")) : reject(new Error("git failed"));
    });
  });
}
const gitCache = new Map<string, { at: number; root: string; files: Map<string, string> } | null>();
async function gitStatus(folder: string) {
  const key = folder.toLowerCase();
  const cached = gitCache.get(key);
  if (cached !== undefined && cached && Date.now() - cached.at < 2000) return cached;
  let root: string;
  try {
    root = resolve((await git(["rev-parse", "--show-toplevel"], folder)).trim());
  } catch {
    gitCache.set(key, null);
    return null;
  }
  const files = new Map<string, string>();
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], root);
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    files.set(resolve(root, line.slice(3)).toLowerCase(), code);
    if (code[0] === "R" || code[0] === "C") i++; // the original name follows
  }
  const result = { at: Date.now(), root, files };
  gitCache.set(key, result);
  return result;
}
function badge(code: string) {
  if (code === "??") return "U";
  if (code.includes("U") || code === "AA" || code === "DD") return "C";
  if (code.includes("D")) return "D";
  if (code.includes("A")) return "A";
  if (code.includes("R")) return "R";
  return "M";
}
const RANK: Record<string, number> = { C: 5, M: 4, A: 3, D: 3, R: 2, U: 1 };

// ---- Folder sizes ----------------------------------------------------------------
async function folderSize(path: string, deadline: number) {
  let bytes = 0,
    files = 0,
    complete = true;
  const queue = [path];
  while (queue.length) {
    if (Date.now() > deadline) {
      complete = false;
      break;
    }
    const dir = queue.pop()!;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(
      dirents.map(async (d) => {
        const child = join(dir, d.name);
        if (d.isDirectory()) queue.push(child);
        else if (d.isFile()) {
          try {
            bytes += (await stat(child)).size;
            files++;
          } catch {
            // Unreadable files are left out.
          }
        }
      }),
    );
  }
  return { bytes, files, complete };
}

export type FileEntry = {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  ext: string;
  hidden: boolean;
  link: boolean;
};
const LIST_LIMIT = 50_000;
const TEXT_LIMIT = 2_000_000;
const IMAGE_LIMIT = 12_000_000;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

function absolute(value: unknown, label = "path") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`A ${label} is required.`);
  if (value.includes("\0")) throw new Error(`The ${label} is invalid.`);
  let path = value.trim();
  // "C:" alone means the drive's working directory on Windows; mean its root.
  if (/^[a-z]:$/i.test(path)) path += sep;
  if (!isAbsolute(path)) throw new Error(`The ${label} must be absolute.`);
  return resolve(path);
}
function validName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name) || (platform() === "win32" && /[<>:"|?*]/.test(name)))
    throw new Error("That name is not allowed.");
  return name;
}
function isRoot(path: string) {
  return parse(path).root === path;
}
function paths(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw new Error("Choose at least one item.");
  if (value.length > 5000) throw new Error("Too many items at once.");
  return value.map((p) => absolute(p));
}
async function entry(dir: string, name: string): Promise<FileEntry | null> {
  const path = join(dir, name);
  try {
    const info = await lstat(path);
    let target = info;
    const link = info.isSymbolicLink();
    if (link) target = await stat(path).catch(() => info);
    return {
      name,
      path,
      dir: target.isDirectory(),
      size: target.isDirectory() ? 0 : target.size,
      mtime: target.mtimeMs,
      ext: target.isDirectory() ? "" : extname(name).slice(1).toLowerCase(),
      hidden: name.startsWith("."),
      link,
    };
  } catch {
    return null;
  }
}
// Hidden/system attributes are a Windows concept that Node does not expose;
// one PowerShell call per listing would be too slow, so dot-files and the
// well-known system names stand in for them.
const WINDOWS_HIDDEN = new Set(["$recycle.bin", "system volume information", "desktop.ini", "thumbs.db", "pagefile.sys", "swapfile.sys", "hiberfil.sys", "dumpstack.log.tmp", "$windows.~bt", "$winreagent", "config.msi", "recovery", "documents and settings"]);
async function list(path: string) {
  const dirents = await readdir(path);
  const truncated = dirents.length > LIST_LIMIT;
  const names = dirents.slice(0, LIST_LIMIT);
  const entries: FileEntry[] = [];
  // Bounded concurrency keeps huge folders from exhausting file handles.
  let next = 0;
  await Promise.all(
    Array.from({ length: 48 }, async () => {
      while (next < names.length) {
        const item = await entry(path, names[next++]!);
        if (item) {
          if (platform() === "win32" && WINDOWS_HIDDEN.has(item.name.toLowerCase())) item.hidden = true;
          entries.push(item);
        }
      }
    }),
  );
  return { path, parent: isRoot(path) ? null : dirname(path), entries, truncated };
}
function drives() {
  if (platform() !== "win32") return [{ name: "/", path: "/" }];
  const result: { name: string; path: string }[] = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    if (existsSync(`${letter}:\\`)) result.push({ name: `${letter}:`, path: `${letter}:\\` });
  }
  return result;
}
function places() {
  const home = homedir();
  return [
    { name: "Home", path: home, icon: "home" },
    ...["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]
      .map((name) => ({ name, path: join(home, name), icon: name.toLowerCase() }))
      .filter((p) => existsSync(p.path)),
  ];
}
async function preview(path: string) {
  const info = await stat(path);
  const base = { path, name: basename(path), size: info.size, mtime: info.mtimeMs, ctime: info.birthtimeMs, dir: info.isDirectory() };
  if (info.isDirectory()) {
    const children = await readdir(path).catch(() => []);
    return { ...base, kind: "folder", count: children.length };
  }
  const ext = extname(path).toLowerCase();
  if (IMAGE_TYPES[ext] && info.size <= IMAGE_LIMIT) {
    const handle = await open(path, constants.O_RDONLY);
    try {
      const data = await handle.readFile();
      return { ...base, kind: "image", url: `data:${IMAGE_TYPES[ext]};base64,${data.toString("base64")}` };
    } finally {
      await handle.close();
    }
  }
  const handle = await open(path, constants.O_RDONLY);
  try {
    const length = Math.min(info.size, TEXT_LIMIT);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const sample = buffer.subarray(0, 8000);
    // NUL bytes in the first few KB mean it is not text worth showing.
    if (sample.includes(0)) return { ...base, kind: "binary" };
    return { ...base, kind: "text", text: buffer.toString("utf8"), truncated: info.size > TEXT_LIMIT };
  } finally {
    await handle.close();
  }
}
async function unique(dir: string, name: string) {
  const { name: stem, ext } = parse(name);
  let candidate = join(dir, name);
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`);
  return candidate;
}
function inside(child: string, parent: string) {
  const c = child.toLowerCase(),
    p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
async function transfer(sources: string[], destination: string, mode: "copy" | "move") {
  const target = await stat(destination);
  if (!target.isDirectory()) throw new Error("The destination is not a folder.");
  const done: string[] = [];
  for (const source of sources) {
    if (inside(destination, source)) throw new Error(`Cannot put “${basename(source)}” inside itself.`);
    const sameFolder = dirname(source).toLowerCase() === destination.toLowerCase();
    if (mode === "move" && sameFolder) continue;
    const to = await unique(destination, basename(source));
    const info = await lstat(source);
    if (mode === "move") {
      try {
        await rename(source, to);
      } catch (error) {
        // Across drives a rename fails; copy then remove the original.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await cp(source, to, { recursive: true, errorOnExist: true, preserveTimestamps: true });
        await trash([source]);
      }
    } else if (info.isDirectory()) await cp(source, to, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    else await copyFile(source, to, constants.COPYFILE_EXCL);
    done.push(to);
  }
  return { paths: done };
}
function run(command: string, args: string[], input?: string) {
  return new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: [input ? "pipe" : "ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr?.on("data", (d) => (errors += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolveRun() : reject(new Error(errors.trim() || `${command} failed.`))));
    if (input) child.stdin?.end(input);
  });
}
// Deleting always goes to the Recycle Bin / Trash, so it can be undone there.
async function trash(items: string[]) {
  for (const item of items) if (isRoot(item)) throw new Error("A drive root cannot be deleted.");
  if (platform() === "win32") {
    // Paths travel on stdin as JSON, never through the command line.
    const script =
      "Add-Type -AssemblyName Microsoft.VisualBasic;" +
      "$items = [Console]::In.ReadToEnd() | ConvertFrom-Json;" +
      "foreach ($p in $items) { if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') } elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') } }";
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], JSON.stringify(items));
  } else if (platform() === "darwin") {
    for (const item of items) await run("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(item)}`]);
  } else await run("gio", ["trash", "--", ...items]);
  return { deleted: items.length };
}
function launch(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => undefined);
  child.unref();
}
function openPath(path: string, reveal: boolean) {
  if (platform() === "win32") launch("explorer.exe", reveal ? [`/select,${path}`] : [path]);
  else if (platform() === "darwin") launch("open", reveal ? ["-R", path] : [path]);
  else launch("xdg-open", [reveal ? dirname(path) : path]);
  return { ok: true };
}
// Folders that are huge, generated or system-owned: walking them costs the
// whole time budget and rarely holds what someone is looking for. They are
// still searched when the search starts inside them.
const SKIP = new Set([
  "node_modules", ".git", ".svn", ".hg", "appdata", "$recycle.bin", "system volume information",
  "__pycache__", ".cache", ".venv", "venv", ".gradle", ".m2", ".nuget", ".npm", ".pnpm-store",
  "windows", "program files", "program files (x86)", "programdata", "$windows.~bt", "$winreagent",
]);
// Every word must appear in the name; "_", "-" and "." count as spaces.
function matcher(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (name: string) => {
    const lower = name.toLowerCase();
    const loose = lower.replace(/[_\-.]+/g, " ");
    return words.every((w) => lower.includes(w) || loose.includes(w));
  };
}
// Best first: exact name, then name starting with the query, then the rest;
// shallower paths before deeper ones.
function rank(entries: FileEntry[], query: string) {
  const q = query.toLowerCase();
  const score = (e: FileEntry) => {
    const name = e.name.toLowerCase(),
      stem = name.replace(/\.[^.]+$/, "");
    return (name === q || stem === q ? 0 : name.startsWith(q) ? 1 : 2) * 1000 + e.path.split(/[\/]/).length;
  };
  return entries.sort((a, b) => score(a) - score(b));
}
// Breadth-first over the given roots in order (most likely first); folders
// reached through more than one root are walked once.
async function search(roots: string[], query: string, hidden: boolean, budget = 6000, limit = 500) {
  const matches = matcher(query);
  const results: FileEntry[] = [];
  const matched = new Set<string>();
  const seen = new Set<string>();
  const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const started = Date.now();
  const queue: string[] = [];
  for (const root of roots) if (!seen.has(pathKey(root))) (seen.add(pathKey(root)), queue.push(root));
  for (const root of queue) {
    const name = basename(root);
    if (!name || (!hidden && name.startsWith(".")) || !matches(name)) continue;
    const item = await entry(dirname(root), name);
    if (!item?.dir) continue;
    results.push(item);
    matched.add(pathKey(root));
    if (results.length >= limit) break;
  }
  let visited = 0;
  let complete = true;
  for (let head = 0; head < queue.length; head++) {
    if (results.length >= limit || visited >= 60_000 || Date.now() - started > budget) {
      complete = false;
      break;
    }
    const dir = queue[head]!;
    visited++;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!hidden && d.name.startsWith(".")) continue;
      const path = join(dir, d.name);
      const key = pathKey(path);
      if (d.isDirectory() && !d.isSymbolicLink() && !SKIP.has(d.name.toLowerCase()) && !seen.has(key)) {
        seen.add(key);
        queue.push(path);
      }
      if (matches(d.name) && !matched.has(key)) {
        const item = await entry(dir, d.name);
        if (item) {
          results.push(item);
          matched.add(key);
        }
        if (results.length >= limit) break;
      }
    }
  }
  return { root: roots[0], query, entries: rank(results, query), complete, visited };
}

function baseNameOfUrl(url: string) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(basename(parsed.pathname, extname(parsed.pathname))) || parsed.hostname;
  } catch {
    return "Image";
  }
}
export function createFilesService(directory: string) {
  // Media elements cannot send JSON or custom headers, so raw file reads are
  // GET requests that carry this per-server token, handed out by "roots".
  const token = randomBytes(18).toString("hex");
  const images = createImageStore(directory);
  const operations: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown> = {
    roots: () => ({ token, home: homedir(), separator: sep, platform: platform(), places: places(), drives: drives() }),
    list: (a) => list(absolute(a.path)),
    preview: (a) => preview(absolute(a.path)),
    mkdir: async (a) => {
      const path = await unique(absolute(a.path), validName(a.name));
      await mkdir(path);
      return { path };
    },
    "new-file": async (a) => {
      const path = await unique(absolute(a.path), validName(a.name));
      await writeFile(path, "", { flag: "wx" });
      return { path };
    },
    write: async (a) => {
      const path = absolute(a.path);
      if (typeof a.text !== "string") throw new Error("Text is required.");
      const info = await stat(path);
      if (!info.isFile()) throw new Error("Only files can be saved.");
      // Refuse to overwrite a file changed by something else since it was read.
      if (Number.isFinite(a.mtime) && Math.abs(info.mtimeMs - Number(a.mtime)) > 1)
        throw new Error("The file changed on disk since it was opened. Reload it first.");
      await writeFile(path, a.text, "utf8");
      return { path, mtime: (await stat(path)).mtimeMs };
    },
    rename: async (a) => {
      const path = absolute(a.path);
      if (isRoot(path)) throw new Error("A drive root cannot be renamed.");
      const name = validName(a.name);
      const to = join(dirname(path), name);
      if (to === path) return { path };
      if (existsSync(to) && to.toLowerCase() !== path.toLowerCase()) throw new Error(`“${name}” already exists here.`);
      await rename(path, to);
      return { path: to };
    },
    copy: (a) => transfer(paths(a.paths), absolute(a.destination, "destination"), "copy"),
    "compare-folders": (a) => compareFolders(absolute(a.left), absolute(a.right)),
    "compare-file-diff": (a) => diffComparedFile(absolute(a.left), absolute(a.right), String(a.path ?? "")),
    "compare-file-copy": (a) => copyComparedFile(
      absolute(a.from), absolute(a.to), String(a.path ?? ""), String(a.source ?? ""),
      typeof a.target === "string" ? a.target : undefined,
    ),
    "playwright-run": (a) => runPlaywright(absolute(a.cwd), a.file === undefined ? undefined : {
      file: absolute(a.file), line: Number(a.line), project: typeof a.project === "string" ? a.project : undefined,
      testTitle: typeof a.testTitle === "string" ? a.testTitle : undefined,
    }),
    "playwright-report": (a) => importPlaywrightReport(absolute(a.cwd), absolute(a.path)),
    move: (a) => transfer(paths(a.paths), absolute(a.destination, "destination"), "move"),
    trash: (a) => trash(paths(a.paths)),
    open: (a) => openPath(absolute(a.path), false),
    reveal: (a) => openPath(absolute(a.path), true),
    terminal: (a) => {
      const path = absolute(a.path);
      if (platform() === "win32") launch("cmd.exe", ["/c", "start", "", "/d", path, "powershell.exe", "-NoExit"]);
      else if (platform() === "darwin") launch("open", ["-a", "Terminal", path]);
      else launch("x-terminal-emulator", ["--working-directory", path]);
      return { ok: true };
    },
    sheet: (a) => readSheet(absolute(a.path), Number(a.index) || 0),
    zip: async (a) => {
      const items = paths(a.paths);
      const folder = dirname(items[0]!);
      const name = items.length === 1 ? `${parse(items[0]!).name || basename(items[0]!)}.zip` : `${basename(folder) || "Archive"}.zip`;
      return zip(items, await unique(folder, name));
    },
    unzip: async (a) => {
      const path = absolute(a.path);
      return unzip(path, await unique(dirname(path), parse(path).name));
    },
    "git-status": async (a) => {
      const folder = absolute(a.path);
      const status = await gitStatus(folder).catch(() => null);
      if (!status) return { repo: false, entries: {} };
      // Badges for this folder's direct children only.
      const prefix = folder.toLowerCase().replace(/[\\/]+$/, "") + sep;
      const entries: Record<string, string> = {};
      for (const [file, code] of status.files) {
        if (!file.startsWith(prefix)) continue;
        const child = file.slice(prefix.length).split(/[\\/]/)[0]!;
        if (!child) continue;
        const nested = file.slice(prefix.length).replace(/[\\/]+$/, "").includes(sep);
        const letter = badge(code);
        const value = nested ? (letter === "U" ? "U" : "M") : letter;
        const current = entries[child];
        if (!current || RANK[value]! > RANK[current]!) entries[child] = value;
      }
      return { repo: true, root: status.root, entries };
    },
    "folder-size": async (a) => {
      const deadline = Date.now() + 8000;
      const results: Record<string, { bytes: number; files: number; complete: boolean }> = {};
      for (const path of paths(a.paths).slice(0, 200)) results[path] = await folderSize(path, deadline);
      return results;
    },
    // Renames several items as one step. Each first moves to a temporary
    // name, so swaps (a→b, b→a) and case-only changes work.
    "rename-many": async (a) => {
      if (!Array.isArray(a.items) || !a.items.length || a.items.length > 5000) throw new Error("Nothing to rename.");
      const plan = a.items.map((item: { path?: unknown; name?: unknown }) => {
        const path = absolute(item?.path);
        return { path, to: join(dirname(path), validName(item?.name)) };
      });
      const targets = new Set<string>();
      for (const step of plan) {
        const key = step.to.toLowerCase();
        if (targets.has(key)) throw new Error(`Two items would be named “${basename(step.to)}”.`);
        targets.add(key);
      }
      const sources = new Set(plan.map((s: { path: string }) => s.path.toLowerCase()));
      for (const step of plan)
        if (existsSync(step.to) && !sources.has(step.to.toLowerCase()))
          throw new Error(`“${basename(step.to)}” already exists.`);
      const moved: { from: string; temp: string; to: string }[] = [];
      try {
        for (const step of plan) {
          const temp = join(dirname(step.path), `.orvane-rename-${randomBytes(6).toString("hex")}`);
          await rename(step.path, temp);
          moved.push({ from: step.path, temp, to: step.to });
        }
        for (const step of moved) await rename(step.temp, step.to);
      } catch (error) {
        // Put back whatever is still at its temporary name.
        for (const step of moved) if (existsSync(step.temp)) await rename(step.temp, step.from).catch(() => undefined);
        throw error;
      }
      return { paths: plan.map((s: { to: string }) => s.to) };
    },
    "import-image": async (a) => {
      if (typeof a.path === "string") return images.fromPath(absolute(a.path));
      if (typeof a.dataUrl === "string") return images.fromDataUrl(a.dataUrl, typeof a.name === "string" ? a.name : "Image");
      if (typeof a.url === "string") {
        if (a.url.startsWith("data:")) return images.fromDataUrl(a.url, "Image");
        try {
          return await images.fromUrl(a.url);
        } catch (error) {
          // Keep the web address so the widget still shows the picture.
          return { url: a.url, name: baseNameOfUrl(a.url), warning: error instanceof Error ? error.message : String(error) };
        }
      }
      throw new Error("Nothing to import.");
    },
    search: (a) => {
      const query = typeof a.query === "string" ? a.query.trim() : "";
      if (!query) throw new Error("Type something to search for.");
      // `paths` searches several roots in order (Ctrl+K); `path` searches one.
      const roots = Array.isArray(a.paths) && a.paths.length ? paths(a.paths).slice(0, 40) : [absolute(a.path)];
      return search(roots, query, a.hidden === true, Math.min(6000, Math.max(300, Number(a.budget) || 6000)), Math.min(500, Math.max(1, Number(a.limit) || 500)));
    },
  };
  return {
    token,
    images,
    resolve: absolute,
    async invoke(operation: string, args: unknown) {
      const run = operations[operation];
      if (!run) throw new Error("Unknown File Explorer operation.");
      try {
        return await run(args && typeof args === "object" ? (args as Record<string, unknown>) : {});
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error("That item no longer exists.");
        if (code === "EACCES" || code === "EPERM") throw new Error("Access is denied.");
        if (code === "EBUSY") throw new Error("The item is in use by another program.");
        if (code === "EEXIST") throw new Error("An item with that name already exists.");
        if (code === "ENOTEMPTY") throw new Error("The folder is not empty.");
        throw error;
      }
    },
  };
}
