# MCP domain extensions

Goal: an AI agent connected to Orvane (Claude Desktop, Claude Code, Codex) can
build automations, not only apps. It should be able to create workflows, add
nodes to them, wire them to buttons and run them, with the same validation,
snapshots and revision checks as every other MCP edit.

## What exists today

- `rules_set`: replace one component's rules and graph (what a button does).
- `action_list / action_set / action_delete`: the **reusable code/flow nodes**
  (`workspace.customNodes`), used by rules with `action: "custom"`.
- Workspace edits go through `applyCommands` (`src/automation.ts`), live in the
  editing window or offline in SQLite.

## Gaps

1. The **Action library** (`workspace.actions`: named workflows with inputs and
   a node graph, shown under Workspace → Action library and on the wheel) has
   no MCP tools at all.
2. Nothing can **run** anything: an agent can build a button but can't press it
   or run a workflow to check that it works.
3. An agent has to guess the node format (`Rule` fields per kind, graph edges,
   `trigger`, success/failure edges).
4. The radial wheel, layouts, the whiteboard and run history aren't reachable.

## Planned tools

| # | Tool | Kind | What it does | Status |
|---|------|------|--------------|--------|
| 1 | `automation_catalog` | read | Every node kind with its fields, rules for values (`{field}`, `{input}`), graph format and a worked example; plus the live targets (exposed apps, their components, workflows, reusable nodes). | Built |
| 2 | `workflow_list` | read | Action-library workflows with inputs, steps and graph. | Built |
| 3 | `workflow_set` | write | Create or replace a workflow. Give `steps` as a simple ordered list and the graph (trigger → step 1 → step 2 …) and node positions are generated; or give `rules` + `graph` for branching and failure paths. | Built |
| 4 | `workflow_delete` | write | Delete a workflow; refuses while buttons or wheel entries use it unless `disconnectReferences` is set. | Built |
| 5 | `workflow_run` | live | Run a workflow in the editing window with input values; returns its final value, any message it showed, or the error. | Built |
| 6 | `component_trigger` | live | Press a button, submit a field (optionally typing a value first) or toggle a checkbox, exactly as a person would; returns the result or error. | Built |
| 7 | `wheel_set` | write | Pin workflows and apps to the radial wheel, in groups. | Next |
| 8 | `automation_runs` | read | Recent runs and failures (the window's connection activity). | Next |
| 9 | `board_*` | write | Sticky notes, arrows and links on the whiteboard (plans the agent draws next to the apps). | Later |
| 10 | `layout_*` | write | Save, switch and arrange named layouts. | Later |
| 11 | Scheduled and event triggers | product | "Every N minutes", "at 9:00", "when a file changes", "when a terminal prints X". Needs a decision on where triggers run while Orvane is hidden. | Needs owner decision |

## Safety

- Writes reuse `applyCommands`: whole-workspace validation, reference checks,
  one recovery snapshot per call, `expectedRevision`.
- Runs only happen in the live editing window, never offline, and report
  failures instead of retrying. Existing guards (recursion depth, overlapping
  runs, exposed-interface rules for cross-app writes) apply unchanged.
