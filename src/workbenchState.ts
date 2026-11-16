export type ClipRect = { x: number; y: number; width: number; height: number };
export type BrowserClip = {
  url: string;
  rect: ClipRect;
  image: string;
  blockId: string;
  tabId: string;
  /** "live" shows the page itself, cropped; otherwise a refreshable picture. */
  mode?: "snapshot" | "live";
  /** Live clips: a dragged area, or a picked element found by selector. */
  pick?: "area" | "element";
  selector?: string;
  /** The page's viewport when pinned (CSS pixels), so it lays out the same. */
  viewport?: { width: number; height: number };
  /** Element clips: lay the element over the whole clip instead of cropping. */
  fill?: boolean;
};

export function readWidget<T extends object>(value: string): Partial<T> {
  try {
    const data = JSON.parse(value);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
