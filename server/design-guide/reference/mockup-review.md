# Mockup review

## What worked in Claude’s Orvane mocks

- **Agent session workspace, r2 to r4.** Codex’s Side by Side showed a realistic chat and useful delegation context. The essential change was missing from the first frame: opening, moving, and closing a tile. Claude’s first revision changed the divider and the owner rejected it. Claude then read Terminal’s split code and Hyprland’s configuration. The picked Hyprland tiles variant made the gap the resize target, moved panes together, and kept each chat mounted so the same draft and transcript survived reflow. The steel-blue focus edge told you which chat would receive keyboard input.
- **Board ideas, Thinking trail.** The local Claude session records scanning the board and reviewing contact sheets before making variants. The mock turned a real File Explorer problem into a readable sequence, with code locations on the relevant steps and a visible current step. The original orb and the line “Then it writes the answer” drew owner corrections. Reuse the established DNA loader and give each line a job.
- **Continue with another model.** The recorded pick gives the reason to prototype beyond the model picker. Claude’s chosen round showed where the draft opens, what it carries, and how to return to the source. The two-way links and transcript context made the relationship visible in both sessions. This comparison comes from the owner’s recorded feedback in [taste-log.md](taste-log.md).

The evidence comes from Lab artifacts and the visible messages and tool activity in the local Claude sessions for Tiled reflow and Board ideas. It describes the workflow Claude demonstrated.

## Applied to the Orvane Host mock

**Before.** Orvane Host r1, Laptop workspace, began on a session already working. The approval example lived in a different session. The design used a separate toolbar and compact web chat conventions.

**Remake.** Orvane Host r2, Laptop sessions, opens at the laptop’s pending decision. The same state shows up beside the session title in the list and in the transcript. The card gives the file and exact change. Allow once leaves a receipt and runs the check. Deny shows the result in the same transcript. Returning to a different session restores its draft. The desktop Agent Sessions screenshot was the visual baseline. The approved DNA example supplies the active indicator.

**Build.** Reuse the hosted entry in `src/host/agents.ts`, which mounts the desktop’s `AgentSessions.vue`. The Lab uses sample data. A real run uses the existing Host permission and run state through `server/orvane-host-agents.ts` and follows the desktop’s edit defaults and Host approval settings.

## Second remake of Side by Side

The first Host remake made the approval easier to see. It left the larger design question open: can the interaction preserve something the user would otherwise have to reconstruct?

In Agent session workspace r2, both panes repeated the same returned summary. “Use in parent” pasted it into the parent’s text field. Claude’s chosen mocks suggest a stronger division of work. A compact summary belongs where the user decides. The evidence belongs with the conversation that produced it. The reference joins those surfaces after the handoff.

**Review in context** uses the original split-layout task. Claude’s pane gives the decision in one sentence. Codex’s pane gives the supporting evidence, including the two lines in `terminalLayout.ts` that let the remaining sibling fill the gap. Use recommendation adds a removable source chip and focuses the existing draft. Closing the review preserves the parent’s text. The chip opens the same review from either the draft or the sent turn. On a narrow screen, the review takes the space of the chat and returns to the draft after attaching.

**Build.** Keep the existing split workspace and session draft state. Start from Agent Sessions’ `AgentQuote` and session-origin handling. Connect the delegation result to its source turn and persist the reference with the sent message so it can be reopened later. Lab demonstrates the flow with sample messages.
