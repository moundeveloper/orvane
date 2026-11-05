# NetSuite MCP migration progress

Updated: 5 November 2026. Working branch: `codex/netsuite-mcp-migration`.

## Working agreement

- Work in bounded, reviewable batches; update this file with changes, checks, limitations, and manual test steps.
- Commit each batch before starting another implementation batch.
- At a test checkpoint, provide the commit and concrete instructions to the user and wait for their test feedback before the next implementation batch.
- Keep unrelated workspace changes out of these commits. Do not change a NetSuite account, deploy a Suitelet, or remove the Magic setup during migration.

## Current position

Batch 0 is committed: `bd04a91` — baseline UI fixes and migration design.
Batch 1 is implemented and at the manual-test checkpoint — direct Desktop read service and Claude Code MCP installation. Commit details are recorded below.
**Next action: user tests Batch 1; do not start Batch 2 until feedback.**
The broader migration is not complete; see [the implementation plan](research/NETSUITE-MCP-IMPLEMENTATION.md).

## Batch 0 — Baseline fixes and design

Commit: `bd04a91` — `fix: resolve keyboard scrolling and tab closing; record NetSuite migration plan`.

Completed before this checkpoint:

- Notes caret navigation keeps the current block visible, including below the breadcrumb bar at canvas zoom.
- Notes `/` command menu scrolls the keyboard-highlighted option locally.
- File Cabinet/NetSuite tabs close with middle-click without triggering canvas panning.
- Git Viewer separates staged/unstaged changes and offers committed history for the current branch.
- Source inventory: 155 static Magic tool declarations with source locations; the improved architecture removes the renderer from the proposed MCP execution path.

Checks already completed: focused browser regressions, type-check, production build, and source/link validation. The broader browser suite previously encountered startup lease/font-load timeouts; targeted fixture tests passed.

These commits exclude pre-existing certificate/API-key-vault and other unrelated edits in the working directory.

## Batch 1 — Direct read path and Claude Code setup

Implementation commit: `feat: add read-only Desktop NetSuite MCP and Claude Code setup` (hash to be recorded in the checkpoint update after committing).

### Completed

- Direct authenticated Desktop gateway on an instance-specific named pipe, with a per-user-permitted discovery directory, request/response size limits, and cleanup/stale-owner checks.
- The Electron-owned NetSuite service is callable directly and through the existing UI IPC. Both share a processing-executor queue; no Vue component callback or canvas lease is needed for these reads.
- Read-only `orvane_netsuite_status` (list/inspect) and `orvane_netsuite_query` (SELECT only), with explicit target IDs and reported client-runtime identity checks before/after reading.
- Dedicated `ORVANE_MCP_PROFILE=netsuite` entrypoint: multiple stdio clients use Desktop without creating workspace bridge listeners or database writers. The two tools are also registered in the existing full Orvane MCP server.
- Installed the dedicated profile as user-scoped **`orvane` in Claude Code**. `claude mcp get orvane` and `claude mcp list` report **Connected**. Existing Magic servers in Claude Desktop were preserved.
- Repeatable PowerShell installer with configuration backup and idempotence; terminal smoke checker; detailed [Batch 1 manual test guide](research/NETSUITE-MCP-BATCH-1-TESTING.md).

### Automated verification

- `node --import tsx --test tests/netsuite-mcp.test.ts`: **6 passed** — explicit targets, changed reported identity, rejected account mismatch/non-SELECT/missing target, authenticated socket, response cap, Unicode, duplicate gateway ownership, two real stdio clients, disconnected Desktop, separate window targets, and shared UI/MCP queue.
- `node --test tests/netsuite-bridge.test.mjs tests/netsuite-login.test.mjs`: **7 passed** — existing NetSuite read/write/input validation and sign-in behavior.
- `node node_modules/vue-tsc/bin/vue-tsc.js --build`: passed.
- Node syntax checks on Electron entrypoint/new gateway modules: passed.
- Installer rerun: correct no-op; Claude Code health checks: Connected.
- `node scripts/check-orvane-mcp.mjs`: both tools discovered; actual local status reports `DESKTOP_UNAVAILABLE` until Desktop is started/restarted with the new main-process code.

The socket and stdio tests use a fake NetSuite executor. No live account query/write, role switch or deployment was performed by these automated checks. Live account behavior is pending the user test.

### Manual checkpoint — please test now

1. Save work and **restart Orvane Desktop** (`pnpm desktop` from this repository). Refreshing the renderer alone does not load the Electron gateway.
2. Start a new Claude Code session. Run `/mcp`; check **orvane** is connected.
3. Ask: **“Use only Orvane MCP. Call orvane_netsuite_status with action list. Do not use Magic or make changes.”**
4. Open/sign in to the intended NetSuite account in Orvane's Browser app. List again, select its explicit target, inspect it, then use its returned identityToken for `SELECT id FROM employee WHERE ROWNUM <= 1 ORDER BY id`. A permission error means use a table your role can already query in Orvane; do not automatically switch accounts/tools.
5. Close only the NetSuite app view and repeat. Also try status from a second Claude Code session. Both should work with the same Desktop gateway.
6. Report connection/list/inspect/query results and error codes, including whether Desktop was restarted. Full copyable prompts and failure checks are in [the test guide](research/NETSUITE-MCP-BATCH-1-TESTING.md).

### Remaining work / deliberate limits

- This is a partial Stage B vertical slice; the 155-tool migration and live contract reconciliation are not complete.
- Client-runtime identity is not server-side account/role verification. Bootstrap identity can be stale after an external role change; stronger session identity/epochs and server capability verification are pending. No server mutation capability is exposed here.
- Lightweight gateway routing currently runs in Electron main. Dedicated broker worker, durable jobs/journal, shared read cache, artifacts and document services are not yet implemented.
- Windows discovery/token ACL is restricted, but explicit named-pipe DACL construction remains transport-hardening work; the pipe currently uses Node defaults plus token authentication.
- Query results follow the existing live-page adapter: 100 rows, 20,000-character SELECT, no semicolons, integer offset, 1 MiB response cap; no snapshot/cursor/export yet.
- The dedicated Claude profile exposes only these two NetSuite tools. The older full workspace MCP transport is unchanged and has not been made multi-client by this batch.

### Next batch after test feedback

Address reported live connection/identity/query defects first. Then extract the gateway into the Desktop-owned broker worker, harden lifecycle/session and Windows pipe permissions, add the request journal/typed registry, and migrate shared listener ownership before expanding the tool surface.

## Commit and checkpoint history

| Batch | Commit | State |
| --- | --- | --- |
| 0 | `bd04a91` | Baseline recorded; separate migration branch created |
| 1 | Implementation commit recorded in the next checkpoint update | Automated checks passed; user test pending |
