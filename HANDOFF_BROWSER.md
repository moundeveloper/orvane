# Handoff: port the Aerframe example into Orvane's Browser 1:1

Written 11 November 2026 for whoever continues this work. The owner's instruction, verbatim: the Browser redesign "didn't port the stuff from the html I gave you 1:1". The goal is a faithful port, not an approximation.

- **Reference**: `C:\Users\Moon\Downloads\aerframe_browser_smooth_split_tooltips.html` (single file: CSS lines 8–294, markup 297–329, script 330–1120). Read all of it before changing anything. It is a design reference only; do not run its script inside Orvane.
- **Target**: `src/components/BrowserView.vue` (one large SFC). Desktop side: `electron/main.mjs`, `electron/preload.cjs`. Icons: `src/components/Icon.vue`.
- **Nothing is committed.** Everything since `c5d47d0` is in the working tree. Ask before committing.

## Rules that are easy to break

- **Keep these names**: existing tests locate `.browser-view`, `.browser-tab`, `.browser-tab.active`, `.browser-page`, `.browser-start`, `.browser-shield`, `.browser-error`, `.browser-discarded`, the `Address` textbox, buttons `New tab`, `Back`, `Forward`, `Bookmark this page`, `Remove bookmark`, `Saved passwords`, and `navigation "Bookmarks"` containing a button named by the bookmark title. Change the tests deliberately if the port moves them (bookmarks moving into a Library drawer will).
- **No whole-subtree selectors**: `pnpm test:css` rejects `:hover *`, `.toggled *` and similar. The example has `body.resizing *`; do not copy it.
- **Overlays are grid children**: `.browser-view` is a CSS grid. Absolutely positioned children need `grid-column: 1 / -1; grid-row: 1 / -1` or they position against the page column only.
- **Everything is drawn inside the app**, which is scaled by the canvas. Convert pointer coordinates with `local(event)` / `pagePoint(event)`; never use `position: fixed` or viewport units.
- **Desktop pages are `<webview>`**: clicks and keys inside a page never reach the host. They are relayed by the injected script in `electron/main.mjs` (`CANVAS_GESTURES`) as `orvane:guest-input` messages (`peek`, `split`, `key`, `focus`, `zoom`, `pan`).
- **Electron 45's `clipboard` has no `writeImage`/`readImage`** (only `clear, has, readText, writeText, read, write`). Screenshots are copied in the renderer with `navigator.clipboard.write`. Do not probe `clipboard.write/read` from a script: it hung and overwrote the user's clipboard.
- **Tooling**: use `npx -y pnpm@10 ...`. Run Playwright with `PLAYWRIGHT_CHROMIUM_EXECUTABLE="C:/Program Files/Google/Chrome/Application/chrome.exe"` (Playwright's bundled Chromium does not start on this machine). Do not edit `src/` while a test run is in progress; the dev server hot-reloads into the running tests.

## State right now

Working and tested (`tests/browser-sidebar.spec.ts`, `tests/desktop-browser.spec.ts`, `tests/browser.spec.ts`):

- Sidebar with space header, space tiles, Pinned / Groups / Tabs headings, bookmarks section, footer.
- Three layouts (sidebar + bar, sidebar only, tabs on top), collapse, resize grip, auto-collapse when narrow.
- Spaces, pinned tabs, tab groups, multi-select, bookmark folders.
- Peek (centered panel, scrim, rail), Split View (inline pair in the sidebar with sliding highlight, captions, draggable divider, stack), command palette, tooltips, start page.
- Desktop: Shift-click and Alt-click on links inside pages, pinned cross-site peek, Ctrl+L / Ctrl+K / Ctrl+T relayed from pages, screenshots (visible, full, area).

Changed after the last full test run and **not yet tested**:

- Clicking inside a split pane selects it (`focusPane`, the webview `focus` listener, the `focus` guest message, and `frameTookFocus` for iframes).
- README Browser section.

Last full suite: 203 passed, 4 failed under load (File Cabinet grid, Git/Notes/Projects MCP); all four passed when rerun alone.

## Differences from the example still to port

Ordered by how visible they are. "Mine" means the current Orvane code.

1. **Split View model.** Example: `primary` / `secondary` panes plus `focused`; the pair stays at `splitAnchor`'s position in the sidebar. `toggleSplit` creates a *new blank tab* right after the source and focuses it. Choosing an ordinary tab while split loads it into the *focused pane*. Mine: `active` + `split` + `flipped`; the toolbar button pairs with the most recent tab; choosing an ordinary tab replaces the selected one.
2. **Pane captions.** Example: each caption has the favicon, title, a "Focus pane" button (expand icon) and a "Close Split View" button. No swap or stack buttons. Divider limited to 25–75 %. Mine has swap and stack on the first caption and close on the second, 20–80 %.
3. **Toolbar.** Example order: back, forward, reload, home | address (lock icon when a page is loaded, search icon otherwise; star inside) | peek, split | divider | command palette, main menu (⋯). Mine has no command or ⋯ button in the toolbar and keeps "Saved passwords" and "Open in your browser" (keep those two; they are Orvane features).
4. **Main menu (⋯).** Example popup, with icons, a "Browser" label and shortcut hints: New tab, Reopen closed tab, Command palette | Enter/Exit Split View, Peek a link…, Hide/Show sidebar | Bookmarks & history, New space, New tab group | Export, Import, Preferences. Mine is a plain text menu holding layouts and screenshots; fold those in rather than dropping them.
5. **Footer.** Example: "Library" (opens the drawer) and a settings button (opens Preferences). Mine: "Search" and a menu button.
6. **Library drawer.** Slides in from the right; tabs "Bookmarks" / "History"; each row has favicon, title, URL, open (Shift-click peeks) and remove. Needs a `recent` history list (60 entries, de-duplicated by URL). Mine lists bookmarks in the sidebar and has no history.
7. **Preferences drawer.** Appearance (Light/Dark custom select; "Keep sidebar collapsed" switch), Peek View ("Enable link previews", "Automatically preview cross-site links from pinned tabs and bookmarks"), Browsing (search engine Google/DuckDuckGo), Data (export/import), keyboard shortcut list. Mine has none of this; Orvane's own layout choice and "Pop out video" belong here too.
8. **Dark theme.** `body.dark` variable set in the example (line 10). Not ported.
9. **Dialogs.** Example uses a modal with a blurred shade for New space, Rename space, New tab group, Rename group, Peek a link, and a confirmation for Delete space. Mine renames inline and deletes without confirming. Note the example's Delete space removes its tabs; mine moves them to another space. Ask the owner which they want.
10. **Menus.** Example popups have a label header, an icon per item, shortcut hints on the right, a `danger` style and a pop animation.
    - Tab: Duplicate tab, Pin/Unpin, Open in Split View, Peek at tab | Create group with tab, Move to *group*, Remove from group | Close tab.
    - Group: New tab in group, Rename group, Collapse/Expand | Ungroup tabs.
    - Space (right-click): Switch to space, Rename space | Delete space.
    - Space header (click): list with initial tiles and a check, New space, Rename current space.
    - Link (right-click a quick-access tile or library row): Open Link in Peek View, Open in new tab, Open in Split View, Open externally.
11. **Groups section.** Always shown, with a "New tab group" button in its heading; an empty group shows "Drop tabs here"; children sit in a `.group-list` with a left rule. Mine hides the section when there are no groups and has no heading button.
12. **Peek.** Example keeps a peek *per source tab* (`tab.peek`), shows an eye indicator in that tab's row (click to close), keeps the address chip at the top left, has "Open as tab" use the external icon with Ctrl+O, closes with Ctrl+W, opens from the address bar with Shift+Enter, and honours the two Peek preferences. Mine has one peek at a time, closes it on tab switch, puts the chip at the bottom left, and has no indicator.
13. **Start page.** Example: subtitle "Your space for everything on the web.", four default quick-access tiles (Google, GitHub, Wikipedia, Example) with Shift-click peek and Alt-click split, footer "⌘ / Ctrl K for commands · Shift-click a shortcut to Peek". Mine uses the first four bookmarks and different text.
14. **Command palette.** Example lists commands (New tab, New tab group, New space, Enter/Exit Split View, Peek a link, Bookmarks and history, Preferences, Collapse sidebar), then "Switch to *space*", then tabs with "Tab" / "Other space" hints, then "Search or open “query”". It shows "ESC" at the right of the input and has a custom scroll thumb. Mine lists tabs and bookmarks only.
15. **Tooltips.** Example positions them at the pointer (15 px right, 23 px below), follows the pointer, splits "Label · meta" and "Label (shortcut)" into two parts, shows on keyboard focus after 240 ms and on hover after 500 ms. Mine centres them under the control with a 420 ms delay and no focus support.
16. **Shortcuts missing in mine**: Ctrl+W close tab, Ctrl+Shift+T reopen closed tab (needs a `closed` list of 16), Ctrl+B library, Ctrl+\ sidebar, Ctrl+1–9 tab by position, Alt+←/→ back/forward, Up/Down between the two split rows. Each also needs adding to the relay in `CANVAS_GESTURES`.
17. **Drag and drop.** Example reorders tabs by dragging and drops a tab onto a group. Not ported.
18. **Small details.** Tab title falls back to the capitalised host; favicon tile colour varies by host; sidebar width 208–376 px and 65 px collapsed (mine 190–360 and 58); the "Some websites block embedded browsing" hint with "Open site" on iframe pages; toast wording ("Bookmarked", "Bookmark removed").

## Orvane features that are not in the example and must survive

Processing tabs bar, saved passwords, "Open in your browser", page pause/discard, the three layouts, tab multi-select, bookmark folders, group-by-site, screenshots, mini player, pop-out video, and the canvas shield for iframe pages.

## Suggested order

1. Run the two browser specs and the desktop spec to confirm the untested pane-focus change.
2. Items 1–2 (split model and captions), since the owner has just used Split View and noticed it.
3. Items 3–7 (toolbar, main menu, footer, Library, Preferences).
4. Items 9–10 (dialogs and menus), then 12–14, then the rest.
5. Full suite, then compare screenshots side by side with the example at 1280×800.

## Verify

```sh
npx -y pnpm@10 exec vue-tsc --build
npx -y pnpm@10 run test:css
PLAYWRIGHT_CHROMIUM_EXECUTABLE="C:/Program Files/Google/Chrome/Application/chrome.exe" npx -y pnpm@10 exec playwright test tests/browser.spec.ts tests/browser-sidebar.spec.ts tests/desktop-browser.spec.ts tests/browser-throttle.spec.ts tests/desktop.spec.ts
```

Screenshots from the tests land in `artifacts/browser-*.png` and `artifacts/desktop-*.png`.
