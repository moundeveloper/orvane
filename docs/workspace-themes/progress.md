# Workspace themes

- [x] Merge the delegation permission fix into `master` and push it. Commit `86ba35b`.
- [x] Create `codex/workspace-themes` from the updated `master`.
- [x] Implement the approved Settings Panel from UI Maker Lab `theme-settings/r1/settings-panel`.
- [x] Connect the palette preview, canvas backgrounds, and draft controls.
- [x] Persist applied appearance and imported media in SQLite. Round-trip both through a full backup.
- [x] Compare the live panel with the approved reference and verify the workflow in isolated browser and Electron workspaces.
- [x] Improve header legibility over wallpaper. Check both header clusters and the preview badge against the user's Emerald Archive video.
- [x] Style pass (Claude, 26.11.2026): remove the top-left wordmark, put the Orvane mark in the dock's Center canvas button, theme the dock and Orvane's floating surfaces from the palette, drop the Plain header frost, and move the Appearance entry into the Workspace options settings area.
- [x] Implement the approved Terminal Auto tint. The six original Lab previews and implementation notes are in [Terminal over wallpaper](terminal-lab/README.md).

## Workflow

Open **Workspace options → Appearance → Palette and background** (the settings area, above Window and Keyboard shortcuts), or search for Appearance settings with Ctrl+K. Back returns to Workspace options with the entry focused; Esc closes and focuses the Workspace options button. Pick a palette or edit its five colors. Choose Plain, Image, Video, or Code. Image and Video accept local files. Code runs the bundled animations and shows their source read-only. Adjust the dot grid, softening, or animation speed where relevant. Apply saves to the workspace. Discard or clicking outside restores the saved appearance.

Selected video backgrounds loop silently. Motion pauses while the app is hidden. The preview switch and OS reduced-motion preference hold a still frame. Full backups include imported background files. Raw workspace exports contain the settings and local file IDs.

## Verification

- `pnpm type-check` and the production build passed.
- An isolated production preview passed 20 Playwright cases covering Appearance, existing Browser and File Explorer workflows, canvas gestures, and workspace persistence. The final two Appearance cases also passed with hidden playback checks and a full backup restore into a fresh SQLite workspace.
- An isolated Electron window verified opening Appearance, changing the live palette, playing a background video, and applying the changes. Screenshot: `artifacts/theme-desktop.png`.
- Independent 1280 × 800 visual comparison scored 97.4/100. The panel matches the reference position and dimensions. Thumbnail artwork and disabled control rendering differ slightly. Playback helper copy was shortened after review and checked in the Electron capture. Comparison images: `C:/Users/Moon/AppData/Local/Temp/orvane-theme-visual-qa/final-compare-panel-*.png`.
- Dev-server Playwright runs timed out waiting for the workspace. The production preview ran the same specs successfully. The CSS guard still reports existing scrollbar rules in `src/components/FlowTestsView.vue`.

## Style pass (26.11.2026)

What changed:

- **Header.** The frosted "orvane" wordmark and "Personal canvas" label are gone. In the frameless desktop window, an invisible 180 × 30 px strip in the same place (`.window-drag-region`) keeps the old drag handlers: `app-region: drag` normally, pointer-driven restore-drag and double-click when maximized. The browser build renders nothing there. `.top-actions` stays right-aligned; the onboarding hint centres in the free space.
- **Dock.** The Center canvas button shows `/favicon.png` (the existing Orvane mark) instead of the box icon. Its label, title, `home()` action, H shortcut, Ctrl+K command and 29 px target are unchanged.
- **Plain header frost.** `.topbar-frost` (the only Plain-mode header frost) is removed. Image, Video and Code keep the frost behind the controls (`.workspace-wallpaper .top-actions::before`). Two tests that used the band as the frost reference now probe `.workspace-frost` directly.
- **Palette on the shell.** For a non-default palette, App.vue puts `.orvane-themed` and `--theme-canvas/surface/text/accent/run` on `<html>`, so popovers teleported to `<body>` follow too. `style.css` ("Workspace palettes") derives `--shell-*` tokens: the surface mixes 20 % canvas into the window colour, plus muted, faint, line, field, hover, selected and focus colours. It themes the dock (tabs, active tab, + button, divider), `.floating-panel` (not the frosted AI launcher), `.select-popover`, the neutral status note, header text in Plain, and the memory badge. Non-scoped `<style>` blocks theme the command palette, board rail, dock action menu, tooltip and the Appearance panel (which previews the palette on itself). The default palette sets nothing, so every default colour is unchanged; a test checks the exact values. Warning notes, the window-close hover, agent status dots and the red trash action keep their colours.
- **Badge.** "Previewing theme" moved to the empty top-left (22, 17). It drops below the header under 820 px or while the onboarding hint is showing.
- **Entry.** Appearance is a settings section ("Appearance", then a "Palette and background" row showing e.g. "Sand · Plain") above Window and Keyboard shortcuts. It is no longer among the Create-app buttons.

Contrast of themed shell text on the shell surface (Sage, Sand, Harbor, Heather): body 7.1–7.8:1, muted 5.4–5.8:1, faint 4.8–5.2:1.

Verification:

- `pnpm type-check` passed; the production build passed.
- `tests/workspace-appearance.spec.ts`: 7/7 against the isolated production preview. The five new or changed tests failed on the pre-pass build. They cover no wordmark or Plain frost; frost for Video and Code; the badge clear of header controls at 1600, 1280, 1000, 820 and 700 px in Plain and Video; the entry's location, Back focus, Enter, Esc focus and Ctrl+K; the dock mark, Center canvas after a middle-drag pan; and the Sage dock, panel and + button colours on preview, Apply and reload, with exact defaults restored by Orvane.
- Electron (isolated data dir and port): `desktop-window.spec.ts` "header can restore the window into a drag" passed with the new region, covering restore-from-maximized drag and `app-region: drag`. `desktop.spec.ts` "frame-blocking sites" passed (Browser webview, canvas zoom over pages, frost material probe). An early, larger region (from the window corner) swallowed that test's canvas click at (5, 5), so the region now matches the old wordmark footprint.
- `agent-sessions.spec.ts` launcher frost and `workspace`, `navigation-fit`, `refinements`, `handoff`: 38/40 passed. The two failures are pre-existing. `handoff` "dock duplication…" fails the same way on the pre-pass build. `handoff` "sandbox…" imports `/src/sandbox.ts`, which only the dev server serves.
- `pnpm test:css`: only the known `FlowTestsView.vue` scrollbar failure.
- Screenshots in `artifacts/style-pass/`: `before-*` (pre-pass build), `after-*` and `verify-01…13` (default Plain, options entry, Video and Code previews, Sand and Harbor previews, badge at 760 px, Sand groups and dropdown, dock menu, command palette, options entry, Sand + Code applied, Center canvas tooltip and result), and `electron-harbor-video-*.png` (real desktop window).

Remaining gaps:

- App content inside app windows (for example example-app inputs and calculator keys) keeps its own blue-grey; only Orvane's shell surfaces follow the palette. The Workspace inbox, Action library and Custom tools have scoped colours that were not converted. Their inner hardcoded colours stay default; they were not checked in screenshots.
- `.select-popover` and `.app-tooltip` are shared controls, so app dropdowns and tooltips follow the palette too.
- In the settings sections, the "Archived apps" count sits mid-row (existing `.section-line > svg + *` margin rule). Not changed.
- Not verified in the owner's running app. Changes to `src/` need a reload of that window; `electron/` was not touched.

Verification used isolated workspaces. Restart the desktop app to load the updated Host server and its new Notes page.
