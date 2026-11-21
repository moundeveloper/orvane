# Component ideas from the Web design board

Source: the owner's Pinterest board *Web design* (pinterest.com/articempire/web-design/). I went through the 605 most recent pins, as of 2026-11-21.

The newest pins are mostly dark-themed AI agent interfaces: command menus, agent composers, "thinking" states, node workflows, effort sliders and timelines. Older pins move toward HUD and sci-fi interfaces, then posters and landing pages.

The ideas below carry over what those pins do well into Orvane's own look, keeping the board's interaction ideas but not its dark theme or glow:

- light theme;
- Inter;
- compact 12–14px controls;
- small, local motion;
- every action reachable from the keyboard.

Each idea has a mockup in UI Maker. They are in Lab round **r5 "Board ideas: agent sessions"** on the `agent-sessions` component. The source pins are proposed as references on the same component; nothing is attached until you approve them.

Nothing here is built. Pick the ones you want.

## Agent sessions

### 1. Thinking trail (Lab: *Thinking trail*)

- **Pin:** 688980443038284927, "Thinking… / Consulting the pricing policy… / Waiting the agent to write response".
- **What:** while a run works, the chat shows a short vertical trail of what the agent is doing:
  - a headline per step;
  - one muted line of detail;
  - the files it touched, as chips you can click.

  The current step shimmers. Finished steps settle to a filled dot. A small orb replaces the bare "Working" line.
- **Why:** Run activity lists tool names. This reads like a story ("Read the session header → Found how Ctrl+K opens folders → Checking…"), so you can follow a run without opening anything.
- **Build:**
  - The runner already sends activities, and now their inputs and outputs too.
  - The headline needs a summary per step: Codex sends reasoning summaries; for Claude, use the tool's `description` input (Bash and Task have one) or the label.
  - The file chips reuse the new `md-path` links.

### 2. Effort and edit mode in the composer (Lab: *Effort and mode*)

- **Pin:** 688980443038246585, "Effort High — Faster ↔ Smarter, Recommended".
- **What:** two pills next to the model picker.
  - **Effort** opens a 4-step slider: Low, Medium, High, Max. It has a "Recommended" line and moves with Ctrl+←/→.
  - **Edits** cycles Ask first / Auto-accept / Plan only with Shift+Tab, like the CLIs do.
- **Build:**
  - Codex takes `-c model_reasoning_effort=…` and sandbox/approval flags. Claude Code takes `--permission-mode`. Check how the installed Claude CLI sets effort (flag or settings) before building it. `server/agent-runner.ts` already builds these command lines.
  - Store the choice per session. Use `CustomSelect`-style popover rules (dismiss on outside pointerdown).

### 3. Slash skills and saved prompts (Lab: *Slash skills*)

- **Pins:**
  - 688980443038314066, a "Search actions…" menu with shortcuts;
  - 688980443038284929, a "/future-self /performance-review /Research + New Skill" row.
- **What:** typing `/` at the start of the composer opens a menu of:
  - skills from the skills folder;
  - session commands (`/compact`);
  - your saved prompts.

  Tab inserts. A row of recent skills sits under the composer, with **+ Save prompt**.
- **Build:**
  - Same mechanics as the new `@` picker (`ContextPicker.vue`): caret token, arrow keys, Tab.
  - Skills come from `~/.claude/skills/*/SKILL.md` front matter (name, description).
  - Saved prompts can live in Orvane's SQLite, next to `workspace_memory` procedures, so Claude and Codex both see them.

### 4. Files changed card (Lab: *Files changed*)

- **Pin:** 688980443038284922, an activity feed with an inline Reply.
- **What:** after a run, one card lists the files it created, modified or deleted:
  - A / M / D badges, +/− counts and a small change bar;
  - a row opens a diff in place;
  - an **Ask about this change** field sends a follow-up that already points at that file;
  - **Open folder** (File Explorer) and **Open in Git** (Git viewer) at the top.
- **Build:**
  - Edit and Write inputs are now recorded per step.
  - For whole-run accuracy, snapshot `git status --porcelain` before and after the run in the session folder, using the existing `git-status` file operation.
  - Reuses the Run activity diff styles.

### 5. Message actions menu (Lab: *Message actions*)

- **Pin:** 688980443038314066, Comment / Ask AI / Delete / Duplicate / Copy link, with shortcuts and a "Last edited by…" footer.
- **What:** hovering a message shows Copy, Fork, and a "…" button. The button opens a searchable action menu:
  - Copy as Markdown;
  - Fork session from here;
  - Retry from this message;
  - Send to Notes;
  - Save as prompt;
  - Pin.

  The footer shows provider, model, time and tokens.
- **Build:**
  - Fork needs `claude --resume <id> --fork-session` or Codex's equivalent (verify against the installed CLIs).
  - Send to Notes uses the Notes API that Ctrl+K already reads.
  - Keep every action in Ctrl+K too.

### 6. Session timeline (Lab: *Session timeline*)

- **Pin:** 688980443029594431, a day timeline with a time rail and coloured event dots.
- **What:** a compact overview of one session, with a filter for All / Files / Approvals:
  - what you asked;
  - what it researched;
  - which approvals you gave;
  - which files it created;
  - what failed;
  - when it answered.

  It could replace the "…" menu's session details, or open from the header.
- **Build:**
  - Built from the transcript plus the saved run logs (`agent-runs/*.json`, which now include step input, output and timing).

## Orvane itself

### 7. Workflow step library (Lab: *Workflow library*)

- **Pin:** 688980443038337290, an Alfred-style workflow canvas with a library of Favourites / Triggers / Inputs, each with stars and descriptions.
- **What:** a right-hand library for Orvane workflows and triggers:
  - searchable (press `/`), grouped as Favourites, Triggers, Actions and Custom tools;
  - you drag a step onto the board, or press Enter to add it after the selected step;
  - "Run agent" makes agents a first-class step.
- **Build:**
  - `automation_catalog` already lists the steps; custom tools come from `custom_tool_list`.
  - Favourites can be saved per workspace.

## Other pins worth a later look

| Pin | Idea | Note |
| --- | --- | --- |
| 688980443038246608 | "Thinking…" orb inside the composer | Small enough to try as the empty-reply state |
| 688980443038247669 | Composer with stacked source icons "+2" | Context chips could collapse into one stack when there are many |
| 688980443038246638 | Three segmented-tab styles | Session list filter: All / Claude / Codex / Running |
| 688980443038314068 | Sidebar "New task ⌘N" with a corner-bracket focus | A distinctive keyboard-focus style for primary actions |
| 688980443038300538 | Preferences sheet with theme cards and toggles | Orvane's light-only rule makes most of it moot; the row layout is good |

Left out on purpose:

- dashboards and KPI overviews (e.g. "AI Overview by Acme AI");
- glow and liquid-metal borders;
- sci-fi HUD styling.

All three go against DESIGN.md (no dashboards, light theme, small motion).
