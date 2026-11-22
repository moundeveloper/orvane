# Orvane feature ideas

A research list of features from comparable apps, matched to where Orvane is
already heading. Compiled November 2026. Nothing here is built yet; it is for
review and picking.

## How to read this

Each idea has four parts:

- **Source**: the app it comes from, with links to where it is documented.
- **How they do it**: the behaviour as the source describes it publicly. This
  is documented behaviour, not their internal code, which is not public.
- **In Orvane**: how it would be built here, naming the existing modules it
  would use.
- **Effort / builds on**: S (a day or two), M (about a week), L (several
  weeks), and what already exists that it extends.

Sources vary in quality. Official docs and changelogs are preferred. Where
only third-party reviews or vendor marketing were found, the idea says so.

## What these are matched to

From the features built so far, Orvane leans toward:

- **Keyboard first**: Ctrl+K everywhere, Browser shortcuts working from any
  focus, the action wheel on Tab.
- **Arc-style browsing**: spaces, pinned tabs, Peek, Split View, groups.
- **Live over static**: live clips, File Explorer live updates, shells that
  survive reloads, NetSuite processing tabs.
- **Precise canvas input**: separate mouse and touchpad schemes, Space-pan,
  focus mode.
- **Custom controls only**: no native pickers or selects.
- **Performance discipline**: paused and discarded pages, windowed grids, the
  50-app budget.
- **Local first**: SQLite, no accounts, backups, MCP for automation.
- **Developer work**: NetSuite/SuiteScript, Playwright, git, terminals.

Ideas that contradict these (accounts, cloud sync, AI that needs a key by
default) are left out. Things Orvane already has were also left out (Peek,
Split View, spaces, groups, layouts, Board, inbox capture, reminders, the
action wheel, File Peek, batch rename, the password manager).

## Top picks

If only a few get built, these give the most for what already exists:

1. **#1 Minimap** (S–M). Big workspaces need it, and it is self-contained.
2. **#2 Zoomed-out summaries** (M). It reads better and saves work for the renderer.
3. **#21 Terminal blocks** (M), then **#22 Pin a block** (S) and **#23 Saved commands** (M).
4. **#29 Project launcher** (M). Most of the parts already exist.
5. **#41 Live script logs** (M). It turns SuiteCloud deploys into a loop: deploy, watch logs, fix.
6. **#10 Auto-archive idle tabs** (S). A memory win that suits the performance work.

Quick wins (S): #6, #10, #13, #18, #34, #45, #58.

### Interactive concepts in UI Maker

**Orvane experiments / Try it on the canvas** has three interactive prototypes.

- **Clip History** compares a pinned page region with an earlier capture. Reuse the existing clip capture and retain matching bounds locally. [Storybook visual testing](https://storybook.js.org/tutorials/visual-testing-handbook/)
- **Page Notes** attaches a note to a specific passage. Use the quoted text and surrounding words to find it again after a page update. [Hypothesis annotations](https://web.hypothes.is/help/annotation-basics/)
- **Layout Preview** lets you approve individual window moves before applying a proposed arrangement. Reuse saved layout geometry, Rewind placeholders, and workspace revision checks. [Photoshop layer comps](https://helpx.adobe.com/photoshop/desktop/create-manage-layers/create-layer-compositions/create-and-manage-layer-comps.html)

The owner passed on the three prototypes in **Orvane workflow ideas / High-impact workflows**.

- **Canvas Map** shows groups and the area currently in view. Pick a window to jump there on a crowded canvas. Use existing app bounds, groups and camera actions. [Miro board navigation](https://help.miro.com/hc/en-us/articles/360017731053-Using-Miro-with-a-mouse-trackpad-or-touchscreen)
- **Command Results** pairs finished commands with output, duration and exit status. Bring a command back to the prompt to inspect or edit it. The terminal needs shell integration to detect command boundaries. [Warp terminal blocks](https://docs.warp.dev/terminal/blocks/block-basics)
- **Deploy Watch** puts recent execution logs alongside a SuiteCloud deploy receipt. Filter by script and time to investigate runtime errors after deployment. Reuse Orvane's existing deploy and account-verified log reader. [NetSuite monitoring](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/subsect_1014180019.html)

---

## Canvas and navigation

### 1. Minimap

- **Source**: [allo.io minimap](https://allo.io/help/en/canvas/minimap); the
  same pattern appears in most whiteboards.
- **How they do it**: a small overview of the whole board in a corner, with a
  rectangle showing the current view. Clicking or dragging it moves the view.
- **In Orvane**: a small overlay in `App.vue` that draws each app in
  `workspace.apps` as a rectangle (using x, y, width, height), coloured by
  its group. Dragging the viewport rectangle sets `camera.x/y`. Hide it in
  focus mode. Pure DOM or a single `<canvas>`, so it costs almost nothing.
  Click an app's rectangle to `focusApp`.
- **Effort / builds on**: S–M. Builds on the camera, groups and focus mode.

### 2. Zoomed-out summaries (semantic zoom)

- **Source**: Heptabase (a reviewer found that remembering *where* a card sits
  on the whiteboard recalls content faster than keyword search,
  [DEV review](https://dev.to/pickuma/heptabase-review-visual-note-taking-for-thinking-through-problems-5daa));
  Kosmik ([TechCrunch](https://techcrunch.com/2023/12/21/meet-kosmik-a-visual-canvas-with-an-in-built-pdf-reader-and-a-web-browser/)).
- **How they do it**: cards stay recognisable at any zoom: titles, previews
  and thumbnails replace content too small to read.
- **In Orvane**: below a zoom threshold (`READABLE_SCALE` already exists in
  `BrowserView.vue`), each app kind renders a compact summary instead of its
  full UI:
  - Browser: the page title, plus the picture it already keeps for paused pages.
  - Terminal: the last line and the exit state.
  - Test results: pass and fail counts.
  - Notes: the page title.
  - Calendar: today's count.
  The full UI unmounts or pauses, which also cuts rendering work.
- **Effort / builds on**: M. Builds on page pausing, `rememberPage` pictures
  and the 50-app work.

### 3. Tours: step through areas of the canvas

- **Source**: Miro presentation mode. The order of frames in its frames panel
  sets the presentation sequence
  ([Miro help](https://help.miro.com/hc/en-us/articles/8512850754962-Interactive-Presentation-Mode),
  [community thread](https://community.miro.com/ask-the-community-45/frames-presentation-23555)).
- **How they do it**: an ordered list of frames. Present moves the camera
  frame by frame with arrow keys.
- **In Orvane**: a "Tour" is an ordered list of groups or saved camera views.
  Arrow keys animate the camera between them. Use it to walk through a NetSuite
  incident, or to demo a project. It is stored next to Layouts. Users have
  complained when Miro dropped its smooth transitions, so keep a smooth camera
  animation.
- **Effort / builds on**: S–M. Builds on Layouts, groups and the camera animation.

### 4. Boards inside boards

- **Source**: Muse, now Allume. Its makers call boards inside boards the main
  feature: you zoom into a board card at the spot you clicked, and leave with
  Escape or breadcrumbs
  ([Guide to Muse](https://museapp.com/guide),
  [vs Freeform](https://museapp.com/vs-freeform)).
- **How they do it**: a board card opens a full canvas of its own, nested to
  any depth.
- **In Orvane**: a group can be opened as its own canvas. The camera enters a
  sub-workspace that holds only that group's apps, with a breadcrumb in the top
  bar. Apps outside it unmount, which helps performance. This is a large
  change to `App.vue` and to the workspace model (apps get a `parent` board).
  Muse's own memo notes a clash between nesting and spatial navigation, so try
  it on a branch first.
- **Effort / builds on**: L. Builds on groups and layouts.

### 5. Link cards: jump to another app

- **Source**: Muse linked cards, which act as shortcuts to boards elsewhere
  ([memo](https://museapp.com/memos/2022-09-linked-cards)).
- **How they do it**: a card that, when opened, takes you to its target.
- **In Orvane**: sticky-note links already open files and pages. Add **app**
  and **camera view** as link targets, so clicking moves the camera and focuses
  that app. Drop an app's header onto a note to link it.
- **Effort / builds on**: S. Builds on Board note links and `focusApp`.

### 6. Two-key "go to" shortcuts and a shortcut sheet

- **Source**: Linear. G then I opens Inbox, and `?` lists every shortcut
  ([navigating Linear](https://linear.app/enablement/guide/navigating-linear)).
- **How they do it**: short key sequences, plus an always-current list of them.
- **In Orvane**:
  - `G` then a letter jumps to an app kind: G T terminal, G B browser,
    G N notes, G C calendar.
  - `G` then 1–9 jumps to a saved camera spot.
  - `?` (outside text fields) shows a sheet built from `allCommands()` in
    `src/commands.ts` plus each app's shortcuts, so it never goes stale.
- **Effort / builds on**: S. Builds on the command registry and `keydown` in `App.vue`.

### 7. Snap zones for arranging apps

- **Source**: PowerToys FancyZones, custom window layouts you snap to with
  Shift+drag
  ([PowerToys docs](https://learn.microsoft.com/en-us/windows/powertoys),
  [repo](https://github.com/microsoft/PowerToys)).
- **How they do it**: you define zones; dragging a window with Shift held shows
  them and drops the window into one.
- **In Orvane**: while Alt-dragging an app, holding Shift shows zones relative
  to the current view: halves, thirds, a 2×2 grid, or a saved custom layout.
  Dropping sets the app's x, y, width and height to fill that zone.
  Keyboard-only variant: Win-style arrows on the active app.
- **Effort / builds on**: M. Builds on app drag and resize in `App.vue` and Layouts.

### 8. Camera back and forward

- **Source**: browser history, applied to the view. tldraw's `zoomToUser`
  moves the camera to a point without changing modes
  ([tldraw docs](https://tldraw.dev/sdk-features/user-following)).
- **How they do it**: camera moves are explicit API calls, so they can be
  recorded.
- **In Orvane**: record camera positions at each large jump (focusing an app,
  opening a search result, switching a layout). Alt+Left and Alt+Right on the
  canvas go back and forward, so you can return after Ctrl+K takes you
  somewhere.
- **Effort / builds on**: S. Builds on `camera` and `announceCamera`.

### 9. Audio indicator for the whole canvas

- **Source**: Arc's built-in media controls and picture-in-picture
  ([PopSci](https://www.popsci.com/diy/arc-browser-tips/),
  [Arc release notes](https://resources.arc.net/hc/en-us/articles/20498377604887-Arc-for-macOS-2023-Release-Notes)).
- **How they do it**: whatever is playing is shown with play/pause and mute,
  even when the tab is not in front.
- **In Orvane**: Browser tabs and live clips already receive
  `media-started-playing` and `media-paused`. Collect them into a small
  top-bar indicator showing what is playing, with mute and "go to" buttons. It
  answers "where is that sound coming from" on a large canvas.
- **Effort / builds on**: S. Builds on the webview events used by `LiveClip.vue`.

---

## Browser

### 10. Auto-archive idle tabs

- **Source**: Arc. Idle unpinned tabs archive after 12 hours by default
  (adjustable), pinned tabs never do, and the archive is searchable
  ([Arc help](https://resources.arc.net/hc/en-us/articles/20498377604887-Arc-for-macOS-2023-Release-Notes),
  [2021 notes](https://resources.arc.net/hc/en-us/articles/20498463803799)).
- **How they do it**: a per-tab "last used" time. A sweep moves stale tabs into
  an Archive list you can search and restore from.
- **In Orvane**:
  - Track `lastUsed` per tab in `BrowserView.vue`; `seenAt` already exists.
  - Add a sweep on a timer that moves stale unpinned tabs into the existing
    `state.closed` list, so Ctrl+Shift+T and search restore them.
  - The setting goes in Browser settings: 12 h, 1 day, 1 week, or off.
  - Freeing webviews helps the live-page budget.
- **Effort / builds on**: S. Builds on `state.closed`, `reopenClosed`, `seenAt` and pinned tabs.

### 11. Link routes (which Browser and space a link opens in)

- **Source**: Arc's Air Traffic Control. Routes decide which space a link from
  outside opens in
  ([allthings.how guide](https://allthings.how/how-to-use-the-arc-browser)).
- **How they do it**: rules match a link's source or URL to a target space.
- **In Orvane**: rules such as "`*.netsuite.com` → NetSuite Browser, space
  Work" and "`github.com/*` → Dev Browser". Apply them in `App.vue`'s
  `openLinkEvent` and in Browser `onOpenTab` before a tab is chosen. This
  matters more in Orvane than in Arc, because Orvane can have several Browser
  apps.
- **Effort / builds on**: S–M. Builds on `orvane:open-link` and spaces.

### 12. Quick floating mini-browser over the canvas

- **Source**: Little Arc, a small floating window
  ([Arc help](https://resources.arc.net/hc/en-us/articles/20498377604887-Arc-for-macOS-2023-Release-Notes));
  Zen's Glance, which shows a link in an overlay
  ([Zen](https://zen-browser.app/welcome/)).
- **How they do it**: links open in a light window. You either keep it as a
  real tab or dismiss it.
- **In Orvane**: a link from anywhere (terminal Ctrl+click, a Notes link, an
  inbox item) can open a floating page over the canvas instead of switching
  apps. Buttons: **Keep as tab**, **Pin as live clip**, **Close**. This is
  Peek, but at canvas level.
- **Effort / builds on**: M. Builds on the webview setup in `LiveClip.vue` and Peek.

### 13. Per-site style tweaks ("Boosts")

- **Source**: Arc Boosts, per-site CSS/JS. Dia reportedly dropped them, and
  sources disagree
  ([SupaSidebar](https://supasidebar.com/blog/arc-browser-vs-dia-browser),
  [SuperchargeBrowser](https://www.superchargebrowser.com/library/arc-browser-status-2026/)).
- **How they do it**: CSS and JS attached to a domain and applied on every
  load.
- **In Orvane**: a "Site style" editor (`CodeEditor.vue`) saved per origin.
  `main.mjs` applies it with `contents.insertCSS` on `dom-ready` for matching
  guests. It doesn't wait for loading to finish, so it also works on streaming
  sites. Keep it CSS-only at first, because CSS is safe and covers most uses
  (hide NetSuite banners, widen forms). It also makes live clips cleaner.
- **Effort / builds on**: S. Builds on the `dom-ready` hooks in `main.mjs`.

### 14. Live groups (tab groups fed by a source)

- **Source**: Arc Live Folders, kept as Live Groups in Dia
  ([Dia updates](https://www.diabrowser.com/updates),
  [arc.net](https://arc.net/)).
- **How they do it**: a sidebar folder that fills itself from a source, such as
  GitHub PRs, and updates.
- **In Orvane**: a tab group with a source and a refresh interval:
  - a SuiteQL query whose rows become record URLs (runs through `NetSuiteQuery`);
  - local git branches, via the git API;
  - failing Playwright tests, from `playwrightResults.ts`;
  - an RSS feed.
  Rows become tabs that are only loaded when opened.
- **Effort / builds on**: M. Builds on tab groups and the NetSuite and Playwright services.

### 15. Tiling more than two tabs

- **Source**: Vivaldi tab tiling: side by side with no set limit, in vertical,
  horizontal or grid layouts
  ([Vivaldi](https://vivaldi.com/desktop)).
  Third-party reviews say Zen allows up to four.
- **How they do it**: select tabs and tile them into one view.
- **In Orvane**: extend Split View from two panes to a 2×2 grid. The layout
  code in `BrowserView.vue` (`paneClass`, `inSplit`) generalises from a pair
  to a list. Only the visible panes stay unpaused.
- **Effort / builds on**: M. Builds on Split View.

### 16. Docked web panels

- **Source**: Vivaldi web panels, sites pinned in a narrow side panel with
  their own width
  ([Liliputing](https://liliputing.com/vivaldi-web-browser-adds-more-power-user-features-accordion-tabs-and-command-chains/),
  [Vivaldi](https://vivaldi.com/desktop)).
- **How they do it**: a site lives in a sidebar strip, always available.
- **In Orvane**: a live page docked to the screen edge rather than the canvas,
  so it stays put while you pan. For example chat, a NetSuite saved search, or
  music. It reuses `LiveClip.vue` in a fixed overlay, with a toggle
  shortcut.
- **Effort / builds on**: S–M. Builds on live clips.

### 17. Picture-in-picture for any video

- **Source**: Arc's picture-in-picture mini player (resizable, with playback
  controls) ([Arc release notes](https://resources.arc.net/hc/en-us/articles/20498377604887-Arc-for-macOS-2023-Release-Notes)).
- **How they do it**: when you leave a tab with playing video, a mini player
  follows you.
- **In Orvane**: when a playing tab or clip goes off screen, offer
  "Pop out". Run `video.requestPictureInPicture()` through `runInPage`, using
  the main-frame bridge that already exists. Chromium's own PiP window then
  floats above everything, including other Windows apps.
- **Effort / builds on**: S. Builds on `runInPage` and the media events.

### 18. Eyedropper and page measuring

- **Source**: PowerToys Color Picker
  ([PowerToys](https://github.com/microsoft/PowerToys)); Polypane's developer
  tools ([features](https://polypane.app/features)).
- **How they do it**: pick a colour from the screen; measure elements.
- **In Orvane**: Browser tools → **Pick colour**, using the Chromium
  `EyeDropper` API through `runInPage`, and copy it as hex or rgb. **Measure**
  reuses the element picker from live clips (`PICK_ELEMENT`) to show the
  hovered element's size, margins and font.
- **Effort / builds on**: S. Builds on the element picker in `liveClip.ts`.

### 19. Responsive set (synced viewports)

- **Source**: Polypane. Several viewports of one site, with scroll, click and
  typing synced across them
  ([polypane.app](https://polypane.app/)). A G2 reviewer notes it is
  RAM-heavy ([G2](https://g2.com/products/polypane/reviews)).
- **How they do it**: one browser instance per pane, with events mirrored.
- **In Orvane**: Browser tools → **Responsive set** creates several live clips
  of the same URL at chosen widths (375, 768, 1280). Scroll syncs through the
  tracker channel in `liveClip.ts`: the active pane sends its scroll position,
  and the others apply it. Start with scroll only, and add clicks later. All of
  them pause when off screen, which avoids the RAM complaint.
- **Effort / builds on**: M. Builds on live clips and `LIVE_CLIP_PREFIX` messaging.

### 20. Highlights from pages to cards

- **Source**: Readwise Reader (highlight on the open web, export per document
  as markdown with templates,
  [docs](https://docs.readwise.io/reader/docs/faqs/exporting),
  [help](https://help.readwise.io/article/48-how-do-i-capture-highlights-from-web-articles-into-readwise));
  Heptabase, which turns highlights into cards.
- **How they do it**: you select text and save it, and each highlight keeps its
  source. Highlights from a document can be exported together.
- **In Orvane**:
  - Add **Send to Board** and **Send to Notes** to the page context menu in
    `main.mjs` (`params.selectionText` is already used there).
  - Each creates a sticky note or Notes block with the text and a link back.
  - The link uses a text fragment URL (`#:~:text=`), so opening it scrolls to
    and highlights the passage.
  - A per-page "notebook" in the Browser drawer lists the highlights and
    exports them as one Notes page.
- **Effort / builds on**: M. Builds on the page context menu, Board notes and Notes.

---

## Terminal

### 21. Command blocks

- **Source**: Warp. Each command and its output form a block with exit code,
  duration and time, searchable and navigable by keyboard
  ([DeployHQ guide](https://deployhq.com/guides/warp),
  [How Warp uses Warp](https://warp.dev/blog/how-warp-uses-warp)).
- **How they do it**: the shell reports where each prompt and command begins
  and ends, and the UI groups the output between them.
- **In Orvane**:
  - Use shell integration sequences (OSC 133 prompt and command markers,
    supported by PowerShell, bash and zsh setups).
  - `server/terminal.ts` already streams PTY output, so it can record the
    marker positions.
  - In `TerminalPane.vue`, xterm's markers and decorations draw a thin gutter
    per block, with an exit-code dot and duration.
  - Ctrl+↑/↓ jumps between blocks; click a block to select its output.
- **Effort / builds on**: M. Builds on xterm 6 and the PTY server.

### 22. Pin a command block to the canvas

- **Source**: the same blocks, plus Orvane's own live clips. A block that stays
  next to the work it relates to.
- **How they do it**: Warp lets you share blocks; pinning them spatially is new.
- **In Orvane**: block menu → **Pin to canvas**. This adds a workbench widget,
  like `test-results`, that shows the block's output. If **Rerun** is used, it
  runs the same command in the same folder and updates. `npm test`, `git
  status` or `suitecloud deploy` then sit next to the code.
- **Effort / builds on**: S once #21 exists. Builds on `addWorkbenchWidget`.

### 23. Saved commands with parameters

- **Source**: Warp Workflows, saved command templates with arguments that can
  live in a repository
  ([DeployHQ guide](https://deployhq.com/guides/warp),
  [How Warp uses Warp](https://warp.dev/blog/how-warp-uses-warp)).
- **How they do it**: a named command with `{{arg}}` placeholders, filled in a
  small form before it runs.
- **In Orvane**: workflows stored per project (`.orvane/workflows.json` in the
  repo, so they are versioned) and globally. They appear in Ctrl+K and the
  action wheel. The argument form uses Orvane's custom controls: `CustomSelect`
  for choices, the pickers for dates. Example:
  `suitecloud file:upload --paths {{file}}` with a file picker.
- **Effort / builds on**: M. Builds on the command registry, the action wheel
  and Projects Hub.

### 24. Searchable history with context

- **Source**: Atuin. Shell history in SQLite with exit code, duration and
  folder, and Ctrl-R search filtered by session, folder or everywhere
  ([Atuin](https://docs.rs/atuin),
  [guide](https://kx.cloudingenium.com/en/atuin-shell-history-sync-search-statistics-guide/)).
- **How they do it**: a shell hook records every command with its context.
- **In Orvane**: with #21's markers, `server/terminal.ts` writes each finished
  command to the existing SQLite store (`server/database.ts`): text, cwd,
  exit code, duration and time. Ctrl+R in a terminal opens a custom search
  panel with three filters (this folder, this tab, everywhere) and a toggle
  for "succeeded only". Enter types the command without running it. A
  per-project ignore list keeps secrets out.
- **Effort / builds on**: M. Builds on #21, SQLite and the terminal server.

### 25. Suggestions from history while typing

- **Source**: Warp autosuggestions, based on history and completions and
  accepted with → or Tab
  ([Warp docs](https://docs.warp.dev/terminal/command-completions/autosuggestions)).
- **How they do it**: Warp owns the input editor, so it can show ghost text.
- **In Orvane**: the shell owns line editing (PSReadLine on Windows already
  predicts from history), so Orvane can't add ghost text reliably. The useful
  part is the folder-aware history from #24: a small chip above the prompt
  shows the most likely next command in this folder, and a click types it.
  This idea is limited on purpose: only do it after #24.
- **Effort / builds on**: S after #24.

### 26. Drop-down terminal from anywhere

- **Source**: Windows Terminal quake mode. Win+` opens a terminal on the top
  half of the screen from anywhere and hides it again
  ([Make Tech Easier](https://maketecheasier.com/windows-terminal-quake-mode),
  [release](https://github.com/microsoft/terminal/releases/tag/v1.9.1445.0)).
- **How they do it**: a global hotkey and a special named window.
- **In Orvane**: `main.mjs` already registers a global shortcut (Ctrl+Alt+I).
  Add one for "summon terminal": it brings the Orvane window forward and slides
  a terminal panel over the canvas, attached to a dedicated shell that keeps
  running. Pressing it again hides it. It reuses the terminal server, so
  sessions persist.
- **Effort / builds on**: S–M. Builds on `globalShortcut` and shells that survive reloads.

### 27. Problems list from build output

- **Source**: VS Code problem matchers. Regexes turn tool output into a list
  of file:line problems, with built-ins like `$tsc`
  ([tasks appendix](https://code.visualstudio.com/docs/reference/tasks-appendix)).
- **How they do it**: a matcher reads the output stream and collects file,
  line, column, severity and message.
- **In Orvane**: built-in matchers for `tsc`, `vue-tsc`, ESLint and SuiteCloud
  validation errors run on a terminal block's output (#21). A **Problems**
  widget lists them, and a click opens the file at that line, the same way the
  Playwright results card opens sources.
- **Effort / builds on**: M. Builds on `TestResults.vue` patterns and #21.

### 28. Run package scripts from a menu

- **Source**: VS Code detects npm tasks automatically
  ([tasks appendix](https://code.visualstudio.com/docs/editor/tasks-appendix)).
- **How they do it**: it reads `package.json` scripts and lists them as tasks.
- **In Orvane**: the terminal's **+** menu and Projects Hub list the current
  folder's `package.json` scripts (and `suitecloud` project commands). Choosing
  one opens a new tab named after the script and runs it.
- **Effort / builds on**: S. Builds on `TerminalView.vue` tabs and Projects Hub.

### 29. Project launcher

- **Source**: canvas IDEs that restore a project's whole set of tools:
  OpenCove ([GitHub](https://github.com/Jevari/opencove)) restores layout,
  terminal output and agent state; Cate
  ([article](https://braindetox.kr/en/posts/cate_infinite_canvas_ide_2026.html))
  spreads all of a project's tools on one canvas.
- **How they do it**: a project is a saved arrangement of tools with their
  state.
- **In Orvane**: from Projects Hub, **Open workbench** creates or reuses a
  group containing:
  - a terminal at the project folder;
  - File Explorer on the repo;
  - a Browser on the dev server URL (read from `vite.config`/`package.json`
    when it can be found);
  - the git viewer and the Playwright card.
  It then applies a saved layout for that group. A second open just focuses
  the existing group.
- **Effort / builds on**: M. Builds on Projects Hub, groups, layouts and workbench widgets.

### 30. Agent status on terminal tabs

- **Source**: canvases built around coding agents: OpenCove (Claude Code and
  Codex on a canvas, [GitHub](https://github.com/Jevari/opencove)) and Maestri
  ([site](https://hn.jakechampion.name/reader/https://www.themaestri.app/en)).
- **How they do it**: each agent session shows whether it is working, waiting
  for you, or finished.
- **In Orvane**: `TerminalView.vue` already tracks title, activity and bell
  per tab. Recognise agent CLIs by their window title and output idle time,
  and show a badge (working, needs input, done) on the tab and in the
  zoomed-out summary (#2). A desktop notification fires when an agent needs
  input while Orvane is in the background.
- **Effort / builds on**: S–M. Builds on terminal activity and bell tracking.

---

## Developer tools

### 31. Playwright traces inside Orvane

- **Source**: Playwright Trace Viewer and UI Mode. The Actions tab shows every
  action's locator and timing, and UI Mode combines watch mode, a locator
  picker and time-travel debugging
  ([trace viewer docs](https://playwright.dev/docs/trace-viewer),
  [UI mode](https://timdeschryver.dev/blog/how-the-new-ui-mode-improves-the-playwright-experience)).
- **How they do it**: a local web app that reads trace zip files.
- **In Orvane**: on a failure in the Playwright results card, **Open trace**
  runs `npx playwright show-trace <zip>` (it serves a local page) and opens it
  in a Browser tab or a canvas mini-browser (#12). **UI mode** does the same
  with `npx playwright test --ui`. The card already uses the project's own
  Playwright install.
- **Effort / builds on**: S. Builds on `TestResults.vue` and `playwrightResults.ts`.

### 32. Record a test from a Browser page

- **Source**: Playwright codegen. It records interactions and writes test code
  with recommended locators
  ([testdino guide](https://testdino.com/blog/debug-playwright-tests),
  [DEV](https://dev.to/playwright/playwrights-ui-mode-watch-mode-and-time-travel-debugging-10g5)).
- **How they do it**: `npx playwright codegen <url>` opens a recording browser.
- **In Orvane**: Browser tools → **Record a Playwright test** runs codegen for
  the current URL in the project's terminal. The generated file lands in
  `tests/`, and the results card picks it up. Later, record inside Orvane's own
  webview using the element picker to suggest locators.
- **Effort / builds on**: S (launching codegen); L (Orvane's own recorder).

### 33. Requests app (HTTP client as files)

- **Source**: Bruno. Collections are plain `.bru` files in your repo, versioned
  with git, with no cloud sync
  ([usebruno.com](https://www.usebruno.com/),
  [Git Tower](https://www.git-tower.com/blog/bruno-api-client-using-git)).
- **How they do it**: one text file per request; environments in files; a
  CLI for CI.
- **In Orvane**: a **Requests** app that reads `.http` files (the common
  format VS Code's REST Client uses) from a project folder. Requests are sent
  by the local server, so there are no CORS problems. Environments come from
  `.env`-style files. Responses show in a JSON tree and can be pinned. Useful
  for NetSuite RESTlets and SuiteTalk REST.
- **Effort / builds on**: M. Builds on the server API pattern (`files-api.ts`)
  and `CodeEditor.vue`.

### 34. Developer toolbox with clipboard detection

- **Source**: DevToys. Offline developer tools (JSON formatter, JWT decoder,
  Base64, regex tester…) with "Smart Detection" that picks the tool for what is
  on your clipboard
  ([GitHub](https://github.com/DevToys-app/DevToys),
  [changelog](https://devtoys.app/Home/Changelog)).
- **How they do it**: one window of small tools. The clipboard decides which
  opens first.
- **In Orvane**: a **Toolbox** app: JSON format/validate, JWT decode, Base64,
  URL encode, regex tester with match groups, timestamp ↔ date, and UUID. When
  the inbox captures text (Ctrl+Alt+I), detect JWTs, JSON or Base64 and offer
  "Open in Toolbox". Everything runs locally, so tokens never go to a website.
- **Effort / builds on**: S–M. Builds on the inbox and `CodeEditor.vue`.

### 35. Commit graph and drag-to-reorder rebase

- **Source**: GitKraken. Interactive rebase with pick, reword, squash and drop,
  commits reordered by dragging, and P/S/R/D keys
  ([docs](https://help.gitkraken.com/gitkraken-client/interactive-rebase),
  [v5.0](https://www.gitkraken.com/blog/gitkraken-v5-0)).
- **How they do it**: a visual todo list that becomes a git rebase plan.
- **In Orvane**:
  - Add a lane graph to `GitViewer.vue`.
  - **Interactive rebase** lists commits since the chosen base. Drag to
    reorder; P/S/R/D set the action.
  - Orvane writes the rebase plan and runs `git rebase -i` with
    `GIT_SEQUENCE_EDITOR` pointing at a script that installs that plan, so git
    does the actual work.
  - Conflicts show in the existing diff view.
- **Effort / builds on**: L. Builds on `GitViewer.vue`, `GitDiff.vue` and `server/git.ts`.

### 36. Copy text out of images and clips (OCR)

- **Source**: PowerToys Text Extractor. It copies text from anywhere on screen
  with OCR (Win+Shift+T)
  ([PowerToys docs](https://learn.microsoft.com/en-us/windows/powertoys)).
- **How they do it**: Windows' built-in OCR engine runs on a screen region.
- **In Orvane**: **Copy text** on image widgets, snapshot clips and inbox
  screenshots. Use the Windows OCR API (`Windows.Media.Ocr`) through a small
  helper. `electron/touchpad.cs` shows the project already ships a native
  helper. Offer tesseract.js as a cross-platform fallback. Handy for error
  screenshots and NetSuite pages that block copying.
- **Effort / builds on**: M. Builds on image widgets and the inbox.

### 37. Paste as… (plain, markdown, JSON)

- **Source**: PowerToys Advanced Paste, which pastes clipboard text in
  different formats ([PowerToys docs](https://learn.microsoft.com/en-us/windows/powertoys)).
- **How they do it**: a paste menu that converts formats on the way in.
- **In Orvane**: Ctrl+Shift+Alt+V in Notes, the inbox and sticky notes opens a
  small menu:
  - plain text;
  - HTML → markdown;
  - a table → Notes database rows;
  - a JSON → pretty block;
  - a list of paths → links.
  Conversion is local; there is no AI step.
- **Effort / builds on**: S. Builds on Notes paste handling.

---

## NetSuite

### 38. Field IDs on hover in NetSuite pages

- **Source**: "NetSuite: Show Field IDs" (hover a field to see its ID; find by
  ID or label) and "Field ID Helper" (Ctrl+click a label to copy its ID)
  ([Chrome Web Store](https://chrome.google.com/webstore/detail/netsuite-show-field-ids/pnhdmfiakolonplgblabffnpfhfplmbh?hl=en),
  [Field ID Helper](https://chromewebstore.google.com/detail/netsuite-field-id-helper/ijjafihmmfloifclbbjdhddglpnjhkce?hl=en-US)).
- **How they do it**: a content script reads NetSuite's form markup and adds
  hover labels.
- **In Orvane**: a NetSuite-only page script (injected with `runInPage` on
  NetSuite origins) adds the same hover IDs and Ctrl+click to copy. It is
  turned on from the NetSuite app or Browser tools. Orvane already detects
  NetSuite origins (`netsuite.mjs`).
- **Effort / builds on**: S–M. Builds on `runInPage` and NetSuite environment detection.

### 39. Record explorer (the record as JSON)

- **Source**: NetSuite Field Explorer, and the "EX" and "Plus" variants. They
  show the data behind a record as tables of body fields and sublists, or as a
  JSON tree, with copy and filter
  ([GitHub](https://www.github.com/hyj1116/netsuite-field-explorer),
  [EX](https://addons.mozilla.org/firefox/addon/ns-field-explorer/),
  [Plus](https://chromewebstore.google.com/detail/hnjblekillpajlcfnogcgbgdgjagfgja)).
- **How they do it**: they load the current record's data through NetSuite's
  page context and render it.
- **In Orvane**: **Explore this record** on a NetSuite tab opens the record in
  the existing **record preview** widget (`NetSuiteRecordPreview.vue`), with
  three views: fields, sublists and raw JSON. Values are copyable, so a field
  ID can go straight into SuiteQL.
- **Effort / builds on**: M. Builds on record previews and the processing tabs.

### 40. Saved search → SuiteQL / SuiteScript

- **Source**: NetSuite Saved Search Extractor, which exports saved searches to
  SuiteScript 1.0, 2.x and SuiteQL, with some search types unsupported
  ([Chrome Web Store](https://chromewebstore.google.com/detail/onllcghelikomnnfldgmblpcjaifipom),
  [Folio3 overview](https://netsuite.folio3.com/blog/top-5-plugins-for-netsuite/)).
- **How they do it**: load the search definition (type, filters, columns,
  sort) and write equivalent code.
- **In Orvane**: on a saved search page, **Convert** loads the search with
  `N/search` in the page context. It writes N/search 2.x code into a new file
  and a best-effort SuiteQL query into `SuiteQLEditor.vue`, with a note listing
  anything it couldn't translate (formula columns, unsupported joins).
- **Effort / builds on**: M. Builds on `SuiteQLEditor.vue` and `runInPage`.

### 41. Live script logs

- **Source**: NetSuite Utilities' Script Log Viewer: filter execution logs by
  type, script, title, detail and date, in a side panel that stays open
  ([docs](https://bernsteinmatt.github.io/netsuite-utilities/docs/features/script-log-viewer)).
- **How they do it**: queries the execution log and shows a filterable list.
- **In Orvane**:
  - A **Logs** tab in the NetSuite app queries the script note records with
    SuiteQL through the existing session, using the windowed grid for speed.
  - Filters: level, script, deployment, text and date.
  - **Follow** re-queries every few seconds.
  - The key link: after a SuiteCloud upload in Projects Hub, offer "Watch logs
    for this script", which opens Logs already filtered to it.
- **Effort / builds on**: M. Builds on `NetSuiteQuery`, `WindowedGrid.vue` and `SuiteCloudUploadView.vue`.

### 42. Compare sandbox and production

- **Source**: Salto Compare & Deploy (two accounts' configuration side by
  side) and Netwrix StrongPoint environment comparison
  ([Salto](https://salto.io/blog-posts/how-to-compare-and-sync-two-netsuite-accounts),
  [Netwrix](https://www.netwrix.com/netsuite-environment-comparison.html)).
  NetSuite's own tools deploy changes without comparing them.
- **How they do it**: fetch both configurations and diff them.
- **In Orvane**: Orvane already holds sessions to several environments
  (processing tabs). **Compare environments** runs the same SuiteQL against
  two of them for scripts and deployments, custom fields, custom records and
  saved search names. The differences show in the `FolderCompare.vue` style:
  only in A, only in B, different. A deeper option fetches both with SDF and
  diffs the folders with the existing folder compare.
- **Effort / builds on**: M. Builds on processing tabs, SuiteQL and folder compare.

### 43. Script and deployment health board

- **Source**: the vendor change-management guides above (Salto), which stress
  knowing what is deployed where
  ([Salto guide](https://www.salto.io/netsuite-change-management-2023-guide)).
- **How they do it**: dashboards of deployments and their status.
- **In Orvane**: a NetSuite dashboard preset, using the dashboards Orvane
  already has, showing recent errors per script (from #41), deployments that
  are not released, and scripts changed in the last 7 days. Pin it as a canvas
  widget next to the project workbench (#29).
- **Effort / builds on**: S after #41. Builds on NetSuite dashboards.

---

## Notes, links and capture

### 44. Backlinks everywhere

- **Source**: Obsidian Backlinks: notes linking here, plus unlinked mentions
  ([Obsidian help](https://obsidian.md/help/plugins),
  [core plugins](https://publish.obsidian.md/hub/05+-+Concepts/Obsidian+Core+Plugins)).
- **How they do it**: an index of links between notes, shown per note.
- **In Orvane**: build an index across *all* of Orvane's link sources: Notes
  page links, sticky-note links, calendar items, inbox captures and Board
  arrows. Each Notes page, file (in File Explorer) and app header shows
  "Linked from (3)". Unlinked mentions search Notes text for the page title.
- **Effort / builds on**: M. Builds on Notes `pageTree`, Board links and Ctrl+K search.

### 45. Daily note linked to the Calendar

- **Source**: Obsidian Daily notes and Templates, with date, time and title
  variables ([core plugins](https://publish.obsidian.md/hub/05+-+Concepts/Obsidian+Core+Plugins)).
- **How they do it**: one note per day, created from a template.
- **In Orvane**: a calendar day opens (or creates) a Notes page for that day
  from a template (`{date}`, `{weekday}`). Today's calendar items are inserted
  as a checklist. Ctrl+K "Today" jumps there.
- **Effort / builds on**: S. Builds on Calendar and Notes.

### 46. Live query blocks in Notes

- **Source**: Tana search nodes, live searches that update as matching nodes
  change and can show as a list, table or calendar
  ([Tana docs](https://tana.inc/docs/search-nodes),
  [supertags](https://tana.inc/docs/supertags)).
- **How they do it**: a saved query embedded in a page, whose results are
  editable references.
- **In Orvane**: a Notes block whose content is a query over Orvane data:
  - "calendar items this week not done";
  - "inbox links captured from github.com";
  - "Notes database rows with Status = Doing";
  - "failing tests in project X".
  Results update live and can be edited in place where the source allows it.
- **Effort / builds on**: M. Builds on Notes databases (filters and sorts already exist).

### 47. Synced blocks between Notes and the canvas

- **Source**: Notion synced blocks. Edit one copy and every copy changes
  ([Notion Academy](https://Notion.com/help/notion-academy/lesson/synced-blocks),
  [Thomas Frank guide](https://thomasjfrank.com/notion-synced-blocks-guide/)).
- **How they do it**: copies reference one original block.
- **In Orvane**: drag a Notes block (a checklist, a database view) onto the
  canvas to make a widget that *is* that block, not a copy. Edits in either
  place update both. Notion warns that a mistake spreads to every copy, so
  show a small "synced" mark.
- **Effort / builds on**: M. Builds on Notes `blockSnapshots` and workbench widgets.

### 48. Universal links between anything

- **Source**: Hookmark, bidirectional links between files, emails, URLs and
  other items, kept across renames and moves
  ([features](https://hookproductivity.com/help/features/),
  [site](https://hookproductivity.com/)).
- **How they do it**: each item knows what is linked to it, both ways.
- **In Orvane**: a small link store (SQLite) relating any two items: a file
  path, a Browser URL, a Notes page, an app, a NetSuite record. A **Link**
  action from any context menu hooks the current item to another; an item's
  links show as a chip. Files are stored by path, and links are updated when
  File Explorer renames or moves the file. #44 then reads from this store.
- **Effort / builds on**: M. Builds on File Explorer operations and the
  `OpenRequest` types in `commands.ts`.

### 49. Snippets with fields

- **Source**: Espanso (forms with fields that feed later steps; shell
  variables, [forms docs](https://espanso.org/docs/legacy/forms)); Raycast
  Snippets (keyword expansion with clipboard and date placeholders,
  [manual](https://manual.raycast.com/llms.txt)).
- **How they do it**: typing a keyword replaces it with a template, asking for
  fields when needed.
- **In Orvane**: a snippet library. In Orvane's own text surfaces (Notes,
  sticky notes, the inbox, the SuiteQL editor, terminals), typing `;keyword`
  expands it. Placeholders: `{clipboard}`, `{date}`, `{cursor}`, and fields
  asked in a small custom-controls form. Examples: a SuiteScript 2.1 header,
  a standard commit message, an `npx playwright test` command with a test
  name field.
- **Effort / builds on**: M. Builds on `CodeEditor.vue`, the Notes editor and `TerminalPane` input.

### 50. Clipboard history

- **Source**: Raycast Clipboard History: text, images, files, links and
  colours, searchable with previews
  ([manual](https://manual.raycast.com/llms.txt),
  [review](https://dev.to/jangwook_kim_e31e7291ad98/raycast-review-2026-the-mac-launcher-that-replaced-4-apps-mcp-setup-guide-3ag2)).
- **How they do it**: every copy is recorded locally and searchable.
- **In Orvane**: opt-in clipboard watching in `main.mjs` (it already reads the
  clipboard for capture). Copies go into a history separate from the inbox,
  with a limit and an ignore list (password managers mark their copies as
  sensitive; skip those). Search it from Ctrl+K with `cb `. Pressing Enter
  pastes, and **Keep** promotes an item to the inbox.
- **Effort / builds on**: M. Builds on the inbox capture code.

### 51. Workspace timeline (activity history)

- **Source**: Screenpipe, the open-source take on Rewind: a searchable
  timeline of past activity, stored locally in SQLite with FTS5
  ([screenpi.pe](https://screenpi.pe/rewind),
  [blog](https://screenpi.pe/blog/rewind-ai-alternative-2026)). Reviews note
  screen capture costs gigabytes.
- **How they do it**: event-triggered screenshots plus OCR, searchable by
  app, window and date.
- **In Orvane**: no screenshots. Record events Orvane already knows: page
  visits, commands run (#24), files opened, notes edited, apps created and
  focused, and NetSuite records viewed, all with times. A **Timeline** view
  answers "what was I doing Tuesday afternoon" and links back to each item.
  It is small, private and fully local.
- **Effort / builds on**: M. Builds on SQLite, Browser history and #24.

### 52. Keyboard triage for the inbox

- **Source**: Linear Triage: accept, escalate, merge, decline (with a
  comment) or snooze, by keyboard
  ([changelog](https://linear.app/changelog/2021-06-29-linear-release-and-issue-triage)).
- **How they do it**: one inbox where each item gets a decision with a
  single key.
- **In Orvane**: in the Workspace inbox, J/K move between items, and single
  keys act:
  - N → sticky note;
  - C → today's calendar;
  - B → open in Browser;
  - S → snooze until tomorrow (it comes back);
  - Delete → discard.
  Snooze is the one new behaviour.
- **Effort / builds on**: S. Builds on `WorkspaceInbox.vue`.

### 53. Time-blocking: drag tasks onto the day

- **Source**: Sunsama (drag tasks onto your calendar) and Akiflow (a universal
  inbox, and "slots" that group tasks in a block)
  ([Akiflow vs Sunsama](https://toolfinder.com/comparisons/akiflow-vs-sunsama),
  [Akiflow slots](https://akiflow.com/blog/daily-planner-time-slots)).
  Both comparison sources are partly promotional.
- **How they do it**: a day timeline you drop tasks onto to give them a time.
- **In Orvane**: add an hour timeline to the Calendar's selected day. Drag
  inbox items, Notes checklist items or calendar items onto it to set a time
  (which also sets the reminder). A **slot** groups several items under one
  block.
- **Effort / builds on**: M. Builds on `CalendarView.vue`, reminders and the inbox.

### 54. Morning plan

- **Source**: Sunsama's daily planning ritual: review yesterday, choose today's
  focus, block time
  ([toolfinder comparison](https://toolfinder.com/comparisons/akiflow-vs-sunsama)).
- **How they do it**: a guided few steps each morning.
- **In Orvane**: on the first open of the day (optional), a small panel shows
  yesterday's unfinished calendar items (roll over or drop), today's items,
  and inbox items older than a day. It finishes with an optional switch to a
  chosen layout. It is quick and skippable, and doesn't block the canvas.
- **Effort / builds on**: S–M. Builds on Calendar, the inbox and Layouts.

---

## Building and automation

### 55. A library of saved apps

- **Source**: Excalidraw libraries. Reusable sets of elements saved as
  `.excalidrawlib` files, shared from a public directory
  ([libraries.excalidraw.com](https://libraries.excalidraw.com),
  [repo](https://github.com/excalidraw/excalidraw-libraries)).
- **How they do it**: select elements and save them to a library; drag them
  back in; import files.
- **In Orvane**: save a built app (its component tree, rules and graphs) to a
  library, exported as an `.orvanelib` JSON file. Drag it from the library onto
  the canvas to create a copy. The MCP batch import and validation
  (`validation.ts`) already handle loading component trees safely.
- **Effort / builds on**: M. Builds on the builder, `validation.ts` and MCP import.

### 56. Named command chains

- **Source**: Vivaldi Command Chains, a named sequence of browser commands,
  run from Quick Commands, a shortcut or a mouse gesture
  ([Liliputing](https://liliputing.com/vivaldi-web-browser-adds-more-power-user-features-accordion-tabs-and-command-chains/),
  [Vivaldi 4.1](https://vivaldi.com/?p=180034)).
- **How they do it**: pick commands from a list, order them and name the chain.
- **In Orvane**: the Action library already runs graphs. Expose Browser,
  Terminal, Layout and camera commands as nodes, for example: "Switch layout
  NetSuite → open Browser tab X → run saved command Y → focus app Z". A
  chain can sit on the action wheel or a shortcut. Most of this is wiring the
  existing commands from `allCommands()` into node types.
- **Effort / builds on**: M. Builds on the Action library and `commands.ts`.

### 57. Buttons that call webhooks or local commands

- **Source**: Notion buttons, one-click actions that can include confirmation
  steps and webhook actions
  ([The Sweet Setup](https://thesweetsetup.com/how-to-create-notion-buttons-to-automate-your-workflow/),
  [Notion help](https://Notion.com/help/category/write-edit-and-customize)).
- **How they do it**: a button runs a list of steps, optionally asking for
  confirmation first.
- **In Orvane**: two new action-graph nodes, **HTTP request** (sent by the
  local server) and **Run command** (in a chosen terminal or folder). Each
  can ask for confirmation, like Notion's. Then an app button can deploy,
  trigger a RESTlet or start a test run.
- **Effort / builds on**: M. Builds on the action graph nodes and the terminal server.

### 58. Command palette extensions

- **Source**: PowerToys Command Palette (the successor to PowerToys Run, with
  an extension gallery) ([PowerToys](https://github.com/microsoft/PowerToys));
  Raycast Quicklinks (any URL with a query becomes a command,
  [manual](https://manual.raycast.com/llms.txt)).
- **How they do it**: small providers add result types to one launcher.
- **In Orvane**: Ctrl+K already searches apps, Notes, history, git and
  files. Add **quicklinks**: a URL template with `{query}`, such as
  "ns rec {id}" opening a NetSuite record or "gh {repo}". Add **result
  providers** too: a folder of small JS modules, loaded at startup, that
  return results (for example "Jira issue", "local docs").
- **Effort / builds on**: S for quicklinks, M for providers. Builds on `commands.ts`.

### 59. Templates for whole layouts

- **Source**: Obsidian Templates and Notion's template buttons, which build
  repeated structures from a template
  ([Obsidian](https://obsidian.md/help/plugins),
  [Notion buttons](https://matthiasfrank.de/en/notion-updates/notion-buttons-can-now-insert-blocks-at-the-top-or-the-bottom-of-a-page/)).
- **How they do it**: a stored template, with variables filled in at
  creation.
- **In Orvane**: a template of *several apps* with placeholders, for example
  "NetSuite ticket": a Notes page `{ticket}`, a Browser on the record, a
  SuiteQL query, a calendar item for the deadline and a sticky note. Creating
  it asks for `{ticket}` and places everything as a group. It differs from #55,
  which saves one app.
- **Effort / builds on**: M. Builds on groups, Layouts and #55.

### 60. MCP tools for the new pieces

- **Source**: Hookmark and Screenpipe both ship MCP servers so coding agents
  can use them ([Hookmark MCP](https://glama.ai/mcp/servers/mnott/Hook),
  [Screenpipe MCP](https://mcpservers.org/en/servers/mediar-ai/screenpipe)).
- **How they do it**: their local data is exposed as tools an agent can call.
- **In Orvane**: as ideas above land, expose them through the existing MCP
  server (`server/index.ts`): command history (#24), the timeline (#51),
  universal links (#48), script logs (#41) and saved commands (#23). An agent
  in an Orvane terminal could then ask "what failed in the last deploy" and
  get the NetSuite log.
- **Effort / builds on**: S per tool. Builds on the MCP server.

---

## Notes on sources

- **Arc**: Arc is being shut down on December 22, 2026; Dia carries over
  sidebar tabs, Profiles, pinned tabs, folders and Split View
  ([arc.net](https://arc.net/), [Arc on Wikipedia](https://en.wikipedia.org/wiki/Arc_(web_browser))).
  Third-party sources disagree on whether Boosts and Little Arc survive in
  Dia. That leaves room for an Arc-style browser.
- **Vendor material**: Salto, Netwrix, Akiflow, Fabric and Screenpipe pages
  are vendors describing their own products or comparisons. The behaviour is
  likely accurate; the comparisons are marketing.
- **Canvas IDE projects** (OpenCove, Cate, Atlas, Maestri) are early-stage.
  Their feature lists are self-reported
  ([listing](https://awesome.ecosyste.ms/projects/github.com%2FDeadWaveWave%2Fopencove),
  [Atlas](https://hunted.space/dashboard/atlas-infinite-canvas-for-ideas)).
- **Not verified**: per-version details (which release added what) and
  pricing. Check the current official docs before building on a specific
  behaviour.
