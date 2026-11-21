# To be finished: NetSuite environment MCP tool

Status: **built, tested with stand-ins only, not yet tried against real NetSuite.** Finish this on the machine where Orvane's Browser signs in to NetSuite automatically.

## Goal

The owner wants to tell an AI "go to sandbox Consitech" and have it open that NetSuite environment in Orvane's Browser, the same way the environment picker in the Browser's top header does. The new MCP tool `browser_netsuite_environments` does this. What's left is to confirm it works for real and fix whatever doesn't.

## Owner preferences that matter here

- Fix only what is asked; don't redesign the header picker or the Browser ([AGENTS.md](AGENTS.md) §1).
- Report honestly what passed, what failed and what you couldn't verify (§7).
- Memories about using Orvane go in Orvane (`workspace_memory`, `browser_memory`), not only in your own AI memory (§9).
- Commit, push or merge only when asked (§8).

## State

- Merged into `master` along with the rest of the work from 2026-11-21. Look for the commit `feat: MCP tool to list and open NetSuite environments`.
- **Verified** with `tests/netsuite-environments.spec.ts` (3 tests pass):
  - name matching: "sandbox consitech", account IDs, addresses, and unclear or unknown names;
  - list and open against a stand-in Browser host;
  - the tool appears over MCP.
- **Not verified:**
  - the real environment lookup;
  - the real tab opening and auto-login;
  - behaviour in the owner's running Orvane.

## How it works

- **list**: reads the environments through a signed-in NetSuite tab the owner shared with the AI (tab menu → Let AI use this tab), or one given by `tabId`. It uses the same lookup as the header picker: `electron/netsuite-accounts.mjs` reads NetSuite's My Roles page through the Browser session.
- **open**: takes `{ environment }`, either an account ID or words that all appear in the environment's label and type. It calls the picker's own `switchNetSuiteEnvironment`:
  - if a tab is already on that account, it switches to it, and the tab's AI access is left as it was;
  - otherwise it opens a new tab at `<origin>/app/center/card.nl`, opened for the owner and shared with the AI (granted).
- An unclear name returns the candidates instead of guessing.

## Remaining work (in order)

1. Reconnect the Orvane MCP and restart Orvane so both run the merged code.
   - Done when `browser_netsuite_environments` appears in the AI's tool list.
2. In Orvane's Browser, open NetSuite, let it sign in, and share the tab (tab menu → **Let AI use this tab**).
3. Call `browser_netsuite_environments` with `{ "action": "list" }`.
   - Done when it returns the same environments the header picker shows, with labels and account IDs.
   - If the labels differ from what the owner says ("sandbox consitech"), check how `accountEnvironments` in `electron/netsuite-accounts.mjs` builds `label`. Change only how `pickEnvironment` in `src/browserAgent.ts` matches names, not the picker.
4. Call `{ "action": "open", "environment": "sandbox consitech" }`.
   - Done when the sandbox opens in a new tab and auto-login completes.
   - Call it again: it should switch to that tab (`reused: true`) instead of opening another.
5. Ask the owner to try "go to sandbox Consitech" themselves, then report the results.
6. Separate check from the same day: in one session, `workspace_status` came back without its `memory` field, while a fresh MCP process and the tests included it. After reconnecting, confirm `workspace_status` returns `memory`. If it doesn't, investigate `server/index.ts` (the `workspace_status` tool).

## Known problems

- `tests/netsuite.spec.ts` › "NetSuite workspace tabs keep separate views, split and restore" fails before and after this change. Two "Scripts" buttons match where the test expects one (`.ns-home .home-open`). It's unrelated to this tool and was left alone.
- The environment lookup needs a signed-in NetSuite tab. With none shared, the tool tells the AI to ask the owner to share one, or to open `https://system.netsuite.com` and let it sign in.

## How to run and test

```powershell
pnpm type-check
```

```powershell
pnpm exec playwright test tests/netsuite-environments.spec.ts --workers=1
```

```powershell
pnpm exec playwright test tests/browser-agent.spec.ts --workers=1
```

- Changes in `server/` need an MCP reconnect.
- Changes in `src/` reload in the running app.
- Changes to `electron/main.mjs` or `electron/preload.cjs` need a full Orvane restart. This tool didn't change them.

## Key files

- `server/browser-tools.ts`: registers the `browser_netsuite_environments` MCP tool and forwards to the Browser ops `netsuite-environments` and `netsuite-open`.
- `src/browserAgent.ts`: those two ops, picking the source tab (`netSuiteSource`), and name matching (`pickEnvironment`).
- `src/components/BrowserView.vue`: the Browser host's `netSuiteEnvironments` and `openNetSuiteEnvironment`. `switchNetSuiteEnvironment` now returns the tab id.
- `src/automation.ts`: the run-request schema now allows the two new ops.
- `electron/netsuite-accounts.mjs`: the existing environment lookup (unchanged).
- `tests/netsuite-environments.spec.ts`: the tests.
- README, Browser → AI control: the tool's documentation.
