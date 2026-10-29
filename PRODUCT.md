# Orvane

## Platform
web

## Purpose
A local-first SPA for creating, running, and composing independently structured apps on an infinite canvas. Source: the supplied app-container-comprehensive-ui-spec.md, questions 1–24.

## Confirmed constraints
The original empty canvas was superseded by the request for prebuilt example apps to explore; install four editable examples once without replacing existing apps. Keep the compact icon-and-label bottom dock. Immediate blank creation. Pan empty space, Space-drag or middle-drag; modifier-scroll zoom uniformly. Alt-drag moves apps; edge dragging resizes. App internals own normal input. Temporary in-app Grid/Flex builder, optional code, contextual rules expandable into graphs, explicit cross-app interfaces. Automatic persistence with visible nonblocking failures. No account, dashboard, gallery, modal creation, permanent inspector, title-bar requirement, or publish step.

## Visual commitments
Light only, cool blue-gray canvas, soft off-white surfaces, slate text, muted blue accents, precise compact controls, restrained corners and flat fields. The supplied brief is the visual authority.

## Open decisions
The user confirmed reversible archive and restore in this session. SQLite on the local Orvane backend is the persistence implementation. Browsers on this computer share one database; existing browser storage is retained for migration/recovery. Backup/import is provided. Audience is unspecified; do not fabricate personas. The node editor supports persistent spatial graphs, branching, explicit connections and reusable node groups. Code uses CodeMirror. Builder panels are resizable.


## Spatial groups
Apps can be assigned to named groups through the Groups control or the app builder. Groups have stable IDs, persistent membership and small canvas labels. Dragging a group label or border moves its member apps together; individual app drags leave other members in place. Existing string group names are migrated without changing app positions, content or sizes.
