# Orvane performance: architecture, measurements and limits

Date: 11 November 2026. Baseline: `c5d47d0`. This continues [PERFORMANCE_50_APPS.md](PERFORMANCE_50_APPS.md), which covers the earlier per-app work (lazy views, windowed lists, shared reads, memory budgets). Standards for app authors are in [APP_PERFORMANCE.md](APP_PERFORMANCE.md).

## Summary

The earlier document's open question was a trace showing 890 ms of style recalculation during a pan. Measuring real input in Electron found the cause and showed it was much wider than panning: **every mouse press and release anywhere in Orvane restyled the entire document.** On the 50-app fixture a single click cost about 1.25 s, starting a pan about 0.75 s, and switching apps waited about 1.35 s before the camera moved, by which time its 280 ms animation had already expired, so the view jumped instead of gliding.

Five changes, in order of measured effect:

1. **Pan feedback is one overlay** instead of `.is-panning *` / `.is-panning:active *`. Chromium keys `:active` invalidation by the pseudo-class alone, so a rule ending in `*` under `:active` invalidates the subtree of every element whose active state changes, and a press makes `<main>`, `<body>` and `<html>` active.
2. **Off-screen apps skip rendering** (`content-visibility: auto` on `.app-surface`), with each one laid out once during idle time so arriving at it does not stall.
3. **Startup is staged**: apps in view mount at once, the rest in idle slices, nearest first.
4. **The Notes page tree is windowed**, which halved the fixture's DOM and brought overview panning and zoom to the display rate.
5. **Camera animations start on their first frame**, and an MCP edit toggles `inert` once instead of twice.

Animations, timings, easing, the header blur and text rendering are unchanged. Nothing was promoted to a GPU layer; that was measured and rejected (below).

## Results

`pnpm bench -- --baseline c5d47d0 --runs 3`, medians of three alternating runs. Production build in Electron 45.1.0 (Chromium 156), 1442×807 window at 1.25 device scale, i7-1355U with integrated graphics, 60 Hz. Fixture: 50 apps (12 Notes, 20 NetSuite, 10 Git, 8 Projects), 94,500 elements.

| Interaction | Measure | Before | After |
|---|---|---:|---:|
| Click on the canvas | style / first frame | 1,238 ms / 1,281 ms | 8 ms / 28 ms |
| Start a pan | camera starts | 793 ms | 60 ms |
| Pan, normal zoom | longest frame / frames over 34 ms | 766 ms / 2 | 34 ms / 0 |
| Pan, all 50 apps in view | 95th-percentile frame / main-thread time | 33 ms / 5,033 ms | 17 ms / 2,164 ms |
| Zoom out to all apps | 95th-percentile frame | 33 ms | 17 ms |
| Zoom in | 95th-percentile frame | 18 ms | 17 ms |
| Drag an app | first frame / main-thread time | 721 ms / 3,830 ms | 28 ms / 992 ms |
| Switch to a far app | camera starts / longest frame | 1,352 ms / 1,299 ms | 38 ms / 33 ms |
| Startup | workspace ready | 660 ms | 259 ms |
| Startup | app in view usable | 2,736 ms | 553 ms |
| Startup | every app mounted | 2,739 ms | 4,293 ms |
| Startup | summed long-task blocking | 218 ms | 941 ms |
| Memory | JS heap / DOM nodes | 254 MB / 192,926 | 217 MB / 96,115 |

An earlier three-run comparison, before the Notes page tree was windowed, measured the same click, Space, pan-start and switch improvements (Space: 1,354 ms of style down to 0.6 ms; six rapid switches: 7,488 ms of style down to 31 ms) but left overview panning and zoom at a 33 ms 95th percentile with unchanged memory. The step to 17 ms and the halved node count come from the tree windowing.

What got slower:

- **Total startup work is spread out, not reduced.** Mounting runs in idle slices and every off-screen app is laid out once in the background, so the last app mounts later (4.3 s against 2.7 s) and the long-task observer counts more blocking in total (941 ms against 218 ms in this run; 805 against 757 in the earlier one, so this figure is noisy). The trade is deliberate: the app in front of the user is usable about five times sooner. Individual stalls stayed around 200–250 ms in both builds.

Reading the table:

- **Style** is the renderer's own style-recalculation time during the scenario; **first frame** is from the input event to the end of the first frame that could show it; **camera starts** is from the input to the first frame in which the canvas transform changed.
- Frame intervals are animation-callback cadence, not proof of presented frames. Input is paced from another process and includes its jitter.
- Three runs give a median, not a tail. Do not read p99 from this.

## Limits, and what was rejected

**Paint still scales with what is on screen.** The canvas uses one non-composited transform, so every pan or zoom frame repaints the visible content; that keeps text sharp and identical during and after motion. With the fixture's 50 apps all in view this now fits a 60 Hz frame on the reference machine, with little headroom: a 120 Hz display, heavier apps or more of them would drop frames at overview again. At ordinary zoom there is ample margin.

**Promoting the canvas to a GPU layer was measured and rejected.** With `translate3d` on `.canvas-plane`, layerization rose from 240 ms to 2,144 ms over the same pan and from 1,412 ms to 6,854 ms at overview; 95th-percentile frame intervals went from 33 ms to 117 ms. Any repaint (the dot grid moves every frame; a caret blinks) forces a full re-layerization over many more layers, and `will-change` additionally disables subpixel text. It is not a setting to flip.

**The Notes page tree is windowed.** Twelve Notes apps held 49,000 of the fixture's 94,500 elements, 3,500 each in a 500-page sidebar. The sidebar now flattens the tree (`src/components/notes/pageTree.ts`) and mounts the rows near the viewport above 100 rows; expansion state moved from each row to the sidebar. Notes' own search covers all pages; the browser's Find sees mounted rows only.

**Next candidates**, by remaining element count: Projects rows (about 2,400 elements per app at 100 projects) and Git history rows (about 1,500 per viewer).

## Electron

Electron was not the bottleneck. Every large cost found was inside the page: selector invalidation, eager rendering of off-screen content, and mounting everything before the first frame. Script time was small throughout (about 0.3 ms per pan frame). Nothing measured pointed at IPC, process allocation or Chromium configuration, so the shell, its sandboxing and its flags are unchanged.

A migration is not justified. On Windows, Tauri renders with WebView2, which is the same Chromium engine with the same style, layout and paint behavior, so none of the costs above would change. It would also replace `<webview>`, on which the Browser app depends for a separate persistent session, per-page density, pausing hidden pages, isolated-world gesture scripts, context menus, popup handling and saved logins.

## Browser app

Unchanged, by design. `electron/main.mjs`, the preload bridge, the `persist:orvane-browser` session, permissions, navigation, popups, passwords and processing pages were not modified. Apps containing a Browser component are excluded from off-screen render skipping (`.has-live-page`), so their pages attach, load and keep their sessions exactly as before; the existing pause/resume of hidden pages still applies. The pan overlay also sits above embedded pages, so a Space-drag that starts over a page pans the canvas instead of being swallowed by it.

## Benchmark

```sh
pnpm bench                       # current working tree
pnpm bench -- --baseline <ref>   # alternate against a build of a commit
pnpm bench -- --runs 5 --trace   # more repetitions plus one traced run per build
pnpm bench -- --check            # exit non-zero when over bench/budgets.ts
pnpm bench -- --browser chrome   # Chromium instead of Electron
```

`bench/run.ts` builds each variant, serves it against a disposable fixture (real SQLite workspace and Notes storage; fixed mock reads for Git, Projects and NetSuite) and drives real input in a focused window. Scenarios: idle, pan at normal zoom, arming Space, zoom out, pan with everything in view, zoom in, click on the canvas, click in an app, switch to a far app, switch back, six rapid switches, and dragging an app. It records frame cadence, input-to-frame latency, the renderer's style/layout/script/task counters, startup milestones and blocking time, heap and node counts. `--trace` adds paint, layerize, raster and GPU totals per scenario. Runs that lose focus or visibility are rejected. Results and screenshots go to `artifacts/bench/<time>/`.

It does not exercise the desktop bridge, `<webview>` guests or processing pages, and it is not a soak test. The heap, lifecycle and 30-minute soak items in the earlier document remain open.

## Verification

- `pnpm exec playwright test`: all 203 tests pass (199 existing, four new), covering canvas gestures, motion, navigation fit, zoom, groups, editors, Notes, NetSuite, Git, Projects, Browser, MCP, storage and recovery.
- `tests/canvas-performance.spec.ts` adds four tests: the pan overlay (Space, Space-drag over an app, middle-drag, dock still usable), staged startup and off-screen rendering, immediate mount of an app opened during startup, and the code-app runtime (API surface, a 50,000-row windowed list, interval throttling off screen and recovery on return).
- `node --import tsx --test research/page-tree.test.ts` covers tree flattening and the row window; the desktop test now also asserts a maximized window without a title bar and the close button's position.
- `pnpm test:css` passes: no stylesheet styles every descendant from a state or a toggled class.
- `pnpm build` type-checks.
- All benchmark runs kept focus and visibility, reported no page errors, and kept the header's `backdrop-filter`. The end-of-run screenshot was reviewed.

Not verified: the tests ran in Chrome and the benchmark in a bare Electron window, so pan, zoom and startup were not timed inside the full desktop shell with live `<webview>` pages, and nothing was run against a signed-in NetSuite session. The three `tests/desktop.spec.ts` tests in the passing run do use the real shell: a frame-blocking site loading in a webview with links opening as tabs, server shutdown, and saved logins. Touch input and displays above 60 Hz were not available. One behavior differs slightly: while Space is held, the cursor over the top bar and dock is their own rather than the grab hand, because the overlay sits beneath them.
