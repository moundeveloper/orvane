// Zip and unzip for the File Explorer, with node:zlib only. Writes standard
// ZIP (deflate, UTF-8 names); reads stored/deflated entries. ZIP64 archives
// (over 4 GB or 65,535 entries) are refused rather than mangled.
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { once } from "node:events";

const TOTAL_LIMIT = 2_000_000_000;
const ENTRY_LIMIT = 65_000;

async function collect(root: string, base: string, out: { path: string; name: string; dir: boolean }[]) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  const name = relative(base, root).split(sep).join("/");
  if (info.isDirectory()) {
    out.push({ path: root, name: name + "/", dir: true });
    for (const child of await readdir(root)) await collect(join(root, child), base, out);
  } else if (info.isFile()) out.push({ path: root, name, dir: false });
  if (out.length > ENTRY_LIMIT) throw new Error("Too many files for one zip (limit 65,000).");
}
function dosTime(date: Date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
export async function zip(paths: string[], target: string) {
  const items: { path: string; name: string; dir: boolean }[] = [];
  for (const path of paths) await collect(path, dirname(path), items);
  const out = createWriteStream(target, { flags: "wx" });
  const central: Buffer[] = [];
  let offset = 0,
    total = 0;
  const write = async (chunk: Buffer) => {
    offset += chunk.length;
    if (!out.write(chunk)) await once(out, "drain");
  };
  try {
    for (const item of items) {
      const data = item.dir ? Buffer.alloc(0) : await readFile(item.path);
      total += data.length;
      if (total > TOTAL_LIMIT || offset > 0xfffffff0) throw new Error("The selection is too large to zip (limit 2 GB).");
      const deflated = item.dir ? data : deflateRawSync(data, { level: 6 });
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      const name = Buffer.from(item.name, "utf8");
      const { time, date } = dosTime((await stat(item.path)).mtime);
      const crc = crc32(data);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6); // UTF-8 names
      header.writeUInt16LE(stored ? 0 : 8, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(body.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(name.length, 26);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(stored ? 0 : 8, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE(item.dir ? 0x10 : 0, 38);
      entry.writeUInt32LE(offset, 42);
      central.push(entry, name);
      await write(header);
      await write(name);
      await write(body);
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(items.length, 8);
    end.writeUInt16LE(items.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await write(directory);
    await write(end);
    out.end();
    await once(out, "close");
    return { path: target, count: items.filter((i) => !i.dir).length };
  } catch (error) {
    out.destroy();
    await rm(target, { force: true });
    throw error;
  }
}
export function readZip(buffer: Buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("This is not a readable zip archive.");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("ZIP64 archives are not supported here.");
  const entries: { name: string; dir: boolean; read: () => Buffer }[] = [];
  for (let n = 0; n < count && offset + 46 <= buffer.length; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const flags = buffer.readUInt16LE(offset + 8),
      method = buffer.readUInt16LE(offset + 10),
      size = buffer.readUInt32LE(offset + 20),
      nameLength = buffer.readUInt16LE(offset + 28),
      extra = buffer.readUInt16LE(offset + 30),
      comment = buffer.readUInt16LE(offset + 32),
      local = buffer.readUInt32LE(offset + 42);
    const raw = buffer.subarray(offset + 46, offset + 46 + nameLength);
    // Bit 11 marks UTF-8; older Windows zips use the OEM code page (latin1 is the closest).
    const name = flags & 0x0800 ? raw.toString("utf8") : raw.toString("latin1");
    if (flags & 1) throw new Error("Encrypted zip archives are not supported.");
    entries.push({
      name,
      dir: name.endsWith("/"),
      read: () => {
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const data = buffer.subarray(start, start + size);
        if (method === 0) return data;
        if (method === 8) return inflateRawSync(data, { maxOutputLength: 4_000_000_000 });
        throw new Error(`“${name}” uses an unsupported compression.`);
      },
    });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}
export async function unzip(path: string, target: string) {
  const info = await stat(path);
  if (info.size > TOTAL_LIMIT) throw new Error("The archive is too large to extract here (limit 2 GB).");
  const entries = readZip(await readFile(path));
  await mkdir(target);
  const root = resolve(target);
  let files = 0;
  try {
    for (const entry of entries) {
      // Zip-slip guard: every entry must land inside the target folder.
      const destination = resolve(root, entry.name.replace(/\\/g, "/"));
      if (destination !== root && !destination.startsWith(root + sep))
        throw new Error(`“${entry.name}” would be written outside the folder.`);
      if (entry.dir) await mkdir(destination, { recursive: true });
      else {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, entry.read(), { flag: "wx" });
        files++;
      }
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { path: root, count: files, name: basename(root) };
}
