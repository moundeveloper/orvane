# Claude accounts: coordination record (Claude ↔ Codex)

**Follow-up, 26.11.2026:** owner requested a gap above the sidebar's Settings footer, renaming existing accounts, and a clearer default-account chooser. After asking to see UI Maker mocks first, picked `claude-accounts/r2/row-choice` over the unselected `default-picker`; saved as v2. Both mocks were rendered and their selection/rename interactions checked. Production uses the chosen visible row radios and inline pencil renaming. The sidebar geometry regression reproduced a zero-pixel gap before the fix and passes with an eight-pixel external gap when Settings is present.

**Implementation, 25.11.2026:** the owner approved all three mocks and requested implementation. Claude produced the account implementation; Codex reviewed and corrected isolation, concurrency, resume routing and UI integration, then ran independent regressions. Claude reached its subscription limit during this coding pass. The implemented behavior and verification limitations are recorded in `IMPLEMENTATION-REVIEW.md`; the design-phase notes below are historical. No commit, push or merge was performed.

**Final Codex verification:** after Claude's revision, Codex ran isolated Playwright interaction checks against all three local HTML files using installed headless Edge, with network blocked. Keyboard focus/selection, signed-out selection guard, editing keys, outside dismissal, repeated Check now, removal cancellation and blank-new-chat simulation passed with no page errors. All final Lab variants were also rendered and inspected. These results supersede the earlier statement below that Claude had not run the interactions. Details are in `REVIEW-NOTES.md`. Application suites and real subscription runs remain unexecuted because this is the design phase.

Date: 25.11.2026. Branch: `codex/claude-subscription-design`. Design phase only: no production code, no auth, config or transcript changes, no commits.

## UI Maker

| What | ID |
|---|---|
| Component | `claude-accounts` ("Claude accounts", 1200×720) |
| Lab round | `r1`, "Claude accounts per chat" (kind `new`, base v1, status open) |
| Variant 1 | `account-pill`, label "Account pill". Local copy: `mock-1-new-chat-account.html` |
| Variant 2 | `settings-accounts`, label "Settings accounts". Local copy: `mock-2-settings-accounts.html` |
| Variant 3 | `two-accounts`, label "Two at once". Local copy: `mock-3-concurrent-sessions.html` |

- The local HTML files are byte-copies of `.orvane/uimaker/components/claude-accounts/lab/r1/*.html`, re-synced after revision 2.
- Every variant was re-rendered with `uimaker_lab_view` after revision 2 and inspected; nothing is clipped or misaligned.
- All fixture data is labelled in each variant's About text: names, `*.example` emails, plans, usage, folders, titles and timings.

## What each variant shows

1. **Account pill.** In a new Claude chat's composer, an Account pill opens a listbox of accounts with email and plan, that account's 5-hour usage, the folder, and keys 1-3.
   - A signed-out account shows Sign in and can't be picked.
   - The footer reads "Only this new chat. Open chats keep their account."
   - The usage pill names its account, and sidebar rows get an account tag.
2. **Settings accounts.** A "Claude accounts" section in the existing Settings page.
   - Adding an account happens inline in three steps: a new empty folder → a Terminal running `claude auth login` bound to that folder → Check now (`claude auth status`).
   - Remove asks inline. It keeps the folder and the sign-in and never signs out.
   - The page also has a "New chats" marker and MCP per account.
   - The footer reads "Existing chats keep their account. Choose another account for a new chat."
3. **Two at once.** Two split tiles run on Work and Default at the same time.
   - Each tile has a locked account chip, a dashed locked pill in the composer, and that account's usage.
   - The chip menu explains the binding and offers "Start a new chat on <account>". That opens a **blank** draft, nothing is copied, and the current chat keeps running.

## Recommendation (Claude)

Build all three as one feature. They are complementary:

- the **pill** is where an account is chosen;
- **Settings** is where accounts are added, signed in and removed;
- the **tile chip** shows which account a chat is bound to and starts a blank chat elsewhere.

A smaller first cut is Settings plus the pill (with row tags and locked pills), then the tile chip menu.

Moving a conversation's history across accounts is **deferred**. It was not requested, and no mock implies it.

## Codex review, revision 2: what was accepted

All 7 points were accepted. Changes:

| # | Codex point | Done |
|---|---|---|
| 1 | Non-goals wrong about API keys; paraphrase sources; no Console warning UI or check-all | PLAN §1: API billing is out of scope (not "unsupported by the docs"). Console keyless is the only isolation exception. A plain per-profile "unsupported sign-in" status (A18). §3 sources paraphrased. The warning UI and check-all mitigations were removed. |
| 2 | Remove cross-account continuation everywhere | Removed from all three mocks, all About texts, PLAN (§1, §6, §8, §11) and this file. The mock 3 chip menu now offers "Start a new chat on …" (a blank draft), and its toast reads "New blank chat on Default · this chat keeps running on Work". The mock 2 footer was replaced. Same-account Continue with another model keeps its profile (PLAN §1, §4). History transfer is listed as deferred (§12.8). |
| 3 | Keyboard defers to text fields, focus vs selection, no global chord, mock 2 `check()` bug | All `Alt+A` / `Alt+N` chords were removed. Mocks 1 and 3: keys are handled only on the open list or menu, and Enter, Space or ↓ on the button opens it and focuses the committed (mock 1) or first (mock 3) item. `.active` and focus track navigation, while `aria-selected` stays the committed account. The mock 1 composer field is now `contenteditable`, so typing there can be tried. Mock 2: `check()` is guarded and idempotent, and its keydown ignores editable targets. |
| 4 | Resume isolation as a required criterion | PLAN §6 and A15 make it a release gate: an absolute `.jsonl` path inside the profile root, failing closed with no Default fallback, plus a real-CLI scope check in temp homes when that is possible without sign-in. |
| 5 | Cache invalidation; old usage unknown; Default env can change | PLAN §4, §5, §7: a fingerprint per profile (effective dir plus non-secret auth identity fields). A change drops that profile's usage, models and auth memo (A17). The old provider-wide usage migrates to unknown, not Default. |
| 6 | MCP isolation checks; dock/pin/split/source links; path validation for folders that don't exist yet | A16 (MCP files hashed before and after), A13 extended to launcher, pin, split, reopen and source links, and a source-links row in the §4 code map. §5: nearest-existing-ancestor `realpath`, re-validation after mkdir, symmetric nesting and alias checks (A14). |
| 7 | Existing folders are an owner choice; no copy, no forced emptying | §5 and §12.3: a generated folder must be new or empty, and Orvane creates it with nothing copied. A selected existing folder (if the owner wants it) is used as-is. The mock 2 step text now reads "new empty folder created by Orvane". |

**Disagreements: none.** One correction to my earlier docs note: the PLAN no longer proposes the Console warning UI or the check-all-accounts step that I added in revision 1.

## Verification status (honest)

- **Done:** Lab re-renders of all three variants, visually inspected after the edits; grep showing no "continue in another", Alt chords or "as reference" left in the mocks.
- **Not done: functional interaction tests did not run.**
  - I wrote a scratch Playwright script at `%TEMP%\claude-accounts-check\check.cjs` (outside the repo; it only reads the three HTML files).
  - It checks typing in the field, pill and menu keys, focus vs aria-selected, outside dismiss, no Alt chord, double Check now without errors, Esc in a field, and the blank-chat toast.
  - Running it needed approval and was refused in this session. The Orvane Browser also refused the `file://` addresses.
  - So the keyboard and `check()` fixes are **verified by code review and render only**. To run it, with approval: `node %TEMP%\claude-accounts-check\check.cjs`.
- No automated tests of Orvane were run (no production code changed).

## Pinterest research: blocked (unchanged)

- The board tab in Orvane's Browser was `visibilityState: hidden` (the app was off-screen), so no pins rendered, and the resource API returned "Invalid Request".
- I did not move the owner's camera. No references were proposed.
- The mocks reuse established Orvane parts instead.
- To finish: put the Browser on screen and rerun `reference/research.md`.

## Docs verification (25.11.2026, web fetch)

Paraphrased; see the PLAN §3 table.

- Confirmed: separate config dirs isolate claude.ai logins and API keys. Console keyless is the documented exception. On Windows the credentials file sits under the config dir when it is set. `auth status` is JSON and reports the config dir from 2.1.268.
- Not documented:
  - the ID-based `--resume` scope relative to the config dir, hence A15;
  - what `auth logout` removes (Orvane never calls it);
  - whether limits are shared across folders on one subscription. This is inference only, and the mocks no longer state it.
- `authMethod` docs list `oauth_token`, while `server/agent-cli.ts:284` accepts `"oauth"`. Verify this in implementation.

## Next steps

1. The owner reviews `claude-accounts` round `r1` and picks or comments. Implementation waits for that approval.
2. Optionally, with approval, run the scratch interaction script.
3. Implement per PLAN phases 1-6, with A15 as a release gate. The Windows two-account smoke test is user-assisted after that.
