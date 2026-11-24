# Continue a real session

## Brief for Claude

Design a fresh interactive UI Maker Lab mock for **Continue with another model** in Orvane. The owner wants to review the mock before implementation. Start with the actual Agent Sessions interface, read `AGENTS.md` and `server/design-guide/SKILL.md`, and use the established chat, model picker, composer, and split-pane components as references.

## The two entry points

| Start from | Where the new session opens |
| --- | --- |
| Pinned side chat | The pinned panel takes the user straight to the new session and focuses its composer. The source stays available through the session reference and the session list. |
| Agent Sessions app | The source stays open. The new session opens side by side in the same app, and its composer takes focus. Use the existing split pane layout. |

These are two contexts for the same feature. Show both in the mock.

## What carries over

- Let the user choose the destination provider and model. Open a separate session in the same project with the original session attached as a reference.
- Make the source reference visible and openable from the new draft. The new agent should be able to inspect the original transcript through the reference, including earlier turns when needed. A prepared summary may help orient the user, but the full source needs to be reachable.
- Show the destination before the first send. Preserve the original session and leave the first instruction editable.

## What to show in the Lab

- Start in a recognizable, populated Orvane chat. Demonstrate a real-looking task with prior decisions, a file or activity entry, and an open question the new agent can pick up.
- Make it possible to trigger the action from both surfaces, choose a different provider or model, cancel, inspect the reference, and see what the first turn looks like.
- Render the pinned version at its narrow width and the Agent Sessions version with both panes visible. Check the composer, menu anchoring, keyboard focus, and overflow at both widths. Keep the chat free of the idle permission blurb.
- The previous generic picker was rejected. The useful question to answer visually is where the user lands and how they and the next agent find the source. The existing **Continue with another model** Lab component has older rounds for context. Present your own take in a fresh round.

## Repo context

- Feature branch `fix/focus-zoom-and-claude-questions` in `C:\Projects\Orvane`. The checkout contains other in-progress changes.
- `src/App.vue` owns the pinned panel. `src/components/SessionChat.vue` hosts the Agent Sessions chat there.
- `src/components/AgentSessions.vue` owns the composer, session actions, and split-pane entry points. `src/agentTiles.ts` holds the split layout.
- `src/agentNavigation.ts` already carries draft state. The existing session reference UX and transcript reader are useful starting points for the handoff design.
