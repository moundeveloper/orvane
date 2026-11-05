# Batch 5 — Typed script and File Cabinet metadata reads

Date: 5 November 2026. Branch: `codex/netsuite-mcp-migration`.

Implementation commit: `691a3a4`.

## Implemented behavior

The dedicated profile now advertises three tools: existing status/query plus `orvane_netsuite_read`. The new tool takes an explicit target/identity, action, optional numeric ID, page and optional in-flight sharing. Older broker capabilities or a failed capability lookup prevent submission; existing status/query calls remain compatible.

| Action | ID meaning | Result |
| --- | --- | --- |
| `scripts` | Omit ID | Script metadata, type, owner and source-file reference |
| `deployments` | Required positive script internal ID | Deployment metadata for that script |
| `folders` | Omit for top-level folders; otherwise parent folder ID | Immediate child folder metadata |
| `files` | Required folder ID | Immediate file metadata, without content/download URLs |

Negative nonzero system folder IDs are allowed. Pages start at 0, contain at most 100 rows and stop at page 10,000 (offset 1,000,000). Fixed SELECTs use name/script ID ordering with a unique internal identifier as tie-breaker. This is live offset paging, not a snapshot. The `read` descriptor reports schema version, action, ID, page, page size and pagination mode; adapter data/counts remain under `data`.

The strict schema and small typed registry in `server/netsuite-read-operations.ts` are shared by MCP and the broker. Templates interpolate only validated safe integer IDs; supplied SQL/effect flags, unknown fields/actions, zero/unsafe IDs and invalid pages are rejected. Erasable TypeScript is imported natively by the forked Node worker, covered by real-worker tests without a worker tsx loader.

Only existing identity/SELECT commands cross the Electron gateway. Reads retain account checks, before/after runtime identity, source-generation fences, queue, result limits and optional sharing. Identical opted-in typed/raw SELECTs may share execution while preserving separate descriptors and request IDs. There is no new NetSuite engine, arbitrary code, write, completed-result cache or retry.

The metadata journal records `read.scripts`, `read.deployments`, `read.folders` and `read.files`; arguments are hashed. Generated SQL, tokens and business rows are not persisted. Client identity remains `serverRuntimeVerified: false`.

## Migration scope

[The incremental disposition map](netsuite-mcp-migration-map.json) records partial/pending contracts without changing the original 155-tool inventory or installing legacy-name aliases. Script filters/fuzzy search, legacy all-row responses, source reads and logs remain pending. Deployment metadata by script ID does not replace Magic's deployed scripts by record type with source code. Folder/file pages are separate reads: combined results, breadcrumbs, context-picker integration and legacy URLs remain pending. Root selection retains Orvane's existing `IsTopLevel` predicate. File contents, artifacts/PDF/binary handling, search and writes are not included. Unmapped tools remain pending.

## Agent-run evidence

- **37 targeted tests passed:** 30 worker/MCP/journal/session/sharing/typed-read tests plus 7 bridge/login tests. New coverage includes strict schema/injection rejection, action-specific IDs/pages, identity-change discard, row bounds, typed/raw sharing isolation and actual two-client MCP routing with durable action-specific outcomes. Unknown SQL fields are also rejected through the real MCP tool.
- Type-check, Node syntax and Git whitespace checks passed. Disposition names/fixture links were validated against the inventory/repository.
- **18 direct live compatibility checks passed** through fresh clients from both installed Claude configurations against the active Batch 4 Desktop. Existing reads/history/sharing work; typed reads return `UPGRADE_PENDING` before submission.
- **15 isolated Batch 5 worker live checks passed.** Real MCP calls relayed through the unchanged Orvane sandbox executor returned two script pages (100 rows each), one deployment, 100 top-level folders, a valid empty child-folder page and two file metadata rows. An earlier run also returned six child folders. No action was skipped in the final run. Every typed response matched its reported identity and completed action-specific journal entry.
- Existing live checks retained five concurrent queries → one SELECT/five journal IDs, a fresh subsequent read, persistent history after an isolated restart and unchanged original Desktop/broker PIDs.

An initial restart-history assertion searched only the latest 20 entries; additional calls moved the original request beyond that page. The checker now requests up to 100 entries for this isolated assertion and passes. No journal data was lost.

Only sandbox `https://4027610-sb1.app.netsuite.com`, account `4027610_SB1`, user `4033`, role `3` was inspected/queried. No Magic, production query, account write, deployment, sign-out, focus change or user application restart was used. Business names/IDs, contents and tokens are omitted from committed evidence. Local redacted reports contain row counts and outcomes.

The active Desktop remains Batch 4. Batch 5 activation awaits the next normal Orvane restart. Existing Claude MCP processes also need a normal reconnect/new session to load the three-tool schema; no configuration reinstall is needed. Tests use fresh SDK clients from installed configuration, not automated Claude conversations. Source lifecycle transitions and server identity were not newly verified.

## Reproduction

```powershell
node --import tsx --test tests/netsuite-typed-reads.test.ts tests/netsuite-shared-reads.test.ts tests/netsuite-broker.test.ts tests/netsuite-mcp.test.ts tests/netsuite-journal-session.test.ts tests/netsuite-session-queue.test.ts
node --test tests/netsuite-bridge.test.mjs tests/netsuite-login.test.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --build
node scripts/test-orvane-mcp-live.mjs --batch 4 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch5-compatibility-live.json
node scripts/test-orvane-broker-live.mjs --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch5-broker-live.json
```

After the next normal restart the agent can use the direct checker with `--batch 5`. It checks typed actions through both configured paths using discovered IDs, recording skips if suitable data is unavailable. It never guesses an account or changes roles. Reports in `artifacts/` are ignored by Git. The isolated checker tracks the current worker; earlier batch documents describe historical runs.

## Direct Desktop acceptance after user restart

The user subsequently restarted Orvane. **28 live checks passed** against the actual Batch 5 Desktop through fresh MCP SDK clients from both installed Claude configurations. Each advertised all three tools and exercised all four typed actions without skips: two 100-row script pages, one deployment, 100 top-level folders, a valid empty child-folder page and two file metadata rows. Identity and action-specific journal outcomes matched. Existing SELECT/sharing/fresh-read/error/disconnect checks also passed.

```powershell
node scripts/test-orvane-mcp-live.mjs --batch 5 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch5-desktop-live.json
```

This supersedes the pending-activation limitation above. No additional restart or manual query test is required. The test did not control a Claude conversation, mutate NetSuite, query production, call Magic, take UI focus or induce navigation/role changes. The report remains local/redacted/ignored by Git; server identity is still unverified.

## Remaining foundations

This registry covers the new read family only. Consolidating all existing policies, explicit Windows pipe DACLs, server-verified capabilities/identity, workspace listener ownership and artifacts/export remain separate slices. This is not full Magic migration completion.
