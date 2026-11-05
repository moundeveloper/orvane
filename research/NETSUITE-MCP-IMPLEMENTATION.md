# Orvane-native NetSuite: improved migration and implementation

Date: 5 November 2026. Status: implementation proposal; none of the new architecture below is implemented by this document.

This is the recommended architecture and delivery plan. It supersedes the renderer-mediated NetSuite transport proposed in [the original migration plan](./NETSUITE-MCP-MIGRATION.md). Keep that document and [the 155-tool source inventory](./netsuite-mcp-tool-inventory.json) as the source-feature checklist and import evidence.

## 1. What becomes possible in Orvane

Yes: Desktop ownership removes several extension-specific constraints. It does not make NetSuite unlimited, remove authentication/role boundaries, or turn browser-side SuiteScript into server-side SuiteScript.

The objective is a NetSuite service built into Orvane, with the app and MCP as two clients of that service. Compatibility with Magic is an adapter at the edge. Its extension transport and fragmented state should not determine the internal design.

| Current constraint or inefficiency | Orvane-native improvement | Boundary that remains |
| --- | --- | --- |
| MCP host → native host → extension/background → page | Thin MCP client → Desktop broker → owned NetSuite executor | Execution still happens under a valid NetSuite session |
| Extension/background lifecycle and duplicated bridge connections | Desktop-owned broker and persistent jobs while Desktop runs | Closing/crashing Desktop interrupts local execution; remote work may continue |
| Native messaging's transport-specific transfer ceiling | Managed binary artifacts and bounded streaming | NetSuite endpoint/file limits and local resource budgets |
| Different UI, extension storage, MCP host, and preview state | One local store and versioned services used by every client | Entity revisions and concurrent editing still need coordination |
| Large list of overlapping tool names | Small typed tool families plus an optional compatibility profile | Every legacy feature still needs an explicit disposition |
| Repeated schema/file/query reads from multiple views and clients | Shared in-flight requests, selective caches, projections, persisted result references | Freshness, permissions, and external changes must be visible |
| One broad queue for everything | Separate local work, NetSuite execution, browser interaction, and account jobs | NetSuite-bound concurrency must stay bounded and adapter aware |
| Another Chromium instance and copied browser sessions for previews | Owned Electron pages for display/control; local artifact rendering workers | DOM control still depends on page state and supported NetSuite behavior |
| Repeated full template/document payloads | Section reads, revisioned patches, deduplicated assets, exact render identity | NetSuite PDF rendering remains a server operation |

NetSuite still terminates SuiteScript that exceeds its governance limits. Design backpressure and server jobs around this rather than raising local timeouts indefinitely. [Oracle: SuiteScript Governance and Limits](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N3350651.html)

Concurrency limits differ by execution path. REST web services and RESTlets share account-level governance; that is not a universal numeric limit for every browser/Suitelet request. Discover and measure the actual adapter instead of assigning one assumed NetSuite concurrency quota to every operation. [Oracle: Web Services and RESTlet Concurrency Governance](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1500275531.html)

Server-only APIs still need an account-side implementation. For example, `N/render` PDF methods are server-side APIs. Reuse a verified Suitelet deployment when suitable; otherwise expose the missing capability until installation is deliberately performed. [Oracle: N/render Module](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4412042824.html)

## 2. Decisions that improve the original plan

1. **Remove the renderer from the MCP execution path.** A closed NetSuite view, Vue reload, inactive tab, or canvas editing lease must not disconnect NetSuite services.
2. **One broker per Desktop profile.** Multiple MCP clients and UI views share environment sessions, queues, caches, artifacts, and jobs. Starting another stdio client must not start another execution engine.
3. **One operation registry.** Schemas, effect classification, capability requirements, routing, timeout policy, cache policy, and compatibility mappings come from one typed registry.
4. **Separate operation effects.** Distinguish remote reads, remote writes, local document edits, browser interaction, executable code, and long-running server tasks. A caller-provided `readOnly` flag does not choose the implementation policy.
5. **Use references and patches.** Large results become reusable artifacts; local documents have revisions; clients request only fields, pages, or source sections they need.
6. **Keep the default MCP surface compact.** Offer useful typed domains rather than advertising all 155 legacy declarations to every client on every connection.
7. **Persist work before dispatch.** Track request identity, target, state, and outcomes so clients can reconnect without resubmitting mutations.
8. **Measure actual improvements.** Set resource budgets and benchmark repeatable workflows. Do not promise a speed multiplier before measuring a baseline.

## 3. Architecture and process ownership

```text
MCP clients                              Orvane UI views
    │                                         │
thin stdio adapters                     narrow preload API
    │                                         │
authenticated local IPC                  Electron main gateway
    └───────────────────┬─────────────────────┘
                        │
               Desktop-owned broker
         operation registry / target resolution
         jobs / local documents / artifacts / events
         read sharing / caches / scheduling
                        │
               Electron main gateway
           guest ownership + identity checks
                ┌───────┴────────┐
         processing executor   visible-tab executor
         queries, API calls    navigation, DOM, input
         verified Suitelet     capture and inspection
                └───────┬────────┘
                  NetSuite account

CPU/file workers ← broker → SQLite + managed artifact directory
```

### Process responsibilities

- **Electron main:** browser session ownership, guest identity checks, IPC authentication, executor dispatch, lifecycle. Avoid heavy queries, PDF rasterization, indexing, or synchronous file work here.
- **Broker worker:** the domain registry, scheduling, request journal, local document services, read sharing, cache metadata, event subscriptions. Desktop starts exactly one worker and owns its private connection.
- **CPU/file workers:** PDF page rasterization, export/import validation, large diffs, hashing, search indexing, and artifact conversion. Bound worker count and memory.
- **Renderer:** forms, editors, tables, previews, and subscriptions. It holds transient editing state, not the execution engine.
- **MCP stdio adapter:** protocol registration, client-specific tool profile, input/output translation, broker connection. It neither owns NetSuite browser sessions nor duplicates the job scheduler.

Extend the existing Desktop child-process pattern in [electron/main.mjs](../electron/main.mjs) and [electron/server.mjs](../electron/server.mjs). Keep a separate process entrypoint for the broker so it has an explicit lifetime and can be tested without launching the full UI.

On Windows, use a per-profile named pipe with an explicit per-user access policy and a rotating capability token. Do not assume the default pipe permissions are sufficient. Desktop → worker uses an inherited private channel. A later cross-platform adapter can use a user-owned Unix socket with equivalent restrictions. Avoid exposing a general browser-callable HTTP execution endpoint.

The endpoint descriptor contains version/instance/transport metadata, never cookies. Restrict descriptor/token file access, validate the instance handshake, reject incompatible protocol versions, and invalidate old tokens on restart. A web page cannot gain broker access by knowing a pipe name or origin URL.

If Desktop is not running, live NetSuite tools report `DESKTOP_UNAVAILABLE`. Offline inspection of already-saved artifacts/knowledge may use a separate read-only local path; it must not start a second writer or pretend a cached result is live.

### MCP launch migration

The current `server/launch.mjs` loads `server/index.ts`, which creates its own `BrowserBridge` listener and discovery file. Connecting the new NetSuite tools to a broker while leaving that startup unchanged would still let two MCP clients compete for the existing workspace bridge port.

During Stage B:

1. Move shared listener/discovery ownership into the single Desktop service. Enforce a per-profile primary-instance lock; another window attaches to the service rather than starting another broker for that profile.
2. Make `server/launch.mjs` a thin client of that service. Preserve the existing configured launch path and stdio protocol while removing per-client bridge listener creation.
3. Delegate existing canvas operations through the one workspace bridge, retaining their editing-lease/revision rules. Delegate NetSuite operations directly through the new service. Reuse existing Git/Notes/Projects implementations behind explicitly owned services rather than creating accidental duplicate schedulers or moving unrelated features in one rewrite.
4. Define the non-Desktop web-development mode explicitly: a single locally owned workspace service can retain the existing browser bridge, but it does not advertise live Electron NetSuite capabilities. Reject a second conflicting service with a clear diagnostic.
5. Test two complete MCP clients, including existing workspace tools, so NetSuite success does not hide a workspace-port collision elsewhere in the same server.

### Lifecycle behavior

| Event | Required result |
| --- | --- |
| NetSuite app view closes | Data jobs continue; UI subscriptions detach |
| Canvas is read-only or editing lease expires | NetSuite capability remains available; canvas writes retain their own lease rules |
| MCP stdio adapter exits | Broker job remains addressable by request/job ID |
| One client cancels a shared read | Remove that subscriber; do not cancel another client's request |
| Browser environment signs out or changes role | Pause new work, invalidate identity-bound caches, revalidate before dispatch |
| Visible tab navigates | Invalidate old DOM handles/control sessions |
| Desktop shuts down | Stop dispatch, persist interruption state, close workers; reconcile submitted remote work later |
| Broker crashes | Recover local queued work conservatively; submitted writes become reconciliation cases, not automatic replays |

Unattended execution after Desktop has fully closed would require a separately designed service/headless mode. It is not implied by the proposed broker.

## 4. One typed operation registry

Put the transport-neutral operation definitions in proposed `src/netsuite/protocol.ts` and `server/netsuite/operations.ts`.

Each operation declares:

```ts
type OperationPolicy = {
  id: string;
  schemaVersion: number;
  inputSchema: unknown;       // concrete runtime schema in implementation
  outputSchema: unknown;
  effect: "read" | "remoteWrite" | "localWrite" | "browserAction" | "code";
  executor: "local" | "processing" | "visibleTab" | "serverTask";
  capability: string;
  retryPolicy: "boundedRead" | "neverAutomatic";
  cachePolicy: "none" | "metadata" | "explicitResult";
  timeoutPolicy: string;      // named policy, not a caller-selected arbitrary timeout
};
```

Generate MCP definitions, preload types, capability lists, compatibility aliases, and contract-test cases from this registry. The effect and required capability are implementation-owned metadata. An alias cannot turn a mutation into a read or bypass a validation step.

Requests carry `requestId`, `clientId`, operation/schema version, target identity, arguments, optional expected entity revision, and optional document/artifact references. Reject unknown fields where they would otherwise silently change meaning.

Use one result envelope:

```json
{
  "requestId": "req_...",
  "state": "completed",
  "target": { "environmentId": "env_...", "accountId": "...", "roleId": "...", "identityEpoch": 7 },
  "data": { "rows": [], "nextCursor": null },
  "artifacts": [],
  "freshness": { "source": "live", "observedAt": "..." },
  "metrics": { "queueMs": 0, "remoteMs": 0, "bytes": 0 }
}
```

Errors include a stable code, stage, target, request/job ID, and recovery action. Distinguish “not dispatched,” “remote rejected,” “completed,” and “outcome unknown.” Do not flatten these into a generic timeout string.

## 5. Explicit environments instead of a global current account

An execution target is a broker-issued environment identity bound to Desktop profile, NetSuite origin, authenticated account/user/role, and an identity epoch. Browser origin alone is insufficient to separate role changes.

Recommended behavior:

- `environments.list` returns candidates, readiness, role/account labels, capabilities, and whether runtime identity is verified.
- With one unambiguous verified environment, the client can bind it once and reuse a target handle.
- With multiple candidates, require an explicit environment selection. Store the preference per MCP client/workspace, not globally for every caller.
- A binding captures an identity epoch. Sign-in/role/account changes invalidate the old epoch, queued assumptions, cursors, and cached permission-sensitive data.
- Revalidate server-side account identity before server mutations. The status tool and a successful client query do not replace `netsuite_server_info` parity.
- Writes created for account A must never silently move to account B after a login redirect.

Current `persist:orvane-browser` ownership must be respected. Two pages sharing that browser session must not be advertised as independent concurrent roles if changing the role affects both. If concurrent roles are required later, provision explicitly separate authenticated profiles/partitions; separate cache keys alone do not create session isolation.

## 6. Smaller, more useful MCP interfaces

The default profile should group related **typed** actions. It should not expose a single `execute(anything)` tool or immediately dump all legacy tool descriptions into model context.

| Proposed family | Main actions and efficiency improvement |
| --- | --- |
| `orvane_netsuite_status` | Health, environments, capabilities, binding, diagnostics |
| `orvane_netsuite_query` | Execute, fetch cursor, summarize known results, export, cancel interest |
| `orvane_netsuite_catalog` | Search types/tables, selected fields/joins, bounded value discovery |
| `orvane_netsuite_files` | Find/list/read, versioned patch/write, upload/download artifact, batch move |
| `orvane_netsuite_records` | Read selected fields/sublists, search, preview/commit typed mutations |
| `orvane_netsuite_scripts` | Inspect script with deployments/logs/files, retrieve subsequent detail |
| `orvane_netsuite_jobs` | Get/list/reconcile/cancel interest; bounded wait for meaningful changes |
| `orvane_netsuite_context` | Select/read versioned record/file context references |
| `orvane_netsuite_documents` | Dashboard/template create/read/patch/history/render/export |
| `orvane_netsuite_knowledge` | Search/read docs and skills, docs batch jobs, skill bindings, quizzes |
| `orvane_netsuite_browser` | Owned tabs/groups, inspect, interact, capture; explicit visible target |
| Advanced families | `orvane_netsuite_custom_tools`, `orvane_netsuite_server_tasks`, `orvane_netsuite_deploy`, and bounded artifact access |

For each family, use a discriminated input union with action-specific required fields. Supply concise usage examples and bounded outputs. Split a family further if real client schema handling or model accuracy is worse with a union; fewer advertised names is useful only when calls remain reliable.

Provide three selectable profiles: **core**, **authoring/advanced**, and **Magic compatibility**. Compatibility adapters preserve old schemas/results and request-scoped target binding. Clients requiring static tool lists can select a fixed profile at startup. Clients supporting list-change notifications can opt into discovered custom tools, with a static generic custom-tool-call fallback.

MCP UI resources and prompts become optional views over the same services. Orvane-native users open the real app/document; an MCP client that supports embedded UI can receive a thin resource adapter. Neither route creates an independent copy of the document.

### Compound reads that remove unnecessary round trips

- `scripts.inspect`: script identity plus requested deployments/recent logs/file references in one bounded response. Independent reads can be scheduled together; return per-section errors.
- `records.read`: requested fields and explicitly requested sublists in one operation. Do not load every sublist or linked record by default.
- `context.capture`: return stable references and versions for selected records/files. Resolve large content only when consumed.
- `documents.patchAndRender`: apply a revision-checked patch, queue the exact resulting render, and return its job/artifact references.

Compound reads are not remote transactions. A result assembled across requests has observation times and can contain partial failures. Do not disguise a mutating batch as one atomic NetSuite operation.

## 7. Query, cache, and scheduling efficiency

### Shared reads and honest cache policy

Move the principle in [src/sharedReads.ts](../src/sharedReads.ts) into the broker: equal in-flight reads share one remote call across UI and MCP clients. Keep subscriber cancellation separate from transport cancellation.

Keys include profile, account, authenticated user/role, identity epoch, adapter/capability version, operation, parameters, selected fields, and paging state. Preserve SQL/parameter semantics; do not merge different queries using naive whitespace/lowercase normalization.

Proposed starting policy, configurable after benchmarks:

| Data | Starting policy |
| --- | --- |
| Catalog metadata | Five-minute TTL, explicit refresh, identity/deployment invalidation |
| Folder/script lists | Short TTL only where opted in; invalidate affected entries after writes |
| File content | Version/hash-bound content artifacts; check current remote version before overwriting |
| Query results | Reuse within the same execution handle; cross-execution caching is explicit and reports age |
| Documentation | Local index and fetched-at/source metadata; refresh deliberately |
| Runtime identity and capabilities | Bind to session epoch; refresh on lifecycle changes, before sensitive dispatch |

Live refresh bypasses completed-result caches but may join an equivalent live request already running. Never cache permission-denied responses as empty successful results. Do not assume broker invalidation observes edits made by users outside Orvane.

Reuse the memory-accounting work in [src/queryOutputs.ts](../src/queryOutputs.ts); do not hold both a full serialized JSON copy and the full object graph in every view. UI and MCP result handles can reference one managed result.

### Result handles and cursors

`query.execute` returns execution ID, columns, a bounded first page, timings, and a cursor. `query.fetch` reads subsequent pages. `query.export` writes NDJSON/CSV to a managed artifact without sending all rows through the renderer or MCP conversation.

Require deterministic ordering for stable paged traversal and report whether the result is a materialized local snapshot or an ongoing live remote traversal. Do not invent an `ORDER BY` that changes query meaning. Oracle requires a unique, unambiguous sort order for `runSuiteQLPaged`; its documented page and feature-dependent result limits still apply. [Oracle: query.runSuiteQLPaged](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157960586441.html)

Cursors bind execution, account/role/epoch, query identity, adapter, page state, expiry, and result version. Reject stale/mismatched cursors. A cursor is not a promise of snapshot isolation while remote data changes. Keep export continuation explicit when a result exceeds the adapter's supported result range.

### Scheduling and backpressure

Start with **one active NetSuite operation per shared authenticated processing executor**. Allow local hashing/indexing/PDF work independently. Serialize visible-tab actions per controlled tab. Queue local writes per entity revision; queue account mutations with appropriate resource locks.

Later enable a small measured read pool only for operations/executors proven independent. Multiple processing pages do not automatically increase the account's usable capacity or isolate a shared login role. Keep a profile-wide/account-aware budget so adding another MCP client does not multiply remote concurrency.

Use fair queues, interactive-versus-background priorities, bounded queue lengths, and jittered retries only for classified reads. Back off on relevant remote throttling/governance errors. Return queue position/state rather than letting the UI appear frozen. Measure queue delay separately from NetSuite response time.

Do not keep an indefinite executeJavaScript promise or refresh a busy page merely because the caller stopped waiting. The existing busy-release behavior in [electron/netsuite.mjs](../electron/netsuite.mjs) is worth preserving.

## 8. Binary artifacts instead of repeated base64 payloads

The current adapter has application-defined 2 MB preview/edit limits, a base64 upload envelope, JSON-stringified results, a fixed query page size, and a 30-second request timer. Desktop gives us room to redesign these; it does not justify replacing them with unbounded memory allocation.

Introduce a content-addressed artifact service:

- Artifacts have ID, content hash, MIME type, size, owner/profile, source environment, revision, creation time, and retention policy.
- Stream downloaded/exported data to managed files, computing hashes incrementally. Use bounded binary frames/private channels between Electron and broker workers.
- Where a NetSuite API requires a complete base64/string payload, keep that conversion inside the adapter with a clear cap. Streaming locally cannot make an unsupported remote upload protocol resumable.
- Return preview text, image blocks, metadata, or artifact references to MCP. MCP image encoding requirements still apply at the protocol boundary; avoid embedding the same image/PDF base64 in text responses repeatedly.
- Provide bounded text/range reads and export-to-selected-path operations. Artifact IDs are not arbitrary filesystem path access.
- Offer thumbnail/first-page previews and fetch additional pages on demand. Full-fidelity artifacts remain available for export or inspection.
- Garbage-collect temporary artifacts by quota/age. Keep document-linked references and revision history until their own retention policy releases them.

Local file upload sources are validated in the broker, with explicit source paths and file metadata. Account paths and local paths are different typed fields. The old native-message transfer ceiling should not be copied into this service; actual NetSuite and resource limits should be reported separately.

## 9. Durable jobs and mutation outcomes

Use one job model for docs batches, query export, PDF rendering, file batches, deployment, and server task monitoring.

```text
queued → running → completed / failed
              ├→ waiting_for_sign_in
              ├→ cancel_requested → cancelled (only if execution confirms it)
              └→ outcome_unknown / interrupted → reconciliation
```

Persist request ID, immutable target identity, operation/argument hash, submit time, current stage, result/artifact references, and any remote task ID. Keep an append-only event sequence for progress and reconciliation.

`jobs.wait(afterSequence, timeout)` returns when the job meaningfully changes or the bounded wait ends. Client disconnect does not mean job cancellation. UI subscriptions consume the same events; a client that cannot receive pushed progress uses bounded waits rather than rapid polling.

For writes:

1. Validate target/permissions/input and expected content/document versions.
2. Journal the intent before remote dispatch.
3. Dispatch once and persist any acknowledgement/task ID.
4. Record completion, failure, or unknown outcome.
5. Reconcile uncertain operations using task ID, remote receipt, resulting content/version, or a domain-specific read. Present unresolved cases explicitly.

Request deduplication prevents duplicate dispatch by this broker. It is **not an exactly-once guarantee for NetSuite**. A version/content check followed by a remote update is also not inherently atomic against external writers. Where the account adapter cannot provide an atomic receipt/mutation or a genuine conditional write, report the weaker guarantee and never silently retry an uncertain mutation.

Do not claim cross-record rollback for a remote batch. Use per-item results and a resumable plan whose already-completed items are not blindly executed again. Compensating actions, where available, are separate operations with their own side effects.

## 10. Shared documents and local state

The renderer currently owns some File Cabinet draft/trash state in IndexedDB via [src/netsuiteFiles.ts](../src/netsuiteFiles.ts). Move durable state needed by MCP into the shared document service with an explicit import; leaving it there would preserve the split-state problem.

Use one writer in the broker for new domain tables. Coexist with existing workspace storage during migration; do not hold a SQLite transaction open across network work or heavy rendering. Apply entity updates and an outbox event in one short local transaction. Renderer clients subscribe using an event sequence and recover gaps using a fresh snapshot/revision.

Proposed tables and responsibilities:

| Table/store | Purpose |
| --- | --- |
| `ns_environment_bindings` | Profile/client bindings, identity epoch, capabilities; no browser cookies |
| `ns_requests`, `ns_jobs`, `ns_job_events` | Dispatch journal, durable work, progress/outcomes |
| `ns_documents`, `ns_document_revisions` | Templates, dashboards, query documents, versioned source |
| `ns_drafts`, `ns_file_history` | File drafts, original-content identity, saved revisions |
| `ns_artifacts`, `ns_artifact_links` | Content metadata and document/job references; bytes stay in managed files |
| `ns_contexts` | Versioned account-bound record/file selections |
| `ns_custom_tools`, `ns_tool_bindings` | Draft/active code definitions, schemas, capabilities, skill bindings |
| Knowledge/FTS tables | Skills, documentation, quiz evidence, searchable metadata |
| `ns_change_events` | Ordered outbox for UI/MCP consistency |

Document patches require an expected revision. A conflict returns current revision and a bounded relevant diff; do not overwrite a user's unsaved editor buffer. Merge/discard is explicit. Replace full documents only for initial creation or an explicit replacement operation.

Import existing IndexedDB/Chrome storage using a versioned export/preview/transaction process. Preserve IDs and environment bindings, verify checksums and linked assets, and retain a rollback snapshot. Mark imported executable custom tools disabled until reviewed. Preserve the old data until the user verifies the import.

## 11. Improvements by feature

### SuiteQL and record exploration

- Shared catalog index, selected-field projections, reusable result handles, named query documents, and bounded schema discovery.
- Read only requested sublists/linked records. Expand through references instead of recursively serializing whole records.
- Parameterize supported query adapters and keep query logging redacted. Validation must understand the supported dialect; an incomplete SQL parser is not proof that arbitrary text is read-only.
- Exports run as jobs and reuse an existing execution where its semantics allow it.

### File Cabinet and SuiteScript development

- Versioned edit/patch operations with before/after previews; save one file or an explicit batch with per-item results.
- Share file content between script inspector, editor, and MCP through an artifact/version reference.
- Make scripts → deployments → logs → source one navigable result. Load expensive log bodies only when requested.
- Keep file recovery/history local without serializing entire file contents into canvas app JSON.

### Template Studio

- One versioned session for brief, references, record context, FreeMarker, feedback, and output artifacts.
- Deduplicate reference images/assets by hash. Read/patch only relevant source sections.
- Render identity includes source version, asset hashes, target account/role, record context, and rendering capability version. Reuse exactly matching completed output; never label an old render as the latest source.
- Debounce superseded local requests and queue only the newest unsent render when appropriate. An already-running remote render may still finish; attach its output to its actual source version.
- Render once to PDF, rasterize requested pages locally, and retain page count/full output. Browser HTML previews can be diagnostic but do not replace NetSuite/BFO rendering fidelity.

### Dashboards

- Shared graph/document compiler, validation, and revisions; one execution service used by both UI and MCP.
- Reuse identical read queries within a dashboard execution and across subscribers when identity/freshness match.
- Track widget dependencies and rerun only affected nodes. Batch visual updates and retain existing virtualized table approaches for large results.
- Provide typed document changes instead of whole-dashboard rewrites. Keep compatibility import for Orvane's current simple SQL widgets.

### Documentation, skills, and quizzes

- Build a local full-text index for saved skills and documentation with source URL/fetched-at metadata. Search locally first when appropriate; refresh through authenticated browser access when needed.
- Preserve tool-skill binding semantics, but replace redundant multi-hop preflight with one broker-owned check. Receipts bind tool, target, skill versions, and request context; invalidate on relevant changes.
- Persist documentation batches and share fetched pages across subscribers within access boundaries. Retain exact evidence links for quizzes and answers.

### Custom tools and server capabilities

- Draft → validate → test → activate, with immutable executed revisions and a visible execution target/module set.
- Run client/server code only in its approved NetSuite execution domain. Never evaluate imported NetSuite code in the privileged Node broker or Electron main process.
- UI scripts with local desktop capabilities need a separately sandboxed capability model; a `risk: read` label is not a sandbox.
- Keep typed built-in operations as the default path. Quick scripts/arbitrary evaluation remain advanced capabilities, not an escape hatch for every missing adapter.

### Browser and Suitelet interaction

- Use existing owned Electron guests instead of launching another logged-in browser. Reuse an inspection snapshot until navigation/DOM invalidation requires another.
- Prefer typed locator/element operations and bounded page reads; resolve identities again after navigation. Keep DOM actions ordered per tab.
- Capture on demand. If streaming is needed, use bounded frame rate, backpressure, visibility awareness, and frame dropping; do not make a constant screenshot loop the default for a local UI.
- Preserve ownership of unrelated tabs and distinguish visible browser state from hidden data processing state.

### Deployment and tasks

- Reuse Projects Hub's SuiteCloud tooling where its semantics match. Bind CLI authentication IDs explicitly; do not infer them from whichever browser account is active.
- Compile/validate locally, show the deployment contents and target, then submit a durable job. Monitor remote task IDs instead of holding a synchronous MCP call open.
- Share artifact packaging, output storage, logs, and job UI across CLI and account-side deployment adapters.

## 12. Implementation structure

All paths below are proposed additions unless marked existing.

```text
src/netsuite/protocol.ts                  request/result/event schemas
src/netsuite/client.ts                    UI client and subscriptions
src/netsuite/stores.ts                    view adapters, not a second durable store

server/netsuite/broker-entry.ts           Desktop-owned worker entrypoint
server/netsuite/broker.ts                 registry dispatch and lifecycle
server/netsuite/operations.ts             typed policies and capabilities
server/netsuite/scheduler.ts              fair queues and executor reservations
server/netsuite/requests.ts               dispatch journal and reconciliation
server/netsuite/jobs.ts                   durable jobs and bounded waits
server/netsuite/documents.ts              revisioned shared documents
server/netsuite/artifacts.ts              streaming, hashes, retention, ranges
server/netsuite/cache.ts                  identity-aware read sharing/caches
server/netsuite/knowledge.ts              local search/docs/skills/bindings
server/netsuite/mcp-tools.ts              compact profiles and generated schemas
server/netsuite/legacy-adapters.ts        Magic schema/result compatibility
server/netsuite/import.ts                 versioned import preview/commit/rollback

electron/netsuite-gateway.mjs             narrow main-process bridge
electron/netsuite-executor.mjs            fixed typed browser operations
electron/netsuite-browser.mjs             owned visible-tab control
electron/preload.cjs                      existing: add narrow broker client API
electron/processing.mjs                   existing: extract/reuse executor lifecycle
electron/netsuite.mjs                     existing: migrate handler into service
server/index.ts                          existing: register adapter/tools
server/launch.mjs                        existing: preserve stable MCP entrypoint
```

Keep the old `netsuite.run` IPC signature as a temporary adapter so existing views can migrate incrementally. Both it and the new client dispatch through the same operation service; remove the old implementation after parity tests pass. Do not keep two independent read/write engines.

## 13. Delivery order and reviewable increments

| Stage | Concrete deliverable | Completion evidence |
| --- | --- | --- |
| A — Baseline and contracts | Reconcile 155 static declarations plus live custom tools/resources; record baseline workflows and dispositions | Source/live inventory report, fixtures, baseline call/byte/timing measurements |
| B — Direct broker vertical slice | Desktop-owned broker, authenticated IPC, environment identity, status + query from UI/MCP | Works with NetSuite view closed, renderer reload, read-only canvas, two MCP clients; no extension/native host |
| C — Reads and artifacts | Catalog/scripts/files/records reads, read sharing, execution cursors, artifact export | Real adapter contract tests, bounded memory, identity-isolated caches, shared results |
| D — Documents, drafts, and writes | Shared revisions/events, IndexedDB import, file edits, typed record/list mutations, journal/reconciliation | UI↔MCP consistency, stale-version rejection, no duplicate dispatch, partial batch results |
| E — Jobs and local authoring | Docs/skills/quizzes/dashboard services, durable work, indexing, event waits | Restart/reconnect behavior, event-gap recovery, source-linked knowledge and history |
| F — Server adapter and advanced tools | Capability/version probe, tasks/metadata/custom tools/SDF adapters | Account identity verified, missing capabilities explicit, sandbox tests and executable-tool isolation |
| G — Templates and browser control | Modern Template Studio, PDF/artifact pipeline, owned tab interactions, optional resource adapters | Same document in UI/MCP, exact render versions, all PDF pages accessible, correct tab ownership |
| H — Cutover | Import report, compatibility profile, packaging, setup switch, rollback | Every enabled legacy tool has a disposition; old transport disabled during verification |

Add the common job/request journal primitives in B; expose the full job UI and authoring features in E. Shared artifacts land before feature-specific PDF/file transfer code. This avoids building temporary bespoke queues and transfer formats for each later feature.

The first implementation PR should be Stage B's smallest end-to-end slice: **status → bind verified environment → execute one bounded SELECT → return a structured result to both UI and MCP**. Include multiple-client and renderer-independent tests. Land the architectural advantage before porting dozens of tools.

## 14. Measurement and acceptance criteria

These are proposed acceptance targets, not measured claims about the current application.

| Scenario | Target |
| --- | --- |
| Five identical concurrent eligible reads | One remote request, five correct independently cancellable subscribers |
| Two MCP clients using the same Desktop profile | One broker/executor budget; no duplicated session polling |
| Canvas editing lease unavailable | NetSuite reads still work; no canvas write bypass |
| UI and MCP patch the same document | One succeeds per expected revision; conflict does not discard either editor's draft |
| Repeated query paging | Stable execution/cursor identity; completed pages reused; no silent full re-fetch per view |
| Large query export | Bounded working memory; streamed artifact; no complete JSON result in conversation or renderer |
| Repeat exact template render request | Same in-flight job or valid completed render reference, bound to exact inputs |
| Client disconnects after write dispatch | Recoverable journal entry; zero automatic mutation replay |
| Account/role changes | Old bindings/cursors/caches rejected or invalidated before new protected work |
| Broker restart with remote task ID | Reconcile status; do not submit a second task |
| Cold/warm workflows | Record end-to-end latency, queue/remote/local breakdown, bytes copied, remote calls, memory |

Benchmark six representative workflows: script inspection, catalog lookup + query paging, file read/edit/save, docs batch, dashboard refresh, and template patch/render/page inspection. Compare the old Magic route, current Orvane UI route, and new broker with equivalent inputs/account conditions. Report medians and tail latency separately; do not attribute a NetSuite server delay to local transport.

Suggested initial resource budgets: bounded first-page responses; an explicit per-profile memory budget for result/cache data; a small configurable artifact disk quota; one processing call per shared executor; and at most a small bounded local worker pool. Choose actual byte limits using measured workloads and expose them as documented configuration. Increasing a preview/export budget must not silently increase a remote API limit.

## 15. Compatibility, import, and retirement rules

- Keep the original inventory unchanged as evidence. Add a separate machine-readable map with `legacyName`, schema version, new operation/action, migration state, contract fixture, and replacement/retirement reason.
- Mark dynamic custom tools and configuration-gated legacy declarations explicitly. A lower default advertised tool count does not mean features disappeared.
- Legacy account switching becomes a per-client binding adapter. Preserve ambiguity errors and prevent cross-client target changes.
- Legacy large responses may be adapted within a documented cap; oversized cases return a clear artifact-based replacement path. Do not silently truncate and call the result equivalent.
- Reconcile prompts/resources as well as tools. Maintain a static compatibility profile for clients that cannot follow tool-list changes.
- Import is previewable, idempotent by import/source identity, transactional for local metadata, and rollbackable. Stream/validate assets before attaching committed metadata; clean abandoned staging files separately.
- Preserve original Chrome/IndexedDB data and old MCP configuration until verification. Regenerate ephemeral browser IDs, connection tokens, receipts, and live job bindings.
- Do not migrate the old extension's native host, named-pipe relay chain, second-browser cookie-copying mechanism, or disabled template approval wait loops into the default architecture.

## 16. What to avoid

- Reproducing all 155 tool descriptions as the mandatory default tool surface.
- Routing backend work through a Vue component's lifetime or the canvas editing lease.
- A new Node process, browser, or scheduler per MCP client or per account operation.
- Unlimited concurrency, unlimited caches, full-result JSON copies, or arbitrary file access presented as desktop advantages.
- Assuming two tabs mean two independently isolated authentication roles.
- Treating content-hash comparison as a universal atomic NetSuite write guarantee.
- Retrying timed-out mutations because the transport is now local and fast.
- Moving imported custom code into privileged desktop execution.
- Rebuilding PDF/file/job/document infrastructure separately for each feature.
- Claiming migration complete because the compact API works while unmatched legacy features remain unreported.

## 17. Evidence used for this revision

Local findings are from the current workspace and previously inspected Magic source, not a live NetSuite benchmark:

- [Existing Electron adapter](../electron/netsuite.mjs): operation allowlist, complete JSON envelopes, base64 file path, preview/edit caps, fixed query page size, execution timeout, and busy-page handling.
- [Processing-page ownership](../electron/processing.mjs): session-sharing pages owned by an Orvane window, busy reservations, readiness/reload behavior.
- [Current workspace bridge](../server/bridge.ts) and [renderer connection](../src/mcpBridge.ts): renderer/session dependency and transport lifecycle; these are not the proposed direct broker.
- [Desktop server lifecycle](../electron/server.mjs): existing child process tied to Desktop lifetime.
- [Current draft/trash storage](../src/netsuiteFiles.ts): durable content still in renderer-side IndexedDB.
- [In-flight read sharing](../src/sharedReads.ts) and [query output accounting](../src/queryOutputs.ts): existing patterns to extend instead of rebuilding.
- [Original migration plan](./NETSUITE-MCP-MIGRATION.md) and [inventory](./netsuite-mcp-tool-inventory.json): source coverage, phases, account-side requirements, and import concerns.

Oracle references above were checked on 5 November 2026. Adapter-specific capabilities and limits must still be verified against the selected NetSuite account and installed server component during implementation.
