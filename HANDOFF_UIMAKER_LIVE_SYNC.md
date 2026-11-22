# Handoff: flaky `tests/uimaker-live-sync.spec.ts`

Status as of 2026-11-22. Branch `feat/next`. The only uncommitted change is the test edit below. Nothing committed for this yet.

## Symptom

The two editor tests in `tests/uimaker-live-sync.spec.ts` fail some of the time:

- "UI Maker shows a component added from outside the editor without a reload"
- "UI Maker takes an artboard size set from outside, without undoing its own size changes"

The two MCP tests in the same file (`uimaker_size`, `uimaker_create`) always pass.

## Found so far

1. **The first UI Maker mount waits longer than the test allows.** On a fresh test dev server (port 5174), the first UI Maker app compiles its editor on demand. It took 8.6-9.4s in four measurements. `openUiMaker` sets `p.setDefaultTimeout(8000)` and then waits for `.help` (the first-run "How it works" overlay), so it timed out with an empty UI Maker app.
2. **The cold first page load is slow.** `p.goto("/")` (waiting for `main[data-ready]`) took 26-40s on a fresh server. There was no dependency re-optimization: `node_modules/.vite/deps/_metadata.json` was unchanged and there was no "optimizing dependencies" log. It is plain cold transformation of the module graph. With the mount, the first test came close to or over its 60s budget ("Target page, context or browser has been closed").
   - Total spec time is either about 1.0m (all 4 pass) or about 2.0m (one test fails). The slow runs are the failing ones.
   - CPU load during the runs was about 26%, so it is not machine load.
3. **Remaining failure, cause not confirmed yet.** After the timeout changes, slow (~2.0m) runs still fail one assertion in the first test:
   - sometimes `expect.poll(... state.components names).toEqual(["Card", "Wheel", "Third"])` (line ~55, 5s poll);
   - once a plain `toEqual` (deep equality), probably at the same check.

   Open question: is this only the 5s poll timing out on a slow server, or a real race where the editor's save overwrites the component added from outside ("Wheel")? The second would be a product bug in UI Maker's live sync (`src/components/uimaker/editor.js` save/merge, `server/uimaker-api.ts` state/save).

## Uncommitted test change (in the working tree)

In `tests/uimaker-live-sync.spec.ts`:

- `openUiMaker`: `.help` wait raised to `{ timeout: 30_000 }`, with a comment explaining the about-9s first compile.
- The two editor tests: `test.setTimeout(60_000)` raised to `120_000`. The MCP tests are unchanged.

With these changes: 4 runs fully passed (about 1.0-1.1m) and 2 runs had 1 failure (about 2.0m, at the state assertion in item 3).

## Next steps

1. Catch a failing run with details. Loop the spec (one at a time, `--workers=1`) and save each log. On failure, read the received value: which components the saved state had (Card + Third without Wheel would mean the race).
   - Test-results error-context files get overwritten by the next run, so save the logs to a scratch folder.
2. If Wheel is missing: it is a real race. Look at how the editor merges outside changes before saving (`follows outside changes`, commit 8e2392c, "UI Maker follows outside changes and gains uimaker_size"). Fix it there, and confirm the test fails on the old code.
3. If the list is right but late: the state poll needs a longer timeout on cold servers (e.g. `{ timeout: 15_000 }`). Keep it test-only.
4. Optional, ask the owner first: `server.warmup` in `vite.config.ts` could cut cold page and editor compile time for tests and the first open after an Orvane restart. That is a config change outside the test, so don't do it without the owner's go-ahead.

## Neighbour status (same session)

- `tests/uimaker-lab.spec.ts`: failed once, then passed. Same cold-start pattern, most likely.
- `tests/uimaker-open.spec.ts`, `tests/design-guide.spec.ts`: pass.
