# Orvane Host: status and what is left

Written 2026-11-24. Covers the LAN host (laptop access) work on branch `codex/host-and-delegation`. The plan itself is in [lan-host-plan.md](lan-host-plan.md).

## Agent Sessions on the laptop is now the desktop component (2026-11-25)

The laptop's Agent Sessions page is the real `src/components/AgentSessions.vue`, not a copy.

- **Build entry:** `host-agents.html` + `src/host/agents.ts` mount `AgentSessions.vue` with a block kept in the laptop's localStorage. `vite.config.ts` builds it beside `index.html` into `dist/`; `electron/server.mjs` rebuilds when it changes.
- **Page:** `server/orvane-host-app.ts` wraps the built tags in the host's top bar (wordmark, app strip, Sign out) and one app window. It adds `<meta name="orvane-host">` (host mode), the sign-in's CSRF token and the desktop's default edit modes. `/assets/*` and `/host-shell.css` are served to signed-in browsers only.
- **Transport:** the component still calls `/__orvane/agents/<op>` and `/__orvane/files/<op>`. The host entry adds the CSRF header to same-origin fetches.
- **Gateway:** `server/orvane-host-agents.ts` allowlists operations and checks each against the shared project folders before calling the desktop's own handlers. `server/agent-sessions-api.ts` now has those handlers in `operate()`, used by both the desktop middleware and the gateway.
  - Allowed: sessions, runs, read, start, queue/unqueue/queue-now/steer, stop, inspect-run, run-events, run-changes, run-diff, permission (only with "Approval from the laptop"), session-approvals, checkpoints and checkpoint preview/restore, transcript-file, slash, models, usage, save/delete prompt, suggest, attachment-save and pasted pictures.
  - Lists are filtered to the shared projects. New sessions must name a shared folder. Attachments must be pasted pictures or files in a shared folder.
  - Everything else is 404: host settings, MCP, delegation, schedules, default modes, launcher, notes rewrite.
  - Files: `roots` lists the shared folders; `list` and `search` work inside them only.
- **Hidden in host mode** (`src/hostMode.ts`): Scheduled, Settings, Snapshot (button and Ctrl+Alt+S), Open folder (button and menu), keep-awake, Pin new session, Send to Notes.
- **Removed:** the hand-written `server/orvane-host-chat-view.ts` and its `/api/sessions`, `/api/chat`, `/chat.js` and markdown-library routes. `HostAgentChat` is now only the scope layer (shared roots, approvals switch, desktop default modes).
- **Tests:**
  - `tests/orvane-host-settings.spec.ts` drives the real component on the laptop page: it lists only shared sessions, approves a Write, answers the question card, and starts Codex. It passes.
  - `tests/orvane-host.spec.ts` has a new gateway test: 401 signed out, 403 without CSRF or cross-origin, 404 for private sessions, runs, folders and attachments, 404 for desktop-only operations, files scoped. It passes.

### Changed from the hand-written page

- **Full paths:** the laptop now shows project paths as the desktop does (the header and the folder field). The old page hid them.
- **Lost acknowledgement retry is gone:** the old page sent each message with a request ID and retried it safely. The real component's `start`/`queue` have no request ID, so on a dropped Wi-Fi reply the laptop shows an error and a resend could start a second turn. This needs an idempotency key in the desktop operations if it matters.
- **A new build is needed:** the laptop page comes from `dist/`. Restarting Orvane rebuilds it. With `ORVANE_DEV=1`, run `pnpm build-only` first, otherwise the page says it isn't built.

## Still open

- **UI Maker, Browser and Terminal** are still hand-written pages (`orvane-host-maker-view.ts`, `orvane-host-browser-view.ts`, `orvane-host-terminal-view.ts`). Do the same as Agent Sessions: one entry per app mounting `UiMakerView.vue` / `LabView.vue`, the Browser and `TerminalView.vue`, plus a gateway each.
- **Not checked on a real second laptop:** everything above was verified in Playwright against a 127.0.0.1 host.

## Earlier (Claude, 2026-11-24)

### Laptop sends now respect the desktop permission setting

- **Before:** `server/orvane-host-chat.ts` always forced Claude to "Ask first" and Codex to "Auto-accept". Every turn sent from the laptop needed approval on the desktop, whatever the desktop's setting.
- **Now:** a send uses the same edit mode the desktop would. That is the mode of the chat's latest desktop turn, otherwise the default from Agent Sessions → Settings → Sessions, and only then the CLI's first mode.
- **How the setting reaches the server:** the desktop default was stored only in the desktop window's localStorage. `src/agentHarness.ts` now posts it to a new loopback-only route, `default-modes` in `server/agent-sessions-api.ts`. The server stores it in app data under `agent-default-modes`.
- **Since 2026-11-25:** the laptop page gets these modes in a `<meta name="orvane-modes">` tag and applies them to the real composer, so new chats start in the desktop's default. The old regression test went with the hand-written page; the new gateway test checks the tag.
- **Not checked yet:** behaviour from a real second laptop.

### Hosted Agent Sessions restyle (superseded: that page was removed on 2026-11-25)

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

- **Settings spec timing:** resolved. The ported spec passes with default waits (about 45s in total).
- **Restart needed.** Server and Electron changes need a full Orvane restart before trying them.
- **Two-machine acceptance** from [lan-host-plan.md](lan-host-plan.md#acceptance-on-two-machines) has not been run on real hardware:
  - Wi-Fi drop during a send,
  - lid close,
  - stale approvals,
  - certificate install.
