import type { ThemeFrame } from "./themeFrame.ts";

export const draw: ThemeFrame = (ctx, w, h, t, theme) => {
  // Orvane's dot grid, breathing slowly
  const gap = 22;
  ctx.fillStyle = theme.canvas;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = theme.rgba(theme.text, 0.34);
  for (let y = gap / 2; y < h; y += gap) {
    for (let x = gap / 2; x < w; x += gap) {
      const wave = Math.sin(x * 0.012 + t * 0.6)
                 + Math.cos(y * 0.016 - t * 0.4);
      ctx.beginPath();
      ctx.arc(x, y + wave * 3, 1.1 + wave * 0.35, 0, 7);
      ctx.fill();
    }
  }
};
