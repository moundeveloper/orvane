import { computed, ref, watch, type InjectionKey, type Ref } from "vue";
import { getThemeMediaUrl, THEME_BACKGROUNDS, type WorkspaceTheme } from "./workspaceTheme";

export const TERMINAL_DARK: InjectionKey<Readonly<Ref<boolean>>> = Symbol("terminal-dark");
type RGB = readonly [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as RGB;

// Compare the wallpaper after the canvas-coloured Soften veil. Sampling is
// deliberately tiny and independent of the camera and animation frame loop.
export function darkWallpaper(sample: RGB, canvas: string, soften: number) {
  const veil = rgb(canvas), alpha = soften / 100;
  const linear = sample.map((v, i) => {
    const c = (v * (1 - alpha) + veil[i]! * alpha) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722 < 0.3;
}

export function useTerminalTint(theme: Ref<WorkspaceTheme>) {
  const sample = ref<RGB>();
  const source = computed<{ url: string | undefined; video: boolean } | undefined>((previous) => {
    const t = theme.value, kind = t.backgroundType;
    if (kind !== "image" && kind !== "video") return undefined;
    const id = t[kind];
    const next = t.media?.[kind]?.id === id
      ? { url: getThemeMediaUrl(id), video: kind === "video" }
      : { url: THEME_BACKGROUNDS[kind].find((v) => v.id === id)?.poster, video: false };
    return previous?.url === next.url && previous?.video === next.video ? previous : next;
  });
  watch(source, (source, _, cleanup) => {
    sample.value = undefined;
    if (!source?.url) return;
    let stopped = false;
    const media = source.video ? document.createElement("video") : new Image();
    function finish() {
      clearTimeout(timer);
      media.onload = media.onerror = null;
      if (media instanceof HTMLVideoElement) {
        media.onloadeddata = null;
        media.removeAttribute("src");
        media.load();
      }
    }
    function loaded() {
      if (stopped) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        // Transparent source pixels show the canvas underneath.
        ctx.fillStyle = theme.value.palette.canvas;
        ctx.fillRect(0, 0, 16, 16);
        ctx.drawImage(media, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < data.length; i += 4)
          for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!;
        sample.value = sum.map((v) => v / 256) as unknown as RGB;
      } catch { /* Failed media reads retain the light material. */ }
      finally { finish(); }
    }
    const timer = setTimeout(finish, 8000);
    media.onerror = finish;
    if (media instanceof HTMLVideoElement) {
      media.muted = true;
      media.preload = "auto";
      media.onloadeddata = loaded;
    } else media.onload = loaded;
    media.src = source.url;
    cleanup(() => { stopped = true; finish(); });
  }, { immediate: true });
  return computed(() => {
    const t = theme.value;
    if (t.backgroundType === "plain") return false;
    const value = t.backgroundType === "code" ? rgb(t.palette.canvas) : sample.value;
    return !!value && darkWallpaper(value, t.palette.canvas, t.soften);
  });
}
