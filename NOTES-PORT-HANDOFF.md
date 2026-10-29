# Notes port handoff — 2026-10-29

## User request and usage constraint
Port Notes from `C:\Projects\MagicNetsuiteExtension` into Orvane, matching Orvane's styling. User asked to monitor Codex usage and write an AI handoff near 4% remaining. Last check: 94% used / 6% remaining in the 300-minute window. Use `mcp__codex_app__get_usage_limits` to recheck; preserve this file if usage runs out.

## Workspace and rules
Work in `C:\Projects\Orvane`, PowerShell. Many preexisting uncommitted changes from earlier work: never reset/revert. Do not modify the source extension. Its AGENTS.md forbids native select/option controls. Orvane uses CustomSelect/CustomNumber. Read DESIGN.md: table headers must be outside scroll bodies; scrollbar starts below header. Source notes feature copied from `vue-ui/src/features/notes`.

## Implemented
- Full feature copied to `src/components/notes`: nested pages, rich text blocks, database table/board/list, tabs, search, favorites, trash, export, images, slash menus, formatting.
- Replaced source Dexie DB with typed SQLite HTTP adapter in `src/components/notes/db.ts`. Serializes requests; block body replacement is atomic.
- `server/notes.ts` validates operations through Zod; `server/notes-api.ts` same loopback/same-origin guard and isolated test namespaces as Git. Vite plugin registered in vite.config.ts.
- `server/database.ts` adds notes_records table and transactional notesData methods (list/get/put/add/delete/bulk/replaceBlocks).
- MCP `notes_data` registered in server/index.ts, shared service for UI/MCP. New `kind: notes` supported model/validation/automation/BlockView. Workspace options has Create Notes. App minimum 640x440.
- NotesView uses local refs instead of vue-router and stores active page/tab IDs in block.value (SQLite workspace autosave). Light Orvane theme, no body theme mutation, app-scoped shortcuts, zoom-correct sidebar sizing.
- Source native dropdown replaced by NotesSelect wrapper around CustomSelect. Structural Sidebar icons use Orvane Icon. Replaced native title tooltips with aria-label.
- Added DOMPurify dependency. Sanitizes HTML before detached/live innerHTML render in BlockItem, BlockEditor, store stripHtml.
- Page title saves immediately instead of source delayed closure that could save wrong page after switching.
- Database header split into static header table and separate scrolling body, horizontal sync, matching colgroup/gutters. BlockEditor drag selection overlay teleports to body.
- Storage error events show an in-app banner.

## Latest status (supersedes older checklist below)

- Usage is now **98% used / 2% remaining**; handoff was created earlier at 6% remaining.
- Notes app **created through LIVE Orvane MCP**, id `af9b56da-256c-406b-a786-39bf0bcd02a3`, via `artifacts/create-notes.mjs`. It is in the user's dock. No original extension notes imported.
- `pnpm build` passes (`artifacts/notes-final-build.log`). Follow-up duplicate aria-label attributes caused by converting native title attributes were fixed in PageTreeItem.vue and BlockItem.vue.
- Most recent UI test passed initial editing/reload checks but failed only at a new app_focus AFTER page.reload because the browser bridge had not reconnected yet. Added workspace_status connected polling before that second app_focus. Next run: `artifacts/notes-delivery-tests.log`; see latest session below if still running.
- Initial complete Notes test run passed both tests before screenshot-refocus enhancement. SQLite atomic rollback/reopen test has continued passing.
- Still inspect framed Notes screenshots and pale paragraph rectangle if present. Temporary `console.log('Notes layout', ...)` in tests/notes.spec.ts prints computed first-block details. Remove after diagnosis.
- Still add brief README/server docs for Notes and update automation tool component description. Broaden relevant checks if justified; do not claim a full regression pass.

## Verification and immediate next work
- `pnpm build` passed after the main port (`artifacts/notes-build.log`).
- `tests/notes.spec.ts` has SQLite atomic replacement/reopen test and real stdio MCP + local Vite UI test covering rich text, HTML event sanitization, title/body persistence/reload, database creation, adding row, no native selects, cross-origin rejection.
- Initial focused run: **2 passed** (`artifacts/notes-tests.log`).
- Follow-up `artifacts/notes-verified-tests.log`: **1 passed, 1 failed**. Inspect final error and `test-results/notes-Notes-MCP-port-edits-435b2--and-exposes-database-views/error-context.md`. Follow-up changes were a new app_focus after reload to frame screenshots and replacing native title attributes with aria-label in note Vue files. Could be cold dev-server loading/5-second assertion timing; diagnose rather than blindly loosening tests.
- Screenshots `artifacts/notes-workspace.png`, `artifacts/notes-database.png` initially offscreen after page.reload because camera not refocused. Added app_focus before screenshot to fix. Inspect updated screenshots. Initial screenshot also showed a pale tall rectangle behind first paragraph; investigate if source content styling/image fixture causes this. Source sanitized test seed includes img src=x onerror attribute, then fills text. Determine real DOM/computed sizes if needed.
- **Not created in user's actual saved workspace yet.** After verification, create through real MCP via programmatic SDK (tools not directly exposed). Adapt `artifacts/create-git-viewer.mjs` or `create-projects-hub.mjs` to kind notes/name Notes/icon text. Do NOT reuse Projects Hub configuration import logic. Preserve user workspace via expectedRevision. Script can use live session or safe offline mode and should reuse existing notes app if present.
- Original extension note data lives in its browser IndexedDB and has NOT been migrated; user requested port view, not data import. Do not claim original notes imported.
- Need add short README + server README notes docs and update automation component description for kind notes.
- Final build/typecheck and relevant regression checks. Existing custom Vite integration tests must use unique cacheDir to avoid shared dependency cache races. Existing full suites can hit 5s lazy-load timing under parallel load; earlier editor test passed alone. No need to rerun full suite unnecessarily.

## Tools and environment
Use tools through functions.exec; git source and Projects Hub app already implemented earlier. No subagents unless user explicitly requests. First response already informed user of work. Keep progress updates under ~60 seconds. UI port scoped by source feature + Orvane styling; no more discovery questions needed.
