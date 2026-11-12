# Magic NetSuite MCP → Orvane migration plan

Date: 5 November 2026. Status: proposed implementation plan; migration has not started.

> The architecture and implementation sequence are superseded by [Orvane-native NetSuite: improved migration and implementation](./NETSUITE-MCP-IMPLEMENTATION.md). This document remains the initial source-feature and migration reference.

## Outcome

Expose Magic NetSuite's MCP capabilities through Orvane's existing MCP server and NetSuite app. Calls use the authenticated NetSuite environment in Orvane's internal browser. The UI and MCP tools call the same services and see the same persisted state. A Chrome extension, native messaging host, and second browser login are no longer required for migrated features.

Keep the existing Magic tool names as compatibility aliases during cutover. Port behavior and data deliberately; do not copy the extension's transport, global account selection, or entire application into Orvane.

## Evidence and scope

The source repository is `C:/Projects/MagicNetsuiteExtension`; the installed packaged build is `C:/Projects/MagicNetsuiteExtensionM`. Source definitions were inspected without executing tools or changing either repository or a NetSuite account.

The companion [tool inventory](./netsuite-mcp-tool-inventory.json) contains **155 unique statically declared tool names**, their source files/lines, source hashes, feature families, and proposed phases. This is not a count of currently enabled tools: some declarations are legacy/configuration gated, and active custom tools can add names dynamically. The inventory combines the native MCP host, MCP App registrations, extension definitions, and shared JSON schemas.

| Source | What it establishes |
| --- | --- |
| [Native MCP host](C:/Projects/MagicNetsuiteExtension/mcp_server/magiNetsuiteMCPServer.js) | Public schemas, tool/skill bindings, custom-tool expansion, account routing, local-file adapters |
| [MCP Apps server](C:/Projects/MagicNetsuiteExtension/mcp_app/server.ts) | Context picker, Suitelet controls, Template Studio sessions, MCP UI resources, legacy feature flags |
| [Extension dispatcher](C:/Projects/MagicNetsuiteExtension/extension-src/background.ts) | Actual execution dispatch, server-side operation set, local state, jobs, environment behavior |
| [Dashboard schemas](C:/Projects/MagicNetsuiteExtension/mcp_server/dashboardTools.json) | Fifteen authoring/execution/export/history tools shared across transports |
| [Browser tab schema](C:/Projects/MagicNetsuiteExtension/mcp_server/browserTabTools.json) | Managed tab/group ownership and limits |
| [Template session store](C:/Projects/MagicNetsuiteExtension/vue-ui/src/features/templateStudio/sessionStore.ts) | References, assets, account/context binding, feedback, revisions, source/render versions |
| [Server script manager](C:/Projects/MagicNetsuiteExtension/extension-src/netsuiteApi/serverScriptManager.ts) | Server-side Suitelet requirements; browser authentication alone does not replace server modules |

## Orvane's starting point

Already present:

- [Electron NetSuite adapter](../electron/netsuite.mjs): environment listing and record navigation; user, scripts, deployments, logs, folder/file reads, search, file writes, catalog discovery, and paged SELECT queries. It validates allowed operations and arguments, executes in an owned processing page, and reports uncertain write timeouts without replaying writes.
- [Processing pages](../electron/processing.mjs): hidden pages owned by the Orvane window, sharing `persist:orvane-browser`, with readiness, sign-in, busy tracking, and reload behavior.
- [Preload API](../electron/preload.cjs): `orvaneDesktop.netsuite.tabs`, `openRecord`, and `run`; websites do not receive this API.
- [NetSuite app](../src/components/NetSuiteView.vue): environment selection and split views for File Cabinet, scripts, SuiteQL, and simple SQL dashboards.
- [MCP server](../server/index.ts), [authenticated workspace bridge](../server/bridge.ts), and [renderer connection](../src/mcpBridge.ts): a reusable request/reply pattern, but **no dedicated NetSuite MCP tools**. The current renderer connection requires a writable canvas session.
- [Projects Hub service](../server/projects.ts): SuiteCloud project inspection, login/upload, and terminal operations. This is useful infrastructure, not proof of parity with Magic's SDF deployment/import behavior.
- [SQLite storage](../server/database.ts): shared local persistence and snapshots. Magic's Chrome storage/IndexedDB data does not automatically exist here.

The current SQL dashboard is not equivalent to Magic's fifteen-tool dashboard builder, node/code editing, import/export, validation, rendering, and history surface.

## Target architecture

```text
MCP client → Orvane MCP tool registry → validated NetSuite request bridge
                                               ↓
                            trusted Orvane Desktop renderer/preload
                                               ↓
                           Electron-owned NetSuite operation service
                                   ↙                         ↘
                  owned processing page             owned visible Browser tab
                  data and Suitelet calls             DOM control / navigation
                                   ↓                         ↓
                         authenticated internal-browser NetSuite session

Local services (SQLite + managed artifact files) ← MCP tools and NetSuite UI
```

### Transport and routing decisions

1. Add typed requests in proposed `src/netsuiteProtocol.ts`, service/IPC handlers in `electron/netsuite-service.mjs`, renderer adapter in `src/netsuiteBridge.ts`, and tool registration in `server/netsuite-tools.ts`. These are planned files, not existing implementations.
2. Extract the current operation handler into a service callable by both existing UI IPC and MCP requests. Avoid two implementations of query/file logic.
3. Give NetSuite capability registration its own bridge channel, authenticated with the existing loopback/token approach. Advertise Desktop identity, available environments, and operation capabilities. A normal web renderer must not advertise Electron capabilities.
4. Keep NetSuite execution independent of the canvas editing lease. The existing `connectMcpBridge` writable gate is appropriate for canvas writes, but would unnecessarily disable NetSuite tools in a read-only canvas or after startup lease failures. Local authoring services retain their own ownership/revision rules.
5. Route every operation to an explicit Desktop session and environment origin. Bind account and role metadata to the request. When multiple targets exist, return their IDs and require selection; never guess a foreground tab or use a process-global mutable account target.
6. Route data operations through processing pages. Route Suitelet UI inspection, screenshots, click/fill/select/scroll, and browser management to explicitly owned visible tabs. A processing page is not the user's currently visible record.
7. Return structured errors such as `DESKTOP_UNAVAILABLE`, `ENVIRONMENT_AMBIGUOUS`, `SIGN_IN_REQUIRED`, `ACCOUNT_MISMATCH`, `ROLE_CHANGED`, `SERVER_CAPABILITY_UNAVAILABLE`, `CONFLICT`, and `WRITE_OUTCOME_UNKNOWN`.
8. Keep browser authentication and cookies inside Electron's existing session. Do not copy cookies to a second Playwright browser or expose them through MCP results.

### Execution and state rules

- Preserve operation allowlists and validate at both MCP and Electron boundaries. Arguments are data; callers cannot inject code into the fixed operation dispatcher.
- Preserve original-content/source-version checks. Persist a request ID, target account, operation, and outcome before sending a write. A timeout or disconnect produces an uncertain outcome to inspect; it does not cause an automatic retry.
- Serialize operations where they share page state; allow independent accounts to proceed separately. Separate browser context from processing context and from local document revision state.
- Treat a custom script, quick script, arbitrary page evaluation, or proxy request as executable/side-effecting regardless of its declared risk label. Give these capabilities a separate explicit enablement and execution path; do not enable them by extending a generic `run` allowlist.
- Verify server-side `runtime.accountId` for server operations. Connectivity/ping, an origin label, or a client-side user lookup is not a substitute for Magic's `netsuite_server_info` behavior. Recheck identity after sign-in, navigation, or role changes.
- Provide bounded results, paging, artifact references for large files/PDFs, and operation-specific timeouts. Use persisted job IDs for documentation batches, render/deploy jobs, and task monitoring.
- Make tool execution visible in the NetSuite app's activity/job UI with account, state, duration, and result/error. Redact passwords, cookies, tokens, and sensitive file bodies from logs.

## Capability mapping

| Capability | Representative Magic tools | Orvane implementation | Phase |
| --- | --- | --- | --- |
| Connectivity and environments | `ping`, `netsuite_list_accounts`, `netsuite_switch_environment`, `magic_netsuite_bridge_status` | Expose Desktop/processing state; replace global selection with request-scoped routing | P1 |
| SuiteQL and catalog | `suiteql_get_guide`, `suiteql_search_tables`, `suiteql_get_table_fields`, `suiteql_get_table_joins`, `suiteql_execute_query`, `suiteql_discover_field_values` | Reuse `tables`, `table-detail`, `query`; add guide, field/join normalization, value discovery, and schema-compatible pagination | P1 |
| Scripts, deployments, logs | `netsuite_get_scripts`, `netsuite_get_script_files`, `netsuite_get_deployed_scripts`, `netsuite_get_logs` | Reuse script/deployment/log/file reads; preserve filters, joins, and response schemas | P1 |
| File Cabinet reads | `netsuite_find_folder`, `netsuite_list_folder`, `netsuite_find_file`, `netsuite_read_file` | Adapt folder/search/file operations; add missing folder/path lookup and binary/artifact handling | P1 |
| File Cabinet writes | create/upload/update/rename/delete file/folder, `netsuite_move_items` | Reuse existing typed writes; preserve localPath/batch/base64 sources, conflict checks, and detailed partial results | P2 |
| Record and selected context | `netsuite_load_record`, `netsuite_get_record_fields`, `netsuite_get_record_sublists`, record-type/search tools, selected-context tools | Add typed record/context service and a NetSuite context picker; store selections per workspace/environment | P2 |
| Records and custom lists | `netsuite_lists`, `netsuite_list_items`, create/update list, create/update record | Add client/server implementations as capabilities require; show before/after field changes | P2 |
| Documentation | search/read page, submit/get docs batch | Port authenticated Help Center access to owned browser pages; keep batches asynchronous and retain source URLs | P3 |
| Skills, bindings, quizzes | prepare/search/load/save/enable skill; create/list/get/delete quiz | Port durable local data and tool-skill bindings to shared services; preserve receipts/version checks and quiz evidence | P3 |
| Dashboard builder | all fifteen `magic_netsuite_dashboard_*` tools | Add a shared dashboard service with graph/code/document revisions; make the UI consume it, with a simple-widget import adapter | P3 |
| Custom tools | search/create/update/test/call custom tool; exposed custom names | Port definitions, schemas, draft/active state, modules, domain, tests, bindings, and dynamic tool-list notifications | P4 |
| Server capabilities and metadata | `netsuite_server_info`, task submit/status, quick scripts, script fields, custom-field inspection, metadata updates | Add verified per-account Suitelet adapter; surface missing/unsupported server modules before execution | P4 |
| Bundles and SDF | list bundles/components, SDF deploy/list objects/import object | Reuse Projects Hub where behavior matches; keep a separately verified account Suitelet path where required | P4 |
| Template Studio | session list/current/read/patch/update/render/screenshot, template assets, workflow prompt | Shared SQLite-backed sessions and asset files; versioned patches; NetSuite/BFO PDF render and page images; feedback/history UI | P5 |
| Suitelet/browser control | control/open/read/inspect/screenshot/hover/scroll/fill/select/click, streams, browser tabs/groups | Electron-owned tabs and control adapters; preserve explicit ownership, selectors, navigation, input, and session rules | P5 |
| Legacy template workflow | approval state, review wait loops, browser HTML preview/convert | Disabled by default, matching the inspected source; map to modern session workflows or provide explicit compatibility errors | P6 |

### Server-only features need an account component

The existing internal-browser session solves authentication, not access to server-only `N/file`, `N/render`, `N/task`, metadata APIs, or every SDF action. Magic declares a server-side tool set and uses a deployed Suitelet/server script manager.

P4 must inspect the supported Suitelet version/capabilities and determine whether an existing deployment can be reused. Installation or upgrades are separately reviewable account changes; migration must not silently deploy a Suitelet. Client-only accounts keep the operations that work and receive clear capability errors for the rest. Template rendering uses the real NetSuite/BFO output, not browser HTML as a substitute for PDF fidelity.

## Implementation phases and completion gates

### P0 — Confirm contracts and capture parity fixtures

- Reconcile the static inventory with live `tools/list` from the configured Magic servers, when available. Include dynamically exposed enabled custom tools, prompts, and MCP UI resources. Record configuration-gated features explicitly.
- Export representative sanitized inputs/results/errors and assign each enabled tool a destination and a contract test. Classify read, local write, account write, browser action, executable code, and long-running job behavior individually.
- Record account/runtime/role verification behavior, paging rules, size limits, custom tool-skill preflight fields, binary transfers, and task outcomes.
- Gate: every enabled tool is mapped, intentionally retired, or explicitly deferred. A static count alone does not prove parity.

### P1 — Read transport and existing-feature parity

- Implement the independent authenticated NetSuite bridge, capability handshake, typed operation service, environment selection, and MCP aliases.
- Deliver SuiteQL/catalog, scripts/logs/deployments, and File Cabinet reads first. Preserve UI behavior while replacing duplicate adapter code with shared services.
- Gate: a standard MCP client can list environments and run reads using an internal-browser sign-in, with the Chrome extension/native host stopped. Test missing Desktop, expired sign-in, two accounts, multiple Desktop sessions, role change, and read-only canvas operation.

### P2 — Records, context, and typed writes

- Add record fields/sublists/search/types, custom lists, selected context, and UI context selection.
- Expose File Cabinet writes through the shared service. Implement exact-content checks, write outcome tracking, batch partial failures, and local-file upload sources without carrying over native messaging's transport-specific size ceiling.
- Gate: sandbox contract tests demonstrate correct account targeting, no duplicate writes after timeout/disconnect, conflict detection, and matching UI/MCP state. Creating/updating records remains explicit; this planning task performs none of those actions.

### P3 — Local authoring, documentation, and dashboards

- Implement shared services/stores for dashboards, skills/bindings/preflight, quizzes, selected context, docs batches, and job activity.
- Support compare-and-set revisions and observable changes so an MCP edit appears in an open app and a UI edit is returned by the next MCP read.
- Gate: restart persistence, concurrent-edit conflicts, docs job progress, citations, skill invalidation, dashboard import/export/history, and old simple-widget dashboard migration all work.

### P4 — Verified server execution, custom tools, and SDF

- Add the account capability probe and versioned server adapter. Port tasks, metadata/script fields, quick scripts, bundles, SDF contracts, and custom-tool execution.
- Reuse Projects Hub's local tooling where applicable. Keep environment/auth IDs explicit; an active browser environment must not silently choose a SuiteCloud CLI account.
- Gate: runtime account mismatch is rejected before mutation, disabled/server-unavailable capabilities report accurately, custom-tool drafts/tests/risk/module domains are preserved, and timed-out account writes are never replayed automatically.

### P5 — Template Studio and Suitelet/browser controls

- Port modern Template Studio state and feedback/revision workflow, binary assets, FreeMarker source/version checks, PDF render jobs, page count, and page screenshots. Expose MCP image/resource results rather than large opaque base64 text dumps.
- Implement visible-tab control and browser group management using Orvane's own tab IDs and ownership records. Preserve unrelated user tabs. Maintain streams/control sessions per environment and MCP session.
- Gate: read/patch/render/screenshot operates on the same session the user sees, all PDF pages can be inspected, and Suitelet actions affect only the selected owned tab. Navigation/sign-out invalidates stale control sessions.

### P6 — Import, compatibility, cutover, and rollback

- Deliver export/import with schema version, source version, checksums, preview counts, conflict choices, transactional writes, and a rollback snapshot.
- Maintain Magic names until clients are updated. Keep legacy template features disabled unless deliberately supported; document replacements instead of silently treating them as successful no-ops.
- Run parity tests with the old extension/native host disabled. Update Orvane MCP setup and tool descriptions, then switch the client configuration in a separate user-authorized cutover step. Keep the old setup available until parity and imported data are verified.
- Gate: every enabled source tool has a recorded result: migrated and tested, compatibility alias, intentionally retired with replacement, or explicitly deferred. Do not remove the old data or uninstall the extension as part of an import.

## Data migration

Export through Magic's existing application/storage adapters; a source directory copy does not include browser-profile data. Do not copy Chrome's live profile databases or browser cookies into Orvane.

| Data | Preserve | Proposed Orvane destination |
| --- | --- | --- |
| Dashboards | IDs, graph/code, actions, variables, revisions, attachments | Versioned dashboard records + artifact files |
| Skills and tool bindings | IDs, content, enabled state, required-skill bindings, versions | Skill/binding tables; regenerate ephemeral receipts |
| Custom tools | IDs/names, schemas, code, module/domain/risk, draft/active state, tests | Custom-tool records; imported executable tools start disabled for review |
| Template sessions | Session/current IDs, brief, references/assets, source/render versions, feedback/history, account/context | Session/revision records + PDF/image/source artifacts |
| Selected context | Record/file IDs, labels, account, role where available | Workspace/environment-scoped selection records |
| Quizzes/docs jobs | Questions, answers, evidence links, completed results, error state | Local knowledge/job stores; pending work becomes interrupted rather than silently resubmitted |
| File drafts/bookmarks/history | Environment binding, paths/IDs, original-content version, draft content, history | Existing File Cabinet persistence plus versioned import adapters |
| Browser/stream sessions | Saved intent/URLs only | Reopen as new owned tabs after explicit selection; never adopt stale Chrome tab IDs |

Regenerate runtime connection tokens, ephemeral control IDs, preflight receipts, and live jobs. Preserve stable user document IDs unless a collision is resolved in the import preview.

## Test and release matrix

- **Bridge:** unauthorized origin, ordinary website IPC calls, no Desktop, no authenticated environment, read-only canvas, lease expiry, multiple sessions/accounts, lost connection, bounded payloads.
- **Account identity:** wrong account/server runtime, changed role, sign-in redirects, environment closing during execution, and no credentials in tool output/logs.
- **Reads:** actual source-compatible filters, joins, pagination, empty/binary/large results, Unicode paths, NetSuite governance errors, optional SuiteQL fallback.
- **Writes:** stale originals/versions, account mismatch, partial batches, timeout after success, disconnect before acknowledgement, and zero automatic mutation retries.
- **Shared state:** UI↔MCP edits, conflicts, restart recovery, import dry run, rollback, current template/dashboard selections scoped to the right account.
- **Browser control:** managed versus unrelated tabs, correct visible/processing page, navigation invalidation, screenshot coordinates/scaling, independent concurrent sessions.
- **Contract parity:** fixtures for every enabled source tool; live sandbox tests only when an account is intentionally selected. A fake bridge test does not establish NetSuite API parity.
- **Packaging:** clean Desktop install works without Chrome extension/native-host/second Chromium dependency; local-only knowledge tools remain available without NetSuite sign-in.

## Decisions to resolve during implementation

Recommended defaults are recorded so P1 can start without reopening the architecture discussion:

1. Keep the current Orvane MCP server as the single entry point; preserve Magic names as aliases during migration.
2. Use SQLite plus managed artifact files for migrated durable state; live NetSuite requests always require Desktop and an explicitly bound environment.
3. Prioritize the P1 read surface, then P2 typed writes/context. Treat modern Template Studio as the target workflow; retain legacy approval/wait-loop declarations only as compatibility decisions.
4. Match an existing deployed Suitelet only after version/account verification. Whether to reuse or upgrade it depends on the actual account deployment discovered in P4.
5. MCP-hosted UI resources and prompts require a client compatibility decision: support them as adapters onto the shared services or return links/actions opening Orvane's native views. Preserve tool results independently of which UI the client supports.
6. Scope all 155 static declarations and any dynamically exposed active custom tools. Anything deferred must remain visible in the parity report; it must not disappear under a claim that migration is complete.

**Next implementation slice:** P0 live contract reconciliation, then P1 `netsuite_list_accounts`, explicit environment routing, and `suiteql_execute_query` through the existing owned processing page, with the extension/native host disabled for verification.
