# Orvane

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

## MCP automation

An optional local MCP server can create, inspect and edit apps, nested components, rules/graphs, reusable actions and spatial groups in the live browser workspace. It also provides atomic batches, validated Merge/Replace import, revision checks and recovery snapshots. Keep Orvane open, and configure your MCP client with [mcp.json](mcp.json); the client launches the server through `server/launch.mjs`. See [MCP setup, tools and examples](server/README.md). Nothing is installed into a host automatically.

## Canvas

- Drag empty space, Space-drag, or middle-drag to pan. Ctrl/Command-scroll or pinch on the background to zoom. Wheel zoom eases continuously toward the requested scale, anchored at the pointer. A single translate/scale transform is used throughout motion and at rest. There is no CSS-zoom handoff, end-of-gesture resize or forced blur/sharpen pass. Frame timing is measured only between animation-frame timestamps; the first frame cannot run backward. App dimensions, text layout and iframe viewports stay unchanged.
- Drag an app header to move it, or Alt/Option-drag its surface; drag any edge or corner to resize. Titles are editable only in Build mode. Header controls and title inputs keep their normal behavior. App options also expose numeric position and size for keyboard and touch access.
- Dock tabs and search pan and zoom to fit the selected app between the top controls and dock, preserving its state and logical dimensions. Drag tabs to reorder, or focus a tab and press Alt+Left/Right. Search matches names and spatial groups. Use Groups in the top bar, or click a group label, to create/name groups and select their apps. Group bounds follow member positions without moving or resizing any app; Go to group pans without changing zoom. Ungroup apps keeps the apps and their content.
- Defaults: **N** creates an app, **K** searches, **H** centers the canvas. Customize these in Workspace. Global shortcuts defer to text fields.

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

Open **Workspace → Create Browser**, or add a **Web browser** component in an app's builder. It has tabs (up to 12), an address bar (text that isn't an address searches DuckDuckGo), back/forward through addresses entered there, reload and **Open in your browser**. Tabs and their addresses save with the workspace.

Pages load in a sandboxed iframe, so this is a light embedded browser, not a full one: many sites (Google, GitHub, banks, most sign-in pages) forbid being embedded and stay blank; use **Open in your browser** for those. Links clicked inside a page don't update the address bar or back/forward history. Only `http`/`https` addresses load, and Orvane's own address is refused so pages can't reach its local APIs. While you're not using a page, a transparent shield covers it so middle-drag, Space-drag and Ctrl+scroll still move the canvas; click the page once to use it, click anywhere outside to give the canvas back.

## Desktop app (Electron)

```sh
pnpm desktop
```

Opens Orvane in its own window. It reuses a dev server already running on `http://localhost:5173`, otherwise starts one with the system `node` (so `better-sqlite3` stays built for the same Node as the MCP server) and stops it on exit. Set `ORVANE_PORT` to use another port (MCP browser bridging then also needs `ORVANE_MCP_ORIGINS`).

In the desktop app the Browser app uses Electron's `<webview>` instead of an iframe, so sites that refuse embedding (NetSuite, Google, GitHub…) load normally, with real back/forward history, page titles on tabs and one live page per tab. Sign-ins persist in a separate `persist:orvane-browser` session, isolated from Orvane itself. Links that open a new tab become Browser tabs; `window.open` popups (e.g. NetSuite selectors) open as small windows. Web pages never get Node, a preload script, or camera/microphone/location/notification permissions, and can't navigate to Orvane's own address. Orvane's window only navigates within Orvane; other links open in your system browser.

## Local Git viewer

Open **Workspace → Create Git viewer**, or add a **Git viewer** component in an app's builder. Choose **Add folder** to browse local directories or enter an absolute path. Valid Git folders are saved as named workspaces in the shared SQLite database. The workspace selector switches repositories; each viewer's selected workspace survives reloads. Multiple viewers can target different repositories.

History defaults to date order, interleaving branches while keeping children before parents; Branch topology is also available. It shows commit lanes, local/remote branch labels, tags, subjects, authors, dates and hashes. Select a commit to inspect its message and changed files, then choose a file for its patch. Drag the divider above the details pane to adjust its height, or focus it and use the arrow keys. Ctrl+scroll over the viewer zooms the canvas. Merge changes compare against the first parent. Search highlights matching commits without removing graph rows, preserving lane continuity. Branch filtering and older-history pages are supported. The Changes tab shows staged, modified and untracked paths, with working-tree/staged diff selection. Untracked files have no committed diff. Refresh reads current local Git state; no automatic remote fetch occurs.

The same capability is exposed through MCP: `git_folders`, `git_workspace_list`, `git_workspace_add`, `git_workspace_rename`, `git_workspace_remove`, `git_history`, `git_commit`, `git_status` and `git_diff`. Use `workspace_batch` to create an app and a `kind: "git"` component; set `properties.gitWorkspaceId` to a saved Git workspace ID. `app_focus` brings the viewer into view when an editing browser is connected. Offline MCP can create the app in the saved SQLite workspace when no browser owns editing; open its dock tab next time Orvane is loaded.

Git must be available on the local server's PATH. Git commands use argument arrays, bounded output/timeouts, no shell, no external diff or text-conversion drivers, no signature verification and no optional index writes. The viewer does not stage, commit, checkout, delete repository files or contact remotes. Folder registrations live in SQLite, including their local absolute paths; JSON app backups retain selected workspace IDs but do not grant filesystem access on another computer. Re-select/register folders there. Full SQLite backups include the saved registrations.


### NetSuite app and processing tabs (desktop)

Open and sign in to NetSuite in a Browser app, then choose **Create NetSuite app** from workspace settings and select an environment. Open NetSuite tabs are detected automatically. Tabs on the same `*.app.netsuite.com` origin appear as one environment; separate account origins remain separate. Orvane creates a hidden processing page per environment in the Browser's shared session, and NetSuite requests run there. Orvane starts and reconnects the processing page automatically. The Browser's compact **Processing tabs** group also shows its status. **Use current tab** can also create a processing page for other websites; generic pages are not refreshed automatically.

Idle NetSuite processing pages reload their account home page every eight minutes. This can help keep a session active but does not guarantee it: authentication, role, permissions, and timeouts remain controlled by NetSuite. Sign in again in a visible Browser tab if needed. Different roles within the same account origin share an environment and the browser's session state.

Home provides a searchable app menu for Scripts, File Cabinet and SuiteQL, preferred-app bookmarks, pinned dashboards, and an environment-specific workspace trail. The app provides locally saved query-based dashboards, a searchable scripts and deployments view, File Cabinet tabs, folder bookmarks, search, text editing and file upload, and a SuiteQL editor with saved query files, a record-catalog browser, execution tracing, pagination and current-page CSV export. File edits are saved to NetSuite only when Save is pressed; unsaved drafts stay in the local workspace. Folder creation and upload depend on the active NetSuite role. The views do not yet reproduce every Magic NetSuite feature, including File Cabinet trash and split panes, the complete script detail workspace, and the dashboard action engine. Calls use NetSuite's in-page SuiteScript runtime and may be affected by its availability or the signed-in role. Credentials are not copied to Orvane.
