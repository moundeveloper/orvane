# Performance standards for Orvane apps

These apply to every app on the canvas: the built-in tools (Notes, NetSuite, Git, Projects, Browser), apps assembled in the builder, and code apps written by a person or generated through MCP. Some are enforced by the host; the rest are rules that a check or a benchmark will catch. The measurements behind them are in [PERFORMANCE.md](PERFORMANCE.md).

## What the host already does for every app

| Guarantee | How |
|---|---|
| An app away from the viewport costs no style, layout or paint | `.app-surface` uses `content-visibility: auto`. State, scroll positions and scripts are untouched. Browser apps are exempt so their pages keep loading. |
| Arriving at an app does not stall on first layout | The canvas lays out each off-screen app once while idle (`warmApps` in `src/App.vue`), nearest first, never during a gesture or camera animation. |
| Pan, zoom and clicks never restyle app content | Pan feedback is a single overlay (`.pan-shield`). No rule on the workspace reaches "every descendant". |
| A code app cannot block the canvas | It runs in a sandboxed, opaque-origin frame; its custom actions run in a terminable worker with a two-second limit. |
| A code app nobody can see does almost no work | The browser stops its `requestAnimationFrame`; its runtime slows `setInterval` to once a second and restores the cadence when it returns. |
| A slow code app is visible to its author | Tasks of 200 ms or more are reported and shown in Build mode. |

## The runtime in every code app: `window.orvane`

Injected ahead of the app's own code (`src/appRuntimeSource.js`). Nothing to import.

```js
orvane.visible                       // is the app on screen right now?
orvane.onVisibility((visible) => {}) // returns a function that stops listening
orvane.frame(draw)                   // run DOM writes once in the next frame; repeats collapse
orvane.debounce(fn, 150)             // after input has been quiet
orvane.throttle(fn, 100)             // at most once per interval, latest arguments
orvane.idle(fn)                      // non-urgent work when the thread is free
orvane.onCleanup(fn)                 // teardown when the app reloads or closes
orvane.list({ container, count, rowHeight, render }) // windowed list
```

`orvane.list` keeps only the rows in view in the DOM. `container` needs a fixed height, rows share `rowHeight`, and `render(index)` returns an element or text. It returns `{ update(count?), destroy() }`.

```html
<div id="rows" style="height:100%"></div>
<script>
  const items = Array.from({ length: 50000 }, (_, i) => `Row ${i + 1}`);
  orvane.list({
    container: document.getElementById("rows"),
    count: items.length,
    rowHeight: 28,
    render: (index) => items[index],
  });
</script>
```

## Rules for app code

Written for whoever authors the app, including a model generating one.

**Rendering**

- Draw more than about 200 rows with a windowed list: `orvane.list` in code apps; `WindowedTableBody`, `WindowedGrid`, `WindowedScriptsBody` or `FileFolderTree` in built-in apps.
- Animate `transform` and `opacity` only. Never animate `width`, `height`, `top`, `left`, `margin` or `box-shadow` on anything larger than a control.
- Do not read layout (`offsetWidth`, `getBoundingClientRect`, `scrollHeight`) after writing styles in the same task. Read first, then write inside `orvane.frame`.
- Never write a selector that reaches "every descendant" from a state or a toggled class: `.busy *`, `:hover *`, `:active *`. The browser then restyles the whole subtree on every change. Name the elements instead. `bench/css-guard.test.mjs` fails on these in built-in styles.
- Do not put `will-change` or 3D transforms on app containers. Layer promotion was measured to make the canvas slower, and it softens text.

**Work**

- No synchronous loop, parse or sort that can exceed 50 ms. Split it with `orvane.idle`, or move it to a worker.
- Debounce work driven by typing; throttle work driven by scroll, pointer or resize.
- Stop polling, animation and network refresh when `orvane.visible` is false. Resume from `orvane.onVisibility`.
- Create expensive parts (editors, charts, terminals, hidden tabs) on first use, not at startup.
- Release what you start: listeners, observers, timers, workers, object URLs. Register it with `orvane.onCleanup`.

**Data**

- Keep large results out of the workspace document. It is saved as a whole; app values should stay small (identifiers, layout, drafts).
- Share identical in-flight reads instead of issuing one per view, and drop results for closed views.
- In built-in (Vue) apps, hold large read-only responses in `shallowRef`; deep reactivity over thousands of rows is the usual cause of slow updates.

## Checks

```sh
pnpm bench                    # interaction benchmark on a 50-app fixture
pnpm bench -- --baseline HEAD # compare the working tree with a commit
pnpm bench -- --check         # fail when a budget in bench/budgets.ts is exceeded
pnpm test:css                 # reject "every descendant" state selectors
```

Budgets are deliberately loose bounds on medians; they exist to catch a regression of the kind that made every click cost over a second, not to certify a frame rate.
