// Local file system operations for the File Explorer app. Every path is
// absolute and normalized here; the HTTP layer (files-api.ts) only accepts
// same-origin loopback requests.
import { spawn } from "node:child_process";
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
async function search(root: string, query: string, hidden: boolean) {
  const needle = query.toLowerCase();
  const results: FileEntry[] = [];
  const started = Date.now();
  const queue = [root];
  let visited = 0;
  let complete = true;
  while (queue.length) {
    if (results.length >= 500 || visited >= 40_000 || Date.now() - started > 6000) {
      complete = false;
      break;
    }
    const dir = queue.shift()!;
    visited++;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!hidden && d.name.startsWith(".")) continue;
      if (d.isDirectory() && !d.isSymbolicLink()) queue.push(join(dir, d.name));
      if (d.name.toLowerCase().includes(needle)) {
        const item = await entry(dir, d.name);
        if (item) results.push(item);
        if (results.length >= 500) break;
      }
    }
  }
  return { root, query, entries: results, complete, visited };
}

export function createFilesService() {
  const operations: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown> = {
    roots: () => ({ home: homedir(), separator: sep, platform: platform(), places: places(), drives: drives() }),
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
    search: (a) => {
      const query = typeof a.query === "string" ? a.query.trim() : "";
      if (!query) throw new Error("Type something to search for.");
      return search(absolute(a.path), query, a.hidden === true);
    },
  };
  return {
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
