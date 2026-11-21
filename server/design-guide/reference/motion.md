# Motion

The owner's words: Orvane is "soft and sophisticated"; what they hate is "jittery animations that ruin the experience". Motion is small, local and smooth. The full record is `MOTION-DISCOVERY.md` in the repo.

## Rules

- Animate only `opacity` and `transform` (and SVG stroke offsets). Never animate width, height, or layout that pushes other content.
- Small distances: 3-8px. Short durations: 130-260ms. `ease-out` for entries.
- One animation per element; an interrupted effect retargets from where it is, never restarts with a jump.
- No bounce, overshoot, stagger, delayed input, lingering exits. Removal and dismissal are immediate.
- Nothing replays on load. Data updates immediately; animation is decoration on top.
- Always provide `@media (prefers-reduced-motion: reduce)` with the final state and no movement.
- Pause loops when off screen or hidden.
- Smooth from the very first frame: the owner rejected "the jump at the beginning of the animation". Start keyframes from the element's resting state.

## Approved values

| Effect | Value |
|---|---|
| New list row | reveal 3px over 160ms |
| Changing value | opacity fade 130ms |
| Popover / menu | 3px + opacity over 140-160ms (`@keyframes in{from{opacity:0;transform:translateY(3px)}}`) |
| Builder panel | 4px over 180ms |
| New app | 5px over 170ms |
| Graph / workbench entry | 8px horizontal + opacity over 240ms, only after measuring |
| Node, component, error | opacity 130ms |
| Done tick | `stroke-dasharray:20; stroke-dashoffset:20 → 0` over 260ms ease-out, 100ms delay |
| Live text shimmer | `background:linear-gradient(90deg,#273f50 0 40%,#b4cad6 50%,#273f50 60% 100%) 0 0/250% 100%; background-clip:text; color transparent;` 1.8s linear infinite |
| Spinner (small) | 12px ring `#bfd0da` with `--run` top, 0.9s linear |
| DNA working indicator | 9 columns 4.5px apart, dot pairs on rungs pinch and reopen, each column 1/7 cycle behind, 1.74s linear; compact (38x16px); see `.cs-dna` |
| Waiting dots | three 3px dots, opacity blink 1.2s, 0.15s apart (only as a quiet "then..." line) |
| Search / palette | opacity + scale anchored to the icon it came from |

## Rejected (owner's feedback)

- A number field and text animation that "looks like a cyberpunk thing": glitch, scramble, rolling digits.
- Text that "disappears and reappears", "jarring", "glitchy".
- Checkbox background flash.
- Radial wheel: outer items that "just scale back into the center", an inner-shadow hover. Wanted: a gradual fade from the outer ring into the inner ring ("Glow Blend": proximity fade merged with the Halo glow, animated smoothly), the selected icon reflected in the centre, frosted glass background with the fade reaching the edge.
- Loaders that are "too bulky": the DNA loader was compressed in width and the merged dots made smaller.
- Three-dot typing animation as the main working indicator (replaced by DNA).

## Getting motion from a reference

When the owner points at a GIF or video (often a Pinterest pin): sample it at its own frame rate (media-digest skill), measure timing per phase, describe it (start, trigger, movement, holds, loop), recreate in CSS with the measured timing, and compare side by side. State which values were measured and which were inferred.
