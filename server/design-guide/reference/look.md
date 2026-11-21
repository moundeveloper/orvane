# Look: tokens and recipes

All values below come from approved designs (`examples/`) and Orvane's own CSS (`src/style.css`, `DESIGN.md`). Copy them literally.

## Tokens

```css
:root{
  --canvas:#e9edf0;   /* workspace background, mock stage */
  --app:#f7f9fa;      /* app surface */
  --raised:#fbfcfd;   /* fields, menus, cards inside an app, buttons */
  --strong:#273f50;   /* titles, selected text, typed text */
  --text:#455968;     /* body */
  --muted:#5d7381;    /* secondary labels */
  --faint:#8296a2;    /* hints, timestamps, placeholders, counts */
  --accent:#6f8998;   /* icons, done dots, focus, links' tone */
  --run:#365f78;      /* live/working state, primary send button, knob */
  --link:#385d76;     /* chips and links text */
  --ok:#4f7d5f;  --add:#3f6b4f;  --del:#7b3b2d;   /* done tick, diff */
  --warn:#b08a4a;     /* approvals / waiting on the user */
  --fail:#a0624f;
  --line:#e3eaee;     /* dividers inside a surface */
  --border:#dbe5eb;   /* field and card borders */
  --border-pop:#d3dee5; /* popover and button borders */
  --chip:#e6eef3;  --chip-hover:#dae6ed;
  --select:#e4edf2;   /* selected row, user bubble (#e4ecf1) */
  --hover:#eef3f6;
  --mono:"Cascadia Code",Consolas,monospace;
}
```

Diff backgrounds: added `#e3efe6`, deleted `#f6e6e1`. Change bars: `#8fb59b` / `#c99a8c` on `#d3dee5`.
Selected-but-focused field border: `#7b97a7`.

## Type

- Family: `"Inter Variable",Inter,"Segoe UI",system-ui,sans-serif`, `-webkit-font-smoothing:antialiased`.
- Body 13px/1.5. Composer text 13.5px. Secondary 12-12.5px. Small meta 11-11.5px.
- Section labels in menus: 10.5px, weight 600, uppercase, letter-spacing .04em, color `#7a8f9b`.
- Weights: 500-550 for row titles, 600 for headers and counts. Never bold body text for emphasis; use `--strong` color.
- Mono (Cascadia Code) for paths, commands, skills (`/scoped-fix`), `kbd`, diff, timings: 11-12px.
- Numbers that change: `font-variant-numeric:tabular-nums`.
- Paragraph width 62-64ch max.

## Shape and depth

- Radii: app 10px, composer 14px, popover/menu 10px, card inside app 8-10px, row/item 6px, button/pill 7-8px, chip 5-7px, kbd 4px, user bubble 12px, send button 9px.
- App shadow: `0 1px 2px #263f5512, 0 10px 30px #263f551c`.
- Popover shadow: `0 1px 2px #263f5514, 0 12px 30px #263f5526`.
- Floating toolbar shadow: `0 4px 12px #263f5518`.
- Composer: `border:1px solid #dbe5eb; background:#fbfcfd; box-shadow: inset 0 1px 3px #53738c12, 0 10px 28px #263f551a`. Focused border `#7b97a7`.
- Frost glass (top bar, AI surfaces, terminal): `background: rgb(247 250 252 / 8%); backdrop-filter: blur(8px) saturate(120%);` with a faint white edge (`border-bottom:1px solid #ffffffa3` on glass headers) and the soft shadow; content behind must stay readable. Approved composer study (`examples/composer-glass.html`) uses stronger blur over a busy canvas.
- Dividers: 1px `--line`, sparse. Separate groups with spacing first, a divider only when spacing is not enough.
- Focus: fields use a faint surface tint and inset baseline, not a rectangular outline; keyboard focus stays visible.

## Sizes and rhythm

- Rows and menu items 32px high, 8px side padding, 9-10px gap, icon 15px.
- Buttons 26px (`.btn`), pills 28px, send 30px, segmented buttons 24px in a 2px-padded track.
- Chips 22-24px high (20px in dense cards).
- kbd: `min-width:18px; height:18px; padding:0 4px; border:1px solid #d6e0e6; border-bottom-width:2px; border-radius:4px; background:#fbfcfd; font:10.5px/1 var(--mono); color:var(--muted)`.
- Icons: stroke icons, `fill:none; stroke:currentColor; stroke-width:1.7-1.8; stroke-linecap:round; stroke-linejoin:round`, 12-15px, colored `--accent` in lists, `currentColor` in buttons.
- Toolbar items share one centre line (`align-items:center`, equal heights).

## Page skeleton for Lab variants

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Variant name</title>
<style>
:root{--canvas:#e9edf0;--app:#f7f9fa;--strong:#273f50;--text:#455968;--muted:#5d7381;--faint:#8296a2;--accent:#6f8998;--run:#365f78;--ok:#4f7d5f;--line:#e3eaee;--mono:"Cascadia Code",Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:13px/1.5 "Inter Variable",Inter,"Segoe UI",system-ui,sans-serif;color:var(--text);background:var(--canvas);display:grid;place-items:center;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer}
.app{width:760px;padding:24px 30px;background:var(--app);border-radius:10px;box-shadow:0 1px 2px #263f5512,0 10px 30px #263f551c}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body><div class="app"><!-- the design, in its most informative state --></div></body></html>
```

## Recipes

### Searchable menu / command list (`examples/slash-skills.html`, `message-actions.html`, `action-menu.html`, `create-menu.html`)
- Container: `border:1px solid #d3dee5; border-radius:10px; background:#fbfcfd;` popover shadow, `overflow:hidden`, width 300-430px.
- Top: search line 36px with the typed token in mono, or a focused 30px field (`border:1.5px solid #7b97a7`).
- Sections: uppercase 10.5px labels.
- Items: grid `18px | name | description (ellipsis, faint) | kbd`, 32px, radius 6, selected `#e4edf2`.
- Footer 30px: count on the left ("14 skills from your skills folder"), `kbd` hints on the right (`↑ ↓ move`, `Tab insert`).

### Composer (`examples/composer-glass.html`, `effort-modes.html`)
- Text and attachments live inside one rounded field; chips, model pill and send sit in the field's bottom bar, not outside.
- Pills (28px, radius 8) for model / effort / mode, value in `--strong` weight 550; an active mode pill fills with `#e4edf2` and no border.
- Send: 30px, radius 9; idle `#dfe8ee` with `--run` arrow, ready `--run` with white arrow.
- Popovers open above the composer (`bottom: calc(100% + 8px)`).
- Shift+Enter new line, Enter sends, Esc leaves the field.

### Step / activity trail (`examples/thinking-trail.html`, `step-details.html`, `session-timeline.html`)
- Vertical rail: 1px line `#d3dee5` fading out at the end, 9px dots; done = filled `--accent`; now = `--run` ring with `0 0 0 4px #365f781a` halo; pending = hollow.
- Headline 13px (strong when current), one muted detail line, then file chips in mono.
- Current step text can shimmer (see motion.md). Durations right-aligned, tabular.
- Finished step = drawn tick in `--ok`, never strikethrough. Rows with details expand inline (Input `dl`, Output `pre`, Copy).

### Cards inside an app (`examples/run-changes.html`)
- `border:1px solid #dbe5ea; border-radius:10px; background:#f2f6f8;` header 36px with title (600) + faint count + mono summary, actions on the right as ghost buttons.
- Rows: badge (18px, radius 5, mono 10px: A green tint, M blue tint, D red tint), path with faint folder + strong file name, deltas, tiny change bar.

### Chips and links
- File chip: 22px, radius 6, `#e6eef3`, `#385d76`, mono 11.5px, file icon 12px; hover `#dae6ed`.
- Inline link in prose: `#385d76`, underline `#9fb6c3`, offset 3px.

### Segmented control (`examples/session-timeline.html`)
- Track `#e8eff3`, 2px padding, radius 7; buttons 24px, 11.5px; pressed = `#fbfcfd` + `0 1px 2px #263f5512`.

### Slider (`examples/effort-modes.html`)
- Track 26px `#eef3f6` radius 7 with a soft gradient fill `#e1ebf1 → #c9d9e3`, notches 4px `#a9bcc7`, knob 22px white with 1.5px `--run` ring and inner 8px dot, labels 11px faint under it, end labels ("Faster", "Smarter") above.

### Timeline colors (`examples/session-timeline.html`)
- You `#8ea3b0`, read `#6f8998`, edit `#4f7d5f`, approval `#b08a4a` (card tint `#fcfaf5`, border `#e7d9bd`), failed `#a0624f`, answered `#365f78`. Current card: border `#9fb6c3` + `0 0 0 3px #6f89981a`.

### Tables
- Header is an opaque row above the scrolling area; only rows scroll; columns share one grid; never a sticky/translucent header over rows.

### Scrollbars
- Narrow, muted thumb, no arrow buttons, transparent track, everywhere (including sandboxes and the terminal).
