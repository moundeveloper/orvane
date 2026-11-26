import { createImageStore } from "./images.ts";
import { NotesService } from "./notes.ts";

export type HostNotes = ReturnType<typeof hostNotes>;

/**
 * Notes for the laptop: the desktop's own notes store (the same pages in
 * workspace.sqlite) and the pictures placed in notes. Pasted pictures are
 * stored like on the desktop; nothing reads files by path or from the web.
 */
export function hostNotes(directory: string, filename: string) {
  const service = new NotesService(directory, filename);
  const images = createImageStore(directory);
  const uploaded = new Set<string>();
  return {
    data: (args: unknown) => service.invoke("data", args),
    image: (id: string) => {
      const file = images.file(id);
      return file && (uploaded.has(id) || service.usesImage(`/__orvane/files/image/${id}`)) ? file : null;
    },
    importImage: async (dataUrl: unknown, name: unknown) => {
      if (typeof dataUrl !== "string") throw Error("Paste a picture to place it in a note.");
      // SVG can carry scripts; the laptop only adds bitmap pictures.
      if (/^data:image\/svg/i.test(dataUrl)) throw Error("SVG pictures can only be added on the desktop.");
      const image = await images.fromDataUrl(dataUrl, typeof name === "string" ? name : "Image");
      uploaded.add(image.id);
      return image;
    },
    close: () => service.close(),
  };
}
