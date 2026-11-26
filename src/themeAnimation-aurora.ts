import type { ThemeFrame } from "./themeFrame.ts";

export const draw: ThemeFrame = (ctx, w, h, t, theme) => {
  // Three slow ribbons in the accent colours
  ctx.fillStyle = theme.canvas;
  ctx.fillRect(0, 0, w, h);
  const ribbons: [string, number, number][] = [[theme.accent, 0.30, 0.18],
                   [theme.run, 0.44, 0.10],
                   [theme.accent, 0.58, 0.13]];
  ribbons.forEach(([c, base, a], i) => {
    const g = ctx.createLinearGradient(0, h * (base - 0.15), 0, h * (base + 0.3));
    g.addColorStop(0, theme.rgba(c, 0));
    g.addColorStop(0.35, theme.rgba(c, a));
    g.addColorStop(1, theme.rgba(c, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 24)
      ctx.lineTo(x, h * base + Math.sin(x * 0.003 + t * 0.25 + i * 2) * h * 0.08);
    ctx.lineTo(w, h);
    ctx.fill();
  });
};
