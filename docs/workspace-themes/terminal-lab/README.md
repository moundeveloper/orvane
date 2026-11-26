# Terminal over wallpaper

The owner picked **Auto tint** in UI Maker Lab, `theme-settings/r2`. Open the HTML files locally to try the original mocks. Press **1** for Dark, **2** for Light, and **3** for Plain.

- [Auto tint](auto-tint.html) — smoked glass on dark wallpaper, light frost on light wallpaper.
- [Current halo](halo-current.html) — the current app behavior and comparison baseline.
- [Deep frost](deep-frost.html) — stronger blur and a brighter glass surface.
- [Inset screen](inset-screen.html) — light terminal output panel inside a glass frame.
- [Line plates](line-plates.html) — light plates behind text and controls.
- [Soft clearing](soft-clearing.html) — a soft fade behind the terminal text.

## Implementation handoff

Auto tint is pending. Follow the two wallpaper states in the approved HTML. Plain uses its existing appearance. Remove the wallpaper halo in `src/style.css` when replacing it with Auto tint.

Measure a small sample once when the wallpaper source changes. Use an image or bundled video poster, the first loaded frame for an imported video, and the canvas color for the code animations. Account for the Soften layer and skip per-frame sampling. Use the dark material only for Terminal surfaces on dark wallpapers. Switch the live xterm foreground, cursor, selection, and ANSI colors in `src/components/terminal/TerminalPane.vue` without reopening the shell. Verify the result over dark and light wallpapers in an isolated desktop workspace.
