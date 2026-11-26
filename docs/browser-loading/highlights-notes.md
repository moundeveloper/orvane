# Source highlights in Orvane Browser: mocks

Files: `highlight-rail.html`, `highlight-widget.html`. Both are single files with inline CSS and JS.

**Status: not run.** Neither file has been opened in a browser or rendered in UI Maker. Running Node needed an approval that was not available, so there are no screenshots and no automated checks. The code was only reviewed by reading it.

Inter is not embedded. The font stack is `"Inter Variable", Inter, "Segoe UI"`, so a machine or Lab frame without Inter will show Segoe UI.

## The two variants

| | Source rail | Source widget |
|---|---|---|
| What | 304px panel right of the page | Small stepper at the bottom right with a list popover above it |
| Why | All quotes stay readable while you move around the page | The page keeps its full width |
| Cost | Narrows and reflows the page | The popover can cover page content |
| Dismiss | Close button, toolbar button, `Alt H`, `Esc` with focus inside | Those, plus outside pointerdown and `Esc` from anywhere outside a text field |

Suggestion: the widget as the default, because it does not reflow arbitrary sites. The rail is better for long reading across many passages.

No Pinterest research was done for this round and no pins are referenced.

## Shown in both

- Starts on tab "Backups and restore", scrolled to passage 2, which is selected in the page, the margin and the list.
- Three passages, with short labels kept apart from the quote text. Quotes are read from the page at load.
- Clicking a row, or `↑ ↓` then `Enter`, jumps to the passage. `Alt ↑` / `Alt ↓` step through found passages.
- Clicking a marked passage or its margin number selects the row.
- Toolbar button with a count, and a count on each sidebar tab that has highlights.
- Missing text: open the "Release notes" tab (1 of 2 found), press Reload on the first tab (its third sentence is edited), or load the file with `#changed`.
- "Keyboard shortcuts" tab: no highlights.
- Clear removes the current tab's marks only. There is no undo; reload the mock file to start again.
- The widget popover stays open after a jump unless it would cover the passage; then it closes and the stepper remains.
- Reduced motion: instant scrolling, no fades.

## Build

- **Marks:** CSS Custom Highlight API (`CSS.highlights`) over DOM `Range`s. No wrapping spans, so page text, links and forms are untouched, and marks are separate from text selection and Ctrl+F. In Orvane this runs inside the `<webview>` guest through the `orvane:page-run` bridge (`runInPage`), not `executeJavaScript` that waits for load. Main-process handlers check `ownGuest(event, id)`.
- **Data per tab:** `{ url, title, passages: [{ quote, prefix, suffix, label? }] }`. The AI supplies a quote to find; Orvane stores what it matched in the page and shows that. A quote that never matches must be reported to the AI and never listed as a source. "No longer found" is only for text that matched before.
- **Matching:** exact, folding only whitespace. The mock uses a prefix to separate repeated text; the real one should store a suffix too. No fuzzy matching: changed text counts as missing.
- **Re-matching:** after load, in-page navigation and relevant DOM changes (debounced, paused for hidden tabs). Late-loading pages should show "Looking" before "No longer found"; the mocks do not include that state.
- **Scope:** list belongs to the tab and its URL. Navigating to another URL hides the marks; whether going back restores them is an open choice, as is whether they survive restart.
- **Overlays:** the margin numbers, stepper and popover are mocked in the page area. In the app, draw the stepper and popover in the host above the webview. Margin numbers need an injected, isolated layer and should be hidden when there is no free margin.
- **Outside dismissal:** a click inside the webview does not reach the host document, so the app needs the same guest-pointerdown signal other Browser popovers use.
- **Not covered by the mocks:** cross-origin iframes, shadow DOM, PDFs, text hidden in collapsed sections, split view.
- **Shortcuts:** `Alt H`, `Alt ↑`, `Alt ↓` are proposals and have not been checked against existing bindings. Add the same actions to Ctrl+K. When focus is inside a page, the guest has to forward them.

## Checks still to run

1. Open each file at about 1280×800 and 760×560: no console errors, toolbar on one centre line, nothing clipped.
2. Passage 2 is visible and not under the widget popover. At narrow widths the popover may overlap it in the opening state, since the cover rule only applies after a jump.
3. Click each row; use arrows, `Enter`, `Alt ↑ ↓`, `Alt H`, `Esc`; confirm focus lands sensibly.
4. Widget: with the list open, press a sidebar tab, a margin number, Reload and a page link. The list closes and each press still works.
5. Follow the in-page links, type in the search field (`Alt H` does nothing there), select text, use Ctrl+F.
6. Switch tabs and back: scroll position, selection and typed text remain.
7. Missing state on both routes; Clear on one tab leaves the other.
8. Reduced motion, and the Lab's scaled view (margin numbers stay aligned).
