# Performance research — 30 October 2026

The deeper investigation for the user-confirmed 50-app NetSuite/Notes/Git/Projects workload, including executable diagnostics and a custom-code evaluation, is in [PERFORMANCE_50_APPS.md](PERFORMANCE_50_APPS.md). This earlier note is retained as background; use the newer report for priorities and evidence.

Baseline: `a5143f4`. The user considers this the acceptable usability baseline. This research changes no application behavior. Findings below distinguish source-confirmed work from hypotheses; no new speedup or maximum supported app count has been measured.

## What the earlier investigation got wrong

Headless Chromium results did not establish desktop usability. Foreground state was not controlled in a desktop run. Empty Git/Projects fixtures and simulated NetSuite pages missed important real workloads. Restoring CSS alone could not restore a property removed during production minification: Electron computed the header's backdrop-filter as `none`. The current build preserves the standard property and a desktop regression assertion covers it.

Keep the current camera interpolation, header blur, app appearance, input routing, and state retention as acceptance requirements. Do not reintroduce canvas-wide layer promotion, visibility toggling, or automatic page unloading as presumed improvements.

## Ranked investigations

### 1. Stop File Cabinet persistence from following every splitter movement

Source: `src/components/NetSuiteFileCabinet.vue`, `persistPanes()` and the deep synchronous watcher below `restorePanes()`.

The watched layout includes its split ratio. Each mutation calls a routine that reads/parses block state, constructs saved pane state, and stringifies the NetSuite block. Updating that block also notifies the workspace save watcher. The workspace drag pause does not cover this inner splitter. Vue explicitly warns that synchronous watchers are unbatched.

Proposed experiment: keep visual ratio updates immediate, but commit persisted ratio once on pointer-up/cancel/blur; batch other pane-state mutations. Flush pending state on close and page hide. Do not replace the workspace revision watcher wholesale: MCP revision checks and editing ownership rely on it.

Verify: compare scripting and serialization counts during 100 splitter moves, save count, and frame times. Reload after pointer-up, blur, cancellation, and immediate close. Confirm active split tabs and their ratio survive.

### 2. Load hidden NetSuite panes only when needed

Sources: `src/components/SplitTabs.vue` mounts every pane and exposes a `visible` slot property; `NetSuiteView.vue` ignores that property. `NetSuiteFileCabinet.vue:restorePanes()` starts navigation and optional file reads for every saved pane concurrently. `NetSuiteScripts.vue` has activation hooks, but CSS-hidden panes are not automatically deactivated.

Proposed experiment: separate tab records/state from expensive initial loading. Load the visible pane(s) first, including both sides of a split. Delay unopened hidden panes until first selection. Preserve already-open editors, draft state, selection, undo history and existing tab state. Bound background request concurrency and deduplicate identical read-only requests per environment.

Do not indiscriminately wrap/unmount panes: KeepAlive preserves instances but does not automatically suspend every watcher, listener or request. Shared caches need environment/role-sensitive keys and invalidation after mutations, refresh, logout and environment changes. Never deduplicate mutations.

Verify: count requests and mounted editors during restore with 1/5/20 saved tabs; measure first visible pane readiness and first-switch latency separately. Test edits in a hidden tab, split views, environment changes and stale responses.

### 3. Make large server responses shallow reactive where they are immutable

Sources: `NetSuiteQuery.vue` results, `NetSuiteScripts.vue` scripts/deployment/log collections, `GitViewer.vue` history and diff responses are held in ordinary refs. Those refs deeply proxy objects by default. This is a candidate at large datasets, not a claim that their current overhead dominates.

Proposed experiment: start with one confirmed read-only response collection. Audit every write, then use shallowRef and replace the root on updates. Keep editable workspace, form and draft state deeply reactive where required. Avoid broad shallow conversion.

Verify: result assignment, filtering, sorting and rendering profiles at realistic row counts; every UI refresh and nested mutation path. Inspect heap retention as tabs accumulate.

### 4. Bound DOM inside large data views

Sources: Scripts renders every filtered script and expanded deployment/log; File Cabinet renders every current list/grid entry; Git diff renders every patch line. Git history itself already requests only 150 commits, so it is a lower priority than huge diffs or file lists. SuiteQL already virtualizes its result rows.

Proposed experiment: optimize the largest measured data view first. Prefer pagination or windowing inside its scroll viewport. Virtual rows must support expanded/variable heights. Preserve full export/search data, keyboard navigation, selection, context menus and scroll restoration. Whole-app canvas culling is outside this experiment.

Verify: actual DOM count, render/scroll timings and memory with large folders, scripts, logs and diffs. Do not accept faster scroll with lost rows, inaccessible selections, broken copy/export or jumping row heights.

### 5. Reduce cross-app reactive work only after tracing it

Sources: `App.vue` renders camera transform, spatial groups and every app wrapper in the same component. Its minimum-size watcher scans all app block trees when its dependencies change. Camera changes can therefore incur parent render/patch work; how much the compiler skips must be profiled. Passing the same workspace object does not by itself prove every child rerenders.

Proposed experiment: use Vue render profiling and Chrome traces to identify actual update fan-out. If significant, isolate camera transform updates from app-content rendering and scope minimum-size recalculation to affected apps. Keep the existing interpolation and gesture behavior. Avoid blanket v-memo: missed dependencies can freeze stale UI.

Verify: component update counts and JS/paint/composite breakdown for ordinary pan, overview pan, rapid dock switching and interrupted zoom at 5/10/20/40 apps. Preserve header blur and text sharpness during and after movement.

### 6. Treat Browser memory as a resource tradeoff

Sources: `BrowserView.vue` retains live webviews by default and only unloads with explicit opt-in. Electron webviews use separate renderer processes. `electron/processing.mjs` also maintains hidden processing windows per environment with background throttling disabled so work can complete.

Pausing JS is not a memory solution and can affect timers/network callbacks. It also does not guarantee that compositor-only animation or video stops. A screenshot plus URL cannot restore arbitrary application memory, undo state or navigation history. Do not promise otherwise.

Investigate duplicate processing pages/requests and unbounded result caches first. Audit processing windows' idle CPU before changing throttling; test session maintenance and request completion. For actual memory reclamation, provide explicit page closing/unloading with clear user choice. Replacing webviews with WebContentsView is an architectural investigation, not a quick optimization or guaranteed memory saving: Electron recommends alternatives for stability, but the canvas transform and input requirements make migration substantial.

## Measurement and acceptance

1. Use the production build launched by `npm run desktop`, and production browser preview. Keep tested windows foregrounded and unobscured; record visibility and focus. Do not compare foreground and background frame rates.
2. Use isolated copies/fixtures representative of the real workload: populated Git history/diffs, Projects folders, Notes documents, script lists, folders, query results, editor drafts and Browser pages. Distinguish mocked results from authenticated NetSuite runs. Never benchmark mutations against live NetSuite records.
3. Test 5/10/20/40 total apps and separately vary heavy views and Browser page counts. App count alone is not a sufficient load description.
4. Record five repeated runs per candidate and baseline, alternating order. Record p50/p95/p99 frame intervals, worst stalls, long tasks, input-to-next-frame delay, first-visible-content and first-switch delays, CPU while idle and working, and host/guest/process memory. Report aggregate working set separately from private memory; shared pages make sums imperfect.
5. Trace CPU sampling, style/layout, paint/compositor, serialization, request counts and Vue updates. Avoid expensive tracing during final comparative timing runs; use separate diagnostic runs.
6. Test gradual load and a 15–30 minute soak. Check memory growth after opening/closing tabs, editor undo retention, blur and text sharpness, clipboard, saved state, logout/relogin and recovery. Automated checks complement direct interaction in the real desktop window.
7. A candidate ships only if its targeted cost improves beyond run variation and baseline interactions do not regress. No speedup percentage is assigned before this comparison. At 60 Hz, 16.7 ms is the nominal frame interval; acceptance also needs stall frequency and perceived interaction, not just the median.

Recommended first implementation experiment: File Cabinet split persistence. Second: lazy loading of unopened NetSuite panes. These have identifiable repeated work and can be evaluated without changing canvas rendering.

## Primary sources

- [Vue watchers: deep traversal and unbatched synchronous watchers](https://vuejs.org/guide/essentials/watchers.html)
- [Vue performance: profiling, prop stability, virtualization and shallow immutable data](https://vuejs.org/guide/best-practices/performance)
- [Vue KeepAlive: caching and activation lifecycle](https://vuejs.org/guide/built-ins/keep-alive.html)
- [Electron performance: profile the running application](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Electron webview: process isolation and stability guidance](https://www.electronjs.org/docs/latest/api/webview-tag)
- [Electron webContents: background throttling behavior](https://www.electronjs.org/docs/latest/api/web-contents)
- [Chrome DevTools performance recording](https://developer.chrome.com/docs/devtools/performance/reference)
- [Chrome rendering guidance: containment caveats](https://developer.chrome.com/docs/modern-web-guidance/guides/performance/performance)
