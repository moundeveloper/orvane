# Workflow Git

- Usa `C:\Projects\Orvane` come unica cartella di lavoro per questo repository.
- Usa i branch Git per separare gli sviluppi. Passa da un branch all'altro con `git switch` nella stessa cartella e integra le modifiche nel branch principale (`master`) quando richiesto.
- Crea un worktree, un clone o una seconda cartella per questo repository soltanto su richiesta esplicita dell'utente.
- Prima di cambiare branch, controlla lo stato del checkout e preserva le modifiche locali. Avvia e verifica l'app dalla cartella del progetto sul branch che contiene le modifiche.

# Working on Orvane: notes for AI agents

Orvane is a local-first desktop workspace: apps (Browser, Terminal, File Explorer, Notes, Git, NetSuite tools, custom-built apps) live on an infinite canvas. Electron shell (`electron/main.mjs`, `electron/preload.cjs`), Vue 3 + TypeScript front end (`src/`), a local Node server (`server/`), SQLite storage, Playwright tests (`tests/`).

These are the project owner's standing preferences. Read them before changing anything. The longer design records are [DESIGN.md](DESIGN.md), [PRODUCT.md](PRODUCT.md), [MOTION-DISCOVERY.md](MOTION-DISCOVERY.md) and [PERFORMANCE.md](PERFORMANCE.md); the README documents current behaviour.

## 1. Fix only what is asked

This is the most important rule.

- When asked to fix a bug, change only what causes that bug. Don't redesign, add features, or "improve" behaviour that was already in place, even if it seems related.
- Pin down exactly where the bug happens first. Keep the fix to that area. Don't apply it app-wide "for consistency".
- Never offer options that replace an existing design decision (for example, making the plain wheel zoom the canvas, when zoom is deliberately Ctrl+scroll).
- Before calling it done, check that the features around it still work as before: scrolling inside apps, the File Explorer, the Browser, Ctrl+zoom, panning, shortcuts.
- If you notice something else that looks wrong, mention it. Don't change it.

## 2. Canvas input: don't touch without being asked

Canvas gestures were tuned deliberately. The current behaviour is documented in the README's canvas section. Leave it alone unless the task is about it.

- Mouse and touchpad are separate control schemes. Never merge them into one behaviour.
- Ctrl/Command+scroll and pinch zoom. Plain scrolling over an app scrolls that app, with no click needed first.
- Pan with empty-space drag, middle-drag, Space-drag, or Space plus pointer movement.
- On Windows precision touchpads, three-finger swipes are OS gestures and never reach the page. If a request depends on them, raise it with the owner instead of picking a workaround.

## 3. Custom controls only

Everything in the UI is custom-styled. Never ship browser-native controls whose popups or chrome look like standard HTML.

- No `<select>`, `<input type="date|time|datetime-local|month|number|color">` and the like. Use `CustomSelect.vue` for dropdowns and `src/components/pickers/` (`TimePicker`, `DatePicker`, `MonthYearGrid`, `usePopover`) for dates and times. Number fields use the shared text-and-stepper control.
- New popovers follow `.select-popover` styling, dismiss on outside pointerdown, and scale with canvas zoom.
- Scrollbars are narrow and muted with no arrow buttons, everywhere (including sandbox documents and the terminal). xterm.js draws its own scrollbar, so the native one stays hidden there.

## 4. Look and motion

- Light theme only: cool blue-gray canvas (`#e9edf0`), off-white apps (`#f7f9fa`), slate text (`#455968`), muted blue accent (`#6f8998`). Inter Variable, compact 12–14px controls, 6–10px radii, sparse dividers, soft shadows. See [DESIGN.md](DESIGN.md).
- Toolbar items line up on one centre line (icons, buttons and text such as URLs).
- Motion is small and local: short fades and reveals. No bouncing, no animated layout sizes, no stagger. Honour reduced motion. Table headers are opaque rows above the scrolling area, never sticky overlays.
- No dashboards, hero sections, wizards or modal creation flows.

## 5. Product direction

- Keyboard first. Every action should have a shortcut or be reachable through Ctrl+K. Shortcuts defer to text fields.
- Live over static: prefer real, interactive views (for example live clips of a page) over screenshots, but keep the light static version when the owner asks for both.
- Local first: no accounts, cloud sync, telemetry or external services. Data stays in `.orvane/workspace.sqlite` and is covered by backups.
- Performance matters: pause hidden or off-screen work, never block the canvas camera, keep camera motion on a single transform.
- Feature ideas the owner is considering, with sources: [FEATURE_IDEAS.md](FEATURE_IDEAS.md). Don't build from it unless asked.

## 6. Technical gotchas

- Browser pages are `<webview>` guests in partition `persist:orvane-browser`. Main-process handlers must check `ownGuest(event, id)` first.
- `webContents.executeJavaScript` and `executeJavaScriptInIsolatedWorld` wait until the page finishes loading. Streaming sites like YouTube never finish, so those calls hang. Use the `orvane:page-run` bridge (`runInPage` in `src/liveClip.ts`), which calls `mainFrame.executeJavaScript` and runs straight away.
- Paused guests (off-screen pages are paused with the debugger) stay paused across `dom-ready`. Don't assume a reloaded page is running.
- Changes to `electron/main.mjs` or `electron/preload.cjs` need a full Orvane restart. Tell the owner when that applies.
- Playwright keyboard events don't reach webview guests. Use `webContents.sendInputEvent` in tests.

## 7. Testing

- `pnpm type-check`, `pnpm test`, `pnpm test:css`.
- Run Electron specs one at a time (`pnpm exec playwright test <spec> --workers=1`). Parallel Electron launches fail.
- For a bug fix, add a regression test and confirm it fails on the old code before calling the fix done.
- Tests use isolated databases. Never touch the owner's real workspace.
- Report results honestly: say what passed, what failed, and what you could not verify (for example, behaviour in the owner's real running app).

## 8. Git

- Work on the feature branch; `master` is the main branch and remote is `origin`.
- Commit, push or merge only when asked. "Merge into main" means fast-forward or merge into `master` and push.
- Conventional commit subjects (`feat:`, `fix:`, `docs:`) with a short body describing what changed.

## 9. Talking to the owner

- Plain, direct language. Lead with what changed and whether it works.
- When something is ambiguous and the choice belongs to the owner (design, gestures, scope), ask instead of deciding.
