# Taste log: the owner's decisions

Quotes are the owner's own words (typos kept out). Newest last. Add to this file when the owner picks, rejects or corrects a design.

## Motion and animation study (video reference → demos → Orvane components)

- On a recreated animation: "I don't like the jump at the beginning of the animation, I want a smooth experience."
- "A little bit confused with the chat text, the input, the number field. It's a little bit too jarring. The text disappears and reappears. It's glitchy."
- "The animation for the number field ... doesn't match the vibe of Orvane. It looks like a cyberpunk thing, where Orvane is soft and sophisticated."
- Motion areas: wants motion in content changes, builder transitions, app creation/switching and popovers. Hates bouncing/overshoot, staggered entrances, content moving to make room, waiting before input, lingering exits. "What I hate is jittery animations that ruin the experience."
- Rejected the checkbox background flash.

## Radial wheel (3 redesigns → picks)

- Picked **Halo** from three; then three variations on it.
- "I like the Halo glow, but the background of the wheel should be frosted glass, just like the Orvane header, and the fading should also reach the edge" (it stopped 1-2px short). Wants smoother transitions between a group and the main ring.
- Rejected: outer items that "just scale back into the center", an inner-shadow hover on the centre. "Not what I asked: the transition from the outer circle into the inner one should be gradual and smooth."
- Rejected three further versions as "absolutely awful"; asked to go back to Halo and merge only the proximity fade from another variant. Picked **Glow Blend** (`examples/radial-glow-blend.html`).
- Then: the hovered icon reflected in the centre; animations for appear, select and the edit-config centre.
- Lesson: when the owner names exactly which two parts to merge, merge exactly those and change nothing else.

## AI composer ("AI prompt glass")

- Frosted and reflective glass studies over a working canvas backdrop. Approved glass: 8% cool-white tint, 8px blur at 120% saturation, faint white edge, soft shadow, content readable through it.
- "To the dropdown add search so I can find immediately the model I want."
- Context chips "should be streamlined into the text area" (inside the field, not a separate row).
- Shift+Enter must add a line and Escape leave the field, "like it does in the chat bots".
- Reference picked: a rounded composer with attachments and send inside the field.
- Use the Orvane AI mark, not sparkles.

## Agent sessions

- Working indicator: did not like the first options; pointed at a Pinterest pin: "I really like it, the DNA kind of animation." Then: "Make it more like the pin. This one looks too bulky." "The balls, when merged and about to split up, are a little bit too big." "Could we compress it on the width side? Make it more compact." → "Perfect."
- Rejected the "Then it writes the answer" line under the run steps: "like duh of course it will." No filler lines that state the obvious; the header (Thinking / Working / Replying) and the DNA loader say enough. Also: only one loader while a run works (no spinning AI mark beside the DNA loader), and Stop sits round inside the context ring where Send was, not as a wide text button.
- Step done mark: picked **Drawn tick** over check circle and checkbox. "I don't like the [row] with the line in the middle" (strikethrough).
- Step details: picked **Inline expand** over side inspector and input/output tabs. Wanted tool, what it did, inputs, outputs, and the drawn tick per step.
- On a mock with a new orb as the thinking mark: "put the already established AI loader there" (the DNA loader). Reuse what exists.
- Scrollbar "should not reach this low and occupy the space of the chat text" (keep scrollbars inside the scrolling area, clear of the composer).
- Session search field "so cramped height wise that the icon barely fits": controls must never shrink below their height.
- `@` should autocomplete files and folders like Ctrl+K, Tab makes it a context block.
- "Open folder" must open Orvane's own File Explorer, not Windows'. File names in replies should be clickable.
- Split chats: a visible grip in the middle "breaks off the immersion". Mocks must keep the current Agent Sessions chat look. Divider-only variants (hover seam, open gap, shared header) were called "sloppy", without smooth animation. The owner asked whether they followed the Terminal reflow and Hyprland look and feel. Picked **Hyprland tiles** (UI Maker `agent-session-workspace` r4, saved as v2). It uses 10px gaps, 10px corners and a 2px border that fades to a steel-blue gradient on focus, with no drawn divider. New chats pop in from 87%. Everything reflows at once with easeOutQuint over 480ms; chats keep their state while they move. Lesson: when the owner names a reference such as Terminal reflow or Hyprland, study it (the code, the real config) before drawing.

## Board ideas rounds (research → Lab)

- After the Pinterest research and two Lab rounds (7 Agent sessions ideas, 6 workspace ideas): "overall I like the ideas you came up with for the UI and features" and had them built. This is the reference quality bar: `examples/thinking-trail.html` ... `examples/run-plan.html`.
- Lab tab strip overflowing under the Pick button "looks ugly": wrap "in a cool way". Nothing may run out of bounds.
- Round 3 workspace references accepted: [Notes text toolbar](https://www.pinterest.com/pin/688980443038284912/), [canvas time rail](https://www.pinterest.com/pin/688980443021846560/), [task properties](https://www.pinterest.com/pin/688980443038314073/) and [file details](https://www.pinterest.com/pin/688980443012828073/).
- Round 3 implementation picks: Notes Rewrite and Canvas Rewind. The owner asked for clearer intent in App Details and explanations in UI Maker. Use each Lab variant’s About field to explain where the feature appears and how the example works.
- The owner disliked the rectangle around the Canvas Rewind time rail. Show keyboard focus on the playhead itself.
- The owner passed on Canvas Map, Command Results, and Deploy Watch because they did not find those concepts useful.

## NetSuite File Cabinet history and compare (23.11.2026)

- Approved as mocked (UI Maker "File Cabinet history and compare", round r1): History and Compare as plain buttons in the existing edit bar, History opening a version menu (relative time, mono +/− line counts, "4 of 5 kept", Clear history in red text), and a side-by-side diff that replaces the editor with "Restore this version" / Close diff (Esc). Ported features keep the existing File Cabinet styling rather than a new look.

## General

- "Everything is custom here": no standard HTML date/time selectors, no native arrows on scrollbars ("the ugly standard html arrows").
- Scrollbars that do not match the app are "so annoying to have to catch and fix over and over": one global scrollbar style.
- Wants options to choose from for design questions, then decides. Do not pick for them when the choice is taste.
