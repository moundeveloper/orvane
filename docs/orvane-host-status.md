# Orvane Host: status and what is left

Written 2026-11-24. Covers the LAN host (laptop access) work on branch `codex/host-and-delegation`. The plan itself is in [lan-host-plan.md](lan-host-plan.md).

## The main problem still open

**The laptop's hosted pages do not use Orvane's real app UI.** Each hosted app is HTML, CSS and JavaScript written by hand as template strings in `server/orvane-host-*-view.ts`. That code copies the desktop's classes and values. Desktop Agent Sessions is `src/components/AgentSessions.vue` with its child components (ComposerModes, ChatMarkdown, ContextRing, AgentRunActivity, ThinkingTrail, AgentQuestions, SlashMenu, ContextPicker, CustomSelect…). The laptop page shares none of that code. It only looks close, it lacks most features, and every desktop change has to be redone by hand.

The owner's requirement: the laptop must show **the same UI as the desktop Agent Sessions app**, not a lookalike. The next step is to reuse the real components rather than polish the copy.

### How to do it (proposed, not started)

1. **Separate Vite entry for the host.** Add an entry (for example `host.html` and `src/host/main.ts`) that mounts the real `AgentSessions.vue`. Later entries would mount UI Maker, Browser and Terminal. Build it with the app's normal Vite build, and have `server/orvane-host.ts` serve the built files only to signed-in browsers. The current CSP (`script-src 'self'`, `style-src 'self'`) already fits a built bundle.
2. **Transport adapter.** Today `agentRequest()` in `src/exposition.ts` posts to `/__orvane/agents/<op>`, and the run stream is an `EventSource` on `/__orvane/agents/run-events`. In the host build, both must go to the host's authenticated routes, with the CSRF header and same-origin checks. Do it with a small module swap (a Vite alias or an injected base URL and headers), not by forking the component.
3. **Allowlisted proxy on the host.** In `server/orvane-host.ts`, forward only the Agent Sessions operations the laptop may use, to the same handlers as `server/agent-sessions-api.ts`:
   - Operations: sessions, read, start/send, stop, permission, questions, run-events, models, slash list, usage, queue.
   - Each call is limited to the shared project roots, as `HostAgentChat.allowedFolder` does today.
   - Remote approvals still follow the "Approval from the laptop" switch.
   - Provider secrets, raw transcript paths, the MCP bridge and Electron calls must stay unreachable.
4. **Features that touch the desktop.** Turn these off (or adapt them) in host mode, behind one `host` flag or prop:
   - Snapshot of desktop apps.
   - Open folder.
   - Attachments from local paths.
   - Desktop notifications and keep-awake.
   - Agent Settings (MCP install, Host access).
   - Tile splitting, if it doesn't fit a laptop.
5. **Delete the hand-written chat page.** Once the real component is served, remove `server/orvane-host-chat-view.ts`. `HostAgentChat` either becomes the proxy's scope and permission layer or is replaced by it.
6. **Then the other apps.** Do the same for UI Maker (`UiMakerView.vue` / `LabView.vue`), Browser and Terminal. Their hand-written pages are `orvane-host-maker-view.ts`, `orvane-host-browser-view.ts` and `orvane-host-terminal-view.ts`.
7. **Tests.** Port `tests/orvane-host.spec.ts` and `tests/orvane-host-settings.spec.ts` to the real component's labels. Keep the security assertions:
   - Signed-out requests get 401.
   - Cross-origin and missing-CSRF requests get 403.
   - Private projects get 404.
   - No full paths are returned.
   - Lost acknowledgements are retried with the same request ID.

## Done in this session (Claude, 2026-11-24)

### Laptop sends now respect the desktop permission setting

- **Before:** `server/orvane-host-chat.ts` always forced Claude to "Ask first" and Codex to "Auto-accept". Every turn sent from the laptop needed approval on the desktop, whatever the desktop's setting.
- **Now:** a send uses the same edit mode the desktop would. That is the mode of the chat's latest desktop turn, otherwise the default from Agent Sessions → Settings → Sessions, and only then the CLI's first mode.
- **How the setting reaches the server:** the desktop default was stored only in the desktop window's localStorage. `src/agentHarness.ts` now posts it to a new loopback-only route, `default-modes` in `server/agent-sessions-api.ts`. The server stores it in app data under `agent-default-modes`.
- **Regression test:** "Host sends use the desktop's default edit mode instead of always asking" in `tests/orvane-host.spec.ts`. It fails on the old code (received `ask`) and passes now.
- **Not checked yet:** behaviour from a real second laptop.

### Hosted Agent Sessions restyle (interim, superseded by the plan above)

- **Restyled** `server/orvane-host-chat-view.ts` to the desktop's structure and values. That covers:
  - the toolbar with + Claude / + Codex,
  - dated session groups with counts, row times, project names and state badges,
  - the frost header with "provider · project · state",
  - message timestamps,
  - the composer with a read-only "Edits <mode>" pill, the project chip, and Stop in Send's place,
  - the new-session empty state,
  - the 650px single-column layout.
- **Replies render as markdown** with the same `marked` + DOMPurify settings and CSS as `ChatMarkdown.vue`. `server/orvane-host.ts` serves the two libraries to signed-in browsers only.
- **New server data:** the session list now includes update time, project folder name (never the full path) and run state. Chat reads include each message's time, the project name and the edit mode. `/api/sessions` includes the default modes.
- **Independent screenshot review:** a separate reviewer scored the page 93.5/100 against the desktop at 100% zoom. Screenshots are local only, in `.orvane/host-ref/`, which git ignores.
- **Still a lookalike:** it doesn't have the desktop's features, which is why the plan above is the real fix.

## Other open items

- **Settings spec timing.** `tests/orvane-host-settings.spec.ts` fails at its default 5-second waits for "Write needs approval" (line 93) and "Codex started" (line 109).
  - With those waits at 25s, the whole spec passes.
  - On the hosted page alone, both appear in about 3s.
  - In this spec, the dev server's run hadn't recorded the approval at 5s.
  - It is unknown whether this was already slow before this session's changes.
- **Restart needed.** Server and Electron changes need a full Orvane restart before trying them.
- **Missing from the laptop today (all solved by reusing the real component):**
  - model dropdown (the new-session Model field is a text box),
  - Effort, and changing the edit mode from the laptop,
  - Scheduled, Settings, Add context / Snapshot / saved prompts, Usage and context ring,
  - session timeline, file-changes view, message actions, queueing and steering,
  - thinking trail and tool-step strips,
  - Open folder.
- **Two-machine acceptance** from [lan-host-plan.md](lan-host-plan.md#acceptance-on-two-machines) has not been run on real hardware:
  - Wi-Fi drop during a send,
  - lid close,
  - stale approvals,
  - certificate install.
- **UI Maker, Browser and Terminal** hosted pages are still hand-written and haven't been compared against the desktop.
