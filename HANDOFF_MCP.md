# Handoff: Orvane MCP extensions (automations, composition, triggers)

Written 2026-11-19 for the next AI session (possibly on another machine).
Read [AGENTS.md](AGENTS.md) first; its rules apply. Tool-by-tool reference:
[docs/MCP-EXTENSIONS.md](docs/MCP-EXTENSIONS.md). MCP server basics:
[server/README.md](server/README.md).

## 1. Goal

The owner wants AI agents connected to Orvane (Claude Desktop, Claude Code,
Codex — all at once) to **build and run automations**, not only apps:
create workflows ("actions"), add nodes, wire them to buttons and the wheel,
run them, schedule them, and do multi-step work **without bulky in-between
data passing through the AI's context** ("that data is just transformative
and the AI doesn't really need it in the context").

## 2. Owner preferences that matter here

- **One MCP server, any number of clients at once.** "anything that is
  connected to orvane should have access to it ... along with claude at the
  same time, I don't want bullshit limits". Never reintroduce a single-client
  port lock.
- **Triggers keep running while Orvane sits in the tray** (owner's answer:
  "Yes, run in tray").
- Don't claim something works without verifying it. The owner was furious
  when an MCP connection was reported as installed but wasn't. Check, then
  report plainly what was and wasn't verified.
- Research how others solved a problem before improvising (the code_run
  design follows Anthropic's "Code execution with MCP" and Cloudflare's
  "Code Mode").
- Fix only what's asked; custom controls only; light theme. See AGENTS.md.
- Commit, merge or push only when asked.

## 3. State

- `master` contains everything below (merged and pushed together with this
  file). Feature branches: `feature/mcp-domain-extensions`,
  `feature/automation-triggers` (both merged).
- Commits, oldest first: `e1fbdcc` workflow tools, `86b64e1` chains / code /
  custom tools / wheel / board / layouts, `2651009` scheduled triggers.

### Verified (isolated test workspaces, never the owner's real data)

- `pnpm type-check` passes (covers `server/**` too).
- `tests/mcp.spec.ts` 8/8, `tests/triggers.spec.ts` 3/3,
  `tests/triggers-tray.spec.ts` 1/1 (real Electron: window hidden to the
  tray, a 1-minute trigger ran by itself), plus wheel, calendar, workspace,
  editors, handoff, refinements, group-controls and board-stacking specs.
- Demos recorded from scripts (output in git-ignored `artifacts/`):
  `scripts/demo-mcp-workflows.ts`, `scripts/demo-mcp-compose.ts`. In the
  compose demo, a code_run that ran 10 workflows and summarised sent the
  agent 159 characters, against 7,971 for a single `workspace_get`.

### Not verified

- The owner's real running Orvane with this code. It needs a restart (see 6).
- Claude Desktop, Claude Code and Codex picking up the new tools after their
  restart, and Claude Desktop/Codex refreshing `custom_*` tools live
  (`custom_tool_run` is the fallback if a client ignores tool-list changes).

### Failing tests that are not caused by this work

They fail the same way on master before these changes (checked by running
each spec alone with `--workers=1` on both): `workspace-actions.spec.ts:97`,
`pan-cursor.spec.ts` ×3, `certificates.spec.ts` ×2,
`exposition-install.spec.ts`, `git.spec.ts:384`, `claude-sessions.spec.ts:342`.
The full parallel `pnpm test` shows more failures from Electron specs
running in parallel (AGENTS.md: run Electron specs one at a time).

## 4. How the MCP server changed

Before: `server/index.ts` registered tools that each did one thing (workspace
ops through `applyCommands`, Git, Notes, Projects, NetSuite, UI Maker). One
process held port 43765, so a second client (Claude Desktop + Claude Code)
failed with EADDRINUSE.

Now:

1. **Multi-client bridge** (`server/bridge.ts`, `server/discovery.ts`,
   `src/mcpBridge.ts`). Each MCP process binds the preferred port, or any
   free port if it's taken, and writes `mcp-bridges/<instanceId>.json` (with
   its pid) in the state dir. Discovery drops entries whose process is dead.
   The Orvane window connects to **every** running bridge and serves them
   through one command queue. Any number of agents edit the same live
   workspace.
2. **Tool registry** (`server/tool-registry.ts`). `createToolRegistry(server)`
   wraps `server.registerTool` right after the `McpServer` is created, so every
   tool from every module is also callable in-process:
   `registry.call(name, args)`. It validates args with the tool's schema and
   unwraps the result (`structuredContent.result`, else parsed text; images
   are reduced to type and size). Nesting is limited to 4 levels
   (AsyncLocalStorage).
   **Any new tool must be registered after the registry is created** (it is
   created right after `new McpServer`).
3. **Live runs.** `BridgeRequest` gained `run?: RunRequest`
   (`src/automation.ts` `runSchema`), handled by `runForMcp` in `src/App.vue`.
   Kinds: `workflow`, `component`, `runs`, `layout-save`, `layout-apply`,
   `trigger-run`. These need the window open (`liveRun` in index.ts errors
   otherwise); they never run offline.
4. **New workspace operations** in `src/automation.ts` `operationSchemas`
   (also usable inside `workspace_batch`, offline or live): `workflow_*`,
   `wheel_*`, `layout_list/delete`, `board_*`, `trigger_list/set/delete`.
   All go through `applyCommands`, which keeps whole-workspace validation,
   reference checks, revision checks and recovery snapshots.
5. **Composition tools.**
   - `tools_chain` (`server/chain.ts`): steps run in order; args use
     `{{step.path}}` / `{{input.x}}`.
   - `code_run` (`server/code-runner.ts` + `server/code-sandbox.mjs`): a
     child Node process with `--permission` (no fs writes, no child
     processes or workers), inside a `vm` context that only has `tools`,
     `input` and `console`. Values cross as JSON strings, and eval is
     disabled. Not a hard boundary: Node 24's permission model doesn't block
     the network.
   - Custom tools (`server/custom-tools.ts`): stored in workspace SQLite
     `app_data` key `mcp:tools`. Every MCP process polls every 3 s and
     registers or removes `custom_<name>` tools, so all clients share them.
6. **Scheduled triggers** (`src/triggers.ts`, `checkTriggers` and
   `runTrigger` in `src/App.vue`). `workspace.triggers` (validated in
   `src/validation.ts`) is checked every 15 s together with calendar
   reminders, by the editing window only. Merging a backup drops incoming
   triggers; replacing keeps them.
7. **`automation_catalog`** (`server/automation-catalog.ts`): the docs an agent
   reads before building (step kinds, value rules, an example, live targets).
   The server `instructions` tell agents to read it, and to use
   tools_chain/code_run to save context.

## 5. Remaining work (suggestions, in order; none started)

1. **Trigger panel in the UI.** Today only agents can see, pause or delete
   triggers. A person needs a list showing name, schedule
   (`describeSchedule` in `src/triggers.ts`), last run and last error, with
   pause/delete, reachable by Ctrl+K. **Ask the owner how it should look and
   where it lives before building** (design decision). Custom controls only.
   Done when a person can pause and delete a trigger without an agent, with a
   Playwright test.
2. **Event triggers**: "when a file changes" and "when a terminal prints X".
   Needs watchers in the local server (`server/files.ts` /
   `server/terminal.ts`) that notify the editing window, plus new `schedule`
   kinds in `src/triggers.ts`, `src/validation.ts` and the `trigger_set`
   schema. Ask the owner which events matter first. Done when tests prove a
   file write fires the workflow once.
3. **Custom tools UI / visibility**: optional list of saved `custom_*` tools
   in the app. Ask first.
4. **Retry the owner's real setup** once the machine runs this code: restart,
   then from Claude Code call `workspace_status`, `automation_catalog` and a
   `code_run` that returns `typeof process` (expect `"undefined"`).
5. Look at the pre-existing failing specs (section 3) only if the owner asks.

## 6. Run, test, restart

```powershell
pnpm install --ignore-scripts
pnpm rebuild node-pty
node node_modules/electron/install.js
```
pnpm 9.6.0 ignores `allowBuilds`, so a plain `pnpm install` leaves native
modules unbuilt (this caused the "marked" resolve failure earlier).

```powershell
pnpm type-check
pnpm exec playwright test tests/mcp.spec.ts --workers=1
pnpm exec playwright test tests/triggers.spec.ts --workers=1
pnpm exec playwright test tests/triggers-tray.spec.ts --workers=1
pnpm exec tsx scripts/demo-mcp-compose.ts
```

- Run Electron specs one at a time. Tests use temp data dirs; never point
  them at the real `.orvane/`.
- **Restart needed to see changes:** Orvane (it builds and serves at startup).
  Fully quit Claude Desktop from the tray and reopen it. Start new Claude Code
  sessions. Restart Codex. Each client starts its own `server/launch.mjs`
  process.

### MCP client registration (on this Windows machine; redo on a new one)

All three use stdio: `node <repo>\server\launch.mjs` with env
`ORVANE_DATA_DIR=<repo>\.orvane`.

- Claude Code: `mcpServers.orvane` in `C:\Users\<user>\.claude.json`.
- Claude Desktop (MSIX build): `claude_desktop_config.json` in
  `%LOCALAPPDATA%\Claude-Data\claude_<id>\`. **Not** `%APPDATA%\Claude`, and
  not `Packages\...\LocalCache`. Find the real folder from the running
  Claude.exe process before editing.
- Codex: `[mcp_servers.orvane]` in `~/.codex/config.toml`.

Paths differ on another machine. Check where each client actually reads its
config, then verify with a real tool call before saying it's connected.

## 7. Key files

- `server/index.ts`: MCP server; registers everything; registry and new tools.
- `server/tool-registry.ts`: in-process tool calls for chains, code and custom tools.
- `server/chain.ts`: `tools_chain`.
- `server/code-runner.ts`, `server/code-sandbox.mjs`: `code_run` sandbox (parent / child).
- `server/custom-tools.ts`: saved `custom_<name>` tools, shared through SQLite.
- `server/automation-catalog.ts`: what agents read before building automations.
- `server/bridge.ts`, `server/discovery.ts`, `src/mcpBridge.ts`: multi-client WebSocket bridge to the window.
- `src/automation.ts`: operation schemas, descriptions, `applyCommands`, `runSchema`.
- `src/App.vue`: `executeMcp`, `runForMcp`, `saveLayoutForMcp`, `checkTriggers`/`runTrigger`.
- `src/triggers.ts`: trigger types and due-time logic.
- `src/validation.ts`, `src/model.ts`: workspace schema, including `triggers`.
- `docs/MCP-EXTENSIONS.md`: tool table and design notes.
- `tests/mcp.spec.ts`, `tests/triggers.spec.ts`, `tests/triggers-tray.spec.ts`: coverage.
- `scripts/demo-mcp-workflows.ts`, `scripts/demo-mcp-compose.ts`: recorded demos.
