import { z } from "zod";

const hex = z.string().regex(/^#[\da-f]{6}$/i);
const paletteSchema = z.object({ canvas: hex, app: hex, text: hex, accent: hex, run: hex });
const mediaSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(200) });
// Palette from image: the image a palette was built from, its colour groups
// (enough to rebuild the palette at another strength) and the strength used.
const paletteImageSchema = mediaSchema.extend({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  strength: z.enum(["quiet", "balanced", "vivid"]),
  swatches: z.array(z.object({ hex, weight: z.number().min(0).max(1) })).min(1).max(6),
});
export const workspaceThemeSchema = z.object({
  preset: z.enum(["orvane", "sage", "sand", "harbor", "heather", "image", "custom"]),
  palette: paletteSchema,
  backgroundType: z.enum(["plain", "image", "video", "code"]),
  image: z.union([z.enum(["lake", "dunes", "paper"]), z.uuid()]),
  video: z.union([z.enum(["clouds", "rain", "tide"]), z.uuid()]),
  code: z.enum(["dots", "flow", "aurora"]),
  soften: z.number().min(0).max(80),
  dots: z.boolean(),
  speed: z.number().min(0.25).max(2),
  media: z.object({ image: mediaSchema.optional(), video: mediaSchema.optional() }).optional(),
  paletteImage: paletteImageSchema.optional(),
}).refine((theme) => (["image", "video"] as const).every((kind) =>
  !z.uuid().safeParse(theme[kind]).success || theme.media?.[kind]?.id === theme[kind],
));

export type WorkspaceTheme = z.infer<typeof workspaceThemeSchema>;
export type ThemePalette = WorkspaceTheme["palette"];
export type ThemePaletteKey = keyof ThemePalette;
export type ThemeBackgroundType = WorkspaceTheme["backgroundType"];
export type ThemeMediaKind = "image" | "video";
export type ThemePaletteImage = NonNullable<WorkspaceTheme["paletteImage"]>;

export const THEME_PRESETS = [
  { id: "orvane", name: "Orvane", palette: { canvas: "#e9edf0", app: "#f7f9fa", text: "#455968", accent: "#6f8998", run: "#365f78" } },
  { id: "sage", name: "Sage", palette: { canvas: "#e6ebe4", app: "#f8f9f6", text: "#46574a", accent: "#76907a", run: "#3d644d" } },
  { id: "sand", name: "Sand", palette: { canvas: "#eeeae3", app: "#fbf9f6", text: "#574e45", accent: "#a0896b", run: "#6c5434" } },
  { id: "harbor", name: "Harbor", palette: { canvas: "#e2e9f1", app: "#f6f9fc", text: "#3d5570", accent: "#5d86aa", run: "#2c5d8a" } },
  { id: "heather", name: "Heather", palette: { canvas: "#ebe8ef", app: "#faf9fb", text: "#524a60", accent: "#8a7ca4", run: "#5a4a7c" } },
] as const;

export const THEME_COLORS: { key: ThemePaletteKey; label: string }[] = [
  { key: "canvas", label: "Canvas" }, { key: "app", label: "Windows" },
  { key: "text", label: "Text" }, { key: "accent", label: "Accent" }, { key: "run", label: "Working" },
];

export const DEFAULT_THEME: WorkspaceTheme = {
  preset: "orvane",
  palette: THEME_PRESETS[0].palette,
  backgroundType: "plain",
  image: "lake",
  video: "clouds",
  code: "dots",
  soften: 25,
  dots: true,
  speed: 1,
};

export const THEME_MEDIA_TYPES = {
  image: ["image/jpeg", "image/png", "image/webp", "image/avif"],
  video: ["video/mp4", "video/webm"],
} as const;
export const MAX_THEME_MEDIA = 30 * 1024 * 1024;

const asset = (file: string) => `/themes/${file}`;
type BackgroundOption = { id: string; name: string; detail: string; poster: string; source?: string };
export const THEME_BACKGROUNDS: Record<ThemeMediaKind | "code", BackgroundOption[]> = {
  image: [
    { id: "lake", name: "Lake morning", detail: "1600×1000", poster: asset("lake.svg") },
    { id: "dunes", name: "Fog dunes", detail: "1600×1000", poster: asset("dunes.svg") },
    { id: "paper", name: "Paper", detail: "400 px tile", poster: asset("paper.svg") },
  ],
  video: [
    { id: "clouds", name: "Slow clouds", detail: "0:12 loop", poster: asset("clouds.webp"), source: asset("clouds.webm") },
    { id: "rain", name: "Rain on glass", detail: "0:08 loop", poster: asset("rain.webp"), source: asset("rain.webm") },
    { id: "tide", name: "Tide", detail: "0:16 loop", poster: asset("tide.webp"), source: asset("tide.webm") },
  ],
  code: [
    { id: "dots", name: "Drifting dots", detail: "JS · 14 lines", poster: asset("dots.webp") },
    { id: "flow", name: "Flow lines", detail: "JS · 16 lines", poster: asset("flow.webp") },
    { id: "aurora", name: "Soft aurora", detail: "JS · 19 lines", poster: asset("aurora.webp") },
  ],
};

const previews = new Map<string, string>();
export function addThemeMediaPreview(id: string, file: File) {
  previews.set(id, URL.createObjectURL(file));
}
export function clearThemeMediaPreview(id: string) {
  const url = previews.get(id);
  if (url) URL.revokeObjectURL(url);
  previews.delete(id);
}
export function getThemeMediaUrl(id: string) {
  return previews.get(id) ?? `/__orvane/storage/theme-media/${encodeURIComponent(id)}`;
}

export function themePaletteStyle(palette: ThemePalette) {
  if (THEME_COLORS.every(({ key }) => palette[key] === DEFAULT_THEME.palette[key])) return {};
  return {
    "--theme-canvas": palette.canvas,
    "--surface": palette.app,
    "--theme-text": palette.text,
    "--accent": palette.accent,
    "--theme-run": palette.run,
  };
}
