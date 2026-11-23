# NetSuite and Browser MCP tools: fewer calls per task (23.11.2026)

## Why

On 23.11.2026 a Codex agent session ("in netsuite dev can you find the latest script I made?") was asked to find, then delete, then open, the owner's newest script in NetSuite Dev. The transcript is in `~/.codex/sessions/2026/11/23/rollout-2026-11-23T09-19-56-01a2077d-*.jsonl`. About 25 tool calls went into work that needs about 5. The calls were not wrong; the tools made them necessary.

| What the agent did | Calls | Cause in the tools |
|---|---|---|
| Every turn: `workspace_status` → `orvane_netsuite_status list` → `inspect` (~3.5 s) → the real call. The token was dropped between turns; one `TARGET_UNAVAILABLE` forced list + inspect again. | ~12 | Every NetSuite call needed `targetId` + `identityToken`, which cost two calls to get. |
| Read tool descriptions one by one to learn their argument shapes. | ~6 | Long descriptions, argument shape at the end, no example call. |
| "Latest script": `read scripts {owner}`, sorted by ID itself, then `schema fields script` looking for a created date. | 3 | `read` had no sort or limit. |
| Opened 2 tabs in a loop of `browser_open`, then a loop of `browser_snapshot` to check them. | 4 | `browser_open` took one URL and returned nothing about the page. |
| Opened `scriptrecord.nl?id=2153` for the script (that is the deployment page) and `scriptdeployment.nl?id=4646` for the deployment. Both showed "Record does not exist"; recovering took re-auth, reads, snapshots, clicks and navigation. | ~7 | Agents had to guess NetSuite page addresses. |
| "Open the folder in File Cabinet": inspect → `find-folders` → hand-built URL → snapshot to confirm. | 4 | No way to open a file's folder. |
| Script and deployments as 2 reads; the file's folder looked up later. | 2 | No single "script detail" read. |

## What changed

All changes are in the MCP server (`server/`). No Electron changes, so Orvane needs no restart; a new agent session loads the new tools.

1. **`origin` instead of `targetId` + `identityToken`** (`server/netsuite-tools.ts`, `targeted()` / `register()`). Every NetSuite tool accepts `origin`: the environment address (`https://1234567.app.netsuite.com`) or an account ID (`1234567`, `1234567_SB1`). Orvane lists and inspects it.
   - Reads reuse an inspection for 60 s, keyed by the normalized origin. If the broker answers `IDENTITY_CHANGED` or `TARGET_UNAVAILABLE` on a reused one, Orvane inspects again and retries once.
   - Writes (`run_suitescript`, `file_write`, `task`, `memory`) always inspect fresh and are never retried.
   - The broker still checks the identity on every call; nothing about that check changed.
   - The explicit `targetId` + `identityToken` path still works. Giving both forms is refused (`INVALID_TARGET`).
2. **Errors list the choices.** No environment given: `TARGET_REQUIRED` with the open environments. Unknown origin: `TARGET_UNAVAILABLE` with the list. One origin open in several windows: `TARGET_AMBIGUOUS` with those targets.
3. **`orvane_netsuite_read`: `sort`, `limit` and `action: "script"`.**
   - `sort`: `name`, `id`/`-id`, `modified`/`-modified` (files, folders), `created`/`-created` (files). `limit`: 1–100.
   - `action: "script"` takes the script's internal `id` or `filters.scriptId` and returns the script (owner, file, folder), all deployments and the page links in one call.
   - These are compiled from the same fixed SELECTs (`compileNetSuiteRead`) and sent through the broker's `query` operation, so they need only the `query.select` capability, not a broker upgrade.
4. **`orvane_netsuite_open`** (full Orvane MCP only; it needs the Orvane window). Opens NetSuite pages for the user by kind + internal ID, up to 10 per call, optionally in a tab group, and reports each page's title plus `pageProblem` when NetSuite shows an error.
   - Kinds: `script`, `deployment`, `file`, `folder`, `file-folder` (the folder holding a file), `record` + `recordType` (transactions, entities, items, `customrecord_…`; anything else is refused, never guessed).
   - Addresses come from `netSuitePagePath()`. A script is `script.nl`, its deployment is `scriptrecord.nl`.
   - `server/index.ts` passes `liveRun` to `registerNetSuiteTools` for this; the NetSuite-only connector (`connector-mcp.ts`) passes none, so it does not get the tool.
5. **`browser_open`** (`server/browser-tools.ts`) takes `urls: [...]` (one tab each, returns `{ tabs }`) and `check: true` (title, address, first text, `pageProblem` for error or sign-in pages, waits up to ~5 s for loading).
6. **`browser_snapshot`** takes `tabIds: [...]` and returns `{ tabs }` in the same order.
7. **Descriptions.** The NetSuite instructions and the `read` / `query` descriptions now start with an example call using `origin`.

## Left out on purpose

- **Marking `browser_open` read-only** to avoid Codex approval prompts. It opens tabs and takes control of them, so the hint would be false. The prompt in that session came from Codex's own approval policy.
- **A brief mode for `workspace_status`.** Minor, and the tool is outside this change.
- **Opening a file inside Orvane's own NetSuite app File Cabinet** (rather than NetSuite's File Cabinet page). It would need a new live-workspace operation; not needed for the cases above.

## Tests

- `tests/netsuite-mcp-shortcuts.test.ts` (`pnpm exec tsx --test <file>` from PowerShell; Git Bash's `whoami` breaks it). Covers origin + reuse + refresh after a role change, error lists, sort/limit SQL, `action: "script"`, and `netSuitePagePath`. The first 4 tests fail on the code before this change.
- `tests/browser-open-many.spec.ts` (Electron, one at a time): `urls` + `check` flags a "Record does not exist" page; `tabIds` reads both tabs. Passes. Not run against the old code because another session held port 5174 at the time.
- `tests/netsuite-mcp.test.ts` still passes (6/6). `pnpm type-check` clean.

## Not verified

`orvane_netsuite_open` end to end against a signed-in NetSuite account, and whether NetSuite's generic custom-record page (`custrecordentry.nl?rectype=<scriptid>`) accepts a script ID in every account.
