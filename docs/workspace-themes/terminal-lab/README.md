# Terminal over wallpaper

The owner picked **Auto tint** in UI Maker Lab, `theme-settings/r2`. Open the HTML files locally to try the original mocks. Press **1** for Dark, **2** for Light, and **3** for Plain.

- [Auto tint](auto-tint.html) — smoked glass on dark wallpaper, light frost on light wallpaper.
- [Current halo](halo-current.html) — the current app behavior and comparison baseline.
- [Deep frost](deep-frost.html) — stronger blur and a brighter glass surface.
- [Inset screen](inset-screen.html) — light terminal output panel inside a glass frame.
- [Line plates](line-plates.html) — light plates behind text and controls.
- [Soft clearing](soft-clearing.html) — a soft fade behind the terminal text.

## Implementation handoff

Auto tint is implemented on `codex/terminal-auto-tint` (27.11.2026), starting from `605efce`, verified against the fetched `origin/master`. It uses the two wallpaper states in the approved HTML. Plain keeps its existing appearance. The previous wallpaper halo is removed.

Measure a small sample once when the wallpaper source changes. Use an image or bundled video poster, the first loaded frame for an imported video, and the canvas color for the code animations. Account for the Soften layer and skip per-frame sampling. Use the dark material only for Terminal surfaces on dark wallpapers. Switch the live xterm foreground, cursor, selection, and ANSI colors in `src/components/terminal/TerminalPane.vue` without reopening the shell. Verify the result over dark and light wallpapers in an isolated desktop workspace.

## Verification — 27.11.2026

- `src/terminalTint.ts` takes a 16×16 sample per media source and computes the material after the canvas-coloured Soften veil. Code backgrounds use the canvas colour. No animation-frame sampling. Unreadable media falls back to light frost.
- The selected mock's glass, blur, saturation, title, toolbar and tab colours are carried into the Terminal app. Live xterm foreground, cursor, selection, scrollbar and ANSI colours switch without remounting. The opaque Projects terminal keeps its existing light palette.
- `pnpm type-check` and `pnpm build` passed.
- Production-preview checks: 17/17 across Appearance, Browser, navigation and terminal output; two additional zoom/popover checks passed. File Explorer's Ctrl+K test completed its visibility assertion but failed deleting the temporary folder with Windows `EBUSY`.
- `tests/terminal-auto-tint.spec.ts`: 2/2 passed, browser and isolated Electron, run serially. Covers dark/light/Plain, imported video frame sampling, Soften without resampling, Apply/Discard, and the same xterm instance/output throughout. Desktop captures were visually inspected: `artifacts/terminal-auto-tint/desktop-dark.png` and `desktop-light.png`.
- `pnpm test:css` reports the already documented `FlowTestsView.vue` scrollbar rules. The dev-server Appearance run stalled at workspace startup; production-preview checks passed. The full test suite was not run.
- No changes to Electron main/preload. Reload the owner's window to load the frontend changes; the owner's real workspace was not used for verification.
- A concurrent edit to `src/components/AgentSessions.vue` appeared during verification and was left untouched. Nothing was committed, pushed or merged.
