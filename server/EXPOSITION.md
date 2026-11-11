# Claude sessions and visual explanations

Orvane mirrors local Claude Code conversations and renders structured explanations in the matching chat. It never sends messages by changing transcripts.

## Use in the desktop apps

1. Start Orvane. In **Workspace options**, choose **Create Claude sessions**. Select a session in the list.
2. Install the integration once with `scripts/install-orvane-exposition.ps1`. It adds the Exposition tools to the `orvane` connector alongside NetSuite in the Claude Code user profile and Claude Desktop's local MCP configuration. It migrates the old standalone `orvane-exposition` entry, preserves other servers and hooks, installs the personal skill, and backs up changed configuration under `~/.claude/backups/`. Fully quit and reopen Claude Desktop to load the updated tool list.
3. Reopen a local session in Claude Desktop’s **Code** tab so the new tool, skill and SessionStart hook load. Ask Claude to explain something visually in Orvane.

The session-context hook supplies the session ID and working directory. Claude must use this exact binding. Tools reject unknown or ambiguous targets instead of choosing the newest chat.

The integration is installed for the current user profile. For another profile, pass explicit `ConfigDirectory`, `McpConfig`, and `DesktopConfig` paths to the installer. `ORVANE_CLAUDE_PROJECTS_DIR` can point at another local transcript root; set it consistently for the Orvane backend and exposition MCP process. The default is `~/.claude/projects`, or `CLAUDE_CONFIG_DIR/projects` when configured.

## Tool contract

- `exposition_sessions`: list session IDs, project paths and titles.
- `exposition_show`: create or replace an explanation in one session. New views use `expectedRevision: 0`. Replace only with the revision returned by a read. Optional `anchorId` is an existing message UUID or tool-call ID.
- `exposition_read`: read a session’s saved explanations and revisions.
- `exposition_update`: replace matching part IDs, append new parts and update title/summary. Omitted parts remain unchanged. Requires the current revision.

Example creation input (illustrative):

```json
{
  "sessionId": "exact-session-id-from-hook",
  "projectPath": "C:/Dev/MyProject",
  "view": {
    "id": "provider-ownership",
    "title": "The engine owns the session",
    "status": "proposal",
    "parts": [{
      "id": "calls",
      "type": "sequence",
      "title": "Request and response",
      "participants": [{"id":"ui","name":"Admin UI"},{"id":"engine","name":"Server engine"}],
      "messages": [{"from":"ui","to":"engine","label":"Start session"},{"from":"engine","to":"ui","label":"Session ID","reply":true}]
    }]
  }
}
```

An update can contain just `sessionId`, `projectPath`, `id`, `expectedRevision` and the changed `parts`. The renderer and styles are installed once; the model supplies facts, not page code. No measured token-saving percentage is claimed.

## Components and provenance

The renderer supports identity/owner lookup, allocation/denominator magnification, missing-handoff recovery, check prerequisites, flow/code ownership, aligned comparison, request/response sequence, and parallel routes. Use `routes` for two or three named paths with up to four stages each, a `merge` label and `shared` stages. An optional `exception` highlights a meaningful failure path. Set `detail: true` on reference parts to keep them available in collapsed sections. Expand gives the visual the full session pane, with Back to chat or Escape to return.

Flow and route diagrams always read horizontally, including in narrow panes. Drag the diagram or use its scrollbars to pan. The zoom controls and Ctrl/⌘ + wheel over the diagram adjust its own zoom. Hold Shift while dragging to select text. Flow connections use orthogonal paths and numbered labels, with the relationship text available under Connection labels. Sequence diagrams switch to a readable sender/receiver transcript when participant columns would be too narrow.

Views declare `illustrative`, `historical`, `proposal` or `verified`. The last requires source references, but Orvane does not independently verify the claims. Local check findings and recovery controls explore supplied facts; they do not execute an audit or modify a system. The renderer accepts typed data only, never model-authored executable HTML. Code snippets render as text.

## Session reading and storage

- Source transcripts remain read-only. Discovery reads bounded head/tail samples; opening a chat scans newline-delimited records incrementally, with a 1 MB per-record limit, a 30,000-character message display limit and a 2,000-message cache per session. At most eight session caches remain in memory.
- Messages page in groups of 60. Tool calls are collapsed. Tool-result bodies, embedded images and sidechain records are not displayed. Warnings expose skipped/shortened content; original files stay unchanged.
- User and assistant messages render GitHub-flavored Markdown: headings, tables, lists, task checkboxes, quotes, links and code blocks. Raw HTML is shown as text; rendered output is sanitized and remote images are not fetched. Wide tables scroll horizontally within the message. Ordinary wheel scrolling stays in the chat; Ctrl/⌘ + wheel zooms the Orvane canvas while the pointer is over the Claude app.
- The app polls the selected conversation approximately every 1.8 seconds while visible. Newline-incomplete records wait until complete. Source truncation/replacement resets the backend cache.
- Explanations persist separately in `.orvane/claude-visuals.sqlite`, with revision checks. Multiple MCP processes and the UI backend share SQLite/WAL, rather than relying on process-local state.
- The UI attaches a view to its explicit anchor, or to the `exposition_show` tool call whose input names that stable view ID. If that message is not loaded, the view appears in **Session visuals** until its anchor is available. A visual is never moved into another session.
- The current release mirrors locally available sessions. It does not provide remote/cloud transcript retrieval or a send-to-Claude interface.

## Validation

Tests cover append fragments, oversized records, pagination, restart persistence, source replacement, wrong-session rejection, foreign anchors, revision conflicts, real stdio MCP tool discovery/calls, installer preservation/idempotence, live chat/visual updates, session isolation, seven renderer types and narrow layouts. Fixture transcripts are isolated from the real Claude directory. Original transcript bytes are checked unchanged by visual writes.
