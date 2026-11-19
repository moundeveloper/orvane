# Orvane performance plan

Drafted 19 November 2026. It builds on [PERFORMANCE.md](PERFORMANCE.md), [PERFORMANCE_50_APPS.md](PERFORMANCE_50_APPS.md) and the `pnpm bench` harness. Steps 0, 1, 3 and 5 are done, step 2 was measured and skipped (results in PERFORMANCE.md, "Desktop shell baseline"); the rest is not implemented yet. Each step lands on its own, with a before/after number, and stops if the number does not move.

## Where the cost is

Electron itself is not the bottleneck. The cost is in what Orvane keeps alive inside it, in this order of likely impact:

| # | Hotspot | Evidence | Why it costs |
|---|---|---|---|
| 1 | Browser pages are never unloaded by default | `BrowserView.vue` `discardEnabled()` reads `orvane.browser.discardEnabled`, default off | Every opened tab keeps its own renderer process (the code estimates ~100 MB each). Debugger pausing stops JavaScript but frees no memory and leaves CSS/video animation running |
| 2 | Every save writes the whole workspace | `storage.ts` serialises the full workspace one second after an edit; `server/database.ts` writes the whole blob with `synchronous = FULL` | Typing in one app costs a full-document stringify, parse and fsync. It grows with the workspace |
| 3 | Off-screen terminals keep rendering | `TerminalPane.vue` writes output whether or not the app is on screen; `terminal.ts` sends one message per output chunk | A busy terminal anywhere on the canvas costs main-thread time and IPC |
| 4 | Canvas camera repaints all visible content | PERFORMANCE.md: p95 frame ≈ 17 ms at overview on 60 Hz; terminals use `backdrop-filter: blur(8px)` (`style.css:2259`) | No headroom on 120 Hz screens; blur is costly to repaint every frame (not yet measured) |
| 5 | Steady timers while idle | Storage lease `POST` every 1 s (`storage.ts`); Claude Sessions poll every 1.8 s even off screen; live clip reports every 400 ms (`liveClip.ts:229`) | Small each, but they keep the CPU and the local server awake |
| 6 | Hidden NetSuite processing pages run unthrottled | `processing.mjs`: `backgroundThrottling: false`, full NetSuite home page per account, reload every 8 min | One full NetSuite page per account, always live (CPU cost not measured) |
| 7 | Git history is not windowed | `GitViewer.vue` renders every commit row | ~1,500 elements per Git viewer; already the docs' next candidate |
| 8 | Startup bundle | 504 KB entry chunk, CodeMirror and `suiteqlTrace` in shared chunks | Slower first paint; probably smaller than 1–5 |

Costs for 3, 4 (blur), 6 and 8 are inferred from code, not measured. Step 0 measures them first.

## Steps

### 0. Measure first (no behaviour change) — done
- Extend `research/electron-foreground.ts` to record memory and CPU per process (main, workspace, each Browser guest, processing pages) on a fixed workspace: 10 Browser tabs, 3 terminals with output, 2 NetSuite accounts, Notes, Git viewer.
- Add a request counter to the `bench` idle scenario (local server calls per minute).
- Add a terminal-output-during-pan scenario and a 120 Hz run, both open items in PERFORMANCE.md.
- Record the baseline in PERFORMANCE.md. Every later step is compared against it.

### 1. Free memory from Browser tabs (biggest expected win) — done
- Turn discarding on by default for tabs that are hidden past the timeout and hold no edited fields (the `snapshot.edited` check already exists). A discarded tab shows its picture and reloads on click, as today.
- Add a per-tab **Keep live** option for pages that must keep running (chats, dashboards).
- **Decision for the owner:** default on, with Keep live as the opt-out, or keep it opt-in.
- Measure: total memory with 10 tabs, before/after.

### 2. Save only what changed
- Store each app as its own SQLite row behind a small manifest (the P0 item in PERFORMANCE_50_APPS.md), so typing in Notes writes one row instead of the whole workspace.
- Switch to `synchronous = NORMAL`. It is safe with WAL: a power cut can lose the last commit but never corrupts the file. Backups are unaffected.
- Measure: save time and bytes written per keystroke in a large workspace.

### 3. Quiet off-screen terminals — done (server batching dropped: ConPTY already groups output)
- Batch terminal output on the server (8–16 ms windows) instead of one message per chunk.
- While a terminal app is off screen, keep output in a buffer and write it once when it comes back. The server already keeps a replay buffer.
- Measure: the terminal-during-pan scenario from step 0.

### 4. Cheaper camera motion
- While the camera moves (`camera-moving` already exists), draw terminals with a flat background instead of the blur.
- Measure: p95 frame time in `panOverview` and `zoomOut`, with and without terminals.
- Canvas input and motion stay as they are: this changes only what is painted.

### 5. Stop idle polling — done (live clips already paused off screen)
- Lease check every 3–5 s instead of 1 s.
- Claude Sessions and live clip position reports stop while their app is off screen (the existing visibility observers already know).
- Measure: idle request count and idle CPU.

### 6. Lighter processing pages
- After step 0 shows their real CPU cost: keep the session alive with a lighter NetSuite page than the full home dashboard, or throttle between jobs.
- Measure: idle CPU with 2 accounts.

### 7. Window Git history
- Same approach as the Projects and File Cabinet windowing already in place.

### 8. Bundle
- Inspect the entry chunk with `rollup-plugin-visualizer`; move CodeMirror and `suiteqlTrace` out of startup chunks. Add a bundle-size budget to `bench`.

### Later, only if the numbers ask for it
- Move Browser pages from `<webview>` to `WebContentsView` (Electron's recommended replacement). Large change; worth it only if step 1 is not enough.
- Keep Electron current: each upgrade brings Chromium's own performance work.

## Rules for every step
- One step per branch and commit, with its before/after numbers in PERFORMANCE.md.
- Regression tests for the behaviour it touches (Browser restore, saving, terminal output, canvas input).
- No change to canvas gestures, shortcuts or motion design.
