# Round 3: ideas from the Web design board

Source: the owner's Pinterest board *Web design* (pinterest.com/articempire/web-design/), read on 2026-11-22. The board now has 1,018 pins; I read the 965 that the board feed returns.

- Only 5 pins are new since the last pass ([BOARD_IDEAS.md](BOARD_IDEAS.md), 2026-11-21). The rest of the newest pins were already used.
- So most of this round comes from pins the earlier rounds passed over (positions 1–260 on the board): AI composers, a text toolbar with an AI action, a reminders list, time rails and task details.
- Pins after position ~260 are posters, logos and landing pages. Nothing there fits Orvane.

Same rules as before: Orvane's light look, Inter, compact 12–14px controls, small local motion, everything on the keyboard. The board's interaction ideas are kept; its dark theme and glow are not.

The mockups are in two UI Maker Lab rounds:

- **r6 "Board ideas 2: agent sessions"** on the `agent-sessions` component (ideas 1–3);
- **r2 "Board ideas 2: workspace"** on the `orvane-board-ideas` component (ideas 4–6).

Ideas 1–3 are implemented on `feat/next`. The source pins were proposed on `agent-sessions`.

Ideas 4 and 5 are implemented on `feat/next`. Idea 6 remains a UI Maker prototype. All three Lab variants on `orvane-board-ideas` have an About explanation and accepted source references (review `2c807d3c-479b-4682-9124-c917ab8ea7ca`).

## Agent sessions

### 1. Context ring on the send button (Lab: *Context ring*)

- **Pin:** 688980443038246589, a round send button wrapped in a thin progress ring.
- **What:** a thin ring around the send button fills as the session's context window fills, with the percentage beside it.
  - Hovering it, or pressing a key, opens a small popover: "128k of 200k", a stacked bar (conversation, files read, system and tools), and a mark where auto-compact happens.
  - The popover has two buttons: **/compact now** and **Fork fresh**.
- **Why:** you can see when a long session is about to compact or lose detail, before it happens, without asking the CLI.
- **Build:**
  - Orvane doesn't record token usage yet.
    - Claude Code's stream-json `result` and `assistant` events carry `usage` (input, cache-read and output tokens).
    - Codex sends `token_count` events.
  - Read them in `server/agent-runner.ts` and store the last value per run next to the step details (`server/step-details.ts`).
  - The window size per model is a small table.
  - UI: in the composer bar of `src/components/AgentSessions.vue`, next to the effort pill (`ComposerModes.vue`).
  - `/compact` already reaches the CLI as a message. "Fork fresh" reuses the fork that `MessageActions.vue` already does.
- **Implemented:** the ring shows cached input, input added on the latest request, and the latest reply. Claude updates during a run and can report its window size in the final result. The window is marked approximate when inferred. Codex updates from the transcript after each turn. The two context actions are Claude-only. The CLIs do not report the auto-compact threshold in this view.

### 2. Queued follow-ups (Lab: *Queued follow-up*)

- **Pin:** 688980443038246901, a "follow-up block" linked by a curved line to the block before it.
- **What:** while a run works, Enter no longer waits. It queues the message under the run in a dashed **Then** block, linked to the running step.
  - Queued messages are numbered.
  - Each one has Edit, Send now and Remove.
  - Alt+↑ edits the queue.
  - When the run ends, the queue is sent in order.
  - Ctrl+Enter interrupts the run and sends at once.
- **Why:** today the composer is locked while a run is busy, so the next instruction has to wait in your head. This is the "type ahead" the CLIs have.
- **Build:**
  - `send()` in `src/components/AgentSessions.vue` returns early while `busy`. Push the draft to a per-session queue instead, and drain it in `watchRun` when the run reaches `completed`. Stop on `failed` and leave the queue in place.
  - Keep the queue in the session state in `src/agentSessions.ts`, so it survives switching sessions.
  - The running step reuses the DNA loader and the shimmering step from `AgentRunActivity.vue`.
- **Implemented:** the local runner owns the queue and resumes the same session in order. A failed or manually stopped run keeps its queue for Edit, Send now or Remove.

### 3. Scheduled prompts (Lab: *Scheduled prompts*)

- **Pins:**
  - 688980443038314099, a Raycast reminders list ("Filter by title, notes or priority", grouped Overdue / Today / Upcoming);
  - 688980443037772268, automations ("Send a summary to email") laid on a date rail.
- **What:** a **Scheduled** view in the Agent sessions sidebar: agent prompts that run on a schedule.
  - Each prompt has a folder, a provider and model, an edit mode and an optional skill (`/feature-scout`, `/scoped-fix`).
  - Prompts are grouped as Failed / Today / Upcoming, with a filter field at the top.
  - The selected row expands to show:
    - the full prompt;
    - the schedule and model;
    - the last result, linked to the session it made;
    - **Run now** (Enter), **Edit** (E) and **Pause** (P).
  - N creates a new one.
- **Why:** recurring checks such as a morning repo check, SuiteQL health or new pins on the board would run by themselves and leave a session to read, instead of you starting them every time.
- **Build:**
  - `src/triggers.ts` already has interval and daily schedules, missed-run handling and `lastRun` / `lastError`. Today a trigger can only start an Action-library workflow (`workflowId`).
  - Add a prompt target to triggers: provider, folder, model, effort, mode and prompt. When it fires, it calls the same `start` op as the composer (`server/agent-sessions-api.ts`).
  - Store the resulting session id on the trigger so "open session" works.
  - `TriggerList.vue` and the day rail from round 2 can show these too.
- **Implemented:** prompt schedules live in the workspace database and share the timing rules in `src/triggers.ts`. The local server checks them while Orvane is open, including in the tray. Each run starts its own session and links back from Scheduled.

## Orvane itself

### 4. Rewrite selected text in Notes (Lab: *Notes rewrite*)

- **Pin:** 688980443038284912, a text toolbar with an **Expand ⌘/** action next to the formatting buttons.
- **What:** the Notes floating toolbar gets a second group: **Shorten**, **Expand**, **Fix** and **Ask…**, with Ctrl+/ for the last one used.
  - The answer appears as a green suggestion card under the selection, with the word count ("53 → 29 words") and which model wrote it.
  - **Tab** replaces the text, **Esc** keeps yours and **R** tries again.
  - A small field at the bottom takes a follow-up ("Make it a numbered step…").
- **Why:** quick edits to notes without copying text into an agent session and back.
- **Build:**
  - The toolbar is `src/components/notes/components/FloatingToolbar.vue`. Today it has bold, italic, underline, strike, code, highlight and link.
  - Running the edit: a one-shot, read-only agent run through `server/agent-runner.ts` (Claude Haiku or a small Codex model, plan-only, no tools). The prompt holds the selection and one line of instruction.
  - The suggestion card is a transient block in `BlockEditor.vue`. Accepting it replaces the selected text as one undo step.
  - Shortcuts stay inside the editor and defer to IME composition.
- **Implemented:** the toolbar and Ctrl+/ use a single-block selection. The green card supports follow-ups, retry, and Tab to apply. Claude Code Haiku receives the selected wording and rewrite instruction with tools and session persistence disabled. Applying the replacement is one Notes undo step.

### 5. Canvas rewind (Lab: *Canvas rewind*)

- **Pins:**
  - 688980443021846560, a schedule with a **LIVE** line across a time rail;
  - 688980443037772268, a date rail with a marker.
- **What:** a frost-glass bar at the bottom of the canvas with today's changes on a time rail.
  - Each change is a dot, coloured by who made it: you, an AI through MCP, or a close or delete.
  - Dragging the playhead, or using ← / →, shows the canvas as it was at that moment:
    - apps that were open then come back with a dashed outline;
    - apps added later fade.
  - **Restore canvas** (Enter) brings that state back. **Restore one app** (A) brings back only the selected app. **Esc** returns to live.
- **Why:** "what did my canvas look like before the AI moved things" or "bring back the Browser I closed at noon", without digging into backups.
- **Build:**
  - Canvas undo in `src/App.vue` already records settled states, but only 100 of them, in memory and untimed.
  - `server/database.ts` keeps only the last 5 `snapshots`, each with a `reason`.
  - Needed:
    - a timed history table (state diff, time, author: user or MCP, reason) with a cap per day;
    - `workspace_batch` writes, tagged with their author.
  - Restoring uses the same path as `workspace_recovery`.
  - The preview renders apps as light placeholders, not live webviews, so scrubbing stays cheap on the Iris Xe.
- **Implemented:** open Canvas rewind from Workspace options or Ctrl+K. It keeps up to 160 saved window arrangements from the last seven days. Results are recorded from saved canvas changes, including MCP edits. Restore one app or restore the arrangement. A full restore archives apps added later and preserves current app contents, whiteboard items and saved layouts.

### 6. App details drawer (Lab: *App details*)

- **Pins:**
  - 688980443038314073, a task with properties, resources and an activity list;
  - 688980443012828073, comments and file details side panels.
- **What:** Ctrl+I, or an ⓘ button in any app's header, opens a details drawer on the right side of that app. It has:
  - **This app:** name, kind, group, the layouts it belongs to, and when and how it was created;
  - **Linked:** the site memory, triggers and folders tied to it;
  - **a pinned note** of your own, such as "Sandbox refreshed 15 Nov…";
  - **Activity:** who touched it today, including which AI did what through MCP ("Claude saved the route…", "Codex opened a tab…").

  N adds a note.
- **Why:** with Claude and Codex both working on the canvas, you can see what happened to an app, and keep small facts with the app they belong to.
- **Build:**
  - Properties come from the workspace model (`src/model.ts`, `src/groups.ts`, layouts).
  - Linked items:
    - site memory via `server/site-memory.ts`, by host;
    - triggers by `workflowId` or a prompt target;
    - folders from File Explorer and Terminal apps.
  - Activity needs the same author-tagged change log as idea 5. MCP writes already pass through the tool registry and the editing bridge (`server/tool-registry.ts`, `server/bridge.ts`), where the tool name and the client can be recorded.
  - Notes are a small field on the app, so backups cover them.
- **Lab prototype:** the browser mock has an Orvane window header with a Details button. Toggle it to see the drawer beside the site, and try editing the pinned note. The About text explains the per-window scope, links, and how to read the activity example.

## Other pins worth a later look

| Pin | Idea | Note |
| --- | --- | --- |
| 688980443038314096 | "Coming soon" roadmap sheet with In progress / Planned | Could show a Git folder's branches and recent commits as plain release notes |
| 688980443012852793 | Insert menu whose items you drag into place (Table, Divider, Image) | Notes' slash menu could let you drag a block type to a position |
| 688980443038246612 | Compact card with a collapsible "Details" list | Collapsed summary for a long tool output in Agent sessions |
| 688980443038337293 | "Templates (103)" with category chips and search | Library filter chips, if the library grows |
| 688980443021846559 | Timeline with an inline "New task" popover | Click on a day rail to add a trigger at that time |

Left out on purpose:

- the glassmorphism template (688980443038485459), the trading and finance pages and the community app: no Orvane use;
- the "Personalizing your demo" onboarding (688980443038314089): it's a wizard;
- the posters, logos and landing pages after position ~260;
- a status board for agent sessions (688980443038314069, "Discharge Planner"): the session list already groups "Needs attention" first.
