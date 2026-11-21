# Research on the owner's board

## Where

- The owner's Pinterest account is **articempire** (Frost ArticEmpire), board **Web design**: `https://www.pinterest.com/articempire/web-design/`. Not the OneUseJob account the Browser is signed in as.
- Open it in **Orvane's Browser** (`browser_open`, then `browser_act`), where the owner's sign-in lives. Orvane's site memory (`browser_memory`) has the route as "Web design board".

## Collect the pins

Pinterest loads pins as you scroll. Collect in short batches (long evals time out):

```js
// browser_act eval, repeat until the count stops growing (about 600 pins is plenty)
window.__pins ??= new Map();
for (const a of document.querySelectorAll('a[href*="/pin/"]')) {
  const img = a.querySelector('img');
  if (img) window.__pins.set(a.href.match(/pin\/(\d+)/)[1], { src: img.currentSrc || img.src, alt: img.alt });
}
window.scrollBy(0, innerHeight * 3);
window.__pins.size;
```

Then read `window.__pins` back, download the 236x thumbnails into a scratch folder, and build contact sheets (a grid of numbered thumbnails per image) so you can look through hundreds quickly. Open the 736x version of the pins that matter and look at them closely. Look at the images; alt text is often empty or generic.

## Read the board

- The newest pins show the current taste. In late 2026 these were mostly AI agent interfaces: command menus, agent composers, "thinking" states, node workflows, effort sliders, timelines, activity feeds with inline replies, segmented tabs, folder cards.
- Older pins drift to HUD / sci-fi interfaces, then posters and landing pages. Use them for ideas only.
- Group what you see by pattern, then match patterns to Orvane parts that could use them (Agent sessions, dock, triggers, automation runs, File Explorer, inbox, UI Maker, Notes).

## Translate a pin

For every pin you use, write:

- **Pin:** id and a short quote of what it shows.
- **What:** the interaction in Orvane terms.
- **Why:** what it improves for the owner, concretely.
- **Build:** which data Orvane already has, what is missing, which files change.

Keep: structure, density, information order, the interaction, keyboard hints.
Drop: dark theme, glow, liquid-metal borders, neon, glassmorphism on everything, decorative gradients, dashboards / KPI tiles, sci-fi HUD chrome, gestures that would change canvas input.

Keep a "Left out on purpose" list with the reason (usually DESIGN.md: light only, no dashboards, small motion).

## Propose references

Propose the actual images with `uimaker_reference_propose` on the component you are designing, each with its pin URL as source and a short title. Wait for the owner to pick. If they ask for alternatives, use their feedback and the excluded URLs to send a different batch. Keep the source URL on every approved image.

## Example of a finished research write-up

`BOARD_IDEAS.md` in the repo: two rounds (Agent sessions, Orvane workspace) with Pin / What / Why / Build per idea and a left-out list. The owner liked both rounds and had them built.
