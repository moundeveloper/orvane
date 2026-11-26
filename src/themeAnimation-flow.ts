import type { ThemeFrame } from "./themeFrame.ts";

export const draw: ThemeFrame = (ctx, w, h, t, theme) => {
  // Thin contour lines drifting sideways
  ctx.fillStyle = theme.canvas;
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 1;
  for (let i = 0; i < 28; i++) {
    const y0 = (i + 0.5) * h / 28;
    const c = i % 3 ? theme.accent : theme.run;
    ctx.strokeStyle = theme.rgba(c, 0.18);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 16) {
      const y = y0 + Math.sin(x * 0.004 + t * 0.3 + i * 0.5) * 26
                   + Math.sin(x * 0.011 - t * 0.2 + i) * 9;
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
};
