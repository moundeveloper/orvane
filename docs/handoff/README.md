# Handoff: UI Maker mocks to build (temporary)

Temporary folder so work can continue on another machine. The mocks live in UI Maker Lab on the owner's office machine (`.orvane/uimaker/components/<id>/lab/r1`); this is a copy. Delete this folder once the designs are built.

Each folder holds the Lab round: one self-contained HTML file per variant, plus `round.json`, which has every variant's `about` (what it is, how it works, what building it takes). Open the HTML files in a browser to see them. To bring them back into UI Maker Lab on another machine: `uimaker_create` a component with the same name, `uimaker_lab_round`, then `uimaker_lab_write` each HTML with its `about`.

**When you are done:** only after the owner has seen the result and says it matches what they want:
1. Delete this `docs/handoff/` folder, plus any temporary files or test configs you made (keep the real tests).
2. Commit everything on a feature branch with conventional subjects, then merge it into `master`.
3. Do not push: the owner pushes.

**Rule from the owner:** build the mocks as designed, every detail. Reuse Orvane's established parts (DNA loader, drawn tick, run activity rows, frost glass, kbd hints). Do not swap in a simpler existing screen. Before calling it done, put a screenshot of the real app next to the mock and check each detail.

## `recorded-test-runs`: record and replay test runs

Variants: `replay.html` (Run replay), `live.html` (Live recording in a Browser tab), `suite.html` (Flow tests list) and `run-map.html` (Run map with the agent session beside it). **None of these screens is built yet.** The back end exists and is merged on `master`:

- `browser_record` (`electron/page-recorder.mjs`, plus the record ops in `src/browserAgent.ts`).
- `flow_tests`, with `explore`, `plan`, `generate`, `run`, `failure`, `rerun` and `history` (`server/flow-tests.ts`).
- The `expect` flow step, and Test plans in Site memory.

On the office machine, another session had started on this UI. It added live progress (`live.json`) and step labels and URLs in `server/browser-tools.ts` and `server/flow-tests.ts`, plus a `tests/flow-tests-app.spec.ts`. Check what reached the repo before starting.
