# Batch 1: test Orvane NetSuite MCP in Claude Code

Branch: `codex/netsuite-mcp-migration`. This is the first read-only checkpoint, not the full migration.

For the current worker implementation, use [the Batch 2 test guide](./NETSUITE-MCP-BATCH-2-TESTING.md). This document records the original Batch 1 setup and checks.

Implementation commit: `568a1fe`. The current branch HEAD also includes the documentation checkpoint recording this hash.

User feedback on 5 November 2026 confirms environment listing, explicit sandbox selection, inspect and one SELECT using only Orvane. The smoke query below now orders inside a subquery before applying `ROWNUM`; the earlier top-level ordering did not guarantee the lowest ID. This does not change the query adapter itself.

## What is installed

Both Claude Code CLI and Claude Desktop now have an `orvane` stdio server using:

- Runtime: the local Node executable found by the installer.
- Entrypoint: `C:/Projects/Orvane/server/launch.mjs`.
- Profile: `ORVANE_MCP_PROFILE=netsuite`.
- Data: `ORVANE_DATA_DIR=C:/Projects/Orvane/.orvane`.
- Tools: `orvane_netsuite_status`, `orvane_netsuite_query`.

This profile avoids the existing canvas bridge entirely. Magic's servers remain unchanged in Claude Desktop; this machine's Claude Code CLI profile had no MCP servers before installation. The normal full Orvane MCP entrypoint is still available without the `netsuite` profile; its workspace transport has not been migrated in this batch.

**The two clients use separate configuration files.** The first installation changed only `~/.claude.json` for Claude Code CLI. The follow-up also adds Orvane to `%APPDATA%/Claude/claude_desktop_config.json`, which controls the screenshot's **Settings > Developer > Local MCP servers** screen. Existing Magic entries and other Desktop preferences were verified unchanged against the backup.

The installer is `scripts/install-claude-code-mcp.ps1` (PowerShell 7). It backs up the user config under `~/.claude/backups/`, preserves other servers, and is a no-op when this exact profile is already installed. It refuses to overwrite a different existing Orvane entry. A custom `CLAUDE_CONFIG_DIR` requires adding the documented entry explicitly in that profile rather than guessing where its configuration lives.

For the Claude Desktop settings screen, use `scripts/install-claude-desktop-mcp.ps1` (PowerShell 7). It atomically adds the entry, writes a timestamped backup next to the Desktop config, preserves other entries/preferences, and is idempotent.

## 1. Restart and check connection

1. Save work, then close and reopen **Orvane Desktop**. An already-running Electron main process cannot load the new gateway by refreshing the page. From this repository, `pnpm desktop` launches Desktop.
2. For **Claude Desktop's Local MCP servers screen**, fully quit Claude Desktop (including its tray process), reopen it, then check **Settings > Developer > Local MCP servers** for `orvane`. Merely closing the settings panel may not reload the file. For **Claude Code CLI**, start a new session, run `/mcp`, and check that `orvane` is connected.
3. In a terminal, `claude mcp get orvane` and `claude mcp list` should also report it connected.
4. Optional terminal smoke check from `C:/Projects/Orvane`: `node scripts/check-orvane-mcp.mjs`. It only lists tools/environments and never runs SQL.

An MCP connection can be healthy while Desktop is closed. In that case, the status tool should return `available: false`, code `DESKTOP_UNAVAILABLE`, and instructions to start/restart Desktop. That is an expected result, not a failed Claude configuration.

## 2. Test status without opening the NetSuite app

Use this prompt in Claude Code:

> Use only the Orvane MCP server. Call orvane_netsuite_status with action list. Do not use Magic NetSuite, run SQL, or make changes. Show the Desktop status and the listed environment labels/origins.

Expected: Desktop is available. If Browser has no signed-in NetSuite environment, the environment list can be empty. The NetSuite app view itself does not need to be open. A read-only canvas or an inactive NetSuite view must not block this tool.

## 3. Inspect an explicit target and run one SELECT

1. In Orvane's **Browser app**, open and sign in to the intended NetSuite account. Leave that Browser tab open for this checkpoint. Use a sandbox for routine testing.
2. Run status/list again. If more than one target appears, tell Claude exactly which origin/window to use. Do not let it switch to Magic's account.
3. Use this prompt, replacing the origin:

> Use only Orvane MCP. List environments and select the target for https://YOUR-ACCOUNT.app.netsuite.com. Inspect that target using orvane_netsuite_status, action inspect. Show the returned accountId, userId and roleId. If the target is ambiguous or not ready, stop and report it. Otherwise use its targetId and identityToken to call orvane_netsuite_query with SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1. Make no changes.

Expected: one bounded query page, target/identity metadata, and an observation time. A role without access to `employee` can produce a NetSuite permission error; choose a table you can already query in Orvane's SuiteQL view and retry explicitly. Do not treat an error as an empty successful result.

The identity returned here is **client-runtime identity**, with `serverRuntimeVerified: false`. A processing page can retain stale bootstrap identity across an external role/session change. This batch does not establish server-side session/role isolation; its checks reject changed *reported* identities. A verified server probe, session epochs and stronger lifecycle invalidation are later work. NetSuite continues enforcing permissions on its own requests.

## 4. Isolation and failure checks

- Open a second Claude Code session. Repeat status/list in both. Both should connect to the same Desktop ID, with no workspace port-in-use error.
- Close only the NetSuite app view, leaving Browser/Desktop open. Repeat the read. It should still work.
- Close Orvane Desktop and call status/list. Expect `DESKTOP_UNAVAILABLE`. Reopen Desktop, list and inspect fresh targets before querying again; target/identity tokens from the previous instance are intentionally invalid.
- Ask for a query with an invalid target ID or missing/stale identity token. Expect an explicit error, not automatic selection of another account.
- `DELETE FROM employee` or a semicolon-separated statement should be rejected. There is no account-write MCP tool in this profile.

## Limits of this batch

- Only status/list, client identity inspection and one SELECT page; no File Cabinet tools, record writes, custom scripts, deployment, server probe, artifact export, cursor snapshots or cached-result sharing yet.
- Uses the existing query adapter: up to 100 rows per page, integer offset, SELECT text up to 20,000 characters, no semicolons, maximum response 1 MiB. Results are live pages, not a materialized snapshot.
- The direct gateway currently runs in Electron main with lightweight routing only. The dedicated broker worker and durable request/job journal are not implemented yet.
- Gateway discovery is a per-user-permitted private directory and an authenticated random named pipe. The Windows pipe itself uses Node's default ACL; an explicit pipe-DACL implementation is still required to meet the full plan's transport-hardening target.
- The existing canvas bridge and canvas editing lease are unchanged. These two NetSuite tools work independently through the dedicated profile.
- Automated tests use a fake NetSuite executor plus the real socket and stdio MCP paths. Real account/query/login behavior requires this manual test; no live account write or deployment was performed.

## Feedback for the next batch

Report the commit you tested, whether Desktop was restarted, the `orvane` connection state, whether listing/inspection/query worked, whether two Claude clients worked, and any error code/message. Include the target origin/account type if useful; never send passwords, cookies, the Desktop discovery file/token, or unrelated account data.

The next implementation batch starts after this checkpoint feedback. Follow [the progress log](../NETSUITE-MCP-PROGRESS.md) for actual scope and commits.
