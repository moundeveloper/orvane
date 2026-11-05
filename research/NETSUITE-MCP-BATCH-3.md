# Batch 3 — Request journal and observed session generations

Date: 5 November 2026. Branch: `codex/netsuite-mcp-migration`.

Implementation commit: `51b565e`.

## Implemented

The Desktop-owned Node worker records request intent before dispatch and assigns a UUID request ID. Completed reads and executor errors return that ID. SQLite stores operation, timestamps, outcome, sanitized error code, input/target hashes and available origin; it stores no SQL, identity tokens, result rows or remote error messages. The journal uses WAL and FULL synchronous writes in the existing protected broker directory. It retains the latest 1,000 records, except running requests are never pruned.

After exclusive gateway ownership is acquired, startup marks abandoned running requests interrupted. It never replays them. A journal failure before dispatch prevents the executor call. An optional MCP startup failure leaves the Desktop UI open.

`orvane_netsuite_status` now accepts `action: "requests"`, optional `limit` (1–100, default 20), and optional `beforeSequence`. Results include metadata, a pagination cursor and retention summary. Public MCP tool names remain unchanged. Against an older running broker this action returns `UPGRADE_PENDING`; list, inspect and query continue working without an automatic application restart.

Electron tracks per-host/per-origin generations for observed main-frame navigation, renderer crashes and source-view destruction. Same-document navigation and child frames do not invalidate the generation. Targets and reported identity tokens include the generation. Both the broker gateway and shared Electron executor reject stale generations; queued requests recheck before dispatch, and changed generations discard active results. Reservations are released even if invalidation happens during acquisition. A hidden processing view is refreshed once when a new generation is first used. There is no retry/replay after a session-change error.

These generations describe observed source-page lifecycle changes. They do not prove server identity, detect every cookie or remote role change, or provide an atomic server snapshot. Identity remains `source: client-runtime`, `serverRuntimeVerified: false`.

## Agent-run verification

- **26 targeted tests passed:** 19 journal/session/worker/socket/stdio tests plus 7 existing bridge/login tests. Coverage includes durable history, privacy, pagination, unavailable-journal dispatch rejection, crash recovery without replay, two clients, stale/missing/mid-read generations, queued invalidation and reservation release.
- Vue/TypeScript build check and Node syntax checks passed; Git whitespace check passed.
- **10 live checks passed** through the actual installed Claude Desktop and Claude Code MCP configurations against the existing Desktop-owned broker and the explicitly selected sandbox.
- **7 additional live checks passed** with the new Batch 3 worker in an isolated profile: two real MCP stdio clients, real ordered SELECT, request/error IDs, redacted history, persistence across an isolated worker restart and unchanged original Desktop/broker process IDs.

The isolated worker delegates its allowed identity/SELECT calls through the already running Orvane Desktop MCP. This tests new worker/journal/MCP code against real sandbox execution without replacing the user's live broker. The relay truthfully reports session-generation support unavailable because the active Desktop is still Batch 2. The new Electron source-event wiring was tested with fixtures; its live activation awaits the user's next ordinary Desktop restart. No restart or manual test is requested for this checkpoint.

Only `https://4027610-sb1.app.netsuite.com`, account `4027610_SB1`, user `4033`, role `3` was inspected/queried. No Magic tool, account write, deployment, sign-out, focus change or user application restart was performed. Results and tokens are omitted from committed evidence.

Reproduction (background, read-only):

```powershell
node --import tsx --test tests/netsuite-broker.test.ts tests/netsuite-mcp.test.ts tests/netsuite-journal-session.test.ts tests/netsuite-session-queue.test.ts
node --test tests/netsuite-bridge.test.mjs tests/netsuite-login.test.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --build
node scripts/test-orvane-mcp-live.mjs --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3
node scripts/test-orvane-broker-live.mjs --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3
```

The baseline live checker currently expects the active Batch 2 broker. Local redacted reports are in ignored `artifacts/netsuite-mcp-live.json` and `artifacts/netsuite-broker-live.json`.

## Direct Desktop acceptance after user restart

The user subsequently restarted Orvane normally. The actual Batch 3 Desktop then passed **14 live checks** from both installed Claude configurations, including positive supported session generations, real sandbox reads, completed metadata-only journal entries and request IDs on identity errors. The original isolated-relay limitation above no longer applies to activation/normal-read verification. Navigation/role-change transitions were not induced, and server identity remains unverified.

```powershell
node scripts/test-orvane-mcp-live.mjs --batch 3 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch3-desktop-live.json
```

The checker defaults to Batch 2 for the historical command above; `--batch 3` additionally requires live generation support, traceable errors and journal entries. No application restart or focus change is performed by the checker.

## Remaining migration work

This is a durable read-request journal, not a job scheduler. Explicit Windows pipe DACL construction, server-verified identity/capabilities, shared workspace listener ownership, artifacts/cache/export and additional feature families remain separate batches. Existing Claude installation and Magic configuration are preserved. The full migration is not complete.
