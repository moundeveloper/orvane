# Motion reference: "That one desktop setup" (43pr, Hyprland)

Source: https://www.youtube.com/watch?v=kYZ5mkGuQEg (50 s, 1080p, true 60 fps).
Config: https://github.com/43PR/dotfiles (`.config/hypr/look.lua`, `.config/quickshell/*`).

Values below are **verified** when the config states them and the 60 fps frames agree.
They are **measured** when they come only from the frames.

## Why it feels smooth

1. **One hero curve, very front-loaded.** `cubic-bezier(0.05, 0.9, 0.1, 1)`. About 43% of the
   motion happens in the first frame and 80% within ~70 ms. The rest is a long, quiet settle.
   The eye sees an instant response, then a soft landing. No overshoot.
2. **Durations are long, but feel short.** Windows run 500 ms, yet they read as "instant" because
   the curve finishes most of the travel in the first 100 ms.
3. **Small UI is fast and plain.** Panels and hovers use OutCubic at 100–280 ms.
4. **Close is faster than open.** Panels close at open / 2.2 with InCubic (no overshoot on exit).
5. **Fade and transform are split.** Opacity uses its own shorter or linear timing.
   Scale/position use the hero curve. They never share one easing.
6. **Only transform, opacity and blur animate.** No layout-size animation.
7. **True 60 fps output with no dropped frames** in the motion segments (16 duplicate frames of 442).

## Tokens

| Token | Value | Source |
|---|---|---|
| `--ease-hero` | `cubic-bezier(0.05, 0.9, 0.1, 1)` | verified: `hl.curve("easeOut")`, fit RMSE 0.005 vs frames |
| `--ease-out` (OutCubic) | `cubic-bezier(0.33, 1, 0.68, 1)` | verified: most QML `Behavior`s |
| `--ease-in` (InCubic, close) | `cubic-bezier(0.32, 0, 0.67, 0)` | verified: `PerspectivePanel.closeEasing` |
| `--ease-pop` (OutBack) | `cubic-bezier(0.34, 1.56, 0.64, 1)` | verified: `PerspectivePanel.popEasing` |
| `--ease-fade` (InOutQuad) | `cubic-bezier(0.45, 0, 0.55, 1)` | verified: carousel intro fade |
| `--dur-fast` | 100 ms (120 in some modules) | verified: `Theme.animFast` |
| `--dur-med` | 200 ms (220) | verified: `Theme.animMed` |
| `--dur-slow` | 280 ms | verified: `Theme.animSlow` |
| `--dur-window` | 500 ms | verified: Hyprland speed 5 (1 unit = 100 ms); measured ~460 ms |
| `--dur-fade` | 400 ms, Hyprland `default` curve | verified: `fade` speed 4 |
| `--dur-workspace` | 600 ms, slide + fade vertical | verified: `workspaces` speed 6 |

## Per-element recipes

### Window open / close (00:19.97, 00:29.07)
- Open: scale from ~0 to 1 around the centre, `--ease-hero`, 500 ms. Opacity in parallel, 400 ms.
- Measured width at 60 fps: 0.43, 0.61, 0.71, 0.78, 0.82, 0.85, 0.88, 0.90 ... 0.99 at 300 ms.
- At 00:20.25 the window re-tiles to its final size (0.99 → 0.71) with the same curve in ~250 ms.
- Close: same curve, 500 ms; visible change ends in ~200 ms because the curve is front-loaded.

### Tiling reflow (00:23.65, ~0.9 s)
- Every window moves/resizes at once with `--ease-hero`. No stagger.

### Popup panel / launcher (00:13.25, 00:15.60)
- Opacity: `--dur-med`, OutCubic.
- Scale: from 0.88 to 1, `--dur-slow` (280 ms), OutBack.
- Tilt: enters from rotateX(20°) rotateY(-16°) to 0, 280 ms, OutCubic.
  While open, follows the pointer with up to 7° parallax.
- Close: all durations ÷ 2.2, scale with InCubic.
- Measured progress (pixel diff): 50% at first frame, 88% at 40%, done at 250 ms.

### Side button stack (00:13.25)
- Fades in together with the panel within ~100 ms. No stagger, no slide.

### Settings sheet inside an app
- Opacity 220 ms; scale 0.96 → 1, 220 ms, OutCubic.

### Lock screen (00:03–00:10)
- Fade in/out, linear, 500 ms (`hyprlock` fadeIn/fadeOut speed 5).
- Background blur: 3 passes, size 5. Rounding 25.

### Wallpaper carousel (00:29.8)
- Launch: opacity 0 → 1 (300 ms, InOutQuad); scale 0.94 → 1 and rise 24 px → 0 (300 ms, OutCubic).
- Scrolling: `SmoothedAnimation` on contentX, velocity-based, max 1000 ms.
  One wheel notch = one tile; notches accumulate, so a fast flick chains smoothly.
- Layout per tile from its distance `f` (0 centre, 1 edge):
  - scale = 0.4 + (0.7 − 0.4) · f^1.75
  - rotateY = ±25° · f^1.25, inner edge nearer, real perspective (camera = 3 tile widths)
  - z-order by scale; active tile on top. Inactive opacity 0.8, active 1.0, 150 ms.

### Wallpaper change (00:36.05, 00:37.00)
- `awww` transition `outer` (circle), 1 s default. Visible circle travel measured ~570 ms.

## Reuse in CSS

```css
:root {
  --ease-hero: cubic-bezier(0.05, 0.9, 0.1, 1);
  --ease-out: cubic-bezier(0.33, 1, 0.68, 1);
  --ease-in: cubic-bezier(0.32, 0, 0.67, 0);
  --ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);
  --dur-fast: 100ms; --dur-med: 200ms; --dur-slow: 280ms; --dur-window: 500ms;
}
.window { transition: transform var(--dur-window) var(--ease-hero), opacity 400ms ease; }
.window[data-entering] { transform: scale(0); opacity: 0; }

.panel { transform-origin: center; transition:
  opacity var(--dur-med) var(--ease-out),
  transform var(--dur-slow) var(--ease-pop); }
.panel:not(.open) { opacity: 0; transform: perspective(900px) rotateX(20deg) rotateY(-16deg) scale(0.88);
  transition-duration: calc(var(--dur-med) / 2.2), calc(var(--dur-slow) / 2.2);
  transition-timing-function: var(--ease-out), var(--ease-in); }

@media (prefers-reduced-motion: reduce) {
  .window, .panel { transition-duration: 0.01ms !important; }
}
```

## Not verified

- The exact Hyprland window style (`popin` %) is not in the config; frames show scale from ~0.
- Carousel scroll speed (`main.speed`) default was not read.
- The pixel-diff curves for multi-element scenes (tiling, carousel) are rough; use the config values.
