---
name: orvane-design
description: How to design UI the way the Orvane owner likes it - research on their Pinterest board, translation into Orvane's soft light look, reuse of established parts, Lab variants with real content, and the owner's past decisions. Use for any UI, design, mockup, redesign, component, animation or "make it look good" work in Orvane or the owner's other apps.
---

# Orvane design method

This is the method behind the designs the owner approved: the Agent sessions run activity, the drawn tick, inline step details, the AI composer on frost glass, the DNA working indicator, the radial wheel "Glow Blend", and the Board ideas rounds (thinking trail, slash skills, files changed, effort and mode, message actions, session timeline, workflow library, action menu, day rail, run plan, create menu, folder cards, inbox triage). Follow it step by step. The references hold the detail:

- `reference/look.md`: tokens, type, spacing, recipes for every recurring part (with CSS).
- `reference/motion.md`: what moves, how long, and what the owner rejected.
- `reference/research.md`: how to mine the owner's Pinterest board and translate pins.
- `reference/taste-log.md`: the owner's own words on past designs: picks, rejections, corrections.
- `examples/`: approved designs as self-contained HTML, each with a PNG render.

## The feel, in one paragraph

Orvane is **soft and sophisticated**, not cyberpunk. A cool blue-gray canvas (`#e9edf0`), off-white apps (`#f7f9fa`), slate text (`#455968`), a muted steel-blue accent (`#6f8998`) and a deeper "working" blue (`#365f78`). Inter, compact 12-14px controls, 6-10px radii, sparse 1px dividers, soft two-layer shadows. AI surfaces float on **frost glass** like the top bar. Dense information is calm because hierarchy comes from weight and tone (strong `#273f50` → text → muted → faint), never from color blocks or borders everywhere. Every mock looks like a real, finished piece of Orvane on a working day, not a concept slide.

## Step 1 - Understand the job before drawing

1. Name the app, the moment and the user's action: "while a run works, the user wants to follow it without opening anything".
2. Read the code that would feed it. A design is only good if it can be built from data Orvane has or can cheaply get. Note what exists (e.g. runner activities with input/output/timing, `automation_runs`, `triggers.ts` schedules, `git status`). Each idea in `BOARD_IDEAS.md` ends with a **Build** line; do the same.
3. Find the established parts that already solve pieces of it (see the table below). **Reuse them.** The owner corrected a mock that invented a new orb instead of using the established DNA loader: "put the already established ai loader there".
4. Check the standing rules: light theme only, custom controls only (no native select/date/number/color), keyboard first (every action has a key or Ctrl+K entry; shortcuts defer to text fields), no dashboards, hero sections, wizards or modal creation flows, no sticky translucent table headers.

## Step 2 - Research on the owner's board (for new ideas and redesigns)

Use the owner's Pinterest **Web design** board (`pinterest.com/articempire/web-design/`) in **Orvane's Browser** (`browser_open`, `browser_act`), not your own browser: the owner is signed in there. Details and scripts in `reference/research.md`. In short:

- Scan the most recent pins first (they show the current taste: light/dark AI agent UIs, command menus, composers, thinking states, timelines, node editors). Older pins drift to HUD/sci-fi and posters: ideas only.
- For each pin, write down the **interaction idea**, not the skin: "searchable action menu with sections and shortcut hints", "vertical trail of steps with one muted detail line and file chips".
- **Translate** into Orvane: keep the idea, structure and density; drop dark backgrounds, neon glow, liquid metal, HUD chrome, gradients-as-decoration, dashboards and KPI tiles.
- Propose the pins you used as references with `uimaker_reference_propose` (real images, source URL in each caption) and let the owner pick. Never attach references without their pick.

## Step 3 - Make Lab variants

Use UI Maker Lab (`uimaker_lab_round`, `uimaker_lab_write`, `uimaker_lab_view`).

- **One idea per variant**, 1-3 word label ("Thinking trail", "Files changed"). Several variants when the owner should compare. No headings, captions or explanations on the page: the design alone on the plain canvas stage.
- **Start from the shared skeleton** (`reference/look.md` → "Page skeleton"): the `:root` tokens, Inter, the canvas body, one `.app` card 760px wide with the app shadow. Fork the first variant with `from` + edits for siblings.
- **Real content only.** Realistic Orvane data: real file names (`AgentSessions.vue:370`), real commands, real skills (`/scoped-fix`), real app names, plausible times (`0:18`), counts that add up. Never lorem ipsum, "Item 1", "John Doe" or marketing copy. Text is short, specific and in the owner's plain voice.
- **Show the interesting state.** The menu open with a row selected, the step running with the next one waiting, the diff expanded, the hover/selected row visible. A mock frozen at its most informative moment beats an empty one.
- **Prototype the change of state.** Start where the user decides or acts. Let them take the action and see where they land, what stays in view, and how to return. Test the parts that must survive the transition, such as a draft, scroll position, or selected file. Compare the mock with the real app at the same viewport. See [Mockup review](reference/mockup-review.md) for examples.
- **Give a separate builder the workflow and checks.** Include an approved example, realistic starting data, and observable outcomes. Replay the result before passing it back. See [Flow review](reference/flow-review.md) for the repair loop and evaluation method.
- **Show the keys.** `kbd` hints (`Tab`, `↑ ↓`, `Ctrl+K`, `/`) in footers or beside items. The owner is keyboard-first.
- **Build real states** in the HTML: hover, focus-visible, selected (`aria-selected`), disabled. Use semantic roles (`listbox`, `option`, `toolbar`).
- **Motion in mocks** follows `reference/motion.md` and always has a `prefers-reduced-motion` fallback.
- Check each variant with `uimaker_lab_view`/`uimaker_render`. Fix anything clipped, wrapped, misaligned or off the centre line before showing it.

## Step 4 - Present and record

- Tell the owner what each variant is in one line each, which pin inspired it, and what it would take to build. Keep a markdown record (like `BOARD_IDEAS.md`): Pin, What, Why, Build, plus a "Left out on purpose" list.
- When the owner picks, implement exactly the picked variant; carry its values over literally.

## Step 5 - Implementing in Orvane

- Match the mock's tokens and spacing exactly; reuse Orvane components (`CustomSelect.vue`, `src/components/pickers/`, `ImagePeek.vue`, `AgentRunActivity.vue`, `ContextPicker.vue`, `Icon.vue`).
- Toolbar items share one centre line. Popovers follow `.select-popover`, dismiss on outside pointerdown without stealing the click, and scale with canvas zoom.
- Scrollbars: narrow, muted, no arrow buttons, everywhere.
- Verify with a screenshot in the real app; compare against the mock side by side.

## Established parts to reuse

| Need | Use | Where |
|---|---|---|
| AI working | DNA loader (dot pairs pinch, travel right like a helix, 1.74s) | `.cs-dna` in `src/components/AgentSessions.vue`; `examples/dna-loader.html` |
| Step finished | Drawn tick (stroke draws in 260ms), never strikethrough | `AgentRunActivity.vue`; `examples/drawn-tick.html` |
| Tool / step list | Run activity rows, inline expand for input/output/duration | `AgentRunActivity.vue`; `examples/step-details.html` |
| AI prompt | Frost-glass composer, chips inside the field, send inside | `examples/composer-glass.html`; Agent sessions composer |
| Pick a file or folder | `@` picker, Tab adds a context chip | `ContextPicker.vue` |
| Dropdown | `CustomSelect.vue`; long lists (models) get a search field | `src/components/CustomSelect.vue` |
| Date / time | `TimePicker`, `DatePicker`, `MonthYearGrid` | `src/components/pickers/` |
| Image viewing | Full-window Peek, wheel zoom at pointer, arrows | `ImagePeek.vue` |
| Command search | Ctrl+K palette | `CommandPalette.vue` |
| Text that shimmers while live | gradient text sweep, 1.8s linear | `examples/thinking-trail.html` |

## What the owner rejects (do not ship)

- Cyberpunk / glitch / neon / HUD styling; anything "jarring" or "glitchy" (text that disappears and reappears).
- Bouncing, overshoot, staggered entrances, a "jump" at the start of an animation, layout that moves to make room for an animation, waiting before input works, lingering exits.
- Bulky indicators: keep loaders small and compact (the DNA loader had to be compressed in width and its merged dots made smaller).
- Native-looking controls and default scrollbars with arrows.
- The sparkles icon for AI. Use function-specific icons (the Orvane AI mark).
- Strikethrough "Done", a line through the middle of tool rows.
- Dashboards, KPI tiles, hero sections, wizards, modal creation flows.
- Inventing a new version of a part Orvane already has.

## Before you show anything

- [ ] Tokens from `look.md`, Inter, light theme only.
- [ ] Real content, specific to Orvane, no filler text.
- [ ] Most informative state visible; keys shown.
- [ ] Established parts reused.
- [ ] One centre line per toolbar; nothing clipped or wrapping by accident.
- [ ] Motion small, local, with reduced-motion fallback.
- [ ] Rendered and looked at.
