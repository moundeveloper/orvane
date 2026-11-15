import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

type FileStamp = { size: number; hash: string };
type Scan = { files: Map<string, FileStamp>; skipped: number };
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const keyOf = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;
function parts(relative: string) {
  const items = relative.split("/");
  if (
    items.some(
      (part) => !part || part === "." || part === ".." || /[\\:\0]/.test(part),
    )
  )
    throw Error("Invalid comparison path.");
  return items;
}
async function checkFolder(path: string) {
  if (!(await lstat(path)).isDirectory())
    throw Error("Choose a directory that is not a filesystem link.");
}
async function stamp(path: string): Promise<FileStamp> {
  const info = await lstat(path);
  if (!info.isFile()) throw Error("Only regular files are supported.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: info.size, hash: hash.digest("hex") };
}
async function scan(root: string): Promise<Scan> {
  await checkFolder(root);
  const files = new Map<string, FileStamp>();
  let skipped = 0,
    total = 0;
  const pending = [""];
  while (pending.length) {
    const folder = pending.pop()!;
    await checkFolder(join(root, folder));
    for (const item of await readdir(join(root, folder), {
      withFileTypes: true,
    })) {
      if (++total > 20000)
        throw Error(
          "Choose smaller folders. This comparison supports up to 20,000 entries per folder.",
        );
      const relative = folder ? folder + "/" + item.name : item.name;
      if (item.isDirectory()) pending.push(relative);
      else if (item.isFile())
        files.set(relative, await stamp(join(root, relative)));
      else skipped++;
    }
  }
  return { files, skipped };
}
export async function compareFolders(left: string, right: string) {
  const [a, b] = await Promise.all([scan(left), scan(right)]);
  const pairs = new Map<
    string,
    { path: string; left?: FileStamp; right?: FileStamp }
  >();
  for (const [path, file] of a.files)
    pairs.set(keyOf(path), { path, left: file });
  for (const [path, file] of b.files) {
    const key = keyOf(path),
      pair = pairs.get(key);
    if (pair) pair.right = file;
    else pairs.set(key, { path, right: file });
  }
  const changes = [...pairs.values()]
    .filter((pair) => pair.left?.hash !== pair.right?.hash)
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    changes,
    identical: pairs.size - changes.length,
    skipped: a.skipped + b.skipped,
  };
}
async function checkedPath(
  root: string,
  relative: string,
  createParents = false,
) {
  await checkFolder(root);
  const names = parts(relative);
  let cursor = root;
  for (const folder of names.slice(0, -1)) {
    cursor = join(cursor, folder);
    if (createParents) {
      try {
        await mkdir(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await checkFolder(cursor);
  }
  return join(cursor, names.at(-1)!);
}
export async function copyComparedFile(
  from: string,
  to: string,
  relative: string,
  expectedSource: string,
  expectedTarget?: string,
) {
  const source = await checkedPath(from, relative);
  if (!(await lstat(source)).isFile())
    throw Error("Only regular files can be copied.");
  const target = await checkedPath(to, relative, !expectedTarget);
  const staged = join(dirname(target), `.orvane-copy-${randomUUID()}.tmp`);
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    if ((await stamp(staged)).hash !== expectedSource)
      throw Error("The source changed. Compare the folders again.");
    if (expectedTarget) {
      if ((await stamp(target)).hash !== expectedTarget)
        throw Error("The destination changed. Compare the folders again.");
      await rename(staged, target);
    } else {
      try {
        await copyFile(staged, target, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw Error(
            "A file or folder already exists at the destination. Compare again.",
          );
        throw error;
      }
    }
    return { ok: true };
  } finally {
    await unlink(staged).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}
export async function diffComparedFile(
  left: string,
  right: string,
  relative: string,
) {
  const paths = await Promise.all([
    checkedPath(left, relative),
    checkedPath(right, relative),
  ]);
  for (const path of paths)
    if (!(await lstat(path)).isFile())
      throw Error("Only regular files can be diffed.");
  return new Promise<{ patch: string }>((done, fail) => {
    // Absolute path arguments are data, with Git's external helpers disabled.
    const child = spawn(
      "git",
      [
        "--no-pager",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        ...paths,
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      fail(Error("The diff timed out."));
    }, 15000);
    child.once("error", () => {
      clearTimeout(timer);
      fail(Error("Git is required to open file diffs."));
    });
    child.stdout.on("data", (buffer: Buffer) => {
      bytes += buffer.length;
      if (bytes <= 2_000_000) chunks.push(buffer);
      else {
        child.kill();
        fail(Error("This diff exceeds 2 MB."));
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1)
        return fail(Error("Git could not compare these files."));
      done({ patch: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
