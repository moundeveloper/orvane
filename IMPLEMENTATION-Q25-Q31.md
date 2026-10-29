# Q25–31 implementation

The supplied `infinite_canvas_implementation_handoff_Q1-Q31.md` is the decision source. This change implements its follow-up decisions in the existing application; it does not claim that every earlier audit recommendation has been completed. Existing example installation and header dragging are retained as subsequent project decisions documented in DESIGN.md.

## Delivered behavior

- **Q25:** Right-click a dock app or press Shift+F10 for Rename, Duplicate, and Manage app. Management identifies incoming dependencies, including reusable action chains. Archive and Move to trash keep stable IDs, content, and connections. Restore either through Workspace. Duplicates detach linked components, clone referenced reusable actions, remap internal targets, retain explicit external targets, and leave other apps in place.
- **Q26:** One relevant hint at a time in the existing top chrome, outside app content. Dismissal is remembered in IndexedDB; using the move/resize gesture also learns it. Search exposes the Canvas guide. No welcome tour or new dock help control.
- **Q27:** A Web Lock grants one tab editing ownership. Secondary tabs are inert viewers, update through BroadcastChannel after committed writes, and queue for ownership. After the editing tab closes or crashes, the next owner reloads persisted data before enabling edits. Storage methods check ownership as well as the UI. No cloud or account is involved.
- **Q28:** Import validates first, then previews Merge and Replace. Merge allocates fresh IDs, including reference remapping, without moving existing apps or changing their order. Unresolved references block commitment with an explanation. Replacement and merge both save a local recovery snapshot in the same Dexie transaction as the workspace. Failed commits leave both stores unchanged. Workspace offers recovery. Import never downloads a backup automatically and clears stale app/editor references after commitment.
- **Q29:** Sandbox throws, including strings, null, zero, and empty strings, are failures. Graph joins execute once after incoming branches settle. Failure stops dependent actions while independent branches continue. Advanced connections can explicitly route **On failure** to a fallback, which receives the error text. Partial completion remains reported as a failure even when fallback runs; completed work is retained and there are no automatic retries. Disconnected graph nodes are identified in the graph footer. Recursive reusable actions and nonfinite counter results produce explanations.
- **Q30:** Dexie/IndexedDB stores current workspace data, recovery snapshots, and learned hints. Existing valid localStorage data migrates; original legacy bytes remain untouched for rollback/export. Unsupported formats are preserved and rejected, rather than reset. Autosave failures retain in-memory edits and expose Retry saving and Export current data. Backup validation strips unknown fields and bounds IDs, graphs, records, size, and nesting.
- **Q31:** Opening a graph uses a draft and does not convert a simple chain. Connection or position changes persist the graph. Individual rules can expand into nested flows, collapse to a compact summary, and retain their behavior. Simple rules remain editable directly; advanced connections remain in the graph editor. Grouping errors appear in the graph footer.

Related repairs include debounced custom-code preview reloads, Space activation of focused buttons, resetting held Space on blur/visibility changes, preserving panels during file-picker or iframe focus, search index clamping, and valid geometry commits.

## Engineering defaults and limits

- The first tab to acquire the lock edits; queued viewers take over only after release. A stalled owner is never forcibly evicted because it might still write. Close that tab to transfer safely.
- Web Locks require localhost or HTTPS and browser support. Unsupported coordination keeps editing disabled and provides export; there is no unsafe competing-writer fallback.
- Recovery retains the five newest snapshots. Restoring a snapshot first snapshots the current workspace, making that restore reversible. Trash retains app data without permanent deletion.
- Backup payload format remains version 1, with additive optional graph/failure-flow fields. Dexie starts at database version 1. Future unsupported payload versions are rejected with recovery instructions.
- Joins require every incoming connection to activate, and take the first incoming result in stored edge order. No automatic value merging is implied.
- Autosave is debounced 180 ms, with visibility/page-hide flushes. Browser termination can interrupt pending asynchronous writes; no durability claim exceeds IndexedDB/browser guarantees.
- Loaded apps, storage, synchronization, and authored actions need no internet connection. Offline navigation/reload requires the application assets to be served locally or cached; this change does not add a service worker.
- Runtime code preview uses a 450 ms pause before applying source edits; applying the new source restarts that frame.

## Verification

`pnpm run build` runs Vue/TypeScript checking and the production build. Playwright covers the incumbent canvas, builder, sizing, focus, motion, groups and custom-code behavior, plus migration, offline writes, tab ownership/sync/transfer, imports/recovery, duplicate independence, trash dependencies, hints, graph inspection and nested editing, validation, graph joins, independent failure branches, fallbacks, and non-Error sandbox throws. Tests run in Chromium; physical touch devices and other browser engines remain unverified.
