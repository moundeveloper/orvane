# Multiple Claude Code subscriptions in Agent sessions: implementation plan

Status: **implemented from the approved mocks.** The owner approved all three mocks on 25.11.2026. Verification results, limitations and corrections are recorded in `IMPLEMENTATION-REVIEW.md`. Branch: `codex/claude-subscription-design`. No commits, push or merge requested.

Companion files in this folder:

- `mock-1-new-chat-account.html`, `mock-2-settings-accounts.html`, `mock-3-concurrent-sessions.html`: the three Lab variants, kept in sync with UI Maker.
- `coordination.md`: the UI Maker component, round and variant IDs, plus the recommendation.
- `REVIEW-NOTES.md`: Codex's independent review of the integration points. This plan builds on it.

## 1. Goal and non-goals

**Goal.** Several Claude Code subscriptions ("accounts") run side by side from Orvane. Each account is its own `CLAUDE_CONFIG_DIR`. A new Claude chat picks its account, every later turn of that chat stays on it, and two chats on two accounts can run at once.

**Non-goals.**

- Orvane never handles credentials. Sign-in is interactive and owned by the CLI (`claude auth login`). Orvane never reads, copies or deletes `.credentials.json`, the OS keychain or OAuth tokens.
- Existing sessions never move to another account. Picking another account from a chat's account menu starts a **blank** new chat on it, with no transcript, reference or history carried over. The current chat is left as it was.
- **Moving a conversation to another account is deferred.** It was not requested or approved, and no UI may suggest it exists.
- The existing same-account "Continue with another model" keeps the source chat's profile.
- No change to `process.env` of the Orvane server or Electron, and no edits to the PowerShell profile, `setx` or any user-wide variable.
- No multiple Codex accounts (possible later via `CODEX_HOME`, out of scope here).
- API-key billing is out of scope. This feature is about claude.ai subscription logins. The docs do support per-config-dir API keys; we just don't build for them.
  - A profile whose `auth status` reports a non-subscription method shows a plain "unsupported sign-in" status and can't start chats.
  - Console sign-in without an API key is the only documented isolation exception. The same status covers it, with no extra warning UI.
- More accounts do not mean more quota for the same subscription.

## 2. Concept in one picture

```
Profile (Orvane record)                 Claude Code (owns auth)
┌──────────────────────────┐            ┌──────────────────────────────────┐
│ id: "work"  (stable)     │  env only  │ CLAUDE_CONFIG_DIR=C:\Users\…\     │
│ name, colour             │ ─────────▶ │   .claude-profiles\work           │
│ configDir (immutable)    │  per child │   .credentials.json  (CLI only)   │
└──────────────────────────┘            │   projects\…\<uuid>.jsonl         │
          ▲                             │   skills\  .claude.json (MCP)     │
          │ profileId                   └──────────────────────────────────┘
Run target / queue / schedule / draft / pane / lineage
```

`default` is the legacy profile. It has **no** `configDir` of its own: children inherit exactly what Orvane inherited today, whether `CLAUDE_CONFIG_DIR` is set or unset. That keeps today's behaviour byte-for-byte.

## 3. Sources (official docs)

All checked on 25.11.2026. Codex also checked them; see `REVIEW-NOTES.md`.

| Topic | Source | What we rely on |
|---|---|---|
| Multiple accounts | https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts | Each account gets its own config directory, chosen with `CLAUDE_CONFIG_DIR`. Each directory keeps its own settings, history and claude.ai login or API key. |
| Isolation exception | same page | Console sign-in without an API key is stored outside the config directory, so separate directories don't keep two of those apart. |
| Windows credentials | same page | By default under the user profile's `.claude` folder. With `CLAUDE_CONFIG_DIR` set, the credentials file lives in that directory. |
| `CLAUDE_CONFIG_DIR` | https://code.claude.com/docs/en/env-vars | Give it an absolute path. Project and local settings can't set it. (The full description of what it relocates was seen only in a summary.) |
| `claude auth login` | https://code.claude.com/docs/en/cli-reference | Interactive sign-in. A flag switches to Console/API billing; Orvane never passes it. |
| `claude auth status` | same page | JSON output, exit code 0 when signed in. Recent versions (2.1.268+) report the config directory in use. Documented auth methods include `claude.ai` and `oauth_token` as well as API-key and third-party kinds. |
| `--resume` | same page | Accepts a session ID, a name or an absolute transcript path. With an ID the CLI searches widely across projects. Its scope relative to `CLAUDE_CONFIG_DIR` is not documented, which is why §6 pins resume to the profile's own transcript path. |

**Not in the docs. Treat as unverified:**

- Whether two folders signed in to the *same* subscription share its limits. This is inferred: limits belong to the account, not to the folder. The mocks no longer state it.
- What exactly `claude auth logout` removes. Orvane never calls it.

A real two-account Windows smoke test stays a **user-assisted step after implementation** (§11, phase 6).

## 4. Code map (verified against the current branch)

| Area | File:line | Today | Change |
|---|---|---|---|
| Child env | `server/agent-cli.ts:160` `agentEnvironment()` | Clones `process.env` and strips API/OAuth/provider overrides. `CLAUDE_CONFIG_DIR` passes through. | `agentEnvironment(profile?: ResolvedProfile)`. It still clones and strips. For a non-default profile it sets `CLAUDE_CONFIG_DIR` on the clone only. |
| Auth check | `server/agent-cli.ts:249` `verifyAgentLogin(provider, command, cwd, env)` | Runs `claude auth status` with the env passed in. | Pass the profile env. If the CLI reports `configDirectory`, compare it with the expected folder (normalised) and fail on a mismatch. Never log the raw payload. |
| Models | `server/agent-cli.ts:19` `claudeModels()`; cache `server/agent-sessions-api.ts:67,317` | Uses the global env. Cache keyed by provider. | Takes the profile env. Cache key `claude:<profileId>`. |
| Args | `server/agent-cli.ts:311` `agentArgs()` | `--resume <id>`, `--fork-session`, `--resume-session-at`. | Resume uses the absolute `.jsonl` path inside the run's profile root, which the CLI supports (§6). If the file is missing or outside the root, the run fails closed. |
| Run target / lock | `server/agent-runner.ts:40` `Target`; `:282` lock `provider:sessionId` | No profile. | Add `profileId` to `Target`. Lock becomes `claude:<profileId>:<sessionId>`. |
| Launch | `server/agent-runner.ts:395-444` `launch()` | `agentEnvironment()` global, then `verifyAgentLogin`, then spawn. | Resolve the profile **once at start** and freeze it on the run (`run.profile`). Every later env, auth check and usage write uses the frozen copy. |
| Queue / steer / follow-up | `server/agent-runner.ts:1014-1103` (`followUp` rebuilds the target at 1092) | Profile would be lost. | Carry `run.profile.id` in `followUp`, `enqueue`, `steer`, `sendQueued`. |
| Fork / rewind / checkpoints | `server/agent-runner.ts:199,405-413`; `agent-sessions-api.ts:361` | Matched by sessionId. | Match by composite key. A fork stays on the source profile. |
| Text jobs | `server/agent-runner.ts:255` `textJob()` (rewrite/suggest, haiku) | Global env. | Use the session's profile. With no session, use the new-chat profile. |
| Cancellation | `server/agent-runner.ts:1105` `stop()` | Kills the process tree. | Unchanged: per run, already confined to its own tree. Test it with two profiles running. |
| Transcripts | `server/session-transcripts.ts:81-99` root, `:153-275` `index()` key = base64url(rel path), `codex:` prefix | One root. | One instance per profile root (read-only). Default keys unchanged. Other keys `claude@<profileId>:<base64url>`. |
| Source links / lineage | `src/agentNavigation.ts`, `src/agentTiles.ts`, lineage map in `AgentSessions.vue` | provider, folder, model | Carry `profileId` through drafts, pin, split, reopen and "continued from" links. Same-account Continue with another model keeps the source profile. |
| Visual bindings | `claude_visuals` in `claude-visuals.sqlite` (`session-transcripts.ts:97`) | Keyed by session key. | Default keys unchanged, so existing bindings keep working. New profiles use the composite key. No migration. |
| API dispatch | `server/agent-sessions-api.ts:71-139` `serviceFor`, `:216` `transcripts()` prefix dispatch, `:218` `sessions` | One Claude instance. | Map `profileId → SessionTranscripts`. Dispatch on the key prefix. `sessions` merges all roots and tags each row with `profileId`. |
| Skills | `server/agent-sessions-api.ts:129` hard-coded `~/.claude/skills` | Global. | `<profile root>/skills`. Default resolves the same way the CLI does (`CLAUDE_CONFIG_DIR` or `~/.claude`). This also fixes the current mismatch when Orvane runs with `CLAUDE_CONFIG_DIR` set. |
| Usage | `server/agent-usage.ts:87-104` single `{claude}` in `app_data:"agent-usage"` | One entry, with no directory or account fingerprint. | `{claudeProfiles: {[profileId]: {usage, fingerprint}}}`. The old entry is **not** moved to Default: Default's inherited env may have differed between restarts and the account may have changed, so its origin can't be proved. It migrates to "unknown" until the next run reports. |
| MCP | `server/agent-mcp.ts:40-61,104-114` `claudeFile` = `CLAUDE_CONFIG_DIR \|\| ~` + `.claude.json`, fixed label | Global. | Status, install and remove per profile, with `claudeFile` under that profile's dir. The label shows the real path. Explicit install only, as today. |
| Terminal / login | `server/terminal.ts:371,399-404` `open()`: pty with `{...process.env}` | No profile path. | New narrow `openClaudeLogin(profileId)`. The server resolves the profile and runs `findAgent('claude')` with structured args `['auth','login']` and env `agentEnvironment(profile)`. No shell, no renderer-supplied env, no generic env map. |
| Schedules | `server/agent-schedules.ts:23-54` input, `:174-226` `run()` | provider, folder, model… | Add `profileId`; existing schedules migrate to `default`. If the profile is missing or removed, the run fails with "Account Work was removed; pick another in the schedule". Never fall back. |
| Exposition | `scripts/orvane-session-context.mjs`; `scripts/install-orvane-exposition.ps1` (`-ConfigDirectory`); `server/exposition-tools.ts:18,84-92` | Default root only. | The hook also emits `configDir` (from its own env). Exposition tools search the registered roots and resolve by `configDir` + sessionId. If ambiguous, return an error; never take the latest. Per-profile install is already supported by `-ConfigDirectory`. |
| UI: new chat | `src/components/AgentSessions.vue:2513-2529` toolbar, `:3321-3410` `.cs-compose-actions` | Provider plus model pill. | Account pill before `CustomSelect.cs-model`, only when `newProvider==='claude'`. Mock 1. |
| UI: rows / tiles | `AgentSessions.vue:2577-2627` `.cs-row-meta`; `agentTiles.ts`, `agentNavigation.ts` | provider, folder, state. | Account tag in row meta. Drafts, panes, pin and split carry `profileId`. Mock 3. |
| UI: settings | `src/components/AgentSettings.vue:112-162` `.as-card` / `.as-row` | MCP and Sessions sections. | New "Claude accounts" section. Mock 2. |
| UI: dock launcher | `src/components/AgentLauncher.vue:295-303` start; localStorage `orvane.agent-launcher.v1` | Provider/model only. | Same account picker. It must send `profileId`, or launcher chats land on the wrong account. |
| Harness settings | `src/agentHarness.ts:180-216` | localStorage. | Store the new-chat account only as `newChatProfileId` on the server (app_data), not in localStorage, so the launcher and Agent sessions agree. |

## 5. Data model and migration

```ts
type ClaudeProfile = {
  id: string;            // "default" | slug + short random, e.g. "work-7k2f"; never reused
  name: string;          // editable
  color: string;         // from a fixed muted palette
  configDir: string | null; // null only for "default" = inherit; otherwise absolute, normalised
  createdAt: number;
  usedAt?: number;       // set on first run; configDir is immutable from then on
  removedAt?: number;    // soft remove; kept for history labels
};
// app_data key "claude-profiles": { version: 1, profiles: ClaudeProfile[], newChatProfileId: string }
```

Migration happens on first read, is idempotent, and runs once per workspace DB:

1. If `claude-profiles` is missing, write `{version:1, profiles:[{id:'default', name:'Default', configDir:null, …}], newChatProfileId:'default'}`.
2. `agent-usage`: mark the old provider-wide Claude entry unknown and stop displaying it. It is never assigned to Default, because its directory and account can't be proved. New entries store a fingerprint (§7).
3. `agent-schedules`: add `profileId:'default'` to every Claude schedule.
4. Session keys, `claude_visuals`, lineage and pane state stay untouched: an unprefixed Claude key means `default`.
5. Env-override rules for Default:
   - If `CLAUDE_CONFIG_DIR` is set in Orvane's env, Default uses it.
   - If it is unset, Default leaves it unset (it does not write `~/.claude` explicitly; see REVIEW-NOTES §1).
   - `ORVANE_CLAUDE_PROJECTS_DIR` stays a Default-only transcript override and is never applied to added accounts.

Validation when an account is added:

- Absolute path only, normalised (`path.resolve`, case-folded on Windows).
- **Folder that doesn't exist yet:** `realpath` fails on it. So resolve the real path of its **nearest existing ancestor**, append the remaining segments, and validate that. After `mkdir`, run `realpath` again and re-validate before saving the profile. If the second check fails, remove only the empty folder Orvane itself just made, and abort.
- **Symmetric nesting:** reject if the new root equals another root, sits inside one, or contains one (Default's effective root included). Compare real paths so junctions and case aliases are caught both ways.
- Reject a path inside the Orvane repo or the `.orvane` data dir.
- **Generated folder** (the default suggestion): it must not exist, or must exist and be empty. Orvane creates it and never copies anything into it (no credentials, no settings from `~/.claude`).
- **An existing folder the owner selects** is an open choice (§12). If supported, it is used as-is: nothing is emptied, overwritten or copied, and its current sign-in shows through `auth status`.
- A different folder means a new profile ID. `configDir` can't be edited after first use.

## 6. Runtime rules

- **Resolve on the server, freeze at launch.** The renderer sends only `profileId`. The server looks it up and rejects unknown or removed IDs (400, "Account not found"), and rejects any other env or path field. The resolved profile is copied onto the run. Renaming it or changing the new-chat account mid-run changes nothing for that run.
- **Composite identity everywhere:** `{provider, profileId, sessionId}`. It is used for locks, run lookup (`current`), persisted runs (`agent-runs/<id>.json` gains `profileId`), approvals, checkpoints, queue, steer, fork, rewind, lineage ("continued from"), panes and the exposition binding.
- **Resume is profile-pinned and must be proved isolated before shipping.**
  - It uses the profile of the root the session was found in, and passes the CLI the absolute transcript path inside that root (supported by `--resume`).
  - If the file is missing, outside the root, or its profile was removed, the run fails closed with a clear error. There is no ID-only search and no Default fallback.
  - A removed profile's chats open read-only, labelled "Account removed". Starting a new chat elsewhere is the only action offered.
  - Release gate A15 in §9.
- **New chat on another account** (from a chat's account menu) opens a blank draft with only the profile preset. No transcript, reference, quote or `@session` chip is attached.
- **Concurrency.** No new global limit. Runs on different profiles and sessions run in parallel. The same composite session never runs twice (lock). Two accounts can still edit the same project folder at once; the existing checkpoint and write protections apply, and Orvane creates no worktrees.
- **Login while busy.** `openClaudeLogin(profileId)` is refused while that profile has a running run ("Work has 2 running chats"). Other profiles are unaffected.
- **Cancellation.** `stop()` stays per run and process tree. A test proves that stopping a Work run leaves the Default run alive.
- **Removal.** Soft remove (`removedAt`), never `rm`, never `claude auth logout`. If schedules reference the account, removal is blocked with a list of them (open choice: block, or re-pin to another account).

## 7. Per-profile state

| State | Key |
|---|---|
| Model catalogue | `claude:<profileId>`, 60 s refresh as today |
| Auth status | memo per profileId, refreshed on Check, on launch failure and on Settings open. Non-subscription methods show "unsupported sign-in". |
| Usage | `claudeProfiles[profileId]`, written only from that run's `rate_limit_event`, with a fingerprint |

**Fingerprint and invalidation.**

- A profile's fingerprint is its resolved effective config dir plus the fields `auth status` reports that identify the sign-in: `authMethod`, and the account/org fields when present. It never contains a token.
- When the fingerprint changes (after a login launcher closes, on Check, or at launch), drop that profile's usage, model catalogue and auth memo.
- For Default the effective dir comes from Orvane's env **at that launch**, which can change between restarts. A changed dir counts as a changed fingerprint.
- Other profiles' caches are never touched.
| Skills / slash | `<root>/skills` per profile |
| MCP status | `<root>/.claude.json` per profile (Default: same rule as today) |
| Transcripts index | one `SessionTranscripts` per root, read-only, each with its own `allowed()` check |

## 8. UI (after the owner picks)

Details per mock are in `coordination.md`. Shared rules:

- Custom controls only: the pill is a `.select-popover` listbox (CustomSelect pattern). It dismisses on outside pointerdown, including in a Browser guest, without swallowing the click, and scales with canvas zoom.
- Keys follow the standing rule that shortcuts defer to text fields, with **no new global chord**:
  - The pill and the chip are buttons. Enter, Space or ↓ opens the list and focuses the committed account.
  - Inside the open list: ↑ ↓ Home End, Enter or Space picks, `1-9` pick, Esc closes back to the button, Tab closes.
  - These keys are handled only on the list, never while focus is in an input, textarea or contenteditable.
  - `aria-selected` marks the committed account. Hover and arrows move only the focus or active row.
- Ctrl+K entries: "New Claude session on Work" (one per account) and "Claude accounts".
- Reduced motion: final states, no movement.

## 9. Tests

All tests use temp dirs and isolated databases. They never touch the real workspace, never run a real login and never contact the network.

- Extend the fake CLI `tests/helpers/agent-cli.cjs`:
  - echo `process.env.CLAUDE_CONFIG_DIR` (or `<unset>`) into its stream and a sidecar file;
  - support `auth status` (JSON with `loggedIn`, `authMethod:'claude.ai'`, `configDirectory`) and `auth login` (writes a marker file in the given dir);
  - write transcripts under `<CLAUDE_CONFIG_DIR>/projects/…`.
- Use fake homes, `tmp/claude-default` and `tmp/claude-work`, with the same session UUID in both to cover the collision case.

Acceptance tests:

| # | Test | Spec |
|---|---|---|
| A1 | Migration: an old DB with sessions, visuals, usage and schedules gets Default; every old key and visual still resolves | `agent-sessions.spec.ts` (new block) |
| A2 | Default with `CLAUDE_CONFIG_DIR` unset leaves the child unset; with it set, the child gets the same value | unit (`agent-cli`) |
| A3 | Two overlapping runs (Default and Work) each see their own config dir; the parent `process.env` is unchanged afterwards | runner spec |
| A4 | Same UUID in two roots: two rows, two keys, each opens its own transcript | transcripts spec |
| A5 | Queue, steer, fork, rewind and checkpoint restore keep the profile | runner spec |
| A6 | Schedule pinned to Work runs on Work; after removal it fails with a clear error and no fallback | schedules spec |
| A7 | Usage events attribute to the run's profile only | usage spec |
| A8 | Model and skills lists differ per profile (fake CLI returns different lists) | api spec |
| A9 | Login launcher: the renderer sends only `profileId`; unknown ID → 400; extra env fields are ignored or rejected; refused while the profile is busy | api + terminal spec |
| A10 | Stopping one run leaves the other running | runner spec |
| A11 | Remove: directory and marker still on disk; no `logout` call recorded by the fake CLI | api spec |
| A12 | Exposition resolves by `configDir` + sessionId; ambiguous → error | `exposition-mcp.spec.ts` |
| A13 | UI checks, all in `agent-sessions-view.spec.ts` (run alone, `--workers=1`) | see the list below the table |
| A14 | Path validation: relative paths, duplicates, nesting either way, junction/case aliases, a not-yet-existing folder validated through its nearest existing ancestor and re-validated after mkdir, a non-empty generated folder rejected | unit |
| A15 | **Release gate, resume isolation.** Same UUID in Default and Work: resuming the Work chat passes the CLI the absolute path in Work's root, and the fake CLI records it. A missing file, a file outside the root, or a removed profile fails closed with no Default fallback. Also check the scope of the installed real CLI in temp config homes, with no sign-in or network. If that can't be confirmed, ship only the absolute-path mode. | runner spec + manual fixture note |
| A16 | MCP per profile: install, status and remove for Work write only `<work>/.claude.json`; Default's and other profiles' files stay byte-identical (hash before and after); the MCP child env carries only Work's dir | `mcp.spec.ts` |
| A17 | Cache invalidation: changing the fake CLI's `auth status` identity in Work's dir drops Work's usage, models and auth memo; Default's stay | api spec |
| A18 | Unsupported sign-in: a fake `auth status` with an API-key method shows "unsupported sign-in" and blocks start | api spec |

A13 UI checks:

- The account pill appears only on new Claude chats, and existing chats show a locked chip.
- Picking in the chip menu opens a blank draft on the other account with no transcript or reference, and the original chat keeps running.
- Outside click and Esc dismiss the list.
- No key in the composer field is captured.
- The dock launcher sends `profileId`.
- Pin, split, reopen and source links keep `profileId`.

Each bug-fix-style change gets a regression test that fails on the old code (AGENTS.md §7). Run `pnpm type-check`, `pnpm test`, `pnpm test:css`, and Electron specs one at a time.

## 10. Risks

- **Silent fallback to Default.** This is the biggest risk. Any code path that rebuilds a `Target` without `profileId` (followUp, schedules, launcher, textJob, same-account continue) puts a turn on the wrong subscription. Mitigation: `profileId` is required on the type for `provider:'claude'`, and A5/A6/A13 cover it.
- **Key collision.** Profile roots share the relative-path key scheme. Mitigation: the composite prefix, with Default unprefixed.
- **Non-subscription sign-ins.** Orvane never passes the Console flag. A profile that reports a non-subscription method gets the normal per-profile "unsupported sign-in" status (A18). There is no extra warning UI.
- **Resume search scope.** ID-based search scope is undocumented. Mitigation: absolute-path resume inside the profile root, failing closed, as release gate A15.
- **Stale per-profile state after a re-login.** Mitigation: fingerprint invalidation (§7, A17).
- **Login race.** A login in a folder with a running process can rotate its credentials. Mitigation: refuse login while busy.
- **Same project, two accounts.** Both can edit the same files. Mitigation: existing protections, plus a visible account tag on each tile.
- **CLI drift.** `auth status` fields can change, and `configDirectory` exists only from v2.1.268. Mitigation: tolerate a missing `configDirectory`, fail closed only on a positive mismatch, and treat `authMethod` values other than `claude.ai`/`oauth_token` as "not a subscription login". `verifyAgentLogin` currently accepts `claude.ai` and `oauth`; check against the documented `oauth_token`.
- **Exposition** runs in a separate MCP process; it needs the roots list and the `configDir` from the hook.
- **Quota expectations.** More folders don't add quota for the same subscription. Usage shows per account.
- **Windows specifics.** Junctions, case and long paths (A14). The real two-subscription smoke test stays manual.
- **Screen sharing.** The email is shown in Settings and the pill (open choice: hide it).

## 11. Phases

Each phase ends green on type-check, tests and CSS, and is committed only when the owner asks.

0. **Owner picks a mock** (gate). Carry the picked values over literally.
1. **Profile store and env.** `claude-profiles` in app_data with migration; `agentEnvironment(profile)`; path validation; unit tests A2 and A14.
2. **Runner pinning.** `Target.profileId`, freeze at launch, lock, followUp/queue/steer/fork/rewind/checkpoint/textJob, persisted runs, absolute-path resume; A3, A5, A10, A15.
3. **Multi-root discovery.** Per-profile `SessionTranscripts`, composite keys, the `sessions` merge, read and transcript-file dispatch; A1, A4.
4. **Per-profile state.** Models, skills, usage with fingerprint, MCP and auth status; A7, A8, A16, A17, A18; MCP per profile in Settings.
5. **Login and Settings UI.** `openClaudeLogin(profileId)`, the Settings section, add, check and remove; A9, A11.
6. **New chat, tiles, launcher, schedules, exposition.**
   - Composer pill, row tags, tile chip with "New chat on …" (blank), AgentLauncher, pane/source-link profile, schedules, Ctrl+K and the exposition hook; A6, A12, A13.
   - Then the **user-assisted Windows smoke test**: the owner signs two real accounts into two folders, runs one chat on each at once, and confirms `/status` in each. Orvane's agent does not perform real sign-ins.

`electron/main.mjs` and `preload.cjs` should not need changes. If one does (e.g. the terminal bridge), tell the owner a full Orvane restart is required.

## 12. Open product choices for the owner

1. Which mock(s): Account pill, Settings accounts, Two at once. They are complementary; see the recommendation in `coordination.md`.
2. Which account a new chat starts with: a fixed "New chats" account (mock 2), or the last used.
3. Folders: a generated empty `~\.claude-profiles\<name>` only, or also allow selecting an existing Claude Code folder (used as-is, never emptied or copied).
4. Show the signed-in email in the UI, or only name and plan.
5. Removing an account that schedules use: block, or re-pin them in the same step.
6. Account colours: fixed muted palette (as mocked), or name only.
7. Later: the same feature for Codex via `CODEX_HOME`.
8. Deferred, not designed: moving a conversation's history to another account. It needs its own request and mock.
