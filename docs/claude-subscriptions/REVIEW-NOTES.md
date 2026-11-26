# Codex review notes for Claude's design and plan

Scope: mockups and an implementation plan, before production changes. Claude leads the mockup design at the owner's explicit request. This file records independently checked integration points; it does not constitute Claude's review or the owner's design selection.

## Verified integration points

- `server/agent-cli.ts`: `agentEnvironment()` already clones the environment and strips API keys, OAuth overrides and alternate providers. Extend this existing boundary with a resolved profile context. Never modify the parent's `process.env`.
- `server/agent-runner.ts`: execution currently obtains one global environment. The existing lock includes provider and session UUID; include the profile identity. Check `current`, persisted run lookup, approvals, checkpoints, queued messages and restart handling for the same assumption.
- `server/session-transcripts.ts`: one root per instance. Existing Claude keys encode the relative transcript path; Codex keys have a `codex:` prefix. Keep legacy Default keys and existing `claude_visuals` bindings valid. Additional profiles need unambiguous keys and root validation before every file read.
- `server/agent-sessions-api.ts`: model catalogues are cached by provider only, Claude skills resolve under `~/.claude/skills`, and transcript services are singleton instances per workspace. Resolve trusted profile IDs on the server, including for reads, without accepting arbitrary filesystem roots from a chat request.
- `server/agent-usage.ts`: there is one stored Claude usage entry. Bind future reports to the run's profile; never display one profile's usage as another's. Existing ambiguous usage should become unknown unless its origin can be established.
- `server/agent-mcp.ts`: the Claude config path already considers `CLAUDE_CONFIG_DIR`, but setup and child environments are global. Both must use the same selected profile. Preserve explicit install/remove semantics.
- `server/terminal.ts`: PTY creation currently inherits the server environment. It does not yet provide a per-agent-profile login launcher. A narrow, server-resolved login launch is required; a general renderer-supplied environment map is unnecessary. Launch the CLI with structured executable/arguments to avoid shell quoting and profile startup overrides.
- `src/components/AgentLauncher.vue`: the dock launcher starts runs separately from `AgentSessions.vue`. Both must preserve the same profile choice. Merely adding a picker to Agent sessions leaves launcher-created chats on the wrong account.
- `src/agentNavigation.ts`, `src/agentTiles.ts`: drafts and pane state carry provider/folder/model context. Extend these and source links with profile identity so pinning, splitting, reopening and continuing with another model preserve it.
- `server/exposition-tools.ts`: the MCP process constructs its own `SessionTranscripts`. Backend UI discovery alone will not make extra-profile exposition work. Propagate the intended profile/root to the MCP process, and disambiguate duplicate session UUIDs without guessing the latest session.
- `server/agent-schedules.ts`: scheduled targets currently carry provider/folder but no profile. Pin profile IDs when saving and carry them through execution and last-session links.

## Isolation details to settle in implementation

1. Legacy Default must retain the current unset-versus-set `CLAUDE_CONFIG_DIR` behavior. Explicitly setting the default `~/.claude` path can change where Claude looks for `.claude.json`; do not equate these launch modes casually.
2. `ORVANE_CLAUDE_PROJECTS_DIR` is a transcript-root override, not an authentication identity. Preserve its existing role for Default; never route every added account to it.
3. Normalize Windows paths and detect duplicate physical roots, including case and junction aliases. One directory registered twice does not create independent accounts.
4. New profile config paths should become immutable after use. Repointing a stable ID would silently reassign old sessions and schedules. A new directory should get a new ID.
5. Capture the resolved profile at run launch. Renaming or changing the default during a run must not change its environment, queued turns, auth checks or usage attribution.
6. Account login affects credentials shared by processes using that directory. Disable or clearly block reauthentication while that profile has an active run; work on other profiles may continue.
7. Missing profiles must stop resume and scheduled execution with a useful error. Do not fall back to Default or choose an account based on matching session UUID alone.
8. Removing a profile registration must preserve its directory, transcript files and credentials. Keep enough identity metadata to explain existing history and scheduled targets, or prevent removal while references remain.
9. Configuration isolation does not isolate project files. Simultaneous accounts in the same working folder can still edit the same files. Preserve existing project checkpoint/write protections and do not silently create worktrees.
10. Auth status should validate the expected config directory when the installed CLI reports it. Treat unsupported/absent fields compatibly, and never log credentials or retain raw authentication payloads.

## Official sources checked on 2026-11-25

- [Authentication: multiple accounts](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts): separate configuration directories support separate claude.ai logins. The documented exception is Claude Console keyless sign-in, which lives outside that directory. This feature should target subscription authentication.
- [Environment variables](https://code.claude.com/docs/en/env-vars): `CLAUDE_CONFIG_DIR` relocates configuration, history and plugins. Use absolute paths and account for user/managed settings precedence. Additional directories do not create additional subscription entitlements.
- [CLI reference](https://code.claude.com/docs/en/cli-reference): `claude auth login` supports interactive subscription login; `auth status` reports JSON and newer versions include `configDirectory`. Keep login interactive and credential ownership with Claude Code.

## Verification required after implementation

Use isolated databases and temporary fake CLI homes. Demonstrate two overlapping runs receiving different config paths, unchanged parent environment, same-UUID transcript separation, profile-pinned resume/queues/schedules, independent usage/model/MCP state, and cancellation confined to one process tree. Check the dock launcher, pinned/split views, source links and exposition as well as the main app. Verify restart and migration preserve existing Default sessions and visuals. Check keyboard/outside dismiss behavior at canvas zoom, including embedded Browser clicks.

Run repository-required type checking, tests and CSS checks. Run any Electron specs individually with one worker. Real Windows OAuth isolation and two real subscriptions require a later user-assisted smoke test; neither source review nor a mock proves that integration.

## Design-phase verification performed by Codex

Rendered and inspected all three variants through Orvane's `uimaker_lab_view`. Independently checked the final local mock HTML in fresh, isolated headless Edge pages controlled by Playwright, with network requests blocked and reduced motion enabled. No production app, workspace database, authentication or transcript files were accessed by these checks.

- Account picker: keyboard opening focuses the committed profile; arrow navigation does not change the committed selection; Enter commits; a signed-out option cannot select an account; editing keys remain available in text fields; outside pointerdown dismisses.
- Settings: reproduced the original second-click `Check now` exception before Claude's revision, then confirmed repeated clicks succeed after the fix. Inline removal cancellation dismisses the confirmation.
- Concurrent sessions: selecting another profile simulates a new blank chat and keeps the source chat's Work identity. The menu dismisses.
- All three inline scripts parse and the interaction checks produce no browser page errors.

The default Playwright Chromium binaries were unavailable, so the checks used the installed Edge channel in a fresh temporary browser context. Repository application suites were not run: this phase changes only mock HTML and documentation. The planned subscription feature remains unimplemented and unverified in the production app.
