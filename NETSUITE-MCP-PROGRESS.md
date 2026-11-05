# NetSuite MCP migration progress

Updated: 5 November 2026. Working branch: `codex/netsuite-mcp-migration`.

## Working agreement

- Work in bounded, reviewable batches; update this file with changes, checks, limitations, and manual test steps.
- Commit each batch before starting another implementation batch.
- Updated by the user after Batch 2: run automated and available live MCP checks independently instead of asking the user to perform routine tests. Record results and commit before moving to another batch. User feedback is no longer a mandatory gate for checks the agent can execute.
- While the user is using the computer, prefer background APIs/processes. Do not move focus, close views, sign out, kill the live broker, or restart their applications to manufacture a test result. Keep disruptive lifecycle tests in isolated fixture processes; report unexecuted live cases honestly.
- Keep unrelated workspace changes out of these commits. Do not change a NetSuite account, deploy a Suitelet, or remove the Magic setup during migration.

## Current position

Batch 5 adds `orvane_netsuite_read` with typed script/deployment and folder/file metadata pages, using the same identity-checked SELECT executor. **37 targeted tests, 18 current-Desktop compatibility checks and 15 isolated-new-worker live checks passed.** The active Desktop remains Batch 4; Batch 5 needs the next normal restart and a fresh Claude MCP connection/schema. No reinstall or manual query test is required. See [Batch 5 evidence](research/NETSUITE-MCP-BATCH-5.md) and [incremental legacy dispositions](research/netsuite-mcp-migration-map.json).

Batch 4 is active after the user restarted Orvane. Explicit, bounded in-flight SELECT sharing passed **16 direct live checks** through both installed Claude MCP configurations, including five overlapping opted-in reads with one execution ID and five distinct request IDs, followed by a fresh execution for a later read. Earlier verification also passed **32 targeted tests, 16 Batch 3 compatibility checks and 9 isolated-new-worker live checks**. See [Batch 4 implementation/evidence](research/NETSUITE-MCP-BATCH-4.md). No further restart or manual test is needed for this checkpoint.

Batch 0 is committed: `bd04a91` — baseline UI fixes and migration design.
Batch 1 core live test passed, as reported by the user: explicit sandbox selection, inspect and SELECT through Orvane only. Claude Desktop and Claude Code configurations are installed and unchanged by Batch 2.
Batch 2 implements the Desktop-owned broker worker and has now passed background live verification against the existing Desktop and both installed Claude MCP configurations. Routine testing is handled by the agent from this point onward.
Batch 3 adds a durable metadata-only request journal, traceable request/error IDs, bounded MCP history and observed session-generation fences. Agent-run verification passed: 26 targeted tests, type-check, 10 baseline live checks and 7 isolated-new-worker live checks. The user's running Batch 2 Desktop was left untouched; new Electron lifecycle wiring activates at the next ordinary restart and has fixture coverage meanwhile.
No routine user test is required at this checkpoint. See [Batch 3 implementation and evidence](research/NETSUITE-MCP-BATCH-3.md).
After the user restarted Orvane, the active Batch 3 Desktop also passed **14 direct live checks** through both installed Claude MCP configurations. Session-generation support, completed journal entries and traceable identity errors are now verified on the actual running Desktop. Source navigation/role-change scenarios were not induced.
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

Implementation commit: `568a1fe` — `feat: add read-only Desktop NetSuite MCP and Claude Code setup`.

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

The socket and stdio tests use a fake NetSuite executor. No live account query/write, role switch or deployment was performed by these automated checks. User-reported live account results are recorded below.

### Manual checkpoint — please test now

1. Save work and **restart Orvane Desktop** (`pnpm desktop` from this repository). Refreshing the renderer alone does not load the Electron gateway.
2. Start a new Claude Code session. Run `/mcp`; check **orvane** is connected.
3. Ask: **“Use only Orvane MCP. Call orvane_netsuite_status with action list. Do not use Magic or make changes.”**
4. Open/sign in to the intended NetSuite account in Orvane's Browser app. List again, select its explicit target, inspect it, then use its returned identityToken for `SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1`. A permission error means use a table your role can already query in Orvane; do not automatically switch accounts/tools.
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
| 1 | `568a1fe`, follow-up `d3f6697` | Automated checks and user-reported sandbox list/inspect/query passed |
| 1 acceptance | `62ca0df` | User feedback recorded; deterministic smoke query corrected |
| 2 | `ef793cb` | 19 targeted tests passed; background live MCP checks passed against both installed profiles |

Use the current branch HEAD when testing; checkpoint documentation commits record the implementation hashes above without starting another implementation batch.

## Batch 1 follow-up — Claude Desktop configuration correction

The first installer targeted Claude Code CLI (`~/.claude.json`), while the user's screenshot was Claude Desktop's **Local MCP servers** screen. Added `orvane` to `%APPDATA%/Claude/claude_desktop_config.json` alongside `magic-netsuite-apps` and `magic-netsuite`.

- Added an idempotent Desktop installer: `scripts/install-claude-desktop-mcp.ps1`.
- Backed up the Desktop config before the atomic update; structural comparison confirms all existing servers and preferences are unchanged.
- Connected an MCP client using the exact Desktop config command/arguments/environment and verified both Batch 1 tools are discoverable. Actual status remains `DESKTOP_UNAVAILABLE` until Orvane Desktop is started/restarted with the new gateway.
- Installer rerun made no change. Updated the manual guide to distinguish Desktop settings from Claude Code CLI's `/mcp`.
- Commit subject: `fix: install Orvane MCP in Claude Desktop alongside Magic` (current follow-up commit).

That setup checkpoint was followed by the successful user test recorded below.

## Batch 1 user test result — received 5 November 2026

- User reports using only Orvane MCP, no Magic tools and no changes.
- Both production and sandbox origins were listed. The sandbox `4027610-sb1.app.netsuite.com` was selected explicitly.
- Inspect reported account `4027610_SB1`, role `3`, client-runtime identity, and `serverRuntimeVerified: false`.
- The bounded employee SELECT returned one row, `id: -5`; the reported before/after identities matched.
- Ephemeral target IDs and identity tokens are intentionally omitted from this progress record.
- The user correctly noted that the original smoke query applied `ROWNUM` before sorting. Manual prompts now use `SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1` to select the lowest ID deterministically.
- The second-client, closed-view and restart cases were not reported in this feedback; they remain in the manual test matrix.

## Batch 2 — Desktop-owned broker worker

Implementation commit: `ef793cb` — `feat: run NetSuite MCP gateway in a Desktop-owned broker worker`.

### Completed

- Desktop now forks one dedicated Node worker with an inherited private IPC channel. The worker owns authenticated socket handling and target/identity orchestration; Electron main owns browser sessions and a limited read executor.
- The Electron boundary independently validates host ownership, NetSuite origin, read operation and SELECT bounds. Unknown operations and account-write attempts are rejected before existing service dispatch.
- Private-channel requests and responses are bounded, pending executor work is limited, and transport/executor failures have explicit error codes.
- Status/inspect/query results expose `batch: 2` and execution metadata with distinct worker/Desktop process IDs. Public tool names and Claude configurations are unchanged.
- Desktop waits for graceful worker shutdown before quitting, with bounded fallback. Worker failure disconnects clients without replay or main-process fallback; stale discovery from a hard termination is reclaimed on a later start after checking the old owner PID.
- Added [the Batch 2 manual test guide](research/NETSUITE-MCP-BATCH-2-TESTING.md). Corrected the smoke SQL after the user's `ROWNUM` observation and committed the Batch 1 acceptance record as `62ca0df` before implementation.

### Automated verification

- `node --import tsx --test tests/netsuite-broker.test.ts tests/netsuite-mcp.test.ts`: **12 tests** — six real-worker lifecycle/private-gateway checks plus the six Batch 1 socket/stdio/identity/queue checks.
- Real worker tests cover two stdio clients sharing one process, privileged-boundary rejection, worker crash during a read with no replay, stale-target invalidation, forced parent termination with no orphaned worker, stale descriptor recovery, missing Node executable, and duplicate profile-owner rejection.
- `node --test tests/netsuite-bridge.test.mjs tests/netsuite-login.test.mjs`: **7 existing bridge/login tests**.
- Type-check (`node node_modules/vue-tsc/bin/vue-tsc.js --build`) and Node syntax checks for the Electron entrypoint and new broker modules: **passed**. Total targeted tests: **19 passed**.

The 19 automated worker/socket/stdio tests use fixtures. Subsequent agent-run live verification is recorded below separately; it exercised the actual Desktop worker and sandbox without an account write.

### Original manual checkpoint (superseded by agent-run checks below)

1. Save work and fully restart Orvane Desktop from this branch. No MCP reinstall is required.
2. Call status/list from Orvane MCP. Expect `batch: 2`, `execution.mode: broker-worker`, and a `brokerPid` different from `desktopPid`.
3. List and inspect a **fresh** target for the intended sandbox, then run `SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1` using the new identity token.
4. Try a second Claude client and confirm the same Desktop/broker IDs. Close only the NetSuite app view, keeping Browser/Desktop open, and repeat the read.
5. Save and close/reopen Desktop normally. Status should become unavailable while closed; after reopening, list/inspect again before querying.

Full copyable prompts and expected results are in [the Batch 2 guide](research/NETSUITE-MCP-BATCH-2-TESTING.md).

Durable jobs/journal, explicit Windows pipe DACLs, server-side identity verification, full workspace bridge migration and new feature families are separate follow-up slices. Do not claim Stage B or the full migration complete after worker extraction.

## Batch 2 live acceptance — agent-run background checks

Date: 5 November 2026. The user requested independent testing while continuing to use the PC. No application was closed/restarted, no focus/input was taken, and no Magic tool or account write was used.

- Added `scripts/test-orvane-mcp-live.mjs`, a repeatable read-only integration checker. It loads the actual `orvane` entries from Claude Desktop and Claude Code configuration, validates the expected repository/profile, and starts two independent MCP SDK clients in the background.
- This tests the configured stdio/MCP paths and real Desktop/NetSuite execution; it does not claim to automate an existing Claude conversation or Claude's visual UI.
- Both profiles connected and advertised exactly the two expected read-only tools.
- Both returned `batch: 2`, `execution.mode: broker-worker`, the same Desktop/broker IDs, and distinct broker/Desktop process IDs.
- Only the previously selected sandbox `4027610-sb1.app.netsuite.com` was inspected/queried. Account, user and role were checked against the user-reported expected values before reading.
- The ordered one-row employee SELECT succeeded from each profile, returned one row and preserved the reported identity. Business row contents and identity tokens are omitted from the report.
- Invalid target IDs and deliberately invalid identity tokens returned `TARGET_UNAVAILABLE` and `IDENTITY_CHANGED` respectively, without selecting another environment.
- Closing only the first **test client's stdio connection** left the existing broker and second test client usable. The user's Claude/Orvane applications were not touched.
- Live result: **10 integration checks passed**. A redacted local report is written to `artifacts/netsuite-mcp-live.json` (ignored by Git).

Reproduction for the already authorized sandbox:

```powershell
node scripts/test-orvane-mcp-live.mjs --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3
```

The checker refuses production origins and ambiguous targets. It stops rather than changing account/role or falling back to Magic. A changed expected identity must be deliberately selected for a future authorized test.

Live closing/reopening of Desktop, closing user views, sign-out/role changes and killing the live worker were **not performed**, because the user is actively using the PC. Their isolated lifecycle coverage remains in the automated fixture tests; the new live checks do not prove server-side session/role verification.

## Batch 3 — Durable reads and observed session fences

Implementation commit: `51b565e` — `feat: journal NetSuite reads and fence observed session changes`.

- Added a worker-owned SQLite metadata journal with durable intent, request/error IDs, bounded history and interrupted-request recovery without replay. SQL, tokens and business rows are not stored.
- Added `status` action `requests` with pagination, preserving the existing two MCP tool names. Older running brokers return `UPGRADE_PENDING` for history while existing reads remain available.
- Added observed source lifecycle generations, target/token rotation, private gateway validation, and shared executor checks before/after reads and after queue/acquisition waits. Changed generations discard results, release reservations and do not retry.
- Optional MCP startup errors now leave Desktop open. Client-runtime identity remains explicitly unverified by a server.
- **26 targeted tests**, type-check and syntax checks passed. **10 baseline live checks** and **7 isolated Batch 3 worker checks** passed on the authorized sandbox. The original live Desktop/broker was neither restarted nor replaced. Actual new Electron navigation-event wiring has fixture coverage and awaits the next ordinary app restart; no manual testing gate is imposed.
- Full implementation, commands, evidence limits and next work: [Batch 3 record](research/NETSUITE-MCP-BATCH-3.md).

Next batch: select the next bounded migration slice from the implementation plan after committing this work. Server-side identity verification, explicit pipe DACLs, full workspace broker ownership, jobs/cache/artifacts and feature expansion remain pending.

### Batch 3 direct Desktop acceptance after user restart

The user confirmed a normal Orvane restart. The background checker was extended with `--batch 3` and ran against the actual installed Desktop and Code profiles, without an isolated relay. All **14 checks passed**: shared Batch 3 worker, explicit sandbox account/user/role, supported positive session generations, ordered one-row SELECT from both clients, stable reported identity/generation, completed metadata-only journal entries, invalid target/identity rejection with request IDs, and continued service after one test client disconnected.

Command: `node scripts/test-orvane-mcp-live.mjs --batch 3 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch3-desktop-live.json`.

The report is local and ignored by Git. No Magic, account mutation, production query, UI input or additional application restart was used. Observed navigation invalidation remains fixture-tested; this live run verifies activation and normal reads, not every lifecycle transition or server-side identity.

## Batch 4 — Bounded in-flight SELECT sharing

Implementation commit: `9d55050` — `feat: share explicitly opted-in NetSuite reads while in flight`.

- Added explicit `shareInFlight` query option, default false. Identical overlapping target/identity/SQL/offset reads share one complete identity-checked execution. No completed-result cache or automatic retry was added.
- Every caller retains an independent durable request ID/result/error; disconnecting one actual MCP client does not cancel the other caller. Status exposes bounded active group/participant counts; responses report the shared execution ID and participant count.
- Capability preflight prevents accidental execution on an older broker when sharing was requested. Existing independent queries and the two installed Claude profiles remain compatible.
- Verified **32 targeted tests**, type-check and syntax checks, **16 live compatibility checks** on the active Batch 3 Desktop, and **9 isolated Batch 4 worker live checks** relaying to the authorized sandbox. Measured five concurrent requests → one SELECT; the later request executed anew. No user application was restarted and no NetSuite mutation was made.
- Full evidence, limits, commands and activation status: [Batch 4 record](research/NETSUITE-MCP-BATCH-4.md).

### Batch 4 direct Desktop acceptance after user restart

On 5 November 2026 the user confirmed a normal Orvane restart. The actual Batch 4 Desktop passed **16 direct live checks** through fresh MCP SDK clients launched from the installed Claude Desktop and Code configurations. Both profiles reached the same separate worker, checked sandbox account/user/role, completed the ordered one-row SELECT, exposed completed metadata-only history and rejected invalid target/identity inputs. Five overlapping opted-in queries returned a common execution ID and five distinct request IDs; the subsequent identical read started a fresh execution. Disconnecting one test client left the other usable.

Command: `node scripts/test-orvane-mcp-live.mjs --batch 4 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch4-desktop-live.json`.

The redacted report is local and ignored by Git. This verifies the actual running Desktop rather than the earlier isolated relay. No Magic, production query, account mutation, GUI input, additional application restart or Claude conversation automation was used. Navigation/role-change disruption was not induced, and server identity remains unverified.

## Batch 5 — Typed script/deployment and File Cabinet metadata

Implementation commit: `691a3a4` — `feat: add typed script and File Cabinet metadata reads`.

- Added compact `orvane_netsuite_read`: `scripts`, `deployments` by script ID, top-level/child `folders`, and `files` by folder ID. Strict shared schema/registry compiles fixed ordered SELECTs and 100-row pages through the existing executor.
- Preserved explicit identity, source-generation fences, optional sharing, bounds and per-caller journal IDs; journal outcomes now distinguish `read.<action>`. Capability checks prevent submission against older brokers.
- Added a separate incremental legacy disposition map. These are partial native read replacements; source content, script filters, combined folder/breadcrumb contracts, record-type deployments, logs and other feature families remain pending.
- **37 targeted tests**, type-check/syntax checks, **18 active-Desktop compatibility checks** and **15 isolated new-worker live checks passed**, including all four typed actions with real sandbox data. The user Desktop/broker remained open and unchanged; no account writes or Magic calls were made.
- Full scope, test commands, evidence limits and activation steps: [Batch 5 record](research/NETSUITE-MCP-BATCH-5.md).
