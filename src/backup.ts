// Backups that restore completely: the workspace JSON plus every picture its
// image widgets use (stored in .orvane/images). File widgets link to files
// elsewhere on disk and are not copied.
import { flatten, type Workspace } from "./model";
import { IMAGE_ID } from "./imageDrop";
import { api } from "./components/files/explorer";
import { readWidget, type BrowserClip } from "./workbenchWidgets";
import { getThemeMediaUrl, MAX_THEME_MEDIA, THEME_MEDIA_TYPES } from "./workspaceTheme";

type BackgroundFile = { mime: string; data: string };
export type Backup = { orvaneBackup: 1; created: string; workspace: Workspace; images: Record<string, string>; backgrounds?: Record<string, BackgroundFile> };

export function imageIds(workspace: Workspace) {
  const ids = new Set<string>();
  for (const capture of workspace.inbox ?? [])
    if (capture.kind === "image") ids.add(capture.value);
  const blocks = [...workspace.apps.flatMap((a) => flatten(a.blocks)), ...workspace.library.flatMap((l) => flatten([l.block]))];
  for (const block of blocks) {
    if (block.kind === "browser-clip") {
      const { image } = readWidget<BrowserClip>(block.value);
      if (typeof image === "string" && IMAGE_ID.test(image)) ids.add(image);
    }
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
  const backgrounds: Record<string, BackgroundFile> = {};
  let missingBackgrounds = 0;
  for (const media of Object.values(workspace.appearance?.media ?? {})) {
    if (!media) continue;
    try {
      const response = await fetch(getThemeMediaUrl(media.id));
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      backgrounds[media.id] = { mime: blob.type, data: await base64(blob) };
    } catch {
      missingBackgrounds++;
    }
  }
  const backup: Backup = {
    orvaneBackup: 1, created: new Date().toISOString(), workspace, images,
    ...(Object.keys(backgrounds).length ? { backgrounds } : {}),
  };
  return { backup, count: Object.keys(images).length, missing, missingBackgrounds };
}
export async function restoreBackgrounds(
  workspace: Workspace,
  backgrounds: Backup["backgrounds"],
  upload: (id: string, file: File) => Promise<void>,
) {
  if (!backgrounds) return 0;
  let rejected = 0;
  for (const kind of ["image", "video"] as const) {
    const media = workspace.appearance?.media?.[kind];
    if (!media || !Object.hasOwn(backgrounds, media.id)) continue;
    const entry = backgrounds[media.id];
    const supported: readonly string[] = THEME_MEDIA_TYPES[kind];
    try {
      if (!entry || !supported.includes(entry.mime) || typeof entry.data !== "string" ||
        entry.data.length > 4 * Math.ceil(MAX_THEME_MEDIA / 3)) throw new Error();
      const bytes = Uint8Array.from(atob(entry.data), (char) => char.charCodeAt(0));
      await upload(media.id, new File([bytes], media.name, { type: entry.mime }));
    } catch {
      rejected++;
    }
  }
  return rejected;
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
