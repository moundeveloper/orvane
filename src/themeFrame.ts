import type { ThemePalette } from "./workspaceTheme.ts";

export type ThemeFrame = (
  ctx: CanvasRenderingContext2D, w: number, h: number, t: number,
  theme: ThemePalette & { rgba: (color: string, alpha: number) => string },
) => void;

export function themeRgba(color: string, alpha: number) {
  const value = Number.parseInt(color.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
