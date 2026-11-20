# Handoff: NetSuite agent tools, SuiteCloud workspace and the certificate login

Written 20.11.2026 for the next agent. Read `AGENTS.md` first. Everything below is **uncommitted** on branch `feat/browser-ai-control`, in the same checkout as another session's browser-AI work (see "Files" — do not commit their files).

## 1. Where things stand

| Piece | State |
|---|---|
| `orvane_netsuite_run_suitescript` (quick script) | Done, live-tested on dev |
| `orvane_netsuite_file_write` (upload/overwrite keeping ID/update/delete/create-folder, read-back verified) | Done, live-tested on dev |
| `orvane_netsuite_memory` + saved scripts (`run_suitescript` with `savedScript`/`params`) | Done, live-tested on dev (test entries removed) |
| `orvane_netsuite_sdf_guide` (copy of the user's `sdf-object-builder` skill in `server/sdf-guide/`) | Done, tested |
| `orvane_netsuite_sdf` (per-account SuiteCloud workspace, bulk write/edit, add-dependencies, validate, deploy, import, list) | Done; status/create/write/add-dependencies live-tested; **deploy not yet live-tested** |
| `orvane_netsuite_task` (run map/reduce or scheduled deployment, restore original status when the run ends, persisted across restarts) | Done, unit-tested; **not yet live-tested** |
| NetSuite app → **SuiteCloud** and **Memory** apps | Done, type-checked; **not visually checked by anyone yet** |
| Browser 12-tabs-per-space limit removed | Done, regression test passes |
| **SuiteCloud login by certificate (M2M)** | **To build — this handoff** |

Why the deploy and task tests are open: both dev SuiteCloud auth IDs (`ctk-dev`, `DEV`) have expired credentials. Refreshing them uses the CLI's browser login, which on Windows always opens the Windows default browser (Brave). Routing it to Orvane's browser is not possible: the SDK (`cli-2025.2.1.jar`, `PKCERequestService.requestCodeGrant`) calls `java.awt.Desktop.browse` unless `SystemUtils.IS_OS_LINUX`; forcing `-Dos.name=Linux` also switches credential storage to Linux and fails ("Secure storage is inaccessible"). The user chose the certificate route.

## 2. Rules the user set (do not break)

- **Never run an interactive SuiteCloud command** (`account:setup`, `-i`, anything that prompts or opens a browser). Orvane closes the CLI's stdin; an expired login must be reported, not driven. The user was explicit about this: Magic NetSuite was buggy because of it.
- **No browser login for SuiteCloud. Certificates only** (`account:setup:ci`).
- **Never run the user's real map/reduce or scheduled scripts** to test. Use a harmless log-only test script you deploy yourself, then delete it.
- Test on **dev = account 1964539** ("CONSITEK SRL (Development Account 1)"). The user allowed writing in File Cabinet folder **3847** ("MagicNetsuiteScripts", path `/SuiteScripts/MagicNetsuiteScripts/`). It holds Magic's two server scripts (`magic_netsuite_mcp_server.js` 23926, `magic_netsuite_server.js` 23925): never change them. Clean up everything you create.
- Commit only when the user asks. No Claude co-author trailer in commits (user's memory rule).

## 3. Next task: SuiteCloud login by certificate

### 3.1 What the user does once in NetSuite (dev)

Send the user these steps (they are the user's actions; do not try them yourself):

1. **Make the certificate in Orvane.** Workspace options → **Certificate manager** → New certificate. Defaults are right for NetSuite: RSA 4096, SHA-256 with RSA-PSS, one year, files `rsapss-cert.pem` and `rsapss-key.pem` (stored in `.orvane/certificates/<id>/`). Give it a clear pair name, e.g. "SuiteCloud dev 1964539". Use **Show in folder** to find `rsapss-cert.pem`.
2. **Check OAuth 2.0 is on** (Administrator): Setup → Company → **Enable Features** → **SuiteCloud** tab → *Manage Authentication*: **OAuth 2.0** ticked; *SuiteCloud Development Framework*: **SuiteCloud Development Framework** ticked. Save.
3. **Check the role** that will deploy (e.g. Administrator, or a developer role) has the permissions *Log in using OAuth 2.0 Access Tokens* and *SuiteCloud Development Framework* (Setup tab). Administrator has them.
4. **Create the M2M mapping:** Setup → Integration → **Manage Authentication** → **OAuth 2.0 Client Credentials (M2M) Setup** → **Create New**:
   - **Entity**: the user (employee) the CLI acts as.
   - **Role**: the role from step 3.
   - **Application**: **SuiteCloud Development Integration** (NetSuite's built-in application for the SuiteCloud CLI/SDK; if the list shows "SuiteCloud IDE & CLI", use that).
   - **Certificate**: upload `rsapss-cert.pem` (the public certificate — **never** the key file).
   - Save. NetSuite shows a **Certificate ID** (a long string) in the list. Copy it.
5. Give the agent: the **certificate ID**, and which Orvane certificate pair it belongs to. The key never leaves the computer.

Notes: the certificate expires (one year by default); the mapping must be renewed with a new certificate before then. One mapping per account (sandbox and production need their own).

### 3.2 What to build in Orvane

- **Non-interactive setup:** run, in the account's workspace project, `suitecloud account:setup:ci --account 1964539 --authid orvane-1964539 --certificateid <id> --privatekeypath <.orvane/certificates/<pair>/rsapss-key.pem>` (sandbox accounts need `--account 4027610_SB1`; `--domain` only for non-default domains). Use `runSuiteCloud` in `server/suitecloud-workspace.ts` (PowerShell, stdin closed, progress output stripped). Then `chooseAuth(account, "orvane-<account>")`.
- **Key path, not key contents:** resolve the private key path through `CertificateService` (`server/certificates.ts`, records have `certPath`/`keyPath`) by pair ID. Never put the key text in an MCP argument, log or response.
- **Where the user triggers it:** the NetSuite app's SuiteCloud app (`src/components/NetSuiteSuiteCloud.vue`). Today it is hidden unless an auth ID exists (`hiddenApps` in `NetSuiteView.vue`). Change: show it whenever the CLI exists, and when there is no usable auth, show a "Connect with certificate" form (custom controls only — `CustomSelect` to pick a certificate pair, a text field for the certificate ID; no native `<select>`). Add the action to `server/netsuite-workspace-api.ts` (`suitecloud-connect`), and optionally to `orvane_netsuite_sdf` (`connect {certificatePairId, certificateId}`).
- **Expired-login detection:** `cli()` already returns `authExpired` + `nextStep`. With certificates the CLI refreshes tokens itself; keep the message for browser-based auth IDs and point it at "Connect with certificate".
- Tests: extend `tests/netsuite-suitecloud.test.ts` (fake CLI) — `setup:ci` args are exactly as above, no interactive flags, key path only from the certificate store, a failure surfaces the CLI error. Keep the existing "never prompts" assertion.

### 3.3 Then finish the live test on dev

The test project is in `.orvane/suitecloud/1964539/` (already has the files, manifest has `SERVERSIDESCRIPTING` from add-dependencies):
- `src/FileCabinet/SuiteScripts/MagicNetsuiteScripts/orvane_test_mr.js` — log-only map/reduce.
- `src/Objects/customscript_orvane_test_mr.xml` — deployment `customdeploy_orvane_test_mr`, status **TESTING** (so the restore can be checked).

Steps (via MCP tools on target 1964539):
1. `orvane_netsuite_sdf` `deploy`.
2. Find the deployment ID: `SELECT primarykey, status FROM scriptdeployment WHERE scriptid = 'customdeploy_orvane_test_mr'` (use **primarykey**, not id).
3. `orvane_netsuite_task` `run {deploymentId, waitSeconds: 50}`; then `status {runId}` until done. Check: status went to NOTSCHEDULED to start, run COMPLETE, then back to **TESTING** (`restore.restored: true`). Check the logs with `orvane_netsuite_logs` (title "orvane test map").
4. If "Save and Execute" is not offered for TESTING, the run fails and the status is put back at once — then retry with the deployment at NOTSCHEDULED/SCHEDULED and report what NetSuite allows.
5. Clean up: delete the deployment and the script record (`orvane_netsuite_run_suitescript`: `record.delete` type `scriptdeployment` by primarykey, then the script record — find its internal ID via `SELECT id FROM script WHERE scriptid = 'customscript_orvane_test_mr'`; type `mapreducescript`), delete the file `/SuiteScripts/MagicNetsuiteScripts/orvane_test_mr.js` (`orvane_netsuite_file_write` `delete`), remove the two local files (`orvane_netsuite_sdf` `write {remove:[...]}`), and confirm folder 3847 holds only Magic's two files.
6. Ask the user to open NetSuite app → **SuiteCloud** and **Memory** and look (nobody has seen them yet).

## 4. How things work (for orientation)

- **Broker path:** MCP server (`server/netsuite-tools.ts`) → named-pipe RPC → broker worker (`electron/netsuite-broker-worker.mjs`, runs `electron/netsuite-read-service.mjs`) → executor gateway in Electron main (`electron/netsuite-broker-protocol.mjs`: `kind: "read"` vs `kind: "write"`, args rebuilt from known fields) → page code in `electron/netsuite.mjs` (one big template string run in the hidden processing page).
- **Task runs:** page ops `run-task` (writes), `task-status` (N/search `scheduledscriptinstance` filtered by `scriptdeployment.internalid`; SuiteQL's table has no deployment link), `set-deployment-status`; tracker `electron/netsuite-task-runs.mjs`, saved in `.orvane/netsuite-broker/task-runs.json`, ticks every 15 s, restores only if the status is still NOTSCHEDULED.
- **SuiteCloud workspace:** `server/suitecloud-workspace.ts` (runs in the MCP server and in the Vite API, not the broker). Project per account in `.orvane/suitecloud/<account>/` with its own `package.json` `"type": "commonjs"` (Orvane's root package is ESM, which broke `suitecloud.config.js`). Auth ID per account: `.orvane/suitecloud/<account>.json`, written to `project.json` `defaultAuthId` (deploy/validate take no `--authid`).
- **Memory:** `server/netsuite-memory.ts`, `app_data` key `netsuite-memory:<ACCOUNT>` in `workspace.sqlite`.
- **App API:** `server/netsuite-workspace-api.ts` at `/__orvane/netsuite-workspace` (local, same-origin), registered in `vite.config.ts` (needs a Vite/Orvane restart after changes).

## 5. Gotchas that cost time

- Changes in `electron/*` need a **full Orvane restart** (the user's app; ask, or restart it yourself only if the user allowed it — this session did: `pnpm desktop` in the background).
- After the user signs in again in Orvane's Browser, targets go stale (`SESSION_CHANGED`): list and inspect again.
- The page code in `electron/netsuite.mjs` is inside a template literal: write `\\n`, `\\d`, `\\.`; a plain `\n` inside a quoted string breaks the page code at runtime. Syntax-check by evaluating the template (see the session's `pagecheck.cjs` idea: extract between ``const code = ` `` and `` `; let processingTab``, replace `${input}` with `{}`, `new Function`).
- Several electron files are **CRLF**; scripted string replacements must normalise line endings.
- Tests: `node --experimental-transform-types --test tests/<name>.test.ts` (run from **PowerShell**: the sandboxed Bash blocks `whoami`, which broker tests need). `tests/netsuite-suitecloud.test.ts` imports the database → run with `pnpm exec tsx --test`. Electron/Playwright specs one at a time.
- SuiteCloud CLI 3.1.3: `project:deploy` flags are `--dryrun`, `--validate`, `--accountspecificvalues`, `--log` (no `--authid`). `account:manageauth --list` / `--info <id>` are non-interactive.
- The Desktop processing page must stay referenced (fixed in commit 930cd93); if calls hang after a 30 s timeout again, look there first.

## 6. Files

Mine (this work), uncommitted:
`electron/netsuite-task-runs.mjs`, `electron/netsuite.mjs`, `electron/netsuite-broker-protocol.mjs`, `electron/netsuite-broker-worker.mjs`, `electron/netsuite-read-service.mjs`, `electron/netsuite-request-journal.mjs`, `electron/netsuite-rpc.mjs`, `server/netsuite-client.ts`, `server/netsuite-tools.ts`, `server/netsuite-metadata-operations.ts`, `server/netsuite-write-operations.ts`, `server/netsuite-sdf-tools.ts`, `server/suitecloud-workspace.ts`, `server/netsuite-memory.ts`, `server/netsuite-workspace-api.ts`, `server/sdf-guide/**`, `src/netsuiteWorkspace.ts`, `src/components/NetSuiteSuiteCloud.vue`, `src/components/NetSuiteMemory.vue`, `src/components/NetSuiteHome.vue`, `src/components/NetSuiteView.vue`, `tests/netsuite-write.test.ts`, `tests/netsuite-suitecloud.test.ts`, `tests/netsuite-mcp.test.ts`, `tests/netsuite-metadata.test.ts`, this document.

Shared with the other session (commit only my hunks, e.g. with a patch of just those hunks and `git apply --cached`):
`README.md` (my NetSuite MCP paragraph), `vite.config.ts` (the `netSuiteWorkspaceApi` import and plugin entry), `src/components/BrowserView.vue` (tab-limit removal only), `tests/browser-sidebar.spec.ts` (the "more than 12 tabs" test).

Everything else modified or untracked belongs to the other session.

Already committed: `930cd93` (processing page GC hang fix), `7235899` (read-only NetSuite tools port).
