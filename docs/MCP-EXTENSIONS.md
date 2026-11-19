# MCP domain extensions

Goal: an AI agent connected to Orvane (Claude Desktop, Claude Code, Codex) can
build automations, not only apps. It should be able to create workflows, add
nodes to them, wire them to buttons and run them, with the same validation,
snapshots and revision checks as every other MCP edit. It should also be able
to do multi-step work inside Orvane without copying bulky in-between data
through its own context.

## What existed before

- `rules_set`: replace one component's rules and graph (what a button does).
- `action_list / action_set / action_delete`: the **reusable code/flow nodes**
  (`workspace.customNodes`), used by rules with `action: "custom"`.
- Workspace edits go through `applyCommands` (`src/automation.ts`), live in the
  editing window or offline in SQLite.

## Tools

| # | Tool | Kind | What it does | Status |
|---|------|------|--------------|--------|
| 1 | `automation_catalog` | read | Every node kind with its fields, rules for values (`{field}`, `{input}`), graph format and a worked example; plus the live targets (exposed apps, their components, workflows, reusable nodes). | Built |
| 2 | `workflow_list` | read | Action-library workflows with inputs, steps and graph. | Built |
| 3 | `workflow_set` | write | Create or replace a workflow. Give `steps` as a simple ordered list and the graph (trigger → step 1 → step 2 …) and node positions are generated; or give `rules` + `graph` for branching and failure paths. | Built |
| 4 | `workflow_delete` | write | Delete a workflow; refuses while buttons or wheel entries use it unless `disconnectReferences` is set. | Built |
| 5 | `workflow_run` | live | Run a workflow in the editing window with input values; returns its final value, any message it showed, or the error. | Built |
| 6 | `component_trigger` | live | Press a button, submit a field (optionally typing a value first) or toggle a checkbox, exactly as a person would; returns the result or error. | Built |
| 7 | `wheel_list` / `wheel_set` | read / write | Read or replace the radial wheel: groups, apps and workflows (with input values). Checks targets, parents and the 8-per-ring limit. | Built |
| 8 | `automation_runs` | live | Connection activity (who ran what, when, errors), including failed agent runs, plus apps showing an action error. | Built |
| 9 | `board_get` / `board_note_set` / `board_arrow_set` / `board_delete` | read / write | Sticky notes (text, color, file/folder/page link) and arrows attached to apps, notes or points on the canvas whiteboard. Deleting a note deletes its arrows, as on the canvas. | Built |
| 10 | `layout_list` / `layout_delete` / `layout_save` / `layout_apply` | read / write / live | List and delete named layouts; save the current arrangement or arrange given apps then save (framing them); switch to a layout. | Built |
| 11 | `tools_chain` | compose | Run Orvane tools in order inside Orvane. Later args use `{{step.path}}` / `{{input.x}}`; only the final value (or a `return` template) comes back. | Built |
| 12 | `code_run` | compose | JavaScript that calls Orvane tools (`await tools.app_list({})`) to loop, filter and join data inside Orvane; only the return value and `console.log` lines come back. | Built |
| 13 | `custom_tool_save` / `custom_tool_list` / `custom_tool_delete` / `custom_tool_run` | compose | Save a chain or code under a name with typed params. It appears to every connected agent as its own tool `custom_<name>`. | Built |
| 14 | `trigger_list` / `trigger_set` / `trigger_delete` / `trigger_run` | write / live | Scheduled triggers: run a workflow with set inputs every N minutes or daily at HH:MM (optionally on chosen weekdays). Owner decision: they keep running while Orvane sits in the tray. | Built |
| 15 | Event triggers | write | "When a file changes", "when a terminal prints X": need watchers in the local server that tell the editing window. | Next |

## Keeping data out of the agent's context

Based on Anthropic's "Code execution with MCP" and Cloudflare's "Code Mode":
agents are better at writing code that calls tools than at relaying large
tool results through their context, and intermediate results can stay where
the work happens.

- `server/tool-registry.ts` wraps `McpServer.registerTool`, so every Orvane
  tool (workspace, Git, Notes, Projects, NetSuite, UI Maker…) can be called
  in-process with the same argument validation as an MCP call.
- `tools_chain` (`server/chain.ts`) is for straight pipelines with no logic.
- `code_run` (`server/code-runner.ts`, `server/code-sandbox.mjs`) is for loops,
  filters and joins. It runs in a separate Node process started with
  `--permission` (no file writes, no reads beyond the sandbox file, no child
  processes or workers), inside a `vm` context that only has `tools`, `input`
  and `console`. Values cross as JSON strings so no host object is reachable;
  `eval`/`new Function` are disabled. Limits: 60 s default (max 300), 500
  tool calls, 60,000-character result, 8,000 characters of logs.
  Not a hard security boundary against hostile code (Node's permission model
  does not restrict the network in Node 24); it keeps an agent's own code to
  Orvane tools.
- Custom tools live in the workspace SQLite (`app_data` key `mcp:tools`), so
  every MCP process (Claude Desktop, Claude Code, Codex) shares them; each
  process picks up changes within 3 seconds and tells its client the tool list
  changed. `custom_tool_run` works for clients that don't refresh tool lists.
- Nesting (code → custom tool → chain …) is limited to 4 levels; `code_run`
  cannot start another `code_run`.

## Scheduled triggers

- Stored in the workspace (`workspace.triggers`), so they are in backups and
  snapshots. Merging a backup does not bring its triggers along (nothing
  imported starts running by itself); replacing does.
- Checked every 15 s by the editing window together with calendar reminders
  (`src/triggers.ts`, `checkTriggers` in `src/App.vue`), so each runs once per
  workspace. Closing the window hides it to the tray and checks continue;
  Chromium throttles hidden pages, so a run can be up to about a minute late.
- Interval runs keep their cadence from creation (or the last run). A run
  missed while Orvane was closed runs once if it was due within the last day;
  older ones are skipped, like reminders.
- Failures are kept as `lastError` and shown in Connection activity
  ("Trigger: name"); `automation_runs` and `trigger_list` return them.
- Deleting a workflow that triggers use needs `disconnectReferences`, which
  deletes those triggers too.
- There is no on-canvas UI for triggers yet; agents manage them over MCP.

## Safety

- Writes reuse `applyCommands`: whole-workspace validation, reference checks,
  one recovery snapshot per call, `expectedRevision`.
- Runs only happen in the live editing window, never offline, and report
  failures instead of retrying. Existing guards (recursion depth, overlapping
  runs, exposed-interface rules for cross-app writes) apply unchanged.
- Chains and code stop at the first failure; calls that already completed
  stay applied (each one is snapshotted like any other MCP write).
