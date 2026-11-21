# Orvane Agent Sessions redesign handoff

## Request

Redesign the existing **Agent Sessions** app in **UI Maker** so it feels like the approved AI launcher. The owner wants to compare, review, and refine the design before it goes into the running app. Start with an interactive mockup that shows the whole session experience.

## Where work stopped

The checkout is `feat/next` in `C:/Users/Moon/Documents/CodingProjects/DesktopApps/orvane`. It contains uncommitted work from earlier Orvane tasks. Read `AGENTS.md` and preserve those changes. The workspace was connected and UI Maker was available. No Agent Sessions redesign component, Lab round, or mockup has been created. The existing `ai-prompt-glass` component is the launcher reference and has a saved **v6**.

## Style references

- **Live launcher** — `src/components/AgentLauncher.vue`. Use its Orbit icon, compact controls, integrated prompt surface, inline context, quiet focus border, and small slide-and-fade motion. The owner selected Orbit after comparing five icons.
- **Shared glass** — `src/style.css`, `.workspace-frost` and `.agent-composer`. The top banner and launcher share an 8% cool-white tint, 8 px backdrop blur, and 120% saturation. Keep the prompt surface transparent enough to show the backdrop. Test against visible canvas content. The banner’s fade mask is specific to its edge treatment.
- **Visual proof** — `C:/Users/Moon/.codex/visualizations/2026/11/21/01a1fe0a-9086-7a92-871a-350e36b414d3/orvane-banner-glass-preview.png`. This shows the approved treatment over canvas content. The screenshot predates the Orbit icon choice. Attach the image to the redesign’s component-wide visual reference board with a caption explaining which visual details to carry over.
- **UI Maker launcher reference** — `.orvane/uimaker/components/ai-prompt-glass/v6/index.html`. Use this for the integrated composer, context placement, and keyboard behavior. Use the live CSS and Orbit choice for the latest visual details.

## Workflows to keep visible in the design

- **Session discovery** — Search and select existing Claude Code and Codex sessions. Show the provider, title, working folder, and what needs attention. Keep the existing new-session and resume entry points.
- **Conversation** — Give the transcript enough width and keep the composer easy to find. Preserve Markdown, earlier messages, session visuals, and the option to expand a visual. Keep the current send, stop, multiline input, and focus behavior legible.
- **Run activity** — Include a state where MCP and other tool calls appear while the run is active, with progress and outcomes. Use representative labels such as `orvane / workspace_status`, `Thinking` for Claude, and `Reasoning summary` for provider-emitted Codex summaries. Keep activity readable after the answer.
- **Permissions** — Show a Claude permission request with its tool name, a readable details preview, and clear **Allow once** and **Deny** actions. Make it easy to tell when the agent is waiting for input.
- **Narrow window** — Make sessions and chat reachable at small app widths. Check that long paths, tool names, and Markdown do not push the composer or permission actions offscreen.

The live implementation to inspect is `src/components/ClaudeSessions.vue`, with `src/components/AgentRunActivity.vue` for the activity feed. `src/agentSessions.ts` defines the relevant run states. `tests/agent-sessions.spec.ts` documents normal launcher, resume, streaming, approval, and stop workflows.

## UI Maker delivery

1. Use Orvane MCP. Call `workspace_status`, then `uimaker_list` to confirm the live state. The owner asked to avoid desktop computer use. If a needed editor operation is unavailable, add or use a focused MCP operation. For component creation, inspect `server/uimaker-api.ts` and `server/uimaker.ts` to reuse the existing creation flow and preserve live editor state.
2. Create a separate **Agent Sessions** design component. Start a Lab round with `uimaker_lab_round`. Use representative sample sessions and tool data, with interactive controls that demonstrate the workflow without making real agent calls.
3. Compare two layouts using the same glass and typography. One useful pairing is **Conversation** with inline activity and **Activity pane** with a compact side pane on wide windows. Let the two alternatives differ in attention and layout while preserving the same controls. Write the first with `uimaker_lab_write`, then fork it with exact edits for the second where practical.
4. Render both with `uimaker_lab_view`. Check a normal and a narrow width, an active run, a permission request, and an open menu. Check the frost with visible material behind it. Follow `AGENTS.md` for custom controls, keyboard access, outside dismissal, and reduced motion.
5. Save a review iteration with `uimaker_deliver` and verify it with `uimaker_render` so Review and Inspect have a real artboard. Tell the owner which layout the review copy shows and where to find both Lab options. Keep the selection open for their decision. The requested delivery is the UI Maker design and review copy.
