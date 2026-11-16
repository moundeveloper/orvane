// Image store for canvas image widgets. Images dropped on the canvas are
// copied here (content-addressed), so a widget keeps working when the
// original file moves or the web page changes. Workspace JSON stores only ids.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { IMAGE_ID } from "../src/imageId.ts";

const LIMIT = 30_000_000;
export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
};
const EXT_OF: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_MIME).map(([ext, mime]) => [mime, ext === "jpeg" ? "jpg" : ext]),
);
export function createImageStore(directory: string) {
  const folder = join(directory, "images");
  async function save(data: Buffer, ext: string, name: string) {
    if (!data.length) throw new Error("The image is empty.");
    if (data.length > LIMIT) throw new Error("Images up to 30 MB can be placed on the canvas.");
    const id = `${createHash("sha1").update(data).digest("hex")}.${ext === "jpeg" ? "jpg" : ext}`;
    await mkdir(folder, { recursive: true });
    const file = join(folder, id);
    if (!existsSync(file)) await writeFile(file, data);
    return { id, name: name.slice(0, 200) || "Image" };
  }
  return {
    file(id: string) {
      return IMAGE_ID.test(id) ? join(folder, id) : null;
    },
    async fromPath(path: string) {
      const ext = extname(path).slice(1).toLowerCase();
      if (!IMAGE_MIME[ext]) throw new Error("Only image files can be placed as image widgets.");
      if ((await stat(path)).size > LIMIT) throw new Error("Images up to 30 MB can be placed on the canvas.");
      return save(await readFile(path), ext, basename(path, extname(path)));
    },
    async fromDataUrl(value: string, name: string) {
      const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(value);
      const ext = match && EXT_OF[match[1]!.toLowerCase()];
      if (!match || !ext) throw new Error("That is not a supported image.");
      return save(Buffer.from(match[2]!, "base64"), ext, name);
    },
    // Downloads a dragged web image. Pages behind a sign-in or with hotlink
    // protection may refuse; the caller then keeps the URL itself.
    async fromUrl(url: string) {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only web images can be downloaded.");
      const response = await fetch(parsed, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!response.ok) throw new Error(`The image could not be downloaded (${response.status}).`);
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const fromName = extname(parsed.pathname).slice(1).toLowerCase();
      const ext = EXT_OF[type] ?? (IMAGE_MIME[fromName] ? fromName : "");
      if (!ext) throw new Error("The link does not point to an image.");
      if (Number(response.headers.get("content-length")) > LIMIT)
        throw new Error("Images up to 30 MB can be placed on the canvas.");
      const data = Buffer.from(await response.arrayBuffer());
      const name = decodeURIComponent(basename(parsed.pathname, extname(parsed.pathname))) || parsed.hostname;
      return save(data, ext, name);
    },
  };
}
