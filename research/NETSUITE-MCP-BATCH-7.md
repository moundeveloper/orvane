# Batch 7 — Managed artifacts for bounded result pages

Date: 5 November 2026. Branch: `codex/netsuite-mcp-migration`.

Implementation commit: `6556d56`.

## Implemented behavior

New `orvane_netsuite_artifact` provides three actions through the Desktop-owned worker. The dedicated profile now advertises four tools; existing configuration paths are unchanged.

| Action | Inputs | Result |
| --- | --- | --- |
| `export` | Explicit target/identity; source `{kind:"query",sql,offset?}` or typed `{kind:"read",action,id?,page?,filters?}`; optional CSV/NDJSON format | Saved page reference, hash, size and provenance; no row payload in the response |
| `inspect` | Target/identity and artifact ID | Metadata for an available artifact |
| `read` | Target/identity, artifact ID, optional offset/length | Bounded text chunk and continuation offset |

Each export executes exactly one existing bounded page, up to 100 rows/256 columns, then serializes locally. There is no automatic pagination, full-query snapshot, NetSuite file download or arbitrary filesystem path. NDJSON is the default and preserves JSON-compatible row values. CSV quotes/doubles field quotes, includes the union of columns and prefixes formula-looking string/header cells (including relevant control/full-width variants) with an apostrophe. Numeric negative values remain numeric text. This changes affected string cells; use NDJSON for faithful JSON interchange. This is not a universal spreadsheet-safety guarantee or an Excel save/reopen verification; see [OWASP's CSV injection guidance](https://community.owasp.org/attacks/CSV_Injection) (checked 5 November 2026).

## Storage, lifecycle and identity

| Budget | Limit |
| --- | --- |
| One artifact | 2 MiB UTF-8 payload |
| Retained payload | 16 MiB, counting unique hashes |
| Artifact references | 64 IDs, with older references evicted when budgets are exceeded |
| Access expiry | 24 hours; earlier quota eviction is possible |
| Read chunk | Default 8,000, maximum 16,000 UTF-16 code units |

The worker lazily opens a private `artifacts` child of the protected broker directory. Content is deduplicated by SHA-256, with distinct IDs/metadata per export. Writes use flushed temporary files and atomic rename. Startup/export cleanup removes expired references, known temporary files and unreferenced blobs. Expired data is inaccessible immediately by timestamp; physical cleanup runs at startup/export rather than on a timer. Metadata and bounded temporary-write overhead are additional to the steady retained-payload quota.

Metadata and payloads persist across normal broker restarts. Reads verify payload size/checksum and return no arbitrary path. Invalid ranges and split Unicode-pair offsets are rejected; clients follow `nextOffset`. Unknown files in the managed directory are preserved and block artifact-store opening. Artifact-store errors do not create a second writer or disable ordinary query handling. Local snapshots contain the exported data in the existing per-user filesystem boundary; no encryption claim is made.

Every action validates a fresh target/identity before and after local work. Records are bound to source origin/account/user/role; another reported identity receives `ARTIFACT_UNAVAILABLE`. After restart a fresh matching target/token may access the saved historical page. Its captured epoch/time remain provenance, not current-session authentication. Metadata contains no identity token or raw SQL. Client-runtime identity remains `serverRuntimeVerified: false`; matching IDs do not prove unchanged server permissions or server identity.

The request journal records `artifact.export`, `artifact.inspect`, `artifact.read` and hashes the source/range. Row content, SQL, filters and tokens stay out of the journal. The artifact payload intentionally contains the exported data. Exports write local files, so the MCP tool has `readOnlyHint:false`; it never mutates NetSuite. `artifacts.page-v1` capability preflight rejects older active brokers before export/read submission.

Publication and the SQLite request journal are separate local persistence operations, not a cross-file transaction. Normal restart and orphan cleanup are tested; no power-loss durability or completed-export result replay is promised. A caller must retain the returned artifact ID. Durable jobs/result recovery, binary streaming and download-to-selected-path remain later work.

## Agent-run evidence

- **47 targeted tests passed:** 40 worker/MCP/journal/session/sharing/typed/filter/artifact tests and 7 existing bridge/login tests. New coverage includes serialization, strict action/source/path schemas, formula prefixing/CSV quoting, simultaneous content deduplication, expiry/quota/count/orphan cleanup, Unicode ranges, corrupt checksums, owner/origin isolation, unknown-file preservation, identity change during local publication, real two-client MCP exchange and persistent reads after a real worker restart without requerying.
- Type-check, Node syntax and Git whitespace checks passed. Incremental mapping names/fixtures were validated against the original inventory.
- **44 direct live compatibility checks passed** through fresh clients from both installed Claude configurations against the active Batch 6 Desktop. Existing reads/filters/sharing remain usable; artifact requests return `UPGRADE_PENDING` before submission.
- **29 isolated Batch 7 worker live checks passed**, using the unchanged real sandbox executor. New cases exported an actual one-row employee query to NDJSON, reconstructed it from another MCP client with matching byte count/hash, exported a literal formula-like cell to CSV with the expected prefix, exported a discovered folder through the typed service, rejected an unknown ID, checked metadata-only journal outcomes, and inspected the saved artifact after isolated worker restart with a fresh matching identity. No artifact case was skipped. Original Desktop/broker PIDs remained unchanged.

Only `https://4027610-sb1.app.netsuite.com`, account `4027610_SB1`, user `4033`, role `3` was queried. No Magic, production query, NetSuite mutation, deployment, sign-out, GUI input or user application restart was performed. Local artifact writes are part of this explicitly implemented feature; isolated live artifacts were removed with their owned temporary profile. Reports contain counts/outcomes, not data rows, source names/IDs, tokens or local artifact paths.

The actual Desktop remains Batch 6. Activation awaits the next normal Orvane restart and fresh Claude MCP connection/schema; no configuration reinstall is needed. The agent can then run the direct `--batch 7` checker. Checks launch fresh SDK clients from installed paths, not a Claude conversation or its cached menu.

## Reproduction

```powershell
node --import tsx --test tests/netsuite-artifacts.test.ts tests/netsuite-read-filters.test.ts tests/netsuite-typed-reads.test.ts tests/netsuite-shared-reads.test.ts tests/netsuite-broker.test.ts tests/netsuite-mcp.test.ts tests/netsuite-journal-session.test.ts tests/netsuite-session-queue.test.ts
node --test tests/netsuite-bridge.test.mjs tests/netsuite-login.test.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --build
node scripts/test-orvane-mcp-live.mjs --batch 6 --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch7-compatibility-live.json
node scripts/test-orvane-broker-live.mjs --origin https://4027610-sb1.app.netsuite.com --account 4027610_SB1 --user 4033 --role 3 --report artifacts/netsuite-batch7-broker-live.json
```

After normal restart use `--batch 7` for direct activation checks. The expanded isolated checker paginates journal history by sequence rather than assuming old requests remain on the newest page. Local reports under `artifacts/` are redacted and ignored by Git; old batch documents describe historical checker versions.

## Remaining migration

This is the common text-artifact foundation with single-page sources. Full query executions/cursors, multi-page export jobs, NetSuite file content/binary/PDF capture, artifact UI/downloads, server-verified identity, explicit pipe DACLs and shared workspace transport remain separate slices. The [incremental legacy map](netsuite-mcp-migration-map.json) records partial query/artifact support; full Magic migration is not complete.
