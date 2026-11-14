// Backups that restore completely: the workspace JSON plus every picture its
// image widgets use (stored in .orvane/images). File widgets link to files
// elsewhere on disk and are not copied.
import { flatten, type Workspace } from "./model";
import { IMAGE_ID } from "./imageDrop";
import { api } from "./components/files/explorer";

export type Backup = { orvaneBackup: 1; created: string; workspace: Workspace; images: Record<string, string> };

export function imageIds(workspace: Workspace) {
  const ids = new Set<string>();
  const blocks = [...workspace.apps.flatMap((a) => flatten(a.blocks)), ...workspace.library.flatMap((l) => flatten([l.block]))];
  for (const block of blocks) {
    if (block.kind !== "image") continue;
    if (IMAGE_ID.test(block.value)) ids.add(block.value);
    try {
      const original = JSON.parse(block.code || "{}").original;
      if (typeof original === "string" && IMAGE_ID.test(original)) ids.add(original);
    } catch {
      // No settings.
    }
  }
  return [...ids];
}
function base64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
// Missing pictures are left out and counted, so one lost file never blocks a backup.
export async function makeBackup(workspace: Workspace) {
  const images: Record<string, string> = {};
  let missing = 0;
  for (const id of imageIds(workspace)) {
    try {
      const response = await fetch(`/__orvane/files/image/${id}`);
      if (!response.ok) throw new Error();
      images[id] = await base64(await response.blob());
    } catch {
      missing++;
    }
  }
  const backup: Backup = { orvaneBackup: 1, created: new Date().toISOString(), workspace, images };
  return { backup, count: Object.keys(images).length, missing };
}
export function isBackup(value: unknown): value is Backup {
  const v = value as Backup;
  return !!v && v.orvaneBackup === 1 && !!v.workspace && typeof v.images === "object" && !!v.images;
}
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", avif: "image/avif",
};
// Restores pictures before the workspace is applied. The server stores by
// content hash, so a picture that does not match its id is rejected.
export async function restoreImages(images: Record<string, string>) {
  let restored = 0,
    rejected = 0;
  for (const [id, data] of Object.entries(images)) {
    if (!IMAGE_ID.test(id) || typeof data !== "string") {
      rejected++;
      continue;
    }
    const ext = id.split(".").pop()!;
    try {
      const result = await api<{ id: string }>("import-image", { dataUrl: `data:${MIME[ext]};base64,${data}`, name: "Image" });
      result.id === id ? restored++ : rejected++;
    } catch {
      rejected++;
    }
  }
  return { restored, rejected };
}
