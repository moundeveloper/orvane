# Batch 2: Desktop-owned NetSuite broker worker

Branch: `codex/netsuite-mcp-migration`. Batch 1 listing/inspection/SELECT was confirmed by the user on 5 November 2026. This checkpoint moves that same read path into a separate process; it adds no account-write capability.

Implementation commit: `ef793cb`. Test the current branch HEAD, which also records the checkpoint documentation.

## What changed

- Desktop starts one Node broker worker on its own private process IPC channel. The socket listener, authentication, target IDs and client-runtime identity tokens live in that worker.
- Electron main retains browser/session ownership and a narrow executor gateway: list trusted window IDs, list their NetSuite environments, inspect client identity, and execute bounded SELECTs. Other operations and non-owned windows are rejected at this boundary.
- Status/inspect/query results include `batch: 2` and `execution` metadata: `mode`, `brokerPid`, `desktopPid`, and protocol version. The public protocol remains compatible with Batch 1.
- Closing a Claude session does not start/stop the broker. Desktop shutdown requests a graceful worker stop; abrupt termination can leave stale discovery metadata, which a later worker reclaims after checking that its owner process has stopped.
- A broker crash disconnects reads; it does not fall back to running them in Electron main or automatically replay them. Restart Desktop to restore the worker.

The existing `orvane` entries in Claude Desktop and Claude Code require **no configuration changes or reinstall**. The two MCP tool names remain `orvane_netsuite_status` and `orvane_netsuite_query`.

## 1. Restart Desktop and confirm the worker

1. Save your work and fully close/reopen **Orvane Desktop** from this branch (`pnpm desktop`). A renderer refresh cannot load the new Electron startup code.
2. Keep your existing Claude client, or start a fresh conversation. Call `orvane_netsuite_status` with `action: list`.
3. Expected: `available: true`, `batch: 2`, and:

```json
{
  "execution": {
    "mode": "broker-worker",
    "brokerPid": 12345,
    "desktopPid": 23456,
    "protocol": 1
  }
}
```

The PIDs above are examples: the actual positive process IDs must differ. `batch: 1` means the old Desktop main process is still running. `DESKTOP_UNAVAILABLE` means Desktop/the gateway is not ready; an MCP server can be connected independently of Desktop readiness.

Optional terminal check from this repository: `node scripts/check-orvane-mcp.mjs`. It lists status only and never chooses an account or runs SQL.

## 2. Repeat the verified sandbox read

Keep the intended NetSuite session open in Orvane's Browser app. Never reuse a target ID or identity token copied from the previous Desktop instance.

Copyable prompt:

> Use only Orvane MCP, without Magic and without modifications. Call orvane_netsuite_status with action list and show batch/execution metadata. Select the target for https://4027610-sb1.app.netsuite.com; if multiple window targets match, ask me which one. Inspect that target. Confirm account 4027610_SB1 and show client-runtime identity metadata. Using the newly returned targetId and identityToken, run SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1. Report the result and execution metadata. Stop if the target/account does not match.

Expected: one bounded result page from the explicitly selected sandbox, unchanged read-only semantics, and `execution.mode: broker-worker`. The row value depends on current data and permissions; do not hard-code `-5` as the expected lowest ID.

The sorting is deliberately inside the subquery: `ROWNUM` in the outer query limits the already ordered rows. No automatic SQL rewrite was added to the adapter.

## 3. Check shared ownership and view independence

1. Call status/list from two Claude Code sessions, or from Claude Desktop and Claude Code using their installed `orvane` profiles.
2. Their `desktopId`, `execution.brokerPid`, and `execution.desktopPid` should match while connected to the same running Orvane profile. The stdio clients themselves have separate processes; neither should start another broker.
3. Close only the **NetSuite app view**, keeping Orvane Desktop and the authenticated **Browser tab** open. List/inspect/query again using fresh returned values. It should continue to work.
4. Closing one Claude conversation/client must not prevent the other from performing a read.

## 4. Check clean stop and restart

1. Close Orvane Desktop normally after saving work. The app should close without hanging.
2. Status/list from Claude should report `DESKTOP_UNAVAILABLE`.
3. Reopen Desktop. List and inspect again, then repeat the sandbox query. New instance target/identity tokens are expected.

Worker crash and forced-parent-termination cases are covered by automated child-process tests. You do not need to kill production processes manually for this checkpoint. If a real crash occurs, report the error and restart Desktop; do not repeatedly resubmit a pending request.

## Still outside this batch

- No durable job/request journal, artifact service, result cache/cursor snapshot, or additional feature families.
- Identity is still `source: client-runtime`, `serverRuntimeVerified: false`; external role changes can leave stale bootstrap identity. This extraction does not establish server-side role isolation.
- Explicit Windows named-pipe DACL construction and the older full canvas/workspace bridge migration remain separate follow-up work. Existing token/discovery-directory permissions and size/queue limits remain in force.
- Workers are tied to Desktop lifetime; this is not an unattended service that continues NetSuite execution after Desktop exits.
- Automated executor fixtures cannot prove live NetSuite behavior. The user's Batch 1 result validates the old path; the new worker path needs this live checkpoint.

## What to report

Report the current commit, `batch`, execution mode, whether the two process IDs differ, whether both Claude clients share one broker, and whether inspect/query and close/reopen work. Include error codes/messages if any. Do not send identity tokens, the discovery file/token, cookies, passwords or unrelated account data.

Batch 3 starts after this feedback. See [the progress log](../NETSUITE-MCP-PROGRESS.md) for actual commits and remaining work.
