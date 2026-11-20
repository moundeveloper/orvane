# Magic NetSuite MCP tool usage — evidence for the Orvane port

Generated 20.11.2026 from local Claude Code transcripts. Read-only analysis; aggregate numbers only (no customer names, account IDs, record data or file contents).

## Scope and method

| Item | Value |
|---|---|
| Transcripts | `~/.claude/projects/*/**.jsonl`, 338 files (main + subagent) |
| Date range | 19.06.2026 → 20.11.2026 |
| Sessions scanned | 206 (by `sessionId`) |
| Sessions using any NetSuite tool | 132, across 18 project folders |
| Unique tool calls (all tools) | 34,886 (deduplicated by `tool_use.id`; resumed sessions repeat history) |
| Magic NetSuite calls | 8,696 (servers `magic-netsuite`, `magic-netsuite-apps`) |
| Orvane `orvane_netsuite_*` calls | 9 (5 `status`, 4 `query`) — too early to compare |

Script: `analyze.mjs` (scratchpad, Node, streams every JSONL). Raw aggregates: `aggregate.json` beside it.

**Heuristic limits (read before trusting numbers)**

- *Strict error* = `is_error: true` on the tool result. *Heuristic error* adds results whose first 600 chars match `error|failed|exception|SSS_*|INVALID_*|"success":false`. Heuristic overcounts payloads that merely contain the word "error" (log rows, skill text).
- Claude Code replaces oversized results with `Error: result (N characters) exceeds maximum allowed tokens`. These are counted as **oversize**, not errors, and N is used as the size.
- *Unhelpful* = error, < 40 chars, or an empty-result pattern. Short-but-valid answers (e.g. `suitelet_eval` returning `true`) count as unhelpful, which inflates fallbacks from that tool.
- *Retry* = same tool again within the next 3 tool calls after an error. *Fallback* = unhelpful Magic tool followed within 3 calls by `run_quick_script` or `suiteql_execute_query`. Both are proximity signals, not proven intent.
- Quick-script classification is regex on the `code` argument (`.save(` also matches `file.save`, `setValue` also matches in-memory objects).
- Tools never called do not appear; "0 calls" means not observed in this window.

## 1. Overall usage (Magic tools, ≥ 10 calls)

| Tool | Calls | Sessions | Projects | Strict err % | Retries after err | Median / p90 result chars | > 20k |
|---|---:|---:|---:|---:|---:|---|---:|
| suiteql_execute_query | 2,604 | 98 | 16 | 11.6 | 286 | 402 / 2.9k | 35 |
| netsuite_run_quick_script | 2,625 | 72 | 10 | 11.5 | 430 | 470 / 2.5k | 22 |
| suitelet_eval | 746 | 36 | 8 | 7.6 | 76 | 106 / 681 | 1 |
| netsuite_switch_environment | 639 | 76 | 10 | 8.5 | 34 | 734 / 891 | 0 |
| suitelet_control_open | 335 | 39 | 9 | 4.8 | 9 | 8.4k / 20.2k | 39 |
| netsuite_server_info | 156 | 70 | 13 | 29.0 | 14 | 447 / 454 | 0 |
| suitelet_screenshot | 133 | 27 | 8 | 1.5 | 0 | image | 0 |
| netsuite_upload_file | 124 | 23 | 5 | 25.0 | 14 | 411 / 773 | 0 |
| netsuite_read_file *(approved)* | 98 | 34 | 8 | 13.3 | 5 | 13k / 151k | 40 |
| ping | 89 | 22 | 8 | 1.1 | 0 | 493 | 0 |
| suitelet_click | 76 | 19 | 4 | 3.9 | 0 | 205 | 0 |
| netsuite_get_bundle_components *(approved)* | 73 | 25 | 8 | 4.1 | 3 | 9.1k / 34k | 20 |
| netsuite_update_record_fields | 70 | 12 | 3 | 2.9 | 1 | 92 / 101 | 0 |
| template_session_patch | 65 | 10 | 1 | 21.5 | 10 | 3.2k / 7.2k | 0 |
| netsuite_search_docs | 57 | 18 | 9 | 0 | 2 | 360 / 6.2k | 0 |
| template_asset_save_svg | 55 | 5 | 1 | 0 | 0 | 567 | 0 |
| netsuite_get_logs *(approved)* | 53 | 32 | 8 | **67.9** | 4 | 555 / 28k | 11 |
| netsuite_update_file_content | 45 | 14 | 4 | **86.7** | 22 | 83 / 478 | 0 |
| netsuite_check_task_status | 43 | 8 | 1 | 2.3 | 0 | 261 | 0 |
| netsuite_find_file | 42 | 18 | 5 | 11.9 | 1 | 308 | 0 |
| template_session_screenshot | 37 | 8 | 1 | 35.1 | 11 | 3.3k | 0 |
| suitelet_proxy_request | 35 | 8 | 3 | 2.9 | 1 | 6.7k / 203k | 10 |
| template_session_update | 31 | 10 | 1 | 16.1 | 5 | 2.1k / 6.6k | 0 |
| netsuite_submit_task | 29 | 10 | 2 | 20.7 | 1 | 157 | 0 |
| netsuite_create_record | 27 | 10 | 5 | 33.3 | 4 | 68 / 669 | 0 |
| template_session_get_current | 27 | 10 | 1 | 0 | 0 | 7.4k / 26.5k | 5 |
| netsuite_sdf_import_object | 26 | 6 | 5 | 11.5 | 2 | 1.9k / 15.5k | 1 |
| netsuite_get_script_files | 26 | 11 | 5 | 23.1 | 3 | 11.5k / 102k | 13 |
| netsuite_load_record | 23 | 11 | 6 | 4.3 | 0 | 5.2k / 11.8k | 2 |
| netsuite_list_bundles *(approved)* | 22 | 17 | 8 | 0 | 0 | 18k / 21k | 5 |
| netsuite_read_doc_page | 22 | 7 | 4 | 0 | 1 | 8.4k / 17.7k | 3 |
| search_skills / load_skill / save_skill | 21 / 18 / 15 | 19 / 13 / 7 | 6 / 3 / 3 | 0 | — | 5k / 19k / 84 | 0 / 7 / 0 |
| suitelet_probe_url / fetch_html | 17 / 16 | 6 / 5 | — | 6 / 13 | — | fetch_html median 6.9M (all oversize) | 13 |
| netsuite_get_scripts | 17 | 10 | 7 | 17.6 | 2 | 241 / 95k | 4 |
| suiteql_get_table_fields *(approved)* | 16 | 12 | 7 | **81.3** | 1 | 485 | 0 |
| netsuite_sdf_list_objects | 12 | 4 | 4 | 16.7 | 2 | 265 / 1.1k | 1 |
| netsuite_get_record_fields | 11 | 10 | 5 | 0 | 0 | 1.3k / 9k | 1 |

Tools with < 10 calls are in `aggregate.json`. Notable low counts: `suiteql_search_tables` 6 (83 % err), `inspect_custom_record_field` 6 (100 % err, argument-shape errors), `magic_netsuite_search_records` 1, `suiteql_get_guide` 1, `get_record_sublists` 1, `list_record_types` 1, `load_record_context` 1, `list_accounts` 5, `sdf_deploy` 3 (all failed), `run_code` 3, `rollback_code_run` 3, dashboards 15 total (1 session). Never observed: `suiteql_get_table_joins`, `suiteql_discover_field_values`, `netsuite_lists`, `list_items`, `create_list`/`update_list`, `update_script_field`, `code_runs`, `freemarker_preview_html`, `recreate_template_workflow`, quizzes, custom-tool CRUD/call.

## 2. Error patterns (generalized)

| Pattern | Where | ~Count |
|---|---|---:|
| `SSS_SEARCH_ERROR_OCCURRED: Unknown identifier '…'` | suiteql_execute_query, get_logs (tool queries a `scriptnote` column that does not exist → **a tool bug**, ~33 of 36 get_logs errors) | 70+ |
| `UNEXPECTED_ERROR` from `runSuiteQL` | suiteql_execute_query | 60 |
| `INVALID_SEARCH_TYPE` | suiteql_get_table_fields / search_tables (metadata tables not queryable) | 16 |
| Bridge/routing: "Could not route MCP calls to account …", `MCP_ACCOUNT_LOGIN_REQUIRED`, `MCP_SUITELET_UNAVAILABLE`, login-page HTML, "connection has timed out", `MCP_SUITELET_TIMEOUT`, "Extension timeout" | switch_environment, server_info, all routed tools | 150+ |
| "NetSuite file update failed. Check the connection…" | update_file_content (39 / 45 calls) | 39 |
| `READ_ONLY_PROPERTY: id` | update_file_content | 6 |
| Input validation (wrong argument shape) | upload_file, inspect_custom_record_field, template screenshot | 15 |
| `SYNTAX_ERROR` in uploaded script | upload_file | 6 |
| Mandatory fields / `INVALID_FLD_VALUE` / `USER_ERROR` | create_record | 7 |
| `await is only valid in async functions` | run_quick_script, suitelet_eval (model writes top-level await) | 19 |
| "Execution context was destroyed (navigation)", "Request timed out" | suitelet_eval | 15 |
| Oversize result (`exceeds maximum allowed tokens`) | read_file 18, suiteql 15, quick_script 13, fetch_html 13, proxy_request 10, get_script_files 8 | 79 |

## 3. Fallbacks to quick script / SuiteQL

329 cases where an unhelpful Magic tool was followed within 3 calls by `suiteql_execute_query` (216) or `run_quick_script` (113).

| Source tool | Fallbacks | Comment |
|---|---:|---|
| suitelet_eval | 112 | mostly short valid results (heuristic noise) |
| switch_environment | 41 | routing error → query directly once routed |
| get_logs | 37 | broken log query → hand-written SuiteQL on `scriptnote` / `ScriptNote` |
| upload_file | 19 | verify file or fix via script |
| server_info | 14 | |
| update_file_content | 12 | broken → rewrite via `file.create`/`file.load` in script |
| suiteql_get_table_fields | 11 | metadata lookup fails → probe with `SELECT … FETCH FIRST 1` |
| create_record / submit_task / dashboard_run | 7 / 6 / 8 | |

APIs inside the 113 fallback quick scripts: `query.runSuiteQL` 65, `N/runtime` 46, `getValue/getText` 45, script/deployment ids 36, `record.load` 30, `file.load` 28, `search.create` 18, `.save()` 15, `setValue` 11, `getFields/getSublists` 7, `record.create` 6, `submitFields` 4.

## 4. What `netsuite_run_quick_script` was used for (2,625 calls, 72 sessions)

Primary class (one per call, priority order write > render > HTTP > file > script > metadata > load > search):

| Primary purpose | Calls | % |
|---|---:|---:|
| Write / update (record.create/submitFields/delete/save, setValue, file.create, task.create) | 821 | 31 |
| Search / query only (runSuiteQL, search.create/lookupFields) | 661 | 25 |
| Script / deployment inspection | 484 | 18 |
| File Cabinet ops (read/write files) | 342 | 13 |
| Other (runtime, config, compute) | 127 | 5 |
| Read record (record.load, no write) | 100 | 4 |
| Field / sublist metadata (getFields, getSublists) | 82 | 3 |
| HTTP call / render-PDF | 8 / — | <1 |

API hits across all quick scripts (multi-label): `query.runSuiteQL` 1,479 (56 %), `N/runtime` 826, `getValue/getText` 774, script/deployment ids 601, `record.load` 525, `N/file` 525, `.save()` 445, `setValue` 314, `search.create` 279, `record.submitFields` 251, `record.create` 193, **`record.delete` 149**, `getFields/getSublists` 128, `file.create` 125, `N/task` 76, `N/https` 54. Code length median 691 chars, p90 1.7k, max 23k.

Takeaway: more than half of quick scripts are SuiteQL wrapped in a script (to post-process, join, or combine with `record.load`). About a third write data, including deletes — the riskiest surface.

## 5. Common sequences (consecutive Magic calls)

| Sequence | Count | Reading |
|---|---:|---|
| quick_script → quick_script (→ quick_script) | 1,575 (1,064) | iterative script edit / retry loops |
| suiteql → suiteql (→ suiteql) | 1,525 (996) | query refinement |
| suiteql ↔ quick_script | 447 / 411 | find ids with SQL, act with script |
| quick_script → switch_environment → quick_script | 212 | same check run on two accounts (DEV vs SBX-like) |
| suitelet_control_open → suitelet_eval (×n) | 205 / 82 | open a NetSuite form in a hidden page, then drive it by JS (bulk file-flag style loops) |
| suitelet_eval → suitelet_screenshot → suitelet_eval | 46 | visual check of UI automation |
| upload_file → quick_script | 70 | upload then verify / run |
| suiteql → read_file | 43 | locate file id, then read |
| switch_environment → server_info | 46 | confirm which account is active |

Anonymized examples: *project A-like*: `suiteql (find custom record ids) → update_record_fields → suiteql (verify)`; *project B-like*: `get_logs (fails) → suiteql on script notes`; *project C-like*: `update_file_content (fails) → retry → upload_file`; *project D-like*: `switch_environment → quick_script → switch_environment → quick_script` (diff two accounts).

## 6. Environment overhead

`switch_environment` (639 calls, 76 sessions) + `server_info` (156) + `ping` (89) + `bridge_status` (5) ≈ 890 calls, about 10 % of all Magic traffic, just to target the right account. Errors there are routing/login, not NetSuite logic. Orvane's explicit `identityToken` per call removes this class.

## 7. Recommendations per group

Legend: **Dedicated** = own Orvane tool; **Quick-script** = covered by a generic script-run tool; **SuiteQL** = covered by the query tool; **Drop** = do not port.

| Group | Calls (max sessions per tool) | Strict err | Recommendation | Evidence |
|---|---|---|---|---|
| Approved set (context) | 276 (34) | 77 | Already porting | `get_logs` 68 % err from a bad column — fix the query when porting; `get_table_fields`/`search_tables` 81–83 % err (`INVALID_SEARCH_TYPE`) — rebuild on record metadata, not SuiteQL; `read_file` and `get_bundle_components` need paging/size caps (40 and 20 results > 20k). |
| Record load / fields / sublists | 42 (11) | 2 | **Quick-script** + SuiteQL; optionally one small dedicated `record_describe` (fields + sublists) | Dedicated tools barely used (load 23, fields 11, sublists 1, list_* ≤ 5, discover_field_values 0) while quick scripts did `record.load` 525× and `getFields` 128×. Low error but low demand. |
| Writes | 341 (23) | 88 | **Dedicated**, narrow: `update_record_fields` (+ `create_record`), `upload_file`/file update, `submit_task` + `check_task_status`. Drop `create/update_list`, `update_script_field`, `update_metadata_record`, `create_folder` (0–1 calls) | `update_record_fields` 70 calls at 3 % err is the cleanest write tool; quick scripts carry 821 writes and 149 `record.delete` with no guardrail — a dedicated, audited write path is the main safety win. `update_file_content` (87 % err) and `upload_file` (25 %) need a single reliable file-write tool. |
| SDF | 41 (6) | 8 | **Drop for now** (keep in local CLI/skills) | 3 tools, ≤ 6 sessions; `sdf_deploy` 3/3 failed. The SDF skill already uses the local CLI. |
| Docs | 81 (18) | 0 | **Dedicated** (search + read page), low priority | 0 strict errors, 18 sessions, 9 projects; results moderate (p90 17k). Batch variants 1 call each → drop. |
| Code runs | 2,631 (72) | 302 | **Dedicated quick-script tool** (core) with read-only default and an explicit write mode/confirmation; drop `run_code`/`code_runs`/`rollback` (3 calls each) | Highest volume with SuiteQL; 430 retries after error; top errors are top-level `await` and timeouts — add async wrapping and a result-size cap. |
| SuiteQL execute (context) | 2,604 (98) | 301 | Already in Orvane (`orvane_netsuite_query`) | Most-used tool in most sessions; add paging and size cap (35 results > 20k, max 0.8M). |
| Dashboards | 15 (1) | 1 | **Drop** | Single session. |
| Templates | 232 (10, 1 project) | 34 | **Drop / defer** to a later Template batch | All in one project; 16–35 % err (extension timeouts). Not general-purpose. |
| Skills | 58 (19) | 0 | **Drop** (Claude Code skills cover it) | Used as a docs lookup; Orvane does not need a second skill store. |
| Suitelet automation | 1,378 (39) | 90 | **Dedicated, later** (page open + eval + screenshot) or leave to Orvane Browser | Third-largest group, 8 projects; drives NetSuite UI where no API exists (bulk file flags). `fetch_html`/`proxy_request` return multi-MB HTML → drop or cap. Overlaps Orvane's own Browser/webview control. |
| Custom tools, quizzes | 2 (1) | 0 | **Drop** | Unused. |
| Misc: env / server_info / ping / browser_tabs | ~890 (76) | 101 | **Drop** (replaced by identityToken + `orvane_netsuite_status`) | 10 % of traffic is routing overhead with routing errors. |
| Misc: scripts / deployments / files / folders | 85 (18) | 14 | **SuiteQL** (Orvane already covers) | `get_scripts`, `find_file` answerable by SQL; `get_script_files` is 23 % err and oversize-prone. |

## 8. Open points for the owner

- Should the quick-script tool allow writes at all, or split into `read` (default) and `write` (explicit) tools? Evidence: 31 % of runs write, 149 delete calls.
- Suitelet/UI automation: port as NetSuite tools, or route through Orvane's Browser app?
- Size caps: pick a default limit and paging contract for query, file read and bundle components.

## 9. How the approved ports address these findings

- `orvane_netsuite_logs` uses the `scriptexecutionlog` search (as Orvane's Scripts view does), not the `scriptnote` SuiteQL column that broke `get_logs`; script types are filtered on the script type name instead of being sent as a log-level filter.
- `orvane_netsuite_schema` reads the Records Catalog endpoint Orvane's SuiteQL schema browser already uses, not a SuiteQL metadata query (`INVALID_SEARCH_TYPE`).
- `orvane_netsuite_file_text` pages text (`maxChars`, `nextOffset`), caps files at 600 KB and returns PDF text instead of base64.
- `orvane_netsuite_field_info` takes the script ID directly (no record-type ID argument, the source of the 6/6 argument errors).
- `orvane_netsuite_query` refuses `LIMIT` before submission with a ROWNUM hint.
