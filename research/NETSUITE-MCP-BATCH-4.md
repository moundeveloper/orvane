# Batch 4 — Explicit sharing of in-flight SELECTs

Date: 5 November 2026. Branch: `codex/netsuite-mcp-migration`.

## Behavior and efficiency

`orvane_netsuite_query` accepts `shareInFlight: true` for reads where one observation may serve multiple callers. The default remains `false`: existing requests execute independently. The two public tool names and installed Claude configurations are unchanged.

The Desktop-owned worker shares the complete identity-before → SELECT → identity-after operation when requests overlap and have exactly the same broker-issued target, reported identity token, SQL text and normalized offset. Target handles already include the source generation and host/window, so other windows, accounts and generations cannot join the group. SQL is not trimmed or otherwise rewritten for matching. Existing account checks, generation fences, SELECT validation and result bounds remain in force.

Each caller still records durable intent and receives its own request ID and outcome. Shared responses also include `readSharing` with an ephemeral execution ID, whether the caller joined, total accepted participants and `cacheHit: false`. Mutable results and errors are copied per caller so one caller's journal/error ID or response mutation cannot contaminate another.

Completed results and failures are removed from the sharing map immediately. A later identical query makes a fresh read. There is no TTL cache, retry, snapshot, cancellation of the underlying read or mutation sharing. An individual MCP disconnect leaves the shared execution and other callers running; the disconnected caller's already accepted journal intent receives the actual outcome.

The worker allows at most 32 active sharing groups and 32 accepted participants per group; existing public socket and executor limits also apply. Saturation returns `READ_SHARING_BUSY`. Status exposes `readSharingBudget` with active group/participant counts and limits. Counts describe accepted pending requests, including a caller that has disconnected, rather than live socket subscriptions. Matching keys are hashed and held only in memory; SQL, identity tokens and results are not added to the durable journal.

The thin MCP adapter checks `query.share-in-flight` capability before submitting an opted-in query. Older active Desktop brokers return `UPGRADE_PENDING`; failure to establish capability also prevents submission. Independent queries remain usable. This adds local status/host-enumeration work to opted-in calls; the measured saving below concerns SELECT dispatches, not all IPC messages or a general latency multiplier.

Already-running Claude MCP adapter processes keep their previously loaded tool schema until their MCP connection is reconnected. The checks here launch fresh SDK clients from the installed configuration; they do not control a Claude conversation or its UI. A configuration reinstall is unnecessary.

## Verification

- **32 targeted tests passed:** 25 worker/MCP/journal/session/sharing tests and 7 existing bridge/login tests. New coverage includes five overlapping requests producing one SELECT, fresh execution after completion/failure, per-caller result/error isolation, SQL/offset/identity/generation separation, bounded groups/participants, and a real MCP caller disconnect while another receives the joined result. The real-worker test also verifies separate durable IDs for shared failures.
- Compatibility tests ensure unsupported or failed capability checks never submit a query. Existing worker crash/parent shutdown/no-replay and shared executor reservation tests still pass.
- Type-check, Node syntax checks and Git whitespace checks passed.
- **16 direct live compatibility checks passed** through both installed Claude configurations against the user's active Batch 3 Desktop, on the authorized sandbox. Independent reads/history still work and opted-in sharing returns `UPGRADE_PENDING`.
- **9 isolated new-worker live checks passed.** Two real MCP stdio clients connected to a Batch 4 worker in a temporary profile. Five overlapping opted-in requests issued **exactly one SELECT** through the real Desktop sandbox relay, returned one common execution ID and five distinct completed journal IDs. The subsequent identical request issued another SELECT. The isolated restart preserved history, and the original Desktop/broker PIDs were unchanged.

The live relay dispatch count measures the new worker's SELECT calls to the existing Desktop adapter. It is not a measurement of every internal HTTP request, nor an atomic server snapshot or latency benchmark. Account/user/role were checked before execution. Business row contents and tokens are omitted from committed evidence.

No Magic tools, production queries, account mutations, deployments, sign-out, focus changes or user application restarts were performed. The active Desktop remains Batch 3. Batch 4's integrated activation requires the next normal Orvane restart; the agent can then run the direct `--batch 4` checker without manual user test steps.

## Reproduction

```powershell
node --import tsx --test tests/netsuite-shared-reads.test.ts tests/netsuite-broker.test.ts tests/netsuite-mcp.test.ts tests/netsuite-journal-session.test.ts tests/netsuite-session-queue.test.ts
node --test tests/netsuite-bridge.test.mjs tests/netsuite-login.test.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --build
node scripts/test-orvane-mcp-live.mjs --batch 3 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch4-compatibility-live.json
node scripts/test-orvane-broker-live.mjs --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch4-broker-live.json
```

After the next normal Desktop restart, use the direct checker with `--batch 4` instead of `--batch 3`. It additionally checks five overlapping direct reads and a subsequent fresh execution. The isolated checker tracks the current worker version, superseding its earlier Batch 3 implementation; older batch documents describe their historical runs. Reports are local, redacted and ignored by Git.

## Remaining migration

This batch improves the existing bounded query path. It does not migrate the other Magic feature families or the full workspace transport. Typed operation registry consolidation, explicit Windows pipe DACLs, server-verified identity, full workspace listener ownership, artifacts/export and feature-family reads remain separate increments. Client-runtime identity is still explicitly unverified by the server.
