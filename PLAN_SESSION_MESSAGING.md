# Plan: send messages to Claude Code and Codex sessions from Orvane

Status: **plan only, nothing built.** Written 2026-11-21, updated the same day for handoff to Codex.

**To the agent picking this up (Codex):** the owner wants you to install both command-line tools, then build this feature. Read [AGENTS.md](AGENTS.md) first; its rules apply (fix only what is asked, custom controls only, tests on isolated databases, commit only when asked). Ask the owner the three decisions below before step 3.

## Goal

From Orvane, type (or dictate) a message to an existing Claude Code or Codex session, or start a new one, and see the work happen, without opening each harness. The owner's words: "at the end of the day I just want the task to be done."

Approach: Orvane's local server runs each tool's own command line in "resume" mode as a child process and streams its output into Orvane. Orvane never controls the desktop apps' windows.

## Sign-in: the owner's subscriptions, no API keys

The owner wants runs to use their own Claude (Pro/Max) and ChatGPT subscriptions, not API keys. The app is for personal use only and is not sold.

- **Claude:** drive the installed `claude` command line (`claude -p`, headless mode). That is Claude Code itself, signed in with the owner's account. **Do not use the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) with a claude.ai login: its docs say third-party developers may not offer claude.ai login in products built on it. The command-line route is the one Anthropic documents for driving Claude Code from other programs.
- **Codex:** drive the installed `codex` command line (`codex exec`, or `codex app-server` if you prefer its JSON-RPC). "Sign in with ChatGPT" uses the subscription. Believed, not checked: `exec` and `app-server` read the same login in `~/.codex`. Confirm this after login.
- Orvane never reads, stores, copies or forwards any token, key or auth file. Each tool's own login is the only credential.
- Runs count against the same usage limits as the desktop apps. When a run hits a limit, show the tool's message as is.

## What you give up compared with the desktop apps

| Desktop app feature | With the command line from Orvane |
|---|---|
| The conversation updates live in the app's window | Orvane shows the reply live. The desktop window only shows the new turns after it reloads the session. |
| Asks before risky actions, in its own window | Can't stop and ask in the terminal. Either set what's allowed up front, or (Claude) send each approval request to Orvane with `--permission-prompt-tool`, so you approve in Orvane. |
| Asks you questions mid-task | The agent can't pause for an answer. It decides or stops. You answer with your next message. |
| Stop or redirect mid-turn | Orvane's Stop button ends the process; redirect with your next message. |
| Desktop-only extras: the built-in browser pane, artifacts, the task list and next-step box, side sessions | Not available. The command line's own tools, your MCP servers (including Orvane's), skills and CLAUDE.md / AGENTS.md all still load. Orvane's Browser covers most of what the browser pane does. |
| Pasting images | Pass image file paths in the message (dropping a file into Orvane can do this). |

Nothing changes in how either tool reads the code or does the work. For "get the task done" the losses are mostly convenience, apart from approvals, which step 6 handles.

## Decisions for the owner (ask before step 3)

1. **Where the message box lives:** under each session in the existing **Claude sessions** app, which today is a read-only mirror whose panel says "Orvane never sends" (this plan changes that), or in a new app.
2. **Default permissions for a run** (Claude `--permission-mode`, Codex sandbox and approval flags). Recommendation: "ask in Orvane" for Claude, and workspace-write with no network for Codex.
3. **Claude first, Codex first, or both in the first version.**

## Steps

1. **Install both command lines** (the owner asked you to do this). Neither `claude` nor `codex` was on PATH on the owner's other machine; `~/.codex` existed there.
   - Check first: `Get-Command claude, codex -ErrorAction SilentlyContinue`, `node --version`, `npm --version`. Skip whatever is already installed.
   - Claude Code: `npm install -g @anthropic-ai/claude-code`, or Anthropic's Windows installer (`irm https://claude.ai/install.ps1 | iex`). Use the install method from Anthropic's current docs (code.claude.com/docs) if it differs.
   - Codex: `npm install -g @openai/codex`. Use OpenAI's current docs if it differs.
   - Open a new shell and check `claude --version` and `codex --version`.
   - Both package names and the installer URL are believed, not checked. Install only from these official sources.
2. **Sign in: the owner does this, not you.** Logins open a browser and use the owner's account.
   - Ask the owner to run `claude auth login` (or `claude`, then `/login`) and pick the Claude subscription, not an API key.
   - Ask the owner to run `codex login` and pick "Sign in with ChatGPT".
   - Never type a password, code or key, and never pass `--with-api-key`.
   - Then check that the logins work with one cheap headless run each, in a scratch folder:
     - `claude -p "reply with ok" --output-format json`
     - `codex exec --json "reply with ok"`
   - Report what each printed. Make sure no `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set in the environment Orvane uses. A key there could bill the API instead of the subscription.
3. **Check the real flags** before coding. Run `claude --help`, `codex --help`, `codex exec --help` and `codex exec resume --help`. The flags below are believed, not checked; correct this plan if they differ.
4. **Runner service** (`server/agent-runner.ts` plus an API route under `/__orvane/`):
   - Find each binary from PATH (on Windows, the npm `.cmd` shims) plus a settings override for its path.
   - Spawn with an argument array, never through a shell string. Working folder: the session's project folder (the sessions app already knows it from the transcript).
   - Clear `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the child's environment, so runs use the subscription logins.
   - Claude, existing session: `claude -p --resume <sessionId> --output-format stream-json --verbose`, message on stdin. New session: the same without `--resume`, in a folder the owner picks.
   - Codex, existing session: `codex exec resume <sessionId> --json "<message>"`. New session: `codex exec --json -C <folder> "<message>"`.
   - Parse the JSON lines as they arrive and push them to the page over the existing server-sent events pattern.
   - Only one run per session at a time (a lock). Stop kills the whole process tree. Keep a time limit. Store the run's log in Orvane's local data.
   - Signed out: when a tool reports that it isn't signed in, show "Run `claude auth login`" (or `codex login`) in Orvane. Never start a login flow yourself.
5. **Transcripts:**
   - Claude: reuse `server/claude-sessions.ts` (reads `~/.claude/projects`). After a run, the new turns appear there.
   - Codex: add a reader for `~/.codex/sessions` (path to verify) in the same shape, so both show in one list.
6. **Approvals in Orvane** (Claude):
   - Add an MCP tool to Orvane's server (for example `agent_permission`) and pass it with `--permission-prompt-tool mcp__orvane__agent_permission`.
   - Each approval request shows as an Allow / Deny card in Orvane, and the run waits for your answer.
   - Codex: use its sandbox and approval flags; `exec` has no interactive approval.
7. **UI:**
   - A message box under the transcript (custom-styled; Enter sends, Shift+Enter adds a new line).
   - A "Running" state with Stop, and the reply streaming into the transcript view.
   - Dictation works as is: Windows voice typing (Win+H) types into the box.
   - Ctrl+K: "Send to session…" and "New Claude/Codex session…".
8. **Safety:**
   - Local and same-origin only, like the other `/__orvane/` routes.
   - Only text the owner types or dictates is sent. Orvane never forwards page or transcript content on its own.
   - Transcript and tool output are untrusted data.
   - Show which folder and permission mode a run uses before the first run in a folder.
9. **Tests:**
   - A fake `claude` / `codex` script that prints recorded JSON lines.
   - Check: streaming, the one-run lock, Stop, the approval card round trip, the signed-out message, the API-key variables cleared, and errors such as a missing binary or a bad session ID.
   - No real model calls in tests. Isolated databases only.
   - Run each Electron spec on its own: `pnpm exec playwright test <spec> --workers=1`.
   - Also run `pnpm type-check`, `pnpm test:css`.
10. **Docs:** a README section (install, sign-in, use) and an AGENTS.md note saying agents may be driven this way.

## Key files today

- `server/claude-sessions.ts`, `server/claude-api.ts`: read Claude transcripts for the Claude sessions app.
- `src/components/ClaudeSessions.vue`: the read-only sessions app the message box would go into.
- `server/index.ts`: Orvane's MCP server, where `agent_permission` would be registered.
- `vite.config.ts`: where `/__orvane/` API middlewares are registered.
