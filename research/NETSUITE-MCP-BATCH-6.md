# Batch 6 — Filtered metadata and global File Cabinet search

Date: 5 November 2026. Branch: `codex/netsuite-mcp-migration`.

Implementation commit: `8f8ea80`.

## Implemented

The existing `orvane_netsuite_read` tool gains optional strict `filters` and two actions, `find-files` and `find-folders`. The profile still advertises three tool names. No configuration reinstall is needed.

| Action | New criteria |
| --- | --- |
| `scripts` | Exact `filters.scriptId`, case-insensitive exact `filters.scriptType`, case-insensitive literal substrings `filters.name` and `filters.owner` |
| `folders` / `files` | `filters.name`, within the existing top-level/parent folder scope |
| `find-files` | Global File Cabinet metadata by positive file `id`, `filters.name`, or both |
| `find-folders` | Global folder metadata by nonzero folder `id` (including negative system IDs), `filters.name`, or both |

All supplied predicates combine with AND in the generated SELECT, before the existing 100-row offset page. Global search requires at least one criterion; it does not silently enumerate the entire File Cabinet with empty criteria. Deployment reads do not accept filters. File IDs must refer to File Cabinet files, rather than an entity/transaction ID; the numeric validator cannot independently prove what a number represents.

Filter strings are trimmed and limited to 160 characters. Empty strings/objects, unsupported fields, control characters within normalized text and semicolons are rejected. Name/owner searches treat apostrophes, percent and underscore as literal text; they do not accept LIKE wildcards or regexes. The compiler uses fixed columns/operators, quote-doubled string literals and validated numeric IDs. The existing SELECT gateway still independently checks the compiled statement. It does not add a caller-supplied SQL/where/sort escape hatch.

The implementation uses `INSTR`, `LOWER` and `UPPER`, documented in [Oracle's SuiteQL supported functions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158513731864.html) (checked 5 November 2026), and verified against the authorized live sandbox. SQLite fixture tests exercise literal and conjunctive semantics; they do not substitute for the NetSuite adapter checks.

Typed result descriptors and policies now report schema version 2. `read.filterFields` lists applied field names without echoing criteria. Capability `read.filters-v1` gates filtered calls; global actions have their own capabilities. An older broker returns `UPGRADE_PENDING` from MCP before a filtered/global read is submitted. Existing unfiltered calls remain usable. Reconnect already-running Claude MCP adapters to refresh their schema after normal Desktop activation.

Reads retain target/account/identity checks, source-generation fences, shared executor bounds, request IDs and optional in-flight sharing. Queries with different compiled predicates cannot accidentally share a result. There is no completed-result cache, remote mutation, retry, snapshot or file-content download. Journal intent hashes now include filters, while public/durable records omit filter text, SQL, tokens and business rows.

## Verification

- **40 targeted tests passed:** 33 worker/MCP/journal/session/sharing/typed/filter tests and 7 existing bridge/login tests. New in-memory SQL fixtures verify exact/type/substring predicates, AND semantics, scope, global searches and literal apostrophe/percent/underscore/injection-shaped text. Tests also cover invalid/empty/overlong criteria, action-specific fields and IDs, all six typed actions through real MCP clients, unchanged privileged SELECT routing, older-broker filter guards and filter privacy in journal JSON/on-disk bytes.
- Type-check, Node syntax and Git whitespace checks passed; migration-map names and fixtures validated against the original source inventory.
- **30 direct live compatibility checks passed** through fresh MCP SDK clients from both installed Claude configurations against the active Batch 5 Desktop. Existing typed reads/query/sharing/history remain usable. Both clients reject filters/global search explicitly before submission.
- **22 isolated Batch 6 worker live checks passed**, relaying through the existing Orvane sandbox executor. Seven new cases used discovered metadata: combined script ID/type/name/owner returned one matching script; contradictory predicates returned zero; global folder ID/name, scoped folder name, global file ID/name, filename-only search and scoped file name each returned a matching row. No filter case was skipped. Prior typed reads/sharing/history/restart checks also passed; the user's Desktop and broker PIDs were unchanged.

Only sandbox `https://4027610-sb1.app.netsuite.com`, account `4027610_SB1`, user `4033`, role `3` was inspected/queried. Names/IDs/criteria and tokens remain in test memory, not committed evidence. Reports contain counts/outcomes. No Magic call, production query, account write, deployment, sign-out, GUI input or user application restart was performed. Client-runtime identity is still not verified by the server.

The active Desktop remains Batch 5. Batch 6 integrated activation awaits the next normal Orvane restart; existing Claude MCP adapters need a reconnect/new session to load the additive schema. The agent can then execute the direct `--batch 6` check. These background clients test installed configuration paths, not a Claude conversation or its UI.

## Reproduction

```powershell
node --import tsx --test tests/netsuite-read-filters.test.ts tests/netsuite-typed-reads.test.ts tests/netsuite-shared-reads.test.ts tests/netsuite-broker.test.ts tests/netsuite-mcp.test.ts tests/netsuite-journal-session.test.ts tests/netsuite-session-queue.test.ts
node --test tests/netsuite-bridge.test.mjs tests/netsuite-login.test.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --build
node scripts/test-orvane-mcp-live.mjs --batch 5 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch6-compatibility-live.json
node scripts/test-orvane-broker-live.mjs --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch6-broker-live.json
```

After normal restart, run the direct checker with `--batch 6`. It checks filters through both configured paths, selecting criteria from discovered rows and explicitly recording skips if suitable data is absent. Reports under `artifacts/` are redacted and ignored by Git; the isolated checker tracks the current worker version.

## Direct Desktop acceptance after user restart

The user subsequently restarted Orvane. **42 live checks passed** against the actual Batch 6 Desktop through fresh clients from both installed Claude configurations. Each profile passed all seven filter/global-search cases without skips, alongside existing typed reads, SELECT/history/error checks and shared/fresh execution behavior. Identity and action-specific journal outcomes matched; disconnecting a test client left the other usable.

```powershell
node scripts/test-orvane-mcp-live.mjs --batch 6 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch6-desktop-live.json
```

This supersedes the pending-activation limitation above. No further restart or manual query test is needed for this checkpoint. No production query, write, Magic call, GUI input or induced role/navigation change was performed. The report is local/redacted/ignored by Git; server identity remains unverified.

## Migration disposition

[The incremental map](netsuite-mcp-migration-map.json) now records partial native replacements for `netsuite_find_file` and `netsuite_find_folder`, and the script filters implemented here. Legacy fuzzy search, wildcard/all-row behavior, exact response adapters/string-ID aliases, URL fields, file contents/artifacts, script logs and mutations remain pending. The original 155-tool inventory and Magic installation are preserved. The wider migration is not complete.
