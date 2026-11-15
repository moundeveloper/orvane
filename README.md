# Orvane

### File Explorer

Create it from **Workspace options → Create File Explorer**, or add a **File Explorer** component in the builder. It browses this computer's folders through Orvane's local server (`/__orvane/files/*`, same-origin loopback only, implemented in `server/files.ts`).

Each tab is a folder with its own back/forward history, sort, Details/Icons view and preview pane. Tabs use the same strip as the NetSuite apps: drag to reorder, drag a tab to the left or right edge to split, right-click for split/duplicate/close-others, Ctrl+Alt+N for a new tab and Ctrl+Alt+T to reopen one. Dragging folders onto the tab bar opens them as tabs. The sidebar has Quick access, pinned folders and a lazy folder tree of the drives; all of them accept drops.

Files support multi-selection (Ctrl/Shift, Ctrl+A, arrows, type-ahead), Enter to open (folders navigate, files open in their default program), F2 inline rename, Ctrl+X/C/V, drag-and-drop between folders, tabs and split panes (same drive moves, another drive copies; Ctrl copies, Shift moves), Ctrl+Shift+N new folder, and Delete, which moves items to the Recycle Bin after an in-app confirmation; nothing is permanently deleted. Ctrl+L edits the path, Ctrl+F filters the folder, and the search box searches the folder and its subfolders by name (limited to 500 results). The preview pane shows images and text, and text files of up to 2 MB can be edited and saved with Ctrl+S; a save is refused if the file changed on disk since it was opened. Tabs, splits, views and pins are saved with the app.

**Peek** (Space, the eye button, or right-click → Peek) opens a file in a panel over the folder, styled like the Browser's Peek View. Arrow keys step through the folder's files; Enter opens the file in its default program; Esc or Space closes. It shows images, video and audio (streamed with seeking, so large files start at once), PDFs, Excel workbooks (.xlsx/.xlsm, every sheet) and CSV/TSV as a table, and code, XML, JSON and other text read-only with syntax highlighting and search. Spreadsheets show stored values (no formula recalculation or date formatting) and the first 2,000 rows × 80 columns; legacy .xls and video codecs Chromium cannot decode open in the default program instead. Media is served at `/__orvane/files/raw` with a per-server token that only the Orvane page receives.

### Image widgets

Drop an image on empty canvas to create an image widget at that spot, sized to the picture: from the File Explorer, from the system's file manager, or dragged out of a web page (including the Browser app). File Explorer images can also be placed with right-click → **Place on canvas** or the Peek rail. Pictures are copied into `.orvane/images/` (content-addressed), so the widget keeps working when the original moves; a web image that cannot be downloaded (for example behind a sign-in) keeps its web address instead. Image widgets can also be added from the builder and filled by dropping or choosing a file. Ctrl+V on empty canvas places a clipboard image (a screenshot, a copied picture or an image address) at the pointer.

Hover an image widget for its tools: rotate left/right, flip, crop (drag the box or its corners; Enter applies, Esc cancels), caption, and a frame (mat border, polaroid, shadow, rounded). Rotate, flip and crop store a new picture and keep the original, so **Reset** returns to it. Pictures from a web address cannot be rotated or cropped.

### File widgets

Any other file dropped on the canvas — a video, PDF, spreadsheet, audio or code file, from the File Explorer or (in the desktop app) from the system — becomes a **file widget** that shows it with the same viewers as Peek. File widgets link to the file where it is, rather than copying it, and refresh as soon as the file changes on disk. **Place on canvas** in the File Explorer works for every file type.

### Canvas workbenches

- **Browser clip.** In Orvane Desktop, open a page and choose **Browser menu → Browser tools → Pin a live clip**. Drag over the area to pin. **Refresh clip** captures that area again from the open source tab, and **Open original** returns to the page. Backups include the last captured image.
- **Folder comparison.** Drop one or two folders from File Explorer on the canvas, or run **Compare two folders** from Ctrl+K. Drop the second folder onto the empty field or enter both paths. The comparison checks nested file contents and skips filesystem links. **Open diff** uses local Git. Copying over an existing file requires confirmation.
- **Playwright test results.** Choose **Pin Playwright results** in Terminal, enter the project folder, and run the suite or import a Playwright JSON report. Click a failure's file and line to see its source, or choose **Rerun test** to run it again. The card uses the project's installed Playwright.

### More File Explorer tools

- **Compress to ZIP** / **Extract here** (right-click). Archives are written and read with Node's zlib; entries that would land outside the target folder are refused, and ZIP64, encrypted and over-2 GB archives are not supported.
- **Git badges**: inside a repository, files and folders show M (modified), A (added), D (deleted), R (renamed), U (untracked) or C (conflict). Folders show the most notable change inside them.
- **Batch rename**: select several items and press F2 (or right-click → Rename). Use find & replace (optionally a regular expression, keeping extensions) or a numbered pattern such as `Photo {n}`; the preview flags duplicates and invalid names, and all items are renamed together.
- **Folder sizes**: the size button computes folder totals in the background (≥ marks a total that stopped early in a very large folder); sorting by size then includes folders.
- **Live updates** (on by default): visible tabs refresh the moment their folder changes on disk.
- History survives reloads; mouse back/forward buttons work in each pane, and Alt+Left/Right/Up and Backspace act on the active pane even after a sidebar click.

### Connections between apps

Drag files from the File Explorer (or the system, in the desktop app) into **Notes**: images become image blocks, other files a 📎 link that opens the file. Drop files on the **Projects Hub terminal** to type their quoted paths at the prompt; nothing runs until Enter.

### Search and commands (Ctrl+K)

Ctrl+K opens one box that searches apps, commands, Notes pages and their text, Browser history, Git commit messages and hashes (across saved Git workspaces) and file names under your home folder. Enter opens the result in its app: a note page, a browser tab, the commit in a Git viewer, or the file selected in the File Explorer. Type `>` first, or press Ctrl+Shift+P, for commands only. Apps add their own commands (open a File Explorer place or pin, new note, new browser tab, run the SuiteQL query, refresh Git history), next to canvas commands such as new apps, layouts, board tools and backups. Inside Notes, Ctrl+K keeps opening the Notes search.

### Layouts

**Layouts** in the top bar saves the current arrangement under a name (Coding, Research, NetSuite…): every app's position, size and whether it is shown, plus the view. Click a layout to switch; switching never changes what is inside an app. Untick apps under "Shown in this view" to leave them out of a layout, update a layout with the save icon, and switch from Ctrl+K. Apps created after a layout was saved stay visible where they are.

### Board

The rail on the left of the canvas holds whiteboard tools: **sticky notes** (click to place; double-click to write; drag the top strip, resize from the corner, change colour), **arrows** (drag from one app or note to another; the arrow follows them as they move; double-click to label), **freehand drawing** and an **eraser**. The colour dot sets the colour for arrows and drawings. Select an item and press Delete to remove it; Esc returns to Select. Board items are saved with the workspace.

Drop a file or folder from the File Explorer, or a tab from the Browser, onto a sticky note to **link** it. The link shows at the bottom of the note; click it to open the file (selected in its folder) or folder in the File Explorer, or the page in the Browser. Dropping several items links the first. Select the note to remove the link.

### Workspace inbox

Open **Workspace options → Workspace inbox** or search for it with Ctrl+K. Add a note, paste a link, or paste a copied image into the capture field. In the desktop app, **Ctrl+Alt+I** (Command+Option+I on macOS) or **Capture clipboard** in the tray saves the current clipboard and opens the inbox. To capture a Windows screenshot, copy it with **Win+Shift+S**, then use the Orvane shortcut.

Move text or links to a sticky note or to today's Calendar. A link on a sticky note opens in an Orvane Browser app. Move an image to the canvas as a widget, or discard any capture. Inbox entries and their images are included in workspace backups.

### Calendar

Create it from **Workspace options → Create Calendar** (or Ctrl+K). Click the month name to jump to any month and year. A month view sits next to the selected day's items: add an item with an optional time, tick it done, edit its title or time, or delete it. An item with a time gets a **reminder** (the bell turns it on or off). Due reminders are checked every 15 seconds by the editing window: in the desktop app they are system notifications, also while Orvane sits in the tray, and clicking one opens the Calendar; in a browser they use the browser's notifications (asked for when you first set one), or a message in Orvane when notifications are blocked. A reminder missed while Orvane was closed is shown once if it was due within the last day, and skipped otherwise. Upcoming items appear in Ctrl+K and open their day.

### Terminal

Create it from **Workspace options → Create Terminal** (or Ctrl+K). Each pane is a real shell running in a pseudo-console ([node-pty](https://github.com/microsoft/node-pty)): output streams as it happens, colours, prompts and full-screen programs work, and Ctrl+C interrupts. The **profiles** are the shells found on this computer: Command Prompt, Windows PowerShell, PowerShell 7, Git Bash, WSL distributions, Visual Studio developer shells and the custom profiles in Windows Terminal's settings. Pick one from the arrow next to **+**, star one to make it the default, or press Ctrl+Shift+1…9.

- **Tabs and split panes**: Ctrl+Shift+T new tab, Ctrl+Shift+W close the pane, Ctrl+Tab / Ctrl+Shift+Tab switch tabs; double-click a tab (or F2) to rename it, middle-click to close it. Alt+Shift+D splits the pane, Alt+Shift+= splits right and Alt+Shift+- splits down (also the buttons on the right); drag a divider to resize and use Alt+arrows to move between panes. Tabs show a dot for new output and a bell when a program rings.
- **Copy and paste** like Windows Terminal: Ctrl+C copies a selection (and interrupts otherwise), Ctrl+V or Ctrl+Shift+V pastes, Ctrl+Shift+C copies, and right-click copies a selection or pastes.
- **Links**: Ctrl+click a web address to open it in the Browser app (or your browser when there is none), or a path like `C:\Users\…` to show it in the File Explorer.
- **Find** with Ctrl+Shift+F (Enter / Shift+Enter for next / previous). Ctrl+= / Ctrl+- / Ctrl+0 change the text size; Ctrl+Shift+K clears the screen.
- **Drop files** from the File Explorer or the system onto a pane to type their quoted paths.
- **Shells keep running** when Orvane reloads or the app is archived: reopening reattaches to them and replays their recent output. A shell that exits normally closes its pane; otherwise press Enter to restart it. Shells no window has shown for 15 minutes end, and all of them end with Orvane.
- The app is frosted glass like the top bar. The terminal server only accepts Orvane's own page on this computer (same origin, loopback).

### Backups

**Export backup** includes the pictures used by image widgets, so restoring brings them back too; a picture whose content no longer matches its id is skipped. Plain workspace JSON from earlier exports still imports. File widgets link to files elsewhere on disk and are not included.

### Projects Hub

Projects Hub recreates the local project manager from `C:\Projects\UI` as an Orvane app. Create it from **Workspace options → Create Projects Hub**, or add a **Projects Hub** component in the builder. Choose an existing projects root using Browse or enter its absolute path and Open. The selected root is saved with the app. Existing `.projects-hub.json` groups and terminal state can be read from that root; new configuration writes go to Orvane's SQLite database, leaving the original metadata file unchanged.

The app supports searchable project folders, named groups with individual workspace folders, group reordering/renaming, multi-selection, project creation (empty, Vue, SuiteCloud or Git clone), importing existing folders, and moving projects between group workspaces. Context actions open VS Code, Explorer, a terminal tab, or the SuiteCloud file upload view. Removal uses an in-app confirmation and a separate choice to remove the actual folder. Root folders and their ancestors cannot be deleted through project removal.

The resizable terminal runs submitted commands in each tab's working directory and remembers tabs and panel state. SuiteCloud supports FileCabinet browsing, file selection, configured account selection, browser login, command preview and upload. These actions use the machine's existing Git, pnpm, VS Code and SuiteCloud CLI installations as appropriate; no toolchain is installed automatically. Git clone and scaffold/upload commands execute only when selected in the UI or explicitly requested through MCP.

MCP can create the app with `component_create` using `kind: "projects"` and `properties.value` set to the absolute projects root. The `projects_hub` tool exposes its folder, group, project, terminal and SuiteCloud operations. Its HTTP API is restricted to same-origin loopback requests and uses the same isolated database namespaces as the existing Git/storage tests.

A quiet, local-first app canvas, built with Vue 3 and TypeScript from the supplied Infinite Canvas App Container specification.

## Run

```sh
pnpm install
pnpm dev
```

Open the local URL Vite prints. Four editable examples (Daily list, Notes, Tally and Calculator) are added once, including to existing workspaces without replacing existing apps. Re-add them from Workspace → Add example apps. Click **+** in the bottom dock to create a blank app; use **Build app** to add and configure components. No accounts, separate database-server installation, API keys or publish step are needed. Fonts and icons are bundled locally. The local Orvane server owns the shared SQLite file.

## Performance

Pan, zoom, clicks and app switching are kept independent of how many apps are open: pan feedback is a single overlay, apps away from the viewport skip rendering, and startup mounts the apps in view first. [PERFORMANCE.md](PERFORMANCE.md) has the measurements and limits; [APP_PERFORMANCE.md](APP_PERFORMANCE.md) has the standards every app follows, including the `window.orvane` runtime that each code app receives.

```sh
pnpm bench              # interaction benchmark on a 50-app fixture (opens an Electron window)
pnpm bench -- --check   # fail when a budget is exceeded
pnpm test:css           # reject selectors that restyle every descendant
```

## MCP automation

An optional local MCP server can create, inspect and edit apps, nested components, rules/graphs, reusable actions and spatial groups in the live browser workspace. It also provides atomic batches, validated Merge/Replace import, revision checks and recovery snapshots. Keep Orvane open, and configure your MCP client with [mcp.json](mcp.json); the client launches the server through `server/launch.mjs`. See [MCP setup, tools and examples](server/README.md). Nothing is installed into a host automatically.

## Canvas

- Drag empty space, Space-drag, or middle-drag to pan. Scrolling (mouse wheel or two fingers) over an app scrolls that app. On a touchpad, hold **Space and scroll with two fingers** to pan. The app you last clicked or typed in has a faint outline; click empty canvas or press Esc to clear it. Hold **Space and move the pointer** (no click needed) to pan freely in any direction — over empty canvas, apps, code apps and Browser pages alike, whichever app has focus; only text fields and code editors keep Space for typing, and a quick tap of Space still reaches the app (e.g. Peek in the File Explorer). Ctrl/Command-scroll or pinch on the background to zoom. Wheel zoom eases continuously toward the requested scale, anchored at the pointer. A single translate/scale transform is used throughout motion and at rest. There is no CSS-zoom handoff, end-of-gesture resize or forced blur/sharpen pass. Frame timing is measured only between animation-frame timestamps; the first frame cannot run backward. App dimensions, text layout and iframe viewports stay unchanged.
- Drag an app header to move it, or Alt/Option-drag its surface; drag any edge or corner to resize. Titles are editable only in Build mode. Header controls and title inputs keep their normal behavior. App options also expose numeric position and size for keyboard and touch access.
- Dock tabs and search pan and zoom to fit the selected app between the top controls and dock, preserving its state and logical dimensions. Drag tabs to reorder, or focus a tab and press Alt+Left/Right. Search matches names and spatial groups. Use Groups in the top bar, or click a group label, to create/name groups and select their apps. Group bounds follow member positions without moving or resizing any app; Go to group pans without changing zoom. Ungroup apps keeps the apps and their content.
- Defaults: **N** creates an app, **K** searches, **H** centers the canvas, **F** focuses the app in use. Customize these in Workspace. Global shortcuts defer to text fields.
- **Focus an app**: the expand button in its header, or **F** for the app you last clicked, fills the window between the top bar and dock with that app. Esc (outside text fields), F or the button again returns; the app keeps its saved position and size and the view comes back as it was. While focused, the canvas doesn't pan or zoom and the app isn't moved or resized. Opening another app from the dock or search leaves focus.
- **Undo** with Ctrl+Z, redo with Ctrl+Shift+Z or Ctrl+Y (outside apps and text fields): moving, resizing, creating, duplicating, archiving and deleting apps, layout visibility, and Board notes, links, arrows and drawings. Content inside apps is never undone this way; each app keeps its own undo. A drag or stroke is one step; history holds 100 steps and starts fresh when the workspace is loaded or replaced.

## Build

The temporary in-app builder has a collapsible hierarchy, component properties, app styling, and explicit connections. Layouts support vertical stacks, wrapping rows and two-column grids, including nesting. Each app can choose a grid stacking breakpoint, spacing, inset, accent, radius, dock icon, and whether to show its name.

Components: text, text field, button, checkbox, list, counter, divider, layout and custom HTML/CSS/JavaScript. Lists and counters work immediately. Button clicks, field Enter and checkbox changes can run ordered rules: add an item, clear a field, increment, toggle, set a value, invoke another component's rules, or use a reusable action. Values can reference fields by `{field label}` or stable `{component ID}`. Blank values pass along the preceding result.

Rules expand into a spatial node editor inside the app: drag node headers, connect input/output sockets, branch flows, reconnect or select and delete wires, and Shift-click nodes to group them. Double-click an input socket to disconnect its incoming wires. Saved wires determine execution; disconnected nodes do not run. Groups reopen as editable internal graphs. Loops are rejected by the editor and guarded at runtime. JavaScript actions receive `value` and return a value; these run in a sandboxed opaque-origin iframe and terminable worker, with a two-second timeout and blocked network connections. HTML components run in isolated sandbox frames with no workspace storage access and restrictive resource policy. Runtime errors appear inline. Custom HTML is intended for code the workspace owner trusts: arbitrary DOM scripts are not a resource-isolated extension platform and can still monopolize their rendering thread.

Reusable component definitions support explicit updates to linked copies and local detachment. Definition updates affect label, arrangement, spacing and custom code while preserving each instance's live data and identity. Cross-app targets are available only after that app explicitly exposes its interface. Stable IDs survive movement and renaming; archived or disconnected targets fail visibly. Inspect recent action traces in Workspace → Connection activity. Traces are session-only.

Code fields use a light CodeMirror editor with line numbers, syntax highlighting, completion, bracket matching, folding, search, undo/redo and inline syntax diagnostics. Expand the editor for more room. Tab indents; Escape followed by Tab leaves the editor. Changes preview live. The builder panel has a narrow draggable divider; focus it and use Left/Right to resize by keyboard. Its width persists with the app. Dropdowns use custom keyboard-accessible listboxes, and scrollbars are themed both in the container and inside isolated code frames.

## Saving and recovery

Definitions, content, rules, code, shared components, positions, sizes, tab order, shortcuts, archived apps and shared actions save automatically to **`.orvane/workspace.sqlite`** through Orvane's local backend. Different browsers and browser profiles connected to this server share the same workspace. One browser/tab owns editing; the others update automatically in read-only mode. Ownership transfers after the editor closes, or after its 15-second lease expires if it crashes. Revision checks reject stale writes. Camera and temporary editing/menu state do not persist.

The first browser opened against an empty SQLite database migrates its existing IndexedDB workspace (or older localStorage workspace). Original browser records are retained unchanged. Existing SQLite data is never overwritten automatically by another browser's old data. Use **Workspace → Recover earlier browser workspace** to preview Merge/Replace if that browser has a different old workspace. Storage failures offer export and retry while preserving in-memory work, and closing with unsaved work invokes the browser's unsaved-changes prompt.

Use `pnpm dev`, or `pnpm build` followed by `pnpm preview`. Both provide the database API; a static-only file host is insufficient. No database executable, service, or administrator setup is needed. `ORVANE_DATA_DIR` selects a different local data directory. The data stays on this computer; it is not cloud synchronization. See [SQLite storage and recovery](server/STORAGE.md).

Export JSON backups from Workspace. Import validates first, previews Merge or Replace, and creates a local recovery snapshot in the same transaction; it never downloads a backup automatically. Workspace can restore the previous snapshot. Malformed stored data is preserved until exported. App management supports archive and recoverable trash with dependency impact, and restoration through Workspace; no permanent-delete action is provided. The last five recovery snapshots are retained in SQLite.

## Validation

```sh
pnpm build
pnpm exec playwright install chromium
pnpm test
```

Tests cover empty creation, layout editing, rules, local reload, archive/restore, desktop gestures, mobile controls, explicit cross-app calls, reusable linked/detached definitions, storage failures, isolated custom actions and timeout recovery. Browser selection supports standard Playwright installations or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Tests use a separate backend and isolated databases; they do not modify your shared workspace.

Graph branches pass their source value independently to each outgoing edge and execute deterministically. Code actions can transform values. Per-field cross-app grants, cloud synchronization and a resource-isolated third-party extension platform remain outside this implementation. Workspace structure validation caps imported apps, components and nesting. The app has no account, telemetry, analytics or external network service dependency.

Standalone code apps fill the available app content height by default. The code component inspector offers Fill available app height or an explicit fixed height for embedded widgets. The calculator uses a responsive flex/grid layout so its keypad follows the viewport without an internal scrollbar. Unmodified legacy calculator examples are upgraded in place; edited HTML is not rewritten. Scrollable sandbox documents reserve 10px between content and their vertical scrollbar, only while overflowing.

## Shared actions and the wheel

Open **Workspace → Action library** to create a named workspace action. It uses the same graph editor as app flows: add nodes, connect the trigger, and use Connections to choose success or failure paths. Nodes can read exposed app fields, update exposed components, call an app flow, run another shared action, navigate, open app settings or a component graph, and show a message. Opening an app view always brings that app into view. Failed nodes stop their dependent steps unless a failure connection leads to recovery; completed writes remain applied.

Declare named inputs in the library and use `{input name}` in node values. On an app button, add an On click rule, choose **Run workspace action**, select the shared action, and map each input to a local field with the source picker or enter a configured value. Direct cross-app reads and writes require that app's exposed interface. Navigation and opening views can target any available app. Missing inputs, unavailable targets, recursion and overlapping runs report visible errors.

Open **Workspace → Edit action wheel** to add action slots or nested groups. Select an existing shared action or create one directly from a slot; removing a slot leaves its shared action in the library. Configure the wheel slot's input values independently. Hold **Tab** from the canvas to open the centered wheel. Pointer angle selects a slot even outside the ring. Click a group to enter it, right-click to return one level, and release Tab over an action to run it. Release Tab in the center to open the centered configuration popup; empty slots and Escape cancel. The popup expands from the center control over a softly dimmed, blurred backdrop; reduced motion skips the animation. Tab in fields, code editors and focused controls keeps its normal behavior. Action definitions, graphs, input mappings and wheel groups save with the workspace and are included in backup/import. Existing navigation-only slots upgrade to shared navigation actions.

## Notes

Open **Workspace → Create Notes**, or add a **Notes** component in an app's builder. Notes is a port of the MagicNetsuiteExtension notes feature styled for Orvane: nested pages, rich text blocks with slash menu and formatting, images, databases with table/board/list views, filters and sorts, page tabs, search (Ctrl+K), favorites, trash and export. Pages, blocks and settings live in the shared SQLite database (`notes_records`), so every Notes app and browser profile on this computer sees the same notes. The open page and tabs are stored in the component's `value` and save with the workspace. Note HTML is sanitized with DOMPurify before rendering. Notes from the original extension's browser storage are not imported.

MCP exposes the same data through `notes_data`; create the app with `workspace_batch` and a `kind: "notes"` component.

## Browser

Open **Workspace → Create Browser**, or add a **Web browser** component in an app's builder. Tabs live in a sidebar under Pinned, Groups and Tabs headings (up to 12 per space), with bookmarks below; the toolbar has back, forward, reload, start page, an address bar (text that isn't an address searches DuckDuckGo), bookmark, **Open in your browser**, Peek and Split View. Everything saves with the workspace.

- **Layouts** (Browser menu, bottom of the sidebar): sidebar with address bar, sidebar only (Ctrl+L or the address chip shows the bar), or tabs on top. The sidebar collapses to icons, resizes by its edge, and collapses by itself in a narrow app.
- **Spaces**: named, coloured sets of tabs and bookmarks, switched from the sidebar header. All spaces share one login session.
- **Pinned tabs**: right-click a tab to pin it; double-click returns it to its pinned address. In the desktop app, a link that leaves a pinned tab's site opens in a Peek.
- **Tab groups**: Ctrl-click or Shift-click tabs, then right-click to group them. Groups rename, recolour, collapse, become a bookmark folder, or are made for you by **Group tabs by site**.
- **Peek**: Shift-click a link or bookmark (or the eye button) to preview a page in a panel over the current one, then open it as a tab or as a Split View. Escape closes it.
- **Split View**: Alt-click a tab, bookmark or link, or use the toolbar button. The two tabs appear together in the sidebar; choosing one moves the selection, the divider drags, and the panes swap or stack.
- **Search** (Ctrl+K or Ctrl+Shift+A): open tabs in every space and bookmarks. Ctrl+Tab cycles recently used tabs.
- **Screenshots** (desktop app, Browser menu): the visible page, the full page, or a dragged area, copied to the clipboard.
- A tab playing sound in the background shows a mini player with mute; **Pop out video when leaving a tab** is optional. Ctrl+Shift+C copies the address.

Pages load in a sandboxed iframe, so this is a light embedded browser, not a full one: many sites (Google, GitHub, banks, most sign-in pages) forbid being embedded and stay blank; use **Open in your browser** for those. Links clicked inside a page don't update the address bar or back/forward history. Only `http`/`https` addresses load, and Orvane's own address is refused so pages can't reach its local APIs. While you're not using a page, a transparent shield covers it so middle-drag, Space-drag and Ctrl+scroll still move the canvas; click the page once to use it, click anywhere outside to give the canvas back.

## Desktop app (Electron)

```sh
pnpm desktop
```

Opens Orvane maximized in its own window, without a system title bar: drag the window by the orvane wordmark. The close button after Workspace options hides Orvane to the **system tray**, where it keeps running (calendar reminders still fire); click the tray icon to bring it back, and use **Quit Orvane** in the tray menu to exit (it still waits for the last save). **Launch at login** in the tray menu starts Orvane with Windows, staying in the tray until opened. It reuses a dev server already running on `http://localhost:5173`, otherwise starts one with the system `node` (so `better-sqlite3` stays built for the same Node as the MCP server) and stops it on exit. Set `ORVANE_PORT` to use another port (MCP browser bridging then also needs `ORVANE_MCP_ORIGINS`).

In the desktop app the Browser app uses Electron's `<webview>` instead of an iframe, so sites that refuse embedding (NetSuite, Google, GitHub…) load normally, with real back/forward history, page titles on tabs and one live page per tab. Sign-ins persist in a separate `persist:orvane-browser` session, isolated from Orvane itself. Links that open a new tab become Browser tabs; `window.open` popups (e.g. NetSuite selectors) open as small windows. Web pages never get Node, a preload script, or camera/microphone/location/notification permissions, and can't navigate to Orvane's own address. Orvane's window only navigates within Orvane; other links open in your system browser.

Desktop Browser pages that are out of view are paused and resume when visible. They remain loaded by default, preserving their navigation history and in-page state. This means many Browser pages can still use substantial memory. Advanced users who accept losing page state and back/forward history can opt into automatic unloading by setting `localStorage.setItem('orvane.browser.discardEnabled', 'true')` in Orvane's developer console. A discarded page reloads from its address when selected. Remove that setting to disable unloading.

## Local Git viewer

Open **Workspace → Create Git viewer**, or add a **Git viewer** component in an app's builder. Choose **Add folder** to browse local directories or enter an absolute path. Valid Git folders are saved as named workspaces in the shared SQLite database. The workspace selector switches repositories; each viewer's selected workspace survives reloads. Multiple viewers can target different repositories.

History defaults to date order, interleaving branches while keeping children before parents; Branch topology is also available. It shows commit lanes, local/remote branch labels, tags, subjects, authors, dates and hashes. Select a commit to inspect its message and changed files, then choose a file for its patch. Drag the divider above the details pane to adjust its height, or focus it and use the arrow keys. Ctrl+scroll over the viewer zooms the canvas. Merge changes compare against the first parent. Search highlights matching commits without removing graph rows, preserving lane continuity. Branch filtering and older-history pages are supported. The Changes tab shows staged, modified and untracked paths, with working-tree/staged diff selection. Untracked files have no committed diff. Refresh reads current local Git state; no automatic remote fetch occurs.

The same capability is exposed through MCP: `git_folders`, `git_workspace_list`, `git_workspace_add`, `git_workspace_rename`, `git_workspace_remove`, `git_history`, `git_commit`, `git_status` and `git_diff`. Use `workspace_batch` to create an app and a `kind: "git"` component; set `properties.gitWorkspaceId` to a saved Git workspace ID. `app_focus` brings the viewer into view when an editing browser is connected. Offline MCP can create the app in the saved SQLite workspace when no browser owns editing; open its dock tab next time Orvane is loaded.

Git must be available on the local server's PATH. Git commands use argument arrays, bounded output/timeouts, no shell, no external diff or text-conversion drivers, no signature verification and no optional index writes. The viewer does not stage, commit, checkout, delete repository files or contact remotes. Folder registrations live in SQLite, including their local absolute paths; JSON app backups retain selected workspace IDs but do not grant filesystem access on another computer. Re-select/register folders there. Full SQLite backups include the saved registrations.


### NetSuite app and processing tabs (desktop)

Run a SuiteQL query, then click **Add record preview** to place a linked widget beside the query, or drag the button to a spot on the canvas. In the preview, enter a SuiteScript record type such as `customer`, select the result column containing the internal ID, and click **Apply**. Select a result row to load that record's populated body fields using the selected environment. The workspace saves the link and mapping. Run the query again after reopening the workspace to choose a row.

Open and sign in to NetSuite in a Browser app, then choose **Create NetSuite app** from workspace settings and select an environment. Open NetSuite tabs are detected automatically. Tabs on the same `*.app.netsuite.com` origin appear as one environment; separate account origins remain separate. Orvane creates a hidden processing page per environment in the Browser's shared session, and NetSuite requests run there. Orvane starts and reconnects the processing page automatically. The Browser's compact **Processing tabs** group also shows its status. **Use current tab** can also create a processing page for other websites; generic pages are not refreshed automatically.

Idle NetSuite processing pages reload their account home page every eight minutes. This can help keep a session active but does not guarantee it: authentication, role, permissions, and timeouts remain controlled by NetSuite. Sign in again in a visible Browser tab if needed. Different roles within the same account origin share an environment and the browser's session state.

Home provides a searchable app menu for Scripts, File Cabinet and SuiteQL, preferred-app bookmarks, pinned dashboards, and an environment-specific workspace trail. The app provides locally saved query-based dashboards, a searchable scripts and deployments view, File Cabinet tabs, folder bookmarks, search, text editing and file upload, and a SuiteQL editor with saved query files, a record-catalog browser, execution tracing, pagination and current-page CSV export. File edits are saved to NetSuite only when Save is pressed; unsaved drafts stay in the local workspace. Folder creation and upload depend on the active NetSuite role. The views do not yet reproduce every Magic NetSuite feature, including File Cabinet trash and split panes, the complete script detail workspace, and the dashboard action engine. Calls use NetSuite's in-page SuiteScript runtime and may be affected by its availability or the signed-in role. Credentials are not copied to Orvane.
