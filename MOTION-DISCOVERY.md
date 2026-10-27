# Orvane motion discovery

Mode: CHANGE. Scope: animation refinement of the existing app. Preserve its current visual language, input ownership, saved data, reduced-motion support, and the corrected camera geometry/timing.

## Q1 — Areas and exclusions (answered)

User answer: “D, C, B, A I like all of them” and explicitly hates all five offered failure cases.

Chosen, in supplied order:
1. D — Changes inside apps: list additions/removals, checkboxes, values.
2. C — Builder transitions: side panel, node editor, expanded code editor.
3. B — App creation/switching: arrival, dock activation, focusing apps.
4. A — Menus/popovers: app options, Groups, dropdowns, Add node.

Explicit exclusions: bouncing/overshooting; staggered button entrances; surrounding content moving to accommodate an animation; waiting before clicking or typing; lingering closing animations.

Confirmed reference: existing K-search animation, with comparable subtlety elsewhere. The content mix was subsequently delegated in Q2; exact durations were not explicitly approved.

## Q2 — Motion language for content changes (answered)

Matched interactive candidates: Soft fade, Small reveal, Quiet highlight. Same list, checkbox and counter in each. Proposed example duration 160ms, illustrative only. Data updates synchronously, no bounce/stagger, reserved comparison layout, and immediate removal. Reduced-motion preference disables the demo motion.

User answer: “mix them where it makes sense. what i hate is jittery animations that ruin the experience.” The user delegates the component-specific mix rather than choosing one uniform candidate. Jitter is explicitly excluded.

Selected implementation direction under that delegation: small contained reveals for new rows, opacity fades for changing values, and quiet local highlights for checkbox feedback. Data and input responses stay immediate. Removal does not linger. Example duration remains a proposal rather than an approved token. No additional rejection of rolling digits or animated strikethroughs was independently stated; avoid them in the delegated mix as an implementation choice, not a fabricated user exclusion.

Jitter prevention implications: animate opacity/contained transforms rather than layout dimensions, cancel or retarget interrupted effects from their current state, avoid stacking animations on the same element, and preserve the corrected camera pipeline.

## Q3 — Builder entry and workspace switching (implementation defaults; no explicit option selection)

Compare a short reveal of the side panel plus workarea crossfade, matching source-anchored reveals for panel and advanced workspaces, or opacity-only transitions throughout. Maintain the existing app dimensions, resizable panel controls, immediate keyboard/pointer access, and no animated reflow of the app preview.

## Live implementation

The next user message, “I don't see the animations it looks just like before,” was treated as steering to apply the agreed direction to the running app instead of continuing preview-only discovery. The earlier examples had not modified the product; this was explained before implementation.

Applied content mix: new rows reveal by 3px over 160ms; values fade over 130ms; checkbox labels receive a local 180ms tint. Removals are immediate. Nothing loops or staggers, and data updates do not wait.

Restrained implementation defaults for the remaining approved areas: builder panel enters by 4px over 180ms, node/code workspaces fade over 130ms, new apps arrive by 5px over 170ms, and popovers reveal by 3px over 160ms. These are implementation choices, not an explicit user selection of Q3 A/B/C. Existing K-search and camera animations are preserved. No exit animation is added. Builder resizing, user content layout and external app dimensions are not tweened.

One managed animation per affected element retargets from its currently rendered state on repeated interaction. Reduced-motion preference skips the new effects. Live-interface tests cover actual animation calls, immediate state changes, interrupted fades, instant dismissal, fixed dimensions, and reduced motion, alongside the existing camera frame trace.

Follow-up delegation: “commit and add animations where it makes sense” with subtle motion and no jank. Newly added builder components and graph nodes now use a 130ms opacity-only reveal; existing nodes and components do not replay on initial load. Restored apps use the same 170ms arrival as new apps. Runtime errors and graph notices fade in locally over 130ms. Node geometry, wire sockets, user resizing and the canvas camera remain outside these decorative effects. No stagger, bounce, animated layout reflow or delayed dismissal is introduced.

## Open details

Taste feedback on the live defaults, any refinements to timings, and whether further C/B/A interviews are useful. Natural data-driven layout changes happen immediately; no extra animated reflow is introduced. Do not present implementation defaults as explicitly selected taste decisions.
