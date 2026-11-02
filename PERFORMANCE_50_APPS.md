# Orvane: research toward 50 usable apps

Date: 30 October 2026. Baseline: `a5143f4`. User priority: mostly NetSuite, Notes, Git and Projects. Current interaction and appearance are acceptance requirements. Custom implementations are acceptable when measurements and correctness tests justify them.

## Implementation update: 2 November 2026

The first implementation pass was committed as `cbcfea8`. The measurements below remain the original research baseline; they are not measurements of this implementation.

- Notes views now own unique Pinia stores and remove their state on disposal. Concurrent startup shares metadata initialization, migration and welcome seeding. Identical in-flight reads share transport results, with detached editable records and independent navigation/undo state per view. Unrelated reads can run concurrently between write barriers; writes wait for earlier reads and later reads wait for writes. Document and metadata revisions reject stale responses, and a pending document save retains its original page identity.
- Workspace tracking now uses individual deep app watchers plus a separate metadata watcher. Minimum-size watchers are also per app. Geometry transactions pause/resume app subscriptions without traversing untouched apps. Complete workspace persistence remains the format; pending ordinary saves coalesce before serialization, while checkpoints remain detached, ordered operations. Lease/revision checks, failure reporting and synchronous final-close capture remain in place.
- File Cabinet and NetSuite splitters defer layout persistence until pointer release, cancellation or blur. Restored NetSuite views mount on first selection, with both visible split halves initialized. File Cabinet retains lightweight hidden folder/file records and opens them on selection. Already-initialized panes remain mounted to retain editor state.
- Git, Projects root/inspection reads, NetSuite environment lists and selected NetSuite folder/file/script reads share identical in-flight requests. No persistent freshness cache was added. Shared Git cancellation is subscriber-specific; one closing viewer cannot abort another's read. Commands, writes and arbitrary SuiteQL execution are not deduplicated.

Validation:

- `node --import tsx --test research/performance.test.ts`: 11 checks covering 50-app traversal isolation, one request for 50 Notes readers, write ordering and recovery, 100 owned-store close cycles, independent store ownership, stale document/metadata responses, one welcome seed for concurrent startup, save coalescing/checkpoints, conflicts and final-close capture.
- 37 distinct Playwright tests passed across `notes`, `netsuite`, `git`, `projects`, `recovery`, `storage-fallback`, `workspace`, `zoom-groups` and the new `performance` suite. Targeted checks cover both split halves, deferred hidden files, one persistence update for a 20-step drag, cancellation/blur, retained query editors, multi-view Notes edits, independent undo/redo, close/reopen and deletion from another view.
- `pnpm build` passes, including Vue/TypeScript checking. Existing Vite configuration, mixed import and bundle-size warnings remain.

Still pending: real foreground Electron/browser comparative traces, first-selection latency measurements, heap snapshots and the 30-minute mixed 50-app soak. The 100-cycle automated check counts Pinia entries; it does not measure heap stabilization. Whole-document undo changes, long-lived canonical metadata caches, per-app database commits, byte limits for open query results, additional list/editor changes and camera work remain subject to the profiling/policy/migration gates in this plan. No 50-app smoothness or memory guarantee is established by the functional checks.

### Second pass: lazy Projects terminals

Committed as `4c9c7cf`. The user subsequently reported smoother interaction; this is qualitative feedback, not a comparative timing result.

Projects now restores terminal tab metadata without constructing an xterm for each tab. Only the selected, open, measurable host initializes. Previously selected terminals retain their instances, input, history, buffers and pending command output across tab switches and hide/show. Restoring a closed panel keeps it closed and initializes no terminals until it is shown. Commands still execute exclusively through the existing callback.

Fit requests share one animation-frame callback, resolve the latest selected tab after rendering, skip hidden hosts, and observe the terminal panel rather than the document body. Xterm and addon instances are excluded from Vue proxying. Closing/unmounting clears disposed instances; teardown also cancels queued frames, observers and resize gesture listeners.

Controlled browser fixture: 50 saved terminal tabs, one selected, a stable visible panel. Before this pass (`cbcfea8`), restoration created 50 xterm instances and invoked fit 103 times. The candidate created 1 instance and invoked fit 2 times. A restored closed panel created 0 instances and made 0 fit calls; five new tabs added in one update initialized only the final selection and invoked fit once. These are work/allocation counts, not timing, heap or foreground Electron measurements. Recorded fixture results are in `research/terminal-startup-results.json`.

Validation: `pnpm exec playwright test tests/terminal-performance.spec.ts tests/projects.spec.ts` passed all 6 tests, covering restoration, lazy selection, closing initialized/uninitialized tabs, hidden command output, unfinished input, history, hide/show, fit coalescing, teardown and existing Projects backend/MCP behavior. `pnpm build` passes with the existing warnings. First-use latency and retained memory after many terminals have actually been visited still need foreground/heap profiling.

### Third pass: SuiteQL output ownership

Closing a SuiteQL tab now evicts its recomputable results and execution trace. Open inactive tabs retain their output, and activation transfers the snapshot back to the displayed view rather than keeping a second cached reference. Membership checks prevent a closing/deleted tab's transition from putting output back into the cache. Emptying displayed results also refreshes the lazy derived row snapshots, and unmounting invalidates pending work and clears output references.

The retention policy is no cached output for closed tabs. Reopening retains SQL text and editor undo/redo, displays the existing run/trace prompts and executes nothing automatically. Output for open tabs has no new byte cap; a measured budget for that workload remains future work. No history or editable SQL is evicted to meet a memory target.

Editor identity and text changes now run through one transition so a new file's text cannot overwrite the outgoing undo state before it is saved. Deleted files are forgotten in both local and cross-view deletion paths, including a pending document switch. Late query/trace responses after deletion, environment change or unmount are ignored.

Baseline browser reproduction on `4c9c7cf`: closing/reopening restored the old result without another query. Candidate tests require the result and trace to be absent until an explicit rerun. `node --import tsx --test research/query-outputs.test.ts` passes 3 ownership checks, including pruning 50 stored outputs to zero, rejecting late saves and transferring active output without cloning. All 16 distinct browser tests across `tests/query-performance.spec.ts` and `tests/netsuite.spec.ts` passed, including a rerun of the updated end-to-end undo check. Coverage includes open/closed results and traces, SQL undo/redo, local/remote deletion, late response ownership, query execution, pagination, CSV and editor behavior. `pnpm build` passes with existing warnings. These are correctness and ownership checks, not heap or frame-rate measurements.

## Conclusion and limits

Fifty app definitions are already within the schema's 300-app limit. That is not a usability guarantee. Work per edit, duplicated data per instance, restored inner tabs, document sizes, terminal instances and live Browser pages determine the practical limit.

For the requested mix, the strongest route is app-scoped changes and persistence, shared read-only data, correct disposal, and lazy initialization of expensive inner views. Start there before changing canvas drawing. These changes should make unrelated apps largely irrelevant to an edit in one app. They do not remove the cost of 50 simultaneously busy applications.

This investigation did not change production code or establish that 50 apps already meet a frame-rate target. It audited the installed code, consulted primary documentation, and ran isolated executable diagnostics. It deliberately did not open another desktop benchmark window or exercise live NetSuite mutations. Earlier headless/UI figures are not used as proof of desktop usability.

## Evidence collected

Machine: Windows, Intel i7-1355U, 12 logical processors, Intel UHD Graphics, approximately 16 GB installed RAM. Other running software and power/thermal state were not controlled. Node v24.16.0.

### Actual library/application paths, isolated from UI and live data

Run `node --import tsx research/scaling.ts`. The fixture uses the actual workspace model and validator, installed Vue watcher implementation, and actual Notes store factory. Each app has 10 blocks, including 200 list items. Five measured repetitions follow one serialization/validation warmup. Values below are medians of those five samples; they are not p95/p99 estimates or desktop frame timings.

| Diagnostic | 5 apps, ~107 KB | 20 apps, ~428 KB | 50 apps, ~1.07 MB |
|---|---:|---:|---:|
| Serialize reactive workspace once | 2.98 ms | 12.96 ms | 30.93 ms |
| Parse JSON and validate once | 1.10 ms | 3.12 ms | 6.05 ms |
| Two coordinate mutations with unpaused global deep watcher | 11.71 ms | 44.96 ms | 119.39 ms |
| Resume paused global watcher after 25 moves | 5.20 ms | 21.48 ms | 57.51 ms |
| Two coordinate mutations with candidate per-app watchers | 1.85 ms | 1.96 ms | 1.86 ms |

The existing baseline already pauses the global watcher for outer app dragging. The unpaused row therefore is NOT a measurement of current drag latency. Pausing reduced callback count from 50 to one over 25 synthetic moves; resuming still traversed the whole tree. The 50-app resume maximum was 73.22 ms in this run. The scoped-watcher row is an isolated candidate, not an implemented optimization or an end-to-end speedup.

Serialization and validation were measured separately. Actual saving also includes additional encoding, server validation, queueing and SQLite work; those stages were not timed here. Node timings cannot be substituted for renderer timings.

### Notes lifecycle: verified retained state

The diagnostic created 50 actual Notes stores, assigned a small sentinel, and called the same `$dispose()` used by `NotesView.vue` on unmount. All 50 state entries remained in Pinia. Explicitly deleting those entries removed all 50. This proves retained store state in the tested teardown path, not a particular number of leaked megabytes. A full heap/close-reopen test is still needed to quantify retained documents and undo snapshots in the renderer.

Source: `NotesView.vue:createWorkspaceStore(...)` uses a component-instance identity; its teardown calls `$dispose()` without removing that identity from the root Pinia state. The store holds page metadata, current blocks and undo/redo arrays. Archived/removed instances can therefore leave data behind until the application session ends. If a future caller deliberately reuses a store identity, cleanup must respect that ownership.

### Notes change fan-out: verified duplicated serial reads

Run `node --import tsx research/notes-fanout.ts`. This exercises actual `refreshPages()` and the shared `notes/db.ts` transport queue with mocked fetch. It mirrors the pages-change notification handler, excluding the originating store.

| Notes instances | Reads for one pages-change notification | Maximum concurrent reads |
|---|---:|---:|
| 5 | 4 | 1 |
| 20 | 19 | 1 |
| 50 | 49 | 1 |

The mock requests a 2 ms timer delay, whose actual scheduling precision varies on Windows. Raw elapsed times are saved for reproducibility but are not backend performance predictions. Request count and serial execution are the useful findings. Blocks-change notifications also refresh each other instance displaying that page, so several views of one document can duplicate reads during edits.

Raw results: `research/scaling-results.json` and `research/notes-fanout-results.json`. No application database was read or written by these diagnostics.

## Implementation priorities

### P0: Notes ownership and shared data

Files: `src/components/notes/NotesView.vue`, `notes/stores/workspace.ts`, `notes/db.ts`.

1. Release instance-owned Pinia state after disposing a permanently destroyed Notes view. Do not delete durable notes or a still-shared store. Keep the change narrowly scoped; test close/reopen/duplicate/import and undo before merging.
2. Separate shared page metadata and canonical committed records from per-view navigation, selection, active document and undo history. One notification should refresh shared metadata once, then update subscribers from that result.
3. Deduplicate identical in-flight reads. Preserve write ordering and give visible-document reads priority. The current single queue serializes unrelated reads as well as writes; do not simply parallelize all operations, because read-after-write behavior matters.
4. Consider transaction-based undo or structurally shared snapshots for large documents. The current `snapshot()` clones the whole blocks array and keeps up to 100 snapshots per instance. First measure bytes per real edited document; don't delete history to reach a memory target.

Expected benefit: fewer retained objects after churn, fewer requests and copies as Notes app count grows. It does not make rich-text rendering free.

Required tests: 100 create/close cycles with state-entry counts and heap snapshots; editing one page in two views; changing pages during pending saves; undo/redo independence; deletion from another view; stale response ordering; write failures and recovery.

### P0: App-scoped change tracking and small persistence commits

Files: `src/App.vue:workspaceWatch/persist`, `src/storage.ts:write/request`, `server/database.ts:write/read`, component splitters.

The current global synchronous watcher traverses the workspace. `WorkspaceStorage.write()` synchronously serializes, parses and validates the entire workspace before queueing a request; the server validates and serializes again. Debouncing network writes does not remove traversal on each mutation. The current geometry pause only covers outer app move/resize/group operations, not every editor or inner splitter.

1. Prototype per-app dirty revisions/subscriptions plus explicit geometry transactions. A change to one app should not inspect 49 others. Scope the minimum-size watcher to the affected app as well; today its source maps all app block kinds and the callback recomputes every app's minimum.
2. Batch File Cabinet split-ratio persistence at gesture completion/cancel/blur. Its deep synchronous layout watcher invokes `persistPanes()` and serializes the entire NetSuite block while the splitter changes.
3. Coalesce superseded pending ordinary saves before doing expensive serialization. Retain distinct import/recovery checkpoints and preserve the final close snapshot, lease ownership and optimistic revision checks. Do not implement a queue that silently drops a failure or allows stale writes.
4. If payload profiling still shows save stalls, persist dirty app records independently with a transaction/versioned manifest. Keep import/export as a complete workspace format. This is a schema/protocol migration requiring atomic cross-app edits, migration backups and recovery tests; it is not a quick toggle.

The schema permits 300 apps but limits a serialized workspace to 25 million characters. Large code/editor content can reach the data limit before app count. Notes content and File Cabinet drafts already have separate persistence; use that existing separation as evidence when designing further boundaries.

Expected benefit: local editing scales with the edited app/document rather than the whole workspace. Cost is still proportional to the size of that app unless document-level commits are introduced.

### P1: NetSuite startup, inner-tab lifecycle and query caches

Files: `NetSuiteView.vue`, `SplitTabs.vue`, `NetSuiteFileCabinet.vue`, `NetSuiteQuery.vue`, `SuiteQLEditor.vue`.

Every split tab is mounted, even when its pane uses display:none. NetSuite does not consume the slot's visibility flag. File Cabinet restore navigates every saved pane and may open each saved file concurrently. Each NetSuite instance also subscribes to processing changes and calls `api.tabs()` independently.

1. Persist lightweight tab records separately from initialization. Initialize the visible pane(s) first; leave never-selected hidden panes unopened. Both halves of a split count as visible.
2. Share environment/status metadata and coalesce refresh notifications. A per-environment read coordinator can share folder/catalog/script reads with correct account/role and invalidation keys. Do not cache mutations or arbitrary user SuiteQL queries by default: freshness and side effects must be understood.
3. Limit speculative background reads. Prioritize the user's selected view; cancel or ignore superseded responses using the existing generation/epoch patterns. Carry request ownership through cancellation so one subscriber cannot abort another subscriber's shared request.
4. Establish a policy for saved query results, traces and editor states. Closing a query tab removes its ID from the open list but does not clear the corresponding result/trace/editor caches; deleting the query file does. This can be intentional history retention, but without a byte policy it retains large results for closed tabs. Evict recomputable results first, with explicit stale/re-run behavior; preserve unsaved text and undo state.

KeepAlive can retain component instances and expose activation hooks, but it does not automatically suspend all watchers or requests. Blindly unmounting editors loses local state. A warm/cold view design needs a document-state owner and tested activation behavior.

Expected benefit: fewer startup request bursts and less unnecessary editor/list work. Measure first selection latency too: delaying work can make initial startup faster while making switching worse.

### P1: Large lists and editor integration

Sources: Script rows/deployment/log loops, File Cabinet list/grid loops, Git diff patch-line loop, CodeEditor/SuiteQLEditor update listeners.

Use app-specific windowing or pagination for the largest measured data views. A custom implementation is reasonable for fixed rows and controllable semantics; expanded deployment/log rows require measured-height support. Preserve selection, keyboard navigation, search, copy, CSV export and scroll anchoring. Git history already requests 150 commits, so enormous diffs/folders/scripts are stronger first candidates than its bounded history list.

CodeMirror already separates immutable EditorState from EditorView and renders a viewport. Replacing it with a custom text editor is not currently justified. Orvane's integration emits a full document string on changes and some wrappers compare another full string back to the prop. Investigate document revisions/transactions and scheduled persistence snapshots before replacing parsing, selection, composition, undo, accessibility and editing infrastructure.

Use shallow immutable response snapshots only after auditing nested writes. Avoid converting editable workspace/forms/drafts to shallow data indiscriminately.

### P1: Git and Projects shared read services

Files: `GitViewer.vue`, `server/git.ts`, `projects/ProjectsHub.vue`, `server/projects.ts`, `projects/TerminalPanel.vue`.

Several viewers of one repository/root can request equivalent data independently. Projects enumerates child folders and awaits stat for each directory. Its filesystem calls are asynchronous, so claiming it blocks the renderer or main Electron thread would be incorrect. Duplicate scans still consume I/O and delay results.

Deduplicate in-flight repository/root reads. Add bounded filesystem concurrency only if traces show serial I/O dominates. Cache with explicit refresh and mutation invalidation; path/repo/branch/order/limit are part of identity. External filesystem and Git changes need invalidation or documented short freshness windows. Never merge command execution or write operations.

Projects restores xterm instances for saved terminal tabs. Investigate lazy initialization of unused terminal views and avoid repeated fit/measurement work when hidden. Commands are submitted through the runCommand callback; a restored xterm view is not evidence of a permanently running shell process. Preserve buffers, active commands and output when altering terminal lifecycle.

### P2: Custom camera controller only if the trace justifies it

The reactive camera and every app wrapper currently render under App.vue. Moving the camera can cause parent render/patch work, but Vue can skip stable children; fifty parent wrappers do not prove fifty full app rerenders. Stack ranking also performs indexOf per app; its quadratic work at 50 is probably minor relative to deep state traversal and data views, and is not a first target without evidence.

If component/render profiling identifies meaningful fan-out, prototype a small custom camera controller that writes the same plane transform once per animation frame and publishes stable, limited metadata to dependants. Keep the existing interpolation, coordinates, gesture cancellation, focus fitting, blur, and text rendering. No GPU promotion or canvas culling is required for this experiment.

Avoid equating off-screen DOM with off-screen painting: the browser already clips/culls paint in many situations. Removing DOM, changing containment or adding compositor layers can increase rasterization, wake-up and switching costs. The previous changes demonstrated why these need real foreground traces.

### Browser and processing pages: secondary for this workload

Fifty app records are different from fifty live external pages. Browser guests and hidden processing windows add separate process/resources. The current explicit opt-in for discarding pages preserves arbitrary page state by default. JS debugger pause is not a memory reclamation mechanism and can disturb timers/callbacks; don't expand it to processing tasks.

Audit hidden processing windows for duplicate environments and idle CPU. Their background throttling is deliberately disabled to complete work. Test request completion and session behavior before altering it. Migrating webview to WebContentsView may improve architectural stability, per Electron guidance, but it does not inherently reduce page memory and requires reworking canvas transforms/input/clipping.

## Custom code versus libraries

| Area | Recommended investigation | Reason |
|---|---|---|
| Dirty app tracking / save scheduler | Small custom controller | Orvane owns the mutation, lease, revision and final-close semantics |
| Shared read coordination | Small custom service | App/environment identity and invalidation are product-specific |
| Simple fixed-row windowing | Custom prototype is reasonable | Small surface with measurable bounds; preserve keyboard/selection behavior |
| Variable-height list/windowing | Compare a proven implementation with a custom prototype | Expanded rows, scroll anchoring and measurement complexity can overwhelm a simplistic custom solution |
| Code editing | Keep CodeMirror initially; improve integration | Existing immutable state, viewport rendering, undo and input handling already solve hard problems |
| Entire frontend/framework or GPU canvas rewrite | No evidence supports starting here | High migration risk and loss of native forms, embeds and accessibility; does not fix duplicate data/save work |

## A concrete 50-app validation workload

Proposed target fixture: 20 NetSuite apps, 12 Notes apps, 10 Git viewers, 8 Projects apps. This composition is a research target, not a measured result.

- NetSuite: a mix of Scripts (hundreds of records), File Cabinet folders (up to thousands of rows), saved query tabs/results and several file editors; include split panes and unsaved drafts. Mock record operations for performance runs; validate read-only authenticated behavior separately.
- Notes: populated metadata, documents with many blocks, several views of the same document, long undo histories and a larger document. Test shared updates and independent view state.
- Git: populated histories across a few repositories, one large diff, several viewers of the same repo, ordinary branch/repository switching. Use fixture repositories, not user worktrees.
- Projects: populated folder fixtures and saved terminal views, with one controlled output-producing command. Restore multiple apps pointing at the same root to expose duplicate work.
- Include multi-megabyte workspace variants. Do not confuse dynamic query rows (outside workspace JSON) with persisted app content when specifying payload size.

Run the same scripts at 5/10/20/35/50 apps, then repeat with all 50 visible at overview and with only a few visible at normal zoom. Vary inner tabs, open documents and data size independently. A lightweight 50-app shell is a lower-bound test only.

## Acceptance and experiment order

1. Record a production baseline on the actual Windows/Electron/graphics stack, plus production browser preview. Verify foreground, focus and document visibility throughout each run. Capture a small visual sample confirming computed and visible header blur. User activity or occlusion invalidates a timing run; it is not a low-frame-rate app result.
2. Capture diagnostic traces separately from comparative timing. Include Vue update counts, scripting, GC, style/layout, paint/raster/composite, serialization, request counts, first-pane readiness, CPU and memory by process. Frame callbacks alone do not prove every frame was presented.
3. Apply one candidate behind an experimental switch or isolated branch. Alternate baseline/candidate order for at least five runs and report spread. More samples are needed for stable tail estimates; do not call the maximum of five runs a p99.
4. Suggested engineering budgets, to validate against the baseline: aim near the display refresh cadence for continuous pan; p95 frame interval below 33 ms on a 60 Hz display; no introduced recurring >100 ms stalls; typing response normally under 50 ms; first input to a warm fitted app under 100 ms beyond the existing intentional camera animation. These are proposed gates, not current measurements or user-approved guarantees.
5. Keep DOM appearance, blur and text sharpness equal during and after motion. Verify composition/IME, undo, multi-view Notes, clipboard, drafts, split state, imports, lease/revision checks and final-close saves. Functional tests alone do not establish smoothness.
6. Run a 30-minute 50-app soak and 100 open/close cycles. Memory should stabilize for a fixed workload, not grow with closed views. Compare private memory and working sets separately and include OS memory pressure. No arbitrary RAM cap is established by this research.
7. Recommended sequence: Notes retained state; shared Notes reads; File Cabinet split persistence; scoped dirty tracking; NetSuite lazy initialization; targeted list/editor/result-cache work; Git/Projects read coordination; only then trace-driven camera changes.

No honest estimate of the final maximum sustainable workload or speedup is available before those foreground and soak runs. The diagnostics do establish concrete scaling work that can be reduced without changing the canvas's current look and feel.

## Primary references

- [Pinia $dispose and retained state](https://pinia.vuejs.org/api/pinia/interfaces/StoreWithState.html)
- [Vue synchronous/deep watcher behavior](https://vuejs.org/guide/essentials/watchers.html)
- [Vue performance: stable updates, shallow data and list virtualization](https://vuejs.org/guide/best-practices/performance)
- [Vue KeepAlive lifecycle](https://vuejs.org/guide/built-ins/keep-alive.html)
- [CodeMirror state, view and viewport design](https://codemirror.net/docs/guide/)
- [Electron performance methodology](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Electron webview process and architecture guidance](https://www.electronjs.org/docs/latest/api/webview-tag)
- [Electron process metrics and CPU sampling intervals](https://www.electronjs.org/docs/latest/api/app)
- [Chrome performance analysis](https://developer.chrome.com/docs/devtools/performance/reference)
- [Chrome heap and detached-object investigation](https://developer.chrome.com/docs/devtools/memory-problems)
