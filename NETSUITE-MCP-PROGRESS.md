# NetSuite MCP migration progress

Updated: 5 November 2026. Working branch: `codex/netsuite-mcp-migration`.

## Working agreement

- Work in bounded, reviewable batches; update this file with changes, checks, limitations, and manual test steps.
- Commit each batch before starting another implementation batch.
- At a test checkpoint, provide the commit and concrete instructions to the user and wait for their test feedback before the next implementation batch.
- Keep unrelated workspace changes out of these commits. Do not change a NetSuite account, deploy a Suitelet, or remove the Magic setup during migration.

## Current position

Batch 0: recording the existing UI fixes and migration design as a baseline.
Batch 1: next — direct Desktop read service and Claude Code MCP installation.
The broader migration is not complete; see [the implementation plan](research/NETSUITE-MCP-IMPLEMENTATION.md).

## Batch 0 — Baseline fixes and design

Commit: `fix: resolve keyboard scrolling and tab closing; record NetSuite migration plan` (find with `git log --oneline -- NETSUITE-MCP-PROGRESS.md`).

Completed before this checkpoint:

- Notes caret navigation keeps the current block visible, including below the breadcrumb bar at canvas zoom.
- Notes `/` command menu scrolls the keyboard-highlighted option locally.
- File Cabinet/NetSuite tabs close with middle-click without triggering canvas panning.
- Git Viewer separates staged/unstaged changes and offers committed history for the current branch.
- Source inventory: 155 static Magic tool declarations with source locations; the improved architecture removes the renderer from the proposed MCP execution path.

Checks already completed: focused browser regressions, type-check, production build, and source/link validation. The broader browser suite previously encountered startup lease/font-load timeouts; targeted fixture tests passed.

These commits exclude pre-existing certificate/API-key-vault and other unrelated edits in the working directory.

## Batch 1 — Planned checkpoint

Goal: install Orvane in Claude Code and make the first read-only NetSuite status/query path testable through Desktop, independently of the NetSuite view and canvas editing lease.

Expected tests: disconnected Desktop status, invalid/ambiguous targets, authenticated bridge requests, two clients, explicit runtime identity, bounded SELECT query, and existing UI bridge behavior.

Manual instructions, actual checks, commit, and remaining limitations will be recorded here before handoff.
