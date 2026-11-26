# Implementation review

The owner approved all three Claude mocks on 2026-11-25: “I love his mocks implement them.” Implementation was completed on `codex/claude-subscription-design` in the original project folder. On 2026-11-26, the owner authorized committing all changes and merging locally into `master`; the owner will push separately.

## Baseline

- `pnpm type-check`: passed before production edits.
- `pnpm test:css`: failed before production edits. The existing `FlowTestsView.vue` defines scrollbar width, height and thumb rules outside `src/scrollbars.css`. This is unrelated to Claude profiles and is left unchanged.
- Existing work at the start consisted of the untracked design folder from the preceding task.

## Independent review requirements

- Profile IDs must come from a server-owned registry. No chat request may inject an environment map or transcript root.
- A run freezes its account identity, environment and root; queue, resume, follow-up, fork, checkpoints, usage and cancellation must retain that identity.
- The original Default profile preserves unset environment semantics, old keys and visual bindings.
- Login is interactive in a profile-bound PTY. Reconnect must not attach the wrong account/purpose, and login/run races must be guarded in both directions.
- Transcript reads and resume paths must remain inside the profile's real root, including Windows junctions and duplicate session IDs.
- Removing a registration preserves its files and credentials and cannot silently reassign a schedule or existing chat.
- Models, skills, auth status, usage and MCP changes stay scoped to one account, including reauthentication.
- Approved UI structure, tokens, keyboard behavior, outside dismissal, canvas zoom and reduced motion must survive integration.
- Test state must remain in isolated databases and temporary CLI homes. Never authenticate or run inference through the owner's real accounts as a test.

## Final verification

### Sidebar spacing, renaming and approved chooser, 26.11.2026

Implemented the owner's UI Maker r2 **Row choice** pick (saved as v2): visible custom account radios, selected-row New chats marker, keyboard arrows/Home/End and inline pencil renaming with Enter/Save and Escape/Cancel. Names remain labels on stable account IDs and immutable configuration folders. The sidebar reserves eight pixels outside the scroller only when its Settings footer exists.

`tests/agent-sidebar-spacing.spec.ts`: 2 passed on the final source, covering the actual sidebar stylesheet with 35 overflowing rows, visible radio selection, keyboard focus, rename cancellation, duplicate-name errors and persistence after reload. The geometry assertion first failed at zero pixels before the spacing fix. Both UI Maker variants were rendered and selection/rename interactions checked before the owner picked. Final account and sidebar renders were inspected. `pnpm type-check`, `pnpm exec vite build` and `git diff --check` pass. CSS guard retains its four existing `FlowTestsView.vue` scrollbar violations, with no new violations. Tests use mocked profile APIs and isolated fixtures; no real profile was renamed or switched.

### GitHub branch correction, 26.11.2026

The owner's missing changes were on GitHub branch `codex/host-and-delegation`, commit `eb8895473703edd2572482f4fcd67eb9eafc5122` ("reuse desktop Agent Sessions on LAN"), not on `master`. This was verified directly through authenticated `gh api repos/moundeveloper/orvane/branches`, rather than inferred from a cached master reference. The feature checkout was fast-forwarded to that exact commit and the subscription work reapplied from a retained recovery stash. Its upstream now follows `origin/codex/host-and-delegation`.

The newer commit's Host gateway, shared desktop session page, UI Maker changes, subagent transcript filtering and styles are preserved. Subscription integration now uses that gateway instead of the superseded Host chat implementation. The Host can read account labels and availability, while local config paths, draft folders and account-management actions stay on desktop. Gateway session-ID checks also match provider and account. Build, type checking and the 11 Node regressions pass after this integration. Earlier verification below is historical.

Combined runtime run (`%TEMP%/orvane-github-sync-tests.log`): 3 passed (account isolation/concurrency, direct delegation, HTTPS Host sign-in/revocation); 3 failed (the existing Agent Sessions UI test timed out on a disabled creation button; Host's file-list assertion received no `src` folder; Host restore could not find OpenSSL). The Host gateway test reached and passed the added account metadata redaction and desktop-only account-management checks before its file-list failure. These results do not establish a fully green application suite. No unresolved Git conflicts remain, no new commit or push was made, and both recovery stashes were retained.

### Main-branch sync, 26.11.2026

The original implementation checkout was based on `1b8d139`, while the locally available `origin/master` had advanced through `3e59ad7` to `2586765` (Orvane Host, delegation and UI Maker updates). On the owner's report of missing features, the feature branch was fast-forwarded to `2586765` and the subscription changes reapplied. A named stash retains the complete pre-sync work as a recovery copy. No new commit, push or merge into master was made.

Conflicts were combined to preserve Host settings, pane shortcuts, delegation run IDs/environment/queues and the account controls. Existing Host and delegated Claude launches explicitly bind Default; their existing interfaces are preserved. Account sign-in terminals remain excluded from Host's shared terminal listing and attachment endpoints. Type checking, production build and all 11 focused Node regressions pass after integration. Fresh remote fetch was unavailable because SSH authentication failed, so equality is verified against the locally available `origin/master` reference.

Post-sync runtime checks: account concurrency/isolation passed. All three Host checks passed (HTTPS sign-in/revocation, saved edit modes, shared transcript resume after a lost acknowledgement) after their standalone runner fixtures were updated to bind the isolated account and exact transcript paths like the desktop API. A new direct desktop delegation regression passed: Default binding, caller-provided run IDs, replay and follow-up identity. The broader MCP delegation test timed out at 120 seconds and remains unverified. Logs: `%TEMP%/orvane-master-sync-tests.log` and `%TEMP%/orvane-master-sync-final.log`. `git diff --check` passes; no unresolved Git conflicts remain.

### Original implementation checks, 25.11.2026

- Final `pnpm type-check` and `pnpm exec vite build`: passed. Vite reports its usual large-chunk warning.
- Focused Node regressions: 11 passed across registry, login reservation and exact transcript resume tests.
- Final targeted browser run: 13 passed across account UI, sign-in/reconnect, removed-account read-only history, usage/list identity, continuation, exposition, terminal output and canvas zoom/groups. Its API concurrency case encountered `ECONNRESET`; a subsequent isolated run with closed HTTP connections passed, including duplicate UUID isolation, simultaneous runs, queues, usage, MCP, scheduled execution/result identity and removal guards. Mutation requests are never retried.
- `pnpm test:css`: retains exactly the four pre-existing `FlowTestsView.vue` scrollbar violations; no new component violations.
- The earlier existing agent suite completed with 13 passes and 3 failures (launcher MCP timing, Codex plan-mode expectation, and file-change approval timing). The full suite is not green; a broad run also reported unrelated NetSuite processing-page unit failures before it was interrupted. These were not changed as part of account support.
- Tests use isolated workspace databases, temporary profile folders and a fake CLI. Live OAuth and inference with two real subscriptions were not exercised.
- Electron Browser Ctrl+F/count/next/previous regression: passed against the built app. A cold UI screenshot rerun found the account-creation assertion used the generic five-second timeout while the CLI auth check was still running; the test now waits up to 30 seconds for the accessible account row. The subsequent screenshot-only rerun hit the overall 120-second timeout without a page snapshot, so repeated cold UI verification remains intermittent despite the earlier passing interaction run. No production behavior was changed to conceal this limitation.
- No production workspace data, user PowerShell profile, account credentials or transcript contents were migrated.

## Findings to resolve before final verification

- Resolved by Codex: `ClaudeProfiles.add` serializes additions and commits against fresh state after awaited filesystem validation. Four independent regression cases reproduced lost registrations, duplicate folder claims, duplicate names and the containment error before the fix; all pass afterwards (`node --import tsx --test tests/claude-profile-registry.test.ts`). Synchronous rename/default/remove operations cannot be overwritten by a stale registry snapshot.
- Resolved by Codex: `within` compares path components for parent escapes. A descendant named `..account` remains inside its parent and cannot bypass overlap validation.
- Resolved by Codex: cancelling a started login retains the account reservation until its PTY actually exits. The independent test first reproduced premature release; both cancellation cases now pass (`tests/claude-login-reservation.test.ts`).
- Resolved by Codex: `profileViews` only shows usage after a supported current login matches its fingerprint. The isolated API regression (`claude-profile-usage.spec.ts`) first displayed cached limits with no known current identity, then passed after requiring confirmation.
- Resolved by Codex: the runner rechecks profile availability synchronously before registration, including queued/text jobs. A regression test first reproduced the removal-during-folder-validation race; it now prevents CLI lookup or run registration after removal.
- Resolved by Codex: resume uses the selected transcript key when available, validates its profile/UUID and rejects ambiguous ID-only lookups. An independent regression test first reproduced a copied UUID resuming the wrong project transcript, then passed after the fix (`tests/claude-resume-key.test.ts`).
- Resolved by Codex: the usage pill clears old values when its account changes and ignores out-of-order responses. The isolated Vue harness first reproduced a delayed Default response replacing Work's limits, then verified request-version protection.
- Resolved by Codex: approval/checkpoint history filters both provider and account, including preview/restore. An independent same-UUID regression first reproduced Codex history appearing in Work's history and now passes.
- Resolved by Codex: Add account waits for a valid server-issued draft; MCP rows refresh after registry changes; a started chat locks its profile; sign-in Terminal lookup survives a page reload. The real-app account UI and fixture login/reconnect tests pass.
- Resolved by Codex: the main list, launcher list, pending-run grouping and pinned activity bubble now match composite session identity; the launcher list also labels accounts. A browser regression first reproduced both copies of a UUID appearing to run, then passed with one matching account. Scheduled results record their original account separately from the editable schedule and reopen that exact account's session.
