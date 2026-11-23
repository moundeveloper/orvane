# Handoff: UI Maker mocks to build (temporary)

Temporary folder so work can continue on another machine. The mocks live in UI Maker Lab on the owner's office machine (`.orvane/uimaker/components/<id>/lab/r1`); this is a copy. Delete this folder once the designs are built.

Each folder holds the Lab round: one self-contained HTML file per variant, plus `round.json`, which has every variant's `about` (what it is, how it works, what building it takes). Open the HTML files in a browser to see them. To bring them back into UI Maker Lab on another machine: `uimaker_create` a component with the same name, `uimaker_lab_round`, then `uimaker_lab_write` each HTML with its `about`.

**When you are done:** only after the owner has seen the result and says it matches what they want:
1. Delete this `docs/handoff/` folder, plus any temporary files or test configs you made (keep the real tests).
2. Commit everything on a feature branch with conventional subjects, then merge it into `master`.
3. Do not push: the owner pushes.

**Rule from the owner:** build the mocks as designed, every detail. Reuse Orvane's established parts (DNA loader, drawn tick, run activity rows, frost glass, kbd hints). Do not swap in a simpler existing screen. Before calling it done, put a screenshot of the real app next to the mock and check each detail.

## 1. `ai-launcher-sessions`: chat with a session in place

Variants: `picker.html` (AI launcher, Sessions tab) and `pinned.html` (chat pinned to the right side). The owner asked for **both**, "with the already established chat UI look". That means: the mock's design, with the chat drawn in Agent sessions' style. It does not mean dropping the mock's extras.

**State of the code (uncommitted on the office machine; may not be in the repo yet):** a first version exists: `src/components/SessionChat.vue` (embeds `AgentSessions.vue` in pane mode), `src/components/SessionList.vue`, the Sessions tab in `src/components/AgentLauncher.vue`, the `.side-chat` panel and Ctrl+Shift+J in `src/App.vue` and `src/editor.css`, and the test `tests/side-chat.spec.ts`. The owner rejected it as a "crappy version" because it is missing these mock details:

- The launcher shows the **session list and the open chat together** (the build shows one or the other, with a Back button).
- The **DNA loader** next to "working" in the list (the build uses a pulsing dot).
- **Compact tool rows** with drawn ticks, the DNA loader on the current step, and times (the build embeds the full transcript).
- An amber **question card** with answer buttons when the agent waits for the owner.
- A header with the **C/X provider badge**, the title and a dropdown.
- A **compact composer**: one field with the send button inside (the build's full composer wraps its pills at 400 px).
- **Kbd hint footers**: `↑ ↓` session, `Enter` open, pin, `Esc` close / type-here, unpin.
- **The canvas shrinks and the dock shifts** when the panel is pinned (the build overlays the canvas).
- **Ctrl+Shift+A** jumps into the panel's composer. The pin toggle is Ctrl+Shift+J, because Ctrl+Shift+P already opens commands.

Notes: Ctrl+Shift+K opens the launcher. Sessions come from `agentRequest("sessions")`, which returns `{ sessions, runs }`; a run with `awaitingApproval` means the session is waiting for the owner. Popovers must dismiss on outside pointerdown and Esc. Browser tests: the shared Playwright config uses port 5174; when another agent is running tests at the same time, use a copy of the config on another port.

## 2. `recorded-test-runs`: record and replay test runs

Variants: `replay.html` (Run replay), `live.html` (Live recording in a Browser tab), `suite.html` (Flow tests list) and `run-map.html` (Run map with the agent session beside it). **None of these screens is built yet.** The back end exists and is merged on `master`:

- `browser_record` (`electron/page-recorder.mjs`, plus the record ops in `src/browserAgent.ts`).
- `flow_tests`, with `explore`, `plan`, `generate`, `run`, `failure`, `rerun` and `history` (`server/flow-tests.ts`).
- The `expect` flow step, and Test plans in Site memory.

On the office machine, another session had started on this UI. It added live progress (`live.json`) and step labels and URLs in `server/browser-tools.ts` and `server/flow-tests.ts`, plus a `tests/flow-tests-app.spec.ts`. Check what reached the repo before starting.
