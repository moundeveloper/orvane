// Turns whatever was dropped (File Explorer items, files from the system,
// images dragged out of a web page) into images stored by the local server.
import { api, DRAG_MIME, isImage } from "./components/files/explorer";

export type PlacedImage = { value: string; name: string };
export const IMAGE_ID = /^[a-f\d]{40}\.(png|jpg|gif|webp|bmp|ico|svg|avif)$/;
export function imageSource(value: string) {
  if (IMAGE_ID.test(value)) return `/__orvane/files/image/${value}`;
  return /^https?:\/\//i.test(value) ? value : "";
}

// Synchronous check usable in dragover, where data is not readable yet.
export function mayHoldImage(dt: DataTransfer | null) {
  if (!dt) return false;
  const types = [...dt.types];
  return types.includes(DRAG_MIME) || types.includes("Files") || types.includes("text/uri-list") || types.includes("text/html");
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}
async function place(args: Record<string, unknown>): Promise<PlacedImage> {
  const result = await api<{ id?: string; url?: string; name: string }>("import-image", args);
  return { value: result.id ?? result.url ?? "", name: result.name };
}
export function importPath(path: string) {
  return place({ path });
}
// The data must be read synchronously inside the drop handler; the returned
// promises do the slow part afterwards.
export function importDrop(dt: DataTransfer): { jobs: Promise<PlacedImage>[]; skipped: number } {
  const jobs: Promise<PlacedImage>[] = [];
  let skipped = 0;
  const internal = dt.getData(DRAG_MIME);
  if (internal) {
    try {
      const paths: string[] = JSON.parse(internal).paths ?? [];
      for (const path of paths) isImage(path) ? jobs.push(importPath(path)) : skipped++;
    } catch {
      // Not ours after all.
    }
    return { jobs, skipped };
  }
  const files = [...dt.files];
  if (files.length) {
    for (const file of files)
      if (file.type.startsWith("image/"))
        jobs.push(readDataUrl(file).then((dataUrl) => place({ dataUrl, name: file.name.replace(/\.[^.]+$/, "") })));
      else skipped++;
    if (jobs.length) return { jobs, skipped };
  }
  // A web image: its address is in the HTML fragment or the URI list.
  const html = dt.getData("text/html");
  const fromHtml = html && new DOMParser().parseFromString(html, "text/html").querySelector("img")?.getAttribute("src");
  const uri = dt
    .getData("text/uri-list")
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith("#"));
  const url = fromHtml || uri;
  if (url && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url))) jobs.push(place({ url }));
  return { jobs, skipped };
}
// Natural size, for sizing the new widget to the picture.
export function measure(value: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 480, height: img.naturalHeight || 360 });
    img.onerror = () => resolve({ width: 480, height: 360 });
    img.src = imageSource(value);
  });
}
