# Orvane interface

Live motion: use small local reveals for new list rows, opacity fades for values, and quiet checkbox feedback. Builder panels, newly created apps and popovers receive short simultaneous entry effects; node/code workspaces fade in. Do not animate layout dimensions, gate input, stagger controls, bounce, linger on exit or change the camera pipeline. Repeated effects retarget the current rendered state and reduced motion disables these effects. See MOTION-DISCOVERY.md for user decisions versus implementation defaults.

Mode: Operate. The detailed supplied brief pins the visual world and spatial composition.

Canvas #e9edf0, app #f7f9fa, text #455968, accent #6f8998. Inter Variable, compact 12–14px controls, 6–10px radii. Sparse dividers, restrained soft offset shadows. A barely visible dot field conveys spatial continuity. The dock is the primary persistent control. The user requested four editable example apps after the initial empty-canvas implementation; these are installed once without replacing existing work. No hero, empty-state CTA or dashboard.

App creation has no wizard. A blank app offers direct naming and a visible Build app entry. Editing is temporary and contained within that app. The hierarchy and contextual controls share one narrow editor area. Shortcuts always defer to text fields. Rendered app dimensions, rather than camera zoom, govern layouts. Reduced motion is honored.

Follow-up refinements: all fields use a faint surface tint and inset baseline instead of a rectangular focus outline. Keyboard focus stays visible. The workspace and app headers are compact. Popovers dismiss on outside pointerdown, including clicks inside other apps. Search enters and exits with an opacity/scale transition anchored precisely to the dock's search icon, for both button and keyboard entry. Zoom uses continuous frame-based interpolation and one uniform transform at every stage.

Editor refinement: native option menus are replaced by flat custom listboxes, and colors use inline swatches/hex entry. All scrollbars, including sandbox documents, use narrow muted tracks without arrows. CodeMirror supplies the light code editor. Logic expands into a separate spatial node workbench inside the app, with muted sockets, Bezier wires and movable nodes. The builder divider is a subtle 1px line with a larger pointer hit zone. There is no layout-zoom conversion or rasterization handoff during or after zoom. Clicking outside an app name explicitly releases focus before canvas gesture capture.

Code-app sizing: a standalone code block fills the app content region instead of inheriting a 210px frame cap. The calculator distributes its display and keypad through that available height. Legitimately scrolling sandbox content gains a 10px inline gutter, and the builder scroll region gets additional right padding. External app dimensions stay under user control.

Spatial groups use a faint enclosing boundary and small persistent name label. Group management is a compact popover with custom controls, not a folder navigation system. Members remain independently movable. Camera panning and zooming use animation-frame state rather than CSS transitions, so interrupting one gesture with another starts at the actually displayed pose.

Motion stays local: new builder components and graph nodes fade in over 130ms, restored apps share the brief new-app arrival, and runtime errors fade into view. Existing content does not replay entrances on load. Direct manipulation and dismissal remain immediate; no dimensions or surrounding layout are animated. The shared motion directive retargets interrupted effects from their current appearance and respects reduced motion.

Latest refinement: checkbox labels have no background pulse. Graph entry begins only after nodes have dimensions and the initial viewport is framed, then reveals the complete workbench with an 8px horizontal movement and opacity over 240ms. Group boundaries use a solid muted blue-gray stroke with a light interior tint. App headers drag directly; titles render as text outside Build mode, and controls never start a header drag.

Graph sockets are measured in node-local coordinates using the actual rendered node scale, including the surrounding canvas transform. Vue Flow's internal zoom alone is insufficient when the canvas is zoomed. Recompute socket bounds on node dimension changes so wires remain attached after opening, resizing, dragging and reframing.
