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

Committed as `bdb5e4d`.

Closing a SuiteQL tab now evicts its recomputable results and execution trace. Open inactive tabs retain their output, and activation transfers the snapshot back to the displayed view rather than keeping a second cached reference. Membership checks prevent a closing/deleted tab's transition from putting output back into the cache. Emptying displayed results also refreshes the lazy derived row snapshots, and unmounting invalidates pending work and clears output references.

The retention policy is no cached output for closed tabs. Reopening retains SQL text and editor undo/redo, displays the existing run/trace prompts and executes nothing automatically. Output for open tabs has no new byte cap; a measured budget for that workload remains future work. No history or editable SQL is evicted to meet a memory target.

Editor identity and text changes now run through one transition so a new file's text cannot overwrite the outgoing undo state before it is saved. Deleted files are forgotten in both local and cross-view deletion paths, including a pending document switch. Late query/trace responses after deletion, environment change or unmount are ignored.

Baseline browser reproduction on `4c9c7cf`: closing/reopening restored the old result without another query. Candidate tests require the result and trace to be absent until an explicit rerun. `node --import tsx --test research/query-outputs.test.ts` passes 3 ownership checks, including pruning 50 stored outputs to zero, rejecting late saves and transferring active output without cloning. All 16 distinct browser tests across `tests/query-performance.spec.ts` and `tests/netsuite.spec.ts` passed, including a rerun of the updated end-to-end undo check. Coverage includes open/closed results and traces, SQL undo/redo, local/remote deletion, late response ownership, query execution, pagination, CSV and editor behavior. `pnpm build` passes with existing warnings. These are correctness and ownership checks, not heap or frame-rate measurements.

### Fourth pass: editor echo snapshots

Committed as `d22a220`.

The general JavaScript/HTML editor and SuiteQL editor now reuse their last emitted string when Vue echoes the model value back. Previously both called CodeMirror's full-document `toString()` again during the echo check. Genuine external updates still take the existing reconciliation path, and SuiteQL resets echo tracking when document identity changes. Emission stays immediate: this pass adds no debounce and changes no parsing, selection, history or composition behavior. File Cabinet already used this pattern.

The instrumented browser fixture patches the actual installed CodeMirror `Text.toString()` and applies ten separately flushed document edits. On baseline `bdb5e4d`, both editors made 20 full-document serialization calls, at both roughly 1 KB and 500 KB document sizes. The candidate makes 10 calls and still emits 10 model updates. For the roughly 500 KB code document, serialized characters fell from 10,000,490 to 5,000,245; for SuiteQL, from 10,000,370 to 5,000,185. Results and fixture details are in `research/editor-serialization-results.json`. These counts do not establish a corresponding typing-latency or frame-rate improvement; one complete string is still emitted per document change.

Validation: all 35 selected Playwright tests passed using `pnpm exec playwright test tests/editor-performance.spec.ts tests/query-performance.spec.ts tests/netsuite.spec.ts tests/editors.spec.ts --grep "editor|SuiteQL|SQL and undo|NetSuite views browse"`. Coverage includes actual browser composition input through Chromium's IME API, external replacements, parent normalization, immediate model updates, selection-only changes, undo/redo, independent document histories and existing editor/NetSuite workflows. `pnpm build` passes with existing warnings. The next performance work remains measured list rendering, document-level persistence/snapshot costs, and foreground/heap/soak validation; this pass does not establish 50-app capacity.

### Fifth pass: large File Cabinet tables

Committed as `27ca652`.

Measured both requested candidates before choosing the change. A 10,000-line Git diff creates 10,004 patch spans and 10,087 elements in its viewer. A File Cabinet root containing 5,000 folders creates 90,101 elements, including its unwindowed sidebar tree. A folder containing 5,000 files creates 65,148 elements, almost all in the table. File Cabinet's default table was therefore the first target; Git diff rendering, the grid, search-result lists and large sidebar trees remain separate work.

Tables above 100 records now render the visible rows with overscan, spacer rows and full logical row indices. Keyboard navigation explicitly reveals unmounted records, and an active rename stays mounted when scrolled away. Row measurements account for overlapping table borders and canvas scale. A collapsed sizing row preserves intrinsic column widths using the complete dataset, including IDs and metadata outside the window. Filtering/sorting reset the window; split panes retain separate scroll state. Small tables and the grid retain their existing rendering. Bulk-selection lookup now uses a set rather than repeatedly scanning the selected-key array.

Matching 1440×1000 browser fixtures on baseline `d22a220` versus this candidate:

| Fixture | Baseline data rows / elements | Candidate data rows / elements |
|---|---:|---:|
| 5,000 root folders, sidebar included | 5,000 / 90,101 | 47 / 45,532 |
| 5,000 files inside one folder | 5,000 / 65,148 | 47 / 767 |

The file-table subtree itself drops from 65,012 to 631 elements. Column widths match the baseline, and total scroll height differs by one pixel (140,031 versus 140,030). A very wide root still retains about 45,000 sidebar elements; it is not a fully bounded view yet. Full record data remains loaded. Folder filtering, application search, selection and copy still operate on the complete record set; browser-native Find only sees mounted row text. Counts and fixtures are recorded in `research/large-lists-results.json`; these are DOM/layout diagnostics, not foreground timings, frame-rate measurements or heap results.

Validation: all 15 Playwright tests across `large-lists`, `file-cabinet-windowing`, `netsuite` and `performance` passed. Checks cover first/last records, off-window keyboard navigation, full 5,000-item selection, shift ranges, clipboard, filtering, sort order, active rename focus, grid/list switching, split-pane scroll independence, resize/zoom, drafts and existing NetSuite/Notes workflows. Baseline/candidate screenshots were visually compared, including actual filename visibility and column alignment. The scoped design detector reported no findings. `pnpm build` passes with existing warnings. No production NetSuite mutations were used for the diagnostics.

### Sixth pass: large Git diffs

Committed as `a2584f7`.

Patches exceeding 500 logical lines or 300,000 characters now use a lazily loaded, read-only CodeMirror viewport. Smaller patches retain the native preformatted renderer. The large renderer adds no parsing or undo history; line decorations inspect only visible ranges and reuse the existing added/removed/hunk colors. The existing font, line spacing, inset, horizontal scrollbar and truncation notice remain. The search package already present through CodeMirror is now an explicit dependency at the installed version, 6.7.2.

The document model retains the complete patch, so Ctrl+A/C copies all lines, Ctrl+Home/End navigates the document, and Ctrl+F within the diff searches unmounted content. Editing/pasting is disabled. Replacing a patch resets selection and scroll; disposal destroys the view and its pending measurements. The application still receives only the server's bounded/truncated patch, not an unlimited repository payload.

In the matching 1440×1000, 10,000-data-line fixture, the baseline (`27ca652`) rendered 10,004 patch spans and 10,087 viewer elements. The candidate renders 36 line elements and 127 viewer elements at the initial viewport; counts vary with viewport and interaction. This removes about 98.7% of viewer elements in that fixture. Full-patch data and CodeMirror's document remain in memory; this is not a measured heap or typing/frame-rate improvement. Cold first use of a large patch now loads the viewer/editor chunks and still needs foreground latency profiling. Small diffs avoid that initialization.

Validation: 14 distinct tests passed across `git-diff`, `git` and `large-lists`, including the isolated rerun of an existing repository-navigation test. Coverage includes full-document clipboard content, read-only behavior, search to the final unmounted line, keyboard navigation, colors, wide-line containment, hidden views, zoom/resize, patch replacement, disposal, native small patches, the 500/501-line boundary, a 310,000-character single line, real Git reads and MCP/workspace switching. `pnpm build` passes. Baseline/candidate screenshots match the existing unfocused appearance, and the scoped design detector reported no findings. Raw DOM counts are in `research/git-diff-results.json`.

### Seventh pass: File Cabinet sidebar trees

Committed as `9ecb673`.

The folder sidebar now flattens the expanded hierarchy and mounts a window of rows against the existing sidebar scroll area. Actions, folder information and Bookmarks retain their positions in that area. Folder and hint measurements use layout pixels independently of canvas zoom; loading/empty hints are measured at their actual indentation so wrapped text contributes the right scroll extent. Observers and scroll/input listeners are removed on unmount.

Filtering retains the existing matching and expanded-ancestor rules. Navigation keeps the full folder path, and selected folders, badges, expansion and loading states remain controlled by the File Cabinet. A focused row stays mounted when scrolled away. Tab and Shift+Tab traverse the complete logical folder sequence, reveal unmounted targets, and enter/leave through the surrounding sidebar controls.

Controlled 5,000-root-folder fixture at 1440×1000: total mounted viewer elements fell from 45,532 after table windowing to 870. The main table remains at 47 mounted data rows and 443 elements, with the same column widths and 140,030-pixel scroll extent. The default baseline and candidate screenshots are pixel-identical. These are DOM/layout diagnostics, not frame-rate, latency or heap measurements. Full folder data remains loaded; application filtering sees all records, while browser-native Find only sees mounted text. Raw counts are in `research/folder-tree-results.json`.

Validation: `pnpm build` passes, as do 16 distinct Playwright checks across `folder-tree`, `file-cabinet-windowing`, `large-lists` and `netsuite`. The concurrent regression run hit Git-render/query/save/reload timeouts; all 13 checks in `folder-tree`, `large-lists` and `netsuite` passed when rerun serially. Coverage includes 5,000 roots, 500 expanded children, full navigation paths, selected state, badges, filtering, loading/empty hints, wrapped hint heights, forward/backward keyboard entry and traversal, focus retention, sidebar collapse, hidden hosts, resize, zoom, disposal, table selection/rename, split panes and draft restoration. The scoped design detector reported no findings. The serial query workflow logged a CodeMirror `Invalid position 15 in document of length 0` measurement error despite passing its assertions; editor measurement remains a separate follow-up from sidebar rendering.

### Eighth pass: File Cabinet grids

Committed as `982d1d3`.

Grids above 100 records now render complete visible CSS grid rows with overscan and row spacers. The native auto-fill columns, tile styles, gap and padding remain. Column counts and tile heights come from layout measurements independently of canvas scale. A rename pins its whole row and accounts for the extra input height; stable item keys preserve focus and text selection when the column count changes. Resize preserves the logical scroll anchor, including staying at the bottom when columns change. Each split pane owns its window, observers and scroll listener, which are disposed on unmount. Small grids render all records.

The 5,000-file fixture at 1440×1000 dropped from 5,000 to 99 mounted tiles and from 45,140 to 1,033 total viewer elements. Both versions use nine columns, 128.4375×91-pixel first tiles, 99-pixel row advance and a 55,056-pixel scroll extent. The visible grid crop has no pixel differences; whole-screenshot differences are confined to the view-toggle focus/hover state. Full records remain loaded, and application filtering, range/bulk selection, clipboard and opening files continue to use the complete dataset. Browser-native Find sees mounted text. These counts do not establish heap, frame-rate or input-latency improvements. Raw counts are in `research/file-cabinet-grid-results.json`.

Validation: `pnpm build` passes, including Vue/TypeScript checking. All 18 distinct checks across `file-cabinet-grid`, `file-cabinet-windowing`, `folder-tree` and `netsuite` pass. Grid checks cover actual viewport visibility, the first/final records, 250 keyboard steps, complete 5,000-item and shift-range selection, clipboard, opening the final file, rename focus/text selection through scrolling and zoom/column changes, filtering, list/grid switches, split panes, hidden tabs, disposal, the 100/101-item threshold, middle scroll anchors and one-column layouts. Existing table, tree, query, draft/reload and NetSuite workflows also pass. The scoped design detector reports no findings. The previously recorded CodeMirror tooltip measurement error remains reproducible in the query workflow; this grid change does not resolve it. Inspection locates the failing coordinate lookup in the installed tooltip plugin's read-measure callback, but does not yet establish the state transition that invalidates its anchor.

### Ninth pass: SuiteQL completion lifecycle

Committed as `e3d19ef`.

The tooltip measurement error recorded in the previous passes now has a focused reproduction. On baseline `982d1d3`, five completion-open/switch-to-empty/restore cycles (ten document switches) produced five caught `RangeError: Invalid position 14 in document of length 0` failures and reopened five old completion popups. The installed tooltip plugin's queued measurement retained outgoing anchors across `setState`, and the saved EditorState retained completion state. The reproduction uses the public `repositionTooltips` API and exception sink, without patching CodeMirror internals.

The wrapper now closes completion before caching the outgoing state and changing document identity. The same fixture produces zero measurement errors and zero restored popups. Ordinary edits and parent echoes keep live completion, and users can request/accept fresh completion after switching. Late asynchronous completion results remain dismissed; this is not a claim that the underlying source/transport is cancelled. The editor view and full undo histories remain in use.

The focused restoration tests also exposed drift from restoring a raw `scrollTop` before CodeMirror finished remeasuring a saved document. Cached document states now store and dispatch CodeMirror's public `scrollSnapshot` effect, preserving the document anchor and horizontal position through layout restoration. Snapshots apply only when the saved document matches the current text. Selection, separate document histories, updated schema/read-only settings and existing forgetting/deletion behavior remain intact.

Validation: all 31 distinct Playwright checks pass across `tooltip-lifecycle`, `editor-performance`, `query-performance` and `netsuite`. Coverage includes the queued measurement reproduction, no cached popup resurrection, live completion through model echoes, accepting fresh completion, independent undo/redo, focus and selection, vertical/horizontal scroll restoration, updated schema/read-only settings, delayed completion results, teardown, IME, parent normalization, output ownership, local/remote deletion and existing NetSuite workflows. The earlier serialization diagnostic remains at ten serializations for ten edits for both editors at 1 KB and 500 KB. The scoped design detector reports no findings. `pnpm build` passes, including Vue/TypeScript checking, with the existing Vite warnings. The end-to-end NetSuite query test now explicitly fails on uncaught errors or the previously unasserted invalid-position console error. Raw reproduction counts are in `research/tooltip-lifecycle-results.json`. These are lifecycle/correctness counts, not foreground latency, frame-rate or heap measurements.

### Tenth pass: collapsed Scripts list rendering

Committed as `d475f56`.

Measured Scripts, expanded content and File Cabinet search before selecting this change. At 1440×1000, 5,000 collapsed scripts mount 40,021 elements. One expanded script containing five deployments and 100 logs raises that to 40,451. The installed desktop bridge already fetches only the first 100 logs per script and limits global search to 100 folders plus 100 files (`electron/netsuite.mjs`); the matching search fixture mounts 2,102 elements, including 2,000 in its results. These are existing bridge limits, not new UI truncation, and other request providers may differ. The main collapsed Scripts list is the larger default rendering cost.

Lists above 100 scripts now mount visible collapsed rows with overscan and spacer blocks. Expanded records remain mounted so previews, log scroll positions, focused controls and deployment actions retain their native DOM. Their measured heights contribute to full scroll geometry; observers track asynchronous loads, wrapping and resize. Logical anchors are restored after layout changes, accounting for native scroll clamping, and the bottom stays visible across viewport-height changes. Tab/Shift+Tab reach unmounted scripts and all expanded controls, enter through the correct logical boundary, and retain a focused row when scrolled away. Small lists render all records. Unmount cancels queued focus correction and removes observers/listeners.

The same 5,000-script fixture now mounts 31 script records and 270 elements. Row height remains 38 pixels, all six column widths match, and scroll extent remains 190,000 pixels. Default baseline and candidate screenshots are pixel-identical. With the one expanded script, the candidate mounts 596 elements while retaining all five deployment records and 100 logs. Full script data remains loaded; application filtering/sorting sees the complete set, while browser-native Find sees mounted text. Expanded panels are deliberately retained, so a many-expanded-panel workload remains a separate profiling target rather than a fully bounded view. No foreground timing, frame-rate or heap improvement is established by these counts. Raw results are in `research/scripts-windowing-results.json`.

Validation: all 15 checks pass across `scripts-windowing`, `netsuite` and `performance`. Coverage includes bridge-bounded search diagnostics, 75 sequential Tab steps, reverse entry/exit, offscreen focus retention, all expanded actions, clipboard, preview/log scroll retention, offscreen panel shrink/collapse anchoring, full-data filters/type selection/sorting, environment changes, controlled loading/failure/retry, zoom/resize, hide/show, teardown and the 100/101-record threshold. Existing NetSuite, query, lazy-view, splitter-persistence and multi-view Notes workflows pass. `pnpm build` passes, including Vue/TypeScript checking, with the existing Vite warnings. The scoped design detector reports no findings.

### Eleventh pass: Notes snapshots and block-write serialization

Committed as `1c117c3`.

Measured the actual owned Notes store with 1,000 blocks (roughly 1 KB HTML each) and 100 snapshots, changing only the first block between captures. Baseline `d475f56` serialized and parsed the entire document 100 times: 122,075,287 serialized characters and 100,000 distinct retained history block objects. The candidate performs no document JSON serialization/parsing for those snapshots and retains 1,099 distinct history block objects, while keeping all 100 history entries. These counts describe this one-block-change fixture, not arbitrary reorder/reindex workloads or measured process RAM.

History now shares immutable, frozen copies of unchanged scalar Block records within each store. Full field/shape comparison catches direct component mutations without relying on timestamps or callers to report changes. Active records restored by undo/redo are detached mutable copies. Current Block fields are scalar; unknown nested/non-scalar imported fields keep the previous JSON-copy behavior, with deeply frozen history copies, so mutable extension objects cannot leak into another history step. The 100-entry limit, action grouping, redo invalidation and independent per-view histories remain. History remains in memory; no persisted format or migration changed.

Block persistence uses detached scalar record copies rather than a JSON encode/parse round trip. The request layer computes deduplication keys only for reads; writes previously serialized their payload to calculate an unused read-cache key. A separate full-block save in the same fixture falls from one document-clone encoding, one clone parse and two payload encodings to a single payload encoding. Atomic full-document replacement, single-block puts, read/write barriers, page identity captured before awaiting, write ordering and surfaced failures remain. Page/schema cloning and the final HTTP JSON encoding are still present.

Snapshots still scan fields across the document and retain a full array of block references per step. Inserts/reindexing or widespread edits can require many new records; complex extension blocks take the deep-copy fallback. This is a bounded internal representation change, not a patch-based editor rewrite or a guarantee of heap/frame-rate improvement. Raw counts are in `research/notes-snapshots-results.json`.

Validation: all 14 unit/service checks pass with `node --import tsx --test research/notes-snapshots.test.ts research/performance.test.ts`. All eight browser checks pass across `notes-snapshots`, `notes` and `performance`. Coverage includes immutable history and writable restores, unknown nested fields, JSON-compatible edge values, the 100-step boundary, full undo/redo cycles and branching, rich block reordering/metadata, independent views, durable reopen/page switching, queued payload detachment and page identity, injected failure/retry, read/write barriers, owned-store disposal, SQLite atomicity and existing Notes UI/MCP workflows. `pnpm build` passes, including Vue/TypeScript checking, with the existing Vite warnings.

### Twelfth pass: query-output budgets and raw snapshots

Committed as `cd51d8c`.

Inactive SuiteQL results and traces now share a 64 MiB estimated-data budget across query views within one renderer. Older inactive outputs are released first. Active output is outside this budget; selecting a tab takes its output before admitting the previous tab, protecting the selected result. An individually oversized output is released when leaving it without displacing other useful entries. Released tabs show an accessible rerun prompt and never execute automatically. Editable SQL and undo history retain their separate owners. Closing/deleting tabs, changing environments and destroying views remove their cache accounting.

Query result arrays and trace snapshots now use shallow ownership after auditing nested writes. Trace progress explicitly notifies the view, while result sorting copies only when needed. Trace row display text is formatted once per completed stage while displayed and discarded when leaving the trace pane. Output-size accounting traverses fields without JSON encoding; saved weights are reused on tab switches.

The 20-tab fixture with 100 rows and approximately 1 KB cells retains the same 19 inactive outputs and makes the same 20 requests. Reactive retained result rows fall from 1,900 to zero; the two-stage trace fixture similarly falls from 125 reactive trace rows to zero. These are proxy counts, not heap savings. In a separate wide-cell retention diagnostic, lowering the candidate's control budget from 1 GiB to the default 64 MiB reduces retained inactive tabs from 19 to 10 and rows from 1,900 to 1,000. Estimated accounting falls from 124,974,508 to 65,776,918 bytes; serialized diagnostic payload size falls from 62,425,200 to 32,855,799 bytes. The active result stays visible, request count remains 20 and teardown returns cache accounting to zero. Raw diagnostics and baseline identity are in `research/query-memory-results.json`.

This budget is an accounting estimate, not a process-memory or JavaScript-heap cap. Active results, SQL/history, in-flight payloads, other app data and temporary display data are outside it. Foreground heap calibration and the mixed-app soak remain necessary.

Validation: seven unit checks and 23 browser checks pass across query ownership, memory and NetSuite workflows, with targeted reruns after the trace-formatting change. Coverage includes shared eviction across views, oversized admission, selected-output protection, SQL undo/redo, explicit reruns, trace progress, formatting counts, raw-data sorting/filtering/export/pagination, environment changes and teardown. `pnpm build` passes with the existing Vite warnings. The released-output prompt was visually reviewed, and the scoped design detector reports no findings.

### Thirteenth pass: large deployment lists in expanded Scripts panels

The actual Scripts component with mocked deployment reads was measured at 20 expanded scripts with 1,000 deployments each. Baseline `cd51d8c` mounted 20,000 deployment rows and 60,381 viewer elements. The candidate mounts 2,000 rows and 6,481 elements, with the same 20 deployment requests. These are synthetic DOM counts, not foreground timings, real account workload frequencies or heap measurements. Raw diagnostics are in `research/script-deployments-results.json`.

Deployment responses remain complete in memory, but panels show at most 100 deployment rows at a time. Larger lists have Previous/Next controls and an announced visible range; lists of 100 or fewer keep every row and omit paging controls. Every fetched deployment remains reachable and opens its original record ID. Browser-native Find sees only the current deployment page. Paging is local and makes no additional requests; it does not change the bridge's response limits or promise that upstream responses include every account record.

A dedicated deployment component owns each panel's page. Other panels loading, execution logs, sorting the script list, outer scrolling and resize do not reset that page. Collapse/filter removal, reload and environment changes recreate panels on their first page. Expanded controls, log scroll and file previews remain mounted; variable-height unmount/remount of entire expanded panels was unnecessary for the measured deployment-row cost. The number of expanded panels and their cached data still grows with user expansion, so this is not a total DOM or memory cap.

Script and deployment row snapshots use shallow refs after auditing their read-only usage. Deployment arrivals replace the response map, notifying the view without deep-proxying each record; editable state and log controls retain their existing behavior. Loading, error/retry and generation checks remain unchanged.

Validation: all 16 browser checks pass across `scripts-deployments`, `scripts-windowing` and `netsuite`, followed by all four deployment checks again after adjusting narrow paging layout. Coverage includes complete 210-row page traversal, last-page record actions, keyboard navigation and exit, empty/100/101-row boundaries, independent panel state, logs, sorting, reload, resize/zoom, existing preview/clipboard/edit actions, scroll anchoring, environment changes and request failures. `pnpm build` passes with the existing Vite warnings. The narrow paging layout was visually reviewed; the scoped design detector reports no findings.

### Remaining work, in current order

1. Profile remaining Notes metadata/cache and persistence costs with representative workloads. Apply further canonical caching or smaller persistence commits only if measurements warrant their consistency/migration costs.
2. Run foreground Electron/browser comparative traces, first-use latency checks, heap/open-close profiling and the 30-minute mixed 50-app soak. These remain the main validation gap for the cumulative optimizations.
3. Use those traces to decide whether many retained expanded panels, camera/controller work or filesystem concurrency need further changes. Capped execution logs/search remain lower priority unless representative evidence changes that ranking.

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
