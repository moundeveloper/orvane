# Browser loading / Stop: two mocks

Files: `stop-swap.html` (A) and `ring-stop.html` (B). Geometry, colours, tabs and toolbar order are copied from `src/components/BrowserView.vue`, default `balanced` layout, light theme. The Browser's own tokens (`--surface:#f8fafb` and so on) are used where they differ from the design guide's generic ones.

## Rationale

| | A: Stop swap | B: Ring stop |
|---|---|---|
| Toolbar, loading | Reload cross-fades to X. Nothing turns here. | X inside a thin turning ring. |
| Tab, loading | A 12px spinner replaces the site tile. | The tile rounds off, shrinks, and a ring turns around it. |
| Strength | Quietest and most familiar. One moving thing. | Progress is visible where you click, and the tab keeps its identity. |
| Cost | While loading, the tab loses its letter. Motion is only in the tab. | Two moving rings for the active tab. The tile letter gets small (about 7px). |

Recommendation: **A**. It is calmer. Choose B if the movement needs to be in the toolbar itself.

Both keep the 28px button and the 16px tab slot, so nothing in the layout moves. No percentage, banner or progress bar. The DNA loader is not used, because it means "AI working" in Orvane.

## Trying the states

- **Loading:** the page opens this way (Electron tab, 9s). The Vue.js tab below it stays idle.
- **Stop:** click X, or press Esc. The page stays partly drawn and Reload returns. No error, matching the app's handling of an aborted load.
- **Loaded:** wait, or click Reload (4.5s).
- **Failed:** select the `localhost:5173` tab and click Reload. After 2.2s the page goes blank, the existing red error row appears and Reload returns.
- **Per tab:** start a load, then switch tabs. The spinner stays on its tab and the button follows the selected tab.
- **Keys:** Tab to the button, then Enter or Space (focus stays on it). Esc stops. In the address field Esc only restores the address. Alt+Left/Right go back and forward, Ctrl+L focuses the address, Up/Down move between tab rows.

## Build notes (not implemented)

- Keep a loading flag per tab. Set it on `did-start-loading` and clear it on `did-stop-loading` in `bindWebview`. Today both listeners act only on the active tab (around lines 820-827), so the flag must be set before that check.
- Add `stop()` to the `WebviewElement` interface (it declares `reload()`), and make the button call `stop()` or `reload()` from the selected tab's flag.
- Also clear the flag when a tab is closed, discarded or restored, or its renderer dies. A discarded tab's button must still restore it.
- `did-fail-load` already ignores `-3` (aborted), so Stop should not raise an error.
- Check comfortable tabs, the collapsed sidebar, Split View and Peek. In the `performance` layout the toolbar is normally hidden, so the tab spinner is the only cue.
- Pause the spinner when the Browser is off-screen or hidden.
- The loading events can include subframe activity, and some streaming pages may stay "loading" for a long time. Check real sites such as YouTube before relying on them.
- The non-desktop `<iframe>` fallback has no reliable Stop. Decide what it shows.
- **Owner decision:** Esc to stop is new. It should come after open menus, dialogs, drawer, Peek and find, and after text fields. Esc pressed inside a web page does not reach this handler; leave it with the page unless asked otherwise.
- Renderer-only change as far as this reading goes, so no change to `electron/` is expected.

## Testing

Done: I read the source and wrote the files. **I did not open them in a browser, render or screenshot them, or run a script check** (the check needed an approval that was not available). No Orvane tests were run. Production code was not edited.

To check in the Lab or a browser:

1. No console errors; both open in the loading state.
2. Stop halts the spinner, and it does not restart or complete later.
3. Button and address do not move between states; one centre line.
4. Focus ring visible and kept through Reload and Stop.
5. With reduced motion, a still arc and the X still read as loading.
6. At about 760px wide nothing clips or wraps.
7. In B, the tile letter is legible and the ring does not touch it.

For the implementation: a Playwright regression test against a local server that holds its response, covering Stop, completion, failure and switching tabs mid-load. Confirm it fails on the current code first.

## Mock limits

- Page content, load times and failures are simulated. `localhost` and `.invalid` addresses fail.
- Spaces, New tab, tab close, Start page, bookmark and the right-hand toolbar buttons are visual only.
- Inter is not embedded; without a local copy the text falls back to Segoe UI.
