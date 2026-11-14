// Shared types and helpers for the File Explorer app.
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
export type SortKey = "name" | "mtime" | "type" | "size";
export type Sort = { key: SortKey; dir: 1 | -1 };
export type PaneState = {
  id: string;
  path: string;
  back: string[];
  forward: string[];
  view: "list" | "grid";
  sort: Sort;
  preview: boolean;
};
export type Place = { name: string; path: string; icon?: string };
export type Roots = {
  token: string;
  home: string;
  separator: string;
  platform: string;
  places: Place[];
  drives: Place[];
};
export type Clip = { mode: "copy" | "cut"; paths: string[] } | null;
export type MenuItem =
  | "sep"
  | { label: string; icon: string; hint?: string; disabled?: boolean; danger?: boolean; run: () => unknown };
// What the shell shares with every pane.
export type ExplorerContext = {
  home: string;
  token: string;
  hidden: boolean;
  clip: Clip;
  signal: { stamp: number; dirs: string[] };
  toggleHidden(): void;
  remember(path: string, entries: FileEntry[]): void;
  changed(dirs: string[]): void;
  toast(text: string, error?: boolean): void;
  confirm(message: string, action: string): Promise<boolean>;
  menu(event: MouseEvent, items: MenuItem[]): void;
  openTab(path: string): void;
  openSplit(path: string): void;
  open(path: string): void;
  reveal(path: string): void;
  terminal(path: string): void;
  isPinned(path: string): boolean;
  togglePin(path: string): void;
  transfer(paths: string[], destination: string, mode: "copy" | "move"): Promise<void>;
  dropPaths(event: DragEvent, destination: string): void;
  addToCanvas(path: string): void;
};
export const DRAG_MIME = "application/x-orvane-files";

export async function api<T = any>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/__orvane/files/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // A non-JSON reply means the files API is not mounted on this server.
  }
  if (!response.ok || !data) throw new Error(data?.error || "The local file service is unavailable.");
  return data as T;
}

const windows = () => typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent);
export function separatorOf(path: string) {
  return /^[a-z]:|^\\\\/i.test(path) || path.includes("\\") ? "\\" : windows() && !path.startsWith("/") ? "\\" : "/";
}
export function joinPath(dir: string, name: string) {
  const sep = separatorOf(dir);
  return dir.endsWith(sep) || dir.endsWith("/") ? dir + name : dir + sep + name;
}
export function baseName(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}
export function parentOf(path: string) {
  const list = crumbs(path);
  return list.length > 1 ? list.at(-2)!.path : null;
}
export function samePath(a: string, b: string) {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return separatorOf(a) === "\\" ? norm(a) === norm(b) : a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
export function rootOf(path: string) {
  return crumbs(path)[0]?.path ?? path;
}
// Breadcrumb segments, each with the absolute path it stands for.
export function crumbs(path: string) {
  const out: { name: string; path: string }[] = [];
  if (path.startsWith("\\\\")) {
    const [server, share, ...rest] = path.slice(2).split(/[\\/]+/).filter(Boolean);
    if (!server) return out;
    let acc = `\\\\${server}\\${share ?? ""}`;
    out.push({ name: share ? `${share} (\\\\${server})` : server, path: acc + "\\" });
    for (const part of rest) out.push({ name: part, path: (acc += "\\" + part) });
    return out;
  }
  const drive = /^([a-z]:)[\\/]*/i.exec(path);
  if (drive) {
    let acc = drive[1]!.toUpperCase() + "\\";
    out.push({ name: drive[1]!.toUpperCase(), path: acc });
    for (const part of path.slice(drive[0].length).split(/[\\/]+/).filter(Boolean)) {
      acc = acc.endsWith("\\") ? acc + part : acc + "\\" + part;
      out.push({ name: part, path: acc });
    }
    return out;
  }
  out.push({ name: "/", path: "/" });
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) out.push({ name: part, path: (acc += "/" + part) });
  return out;
}
export function label(path: string, home?: string) {
  if (home && samePath(path, home)) return "Home";
  const list = crumbs(path);
  return list.length === 1 ? (list[0]!.name.length <= 3 ? `Local Disk (${list[0]!.name})` : list[0]!.name) : list.at(-1)!.name;
}

const units = ["B", "KB", "MB", "GB", "TB"];
export function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
export function formatDate(ms: number) {
  return Number.isFinite(ms) && ms > 0 ? dateFormat.format(ms) : "";
}
export function typeName(entry: FileEntry) {
  if (entry.dir) return "File folder";
  return entry.ext ? `${entry.ext.toUpperCase()} file` : "File";
}
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "tif", "tiff", "heic"]);
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma"]);
const VIDEO = new Set(["mp4", "mkv", "mov", "avi", "webm", "wmv", "m4v"]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso"]);
const CODE = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "json", "html", "htm", "css", "scss", "less", "py", "rb", "go", "rs", "java",
  "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "ps1", "bat", "cmd", "sql", "xml", "yml", "yaml", "toml", "ini", "md",
]);
export function iconOf(entry: FileEntry) {
  if (entry.dir) return "folder";
  if (IMAGE.has(entry.ext)) return "image";
  if (AUDIO.has(entry.ext)) return "music";
  if (VIDEO.has(entry.ext)) return "video";
  if (ARCHIVE.has(entry.ext)) return "archive2";
  if (CODE.has(entry.ext)) return "file-code";
  return "file";
}
export function toneOf(entry: FileEntry) {
  if (entry.dir) return "tone-folder";
  if (IMAGE.has(entry.ext)) return "tone-image";
  if (CODE.has(entry.ext)) return "tone-code";
  if (ARCHIVE.has(entry.ext)) return "tone-archive";
  return "tone-file";
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function sortEntries(entries: FileEntry[], sort: Sort) {
  const { key, dir } = sort;
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    let r = 0;
    if (key === "mtime") r = a.mtime - b.mtime;
    else if (key === "size") r = a.size - b.size;
    else if (key === "type") r = collator.compare(a.ext, b.ext);
    return (r || collator.compare(a.name, b.name)) * (key === "name" || r ? dir : 1);
  });
}

// ---- Peek ----------------------------------------------------------------------
export type PeekKind = "image" | "video" | "audio" | "pdf" | "sheet" | "text";
const PEEK_IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);
const PEEK_VIDEO = new Set(["mp4", "m4v", "webm", "ogv", "mov", "mkv"]);
const PEEK_AUDIO = new Set(["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus"]);
const PEEK_SHEET = new Set(["xlsx", "xlsm", "csv", "tsv"]);
// Everything else is tried as text; the server reports binary files.
export function peekKind(entry: FileEntry): PeekKind {
  if (PEEK_IMAGE.has(entry.ext)) return "image";
  if (PEEK_VIDEO.has(entry.ext)) return "video";
  if (PEEK_AUDIO.has(entry.ext)) return "audio";
  if (PEEK_SHEET.has(entry.ext)) return "sheet";
  if (entry.ext === "pdf") return "pdf";
  return "text";
}
export function isImage(path: string) {
  return PEEK_IMAGE.has(path.split(".").pop()?.toLowerCase() ?? "");
}
export function rawUrl(path: string, token: string) {
  return `/__orvane/files/raw?path=${encodeURIComponent(path)}&t=${token}`;
}
export type CodeLanguage = "javascript" | "typescript" | "jsx" | "html" | "xml" | "sql" | "plain";
export function languageOf(ext: string): CodeLanguage {
  if (["js", "mjs", "cjs", "json", "jsonc", "json5"].includes(ext)) return "javascript";
  if (["ts", "mts", "cts"].includes(ext)) return "typescript";
  if (["jsx", "tsx"].includes(ext)) return "jsx";
  if (["html", "htm", "vue", "svelte", "astro"].includes(ext)) return "html";
  if (["xml", "xaml", "xsd", "xsl", "xslt", "svg", "plist", "csproj", "vbproj", "props", "targets", "config", "resx", "rss", "atom", "wsdl", "kml", "gpx"].includes(ext)) return "xml";
  if (ext === "sql") return "sql";
  return "plain";
}
