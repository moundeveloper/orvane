# Orvane

A quiet, local-first app canvas, built with Vue 3 and TypeScript from the supplied Infinite Canvas App Container specification.

## Run

```sh
pnpm install
pnpm dev
```

Open the local URL Vite prints. Four editable examples (Daily list, Notes, Tally and Calculator) are added once, including to existing workspaces without replacing existing apps. Re-add them from Workspace → Add example apps. Click **+** in the bottom dock to create a blank app; use **Build app** to add and configure components. No accounts, server, API keys or publish step are needed. Fonts and icons are bundled locally.

## Canvas

- Drag empty space, Space-drag, or middle-drag to pan. Ctrl/Command-scroll or pinch on the background to zoom. Wheel zoom eases continuously toward the requested scale, anchored at the pointer. A single translate/scale transform is used throughout motion and at rest. There is no CSS-zoom handoff, end-of-gesture resize or forced blur/sharpen pass. Frame timing is measured only between animation-frame timestamps; the first frame cannot run backward. App dimensions, text layout and iframe viewports stay unchanged.
- Drag an app header to move it, or Alt/Option-drag its surface; drag any edge or corner to resize. Titles are editable only in Build mode. Header controls and title inputs keep their normal behavior. App options also expose numeric position and size for keyboard and touch access.
- Dock tabs pan to apps while preserving their state and dimensions. Drag tabs to reorder, or focus a tab and press Alt+Left/Right. Search matches names and spatial groups. Use Groups in the top bar, or click a group label, to create/name groups and select their apps. Group bounds follow member positions without moving or resizing any app; Go to group pans without changing zoom. Ungroup apps keeps the apps and their content.
- Defaults: **N** creates an app, **K** searches, **H** centers the canvas. Customize these in Workspace. Global shortcuts defer to text fields.

## Build

The temporary in-app builder has a collapsible hierarchy, component properties, app styling, and explicit connections. Layouts support vertical stacks, wrapping rows and two-column grids, including nesting. Each app can choose a grid stacking breakpoint, spacing, inset, accent, radius, dock icon, and whether to show its name.

Components: text, text field, button, checkbox, list, counter, divider, layout and custom HTML/CSS/JavaScript. Lists and counters work immediately. Button clicks, field Enter and checkbox changes can run ordered rules: add an item, clear a field, increment, toggle, set a value, invoke another component's rules, or use a reusable action. Values can reference fields by `{field label}` or stable `{component ID}`. Blank values pass along the preceding result.

Rules expand into a spatial node editor inside the app: drag node headers, connect input/output sockets, branch flows, reconnect or select and delete wires, and Shift-click nodes to group them. Double-click an input socket to disconnect its incoming wires. Saved wires determine execution; disconnected nodes do not run. Groups reopen as editable internal graphs. Loops are rejected by the editor and guarded at runtime. JavaScript actions receive `value` and return a value; these run in a sandboxed opaque-origin iframe and terminable worker, with a two-second timeout and blocked network connections. HTML components run in isolated sandbox frames with no workspace storage access and restrictive resource policy. Runtime errors appear inline. Custom HTML is intended for code the workspace owner trusts: arbitrary DOM scripts are not a resource-isolated extension platform and can still monopolize their rendering thread.

Reusable component definitions support explicit updates to linked copies and local detachment. Definition updates affect label, arrangement, spacing and custom code while preserving each instance's live data and identity. Cross-app targets are available only after that app explicitly exposes its interface. Stable IDs survive movement and renaming; archived or disconnected targets fail visibly. Inspect recent action traces in Workspace → Connection activity. Traces are session-only.

Code fields use a light CodeMirror editor with line numbers, syntax highlighting, completion, bracket matching, folding, search, undo/redo and inline syntax diagnostics. Expand the editor for more room. Tab indents; Escape followed by Tab leaves the editor. Changes preview live. The builder panel has a narrow draggable divider; focus it and use Left/Right to resize by keyboard. Its width persists with the app. Dropdowns use custom keyboard-accessible listboxes, and scrollbars are themed both in the container and inside isolated code frames.

## Saving and recovery

Definitions, content, rules, code, shared components, positions, sizes, tab order, shortcuts and archived apps save automatically to this origin's localStorage. Camera and temporary editing/menu state do not persist. Browser storage is local to the browser profile and URL origin; keep the same dev-server address/port to see the same workspace. Storage failures are visible and do not block the current session.

Export JSON backups from Workspace. Import validates the file before replacing anything and downloads the existing workspace as a backup first. Malformed stored data is preserved until exported. Archive an app through its options and restore it from Workspace; no permanent-delete action is provided.

## Validation

```sh
pnpm build
pnpm exec playwright install chromium
pnpm test
```

Tests cover empty creation, layout editing, rules, local reload, archive/restore, desktop gestures, mobile controls, explicit cross-app calls, reusable linked/detached definitions, storage failures, isolated custom actions and timeout recovery. Browser selection supports standard Playwright installations or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

Graph branches pass their source value independently to each outgoing edge and execute deterministically. Code actions can transform values. Per-field cross-app grants, cloud synchronization and a resource-isolated third-party extension platform remain outside this implementation. Workspace structure validation caps imported apps, components and nesting. The app has no account, telemetry, analytics or network service dependency.

Standalone code apps fill the available app content height by default. The code component inspector offers Fill available app height or an explicit fixed height for embedded widgets. The calculator uses a responsive flex/grid layout so its keypad follows the viewport without an internal scrollbar. Unmodified legacy calculator examples are upgraded in place; edited HTML is not rewritten. Scrollable sandbox documents reserve 10px between content and their vertical scrollbar, only while overflowing.
