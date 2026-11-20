---
name: sdf-object-builder
description: Create NetSuite SuiteCloud (SDF) customizations — scripts (client/user-event/scheduled/map-reduce/suitelet/restlet/portlet/mass-update/workflow-action), custom record types, custom fields of every family (entity/body/column/item/crm/other), custom lists, and other object types — error-free, using generic templates. Works with the standard SuiteCloud CLI / file-based SDF project (no extension required); can also use the magic-netsuite MCP as a shortcut when present. Use whenever building, editing, or deploying an SDF object or any customscript_/customrecord_/custom object XML. Includes a protocol for object types not yet documented: import a real one, analyze it, reconstruct it, and add it to the skill.
---

# SDF Object Builder

Build NetSuite SuiteCloud (SDF) objects that deploy without errors, using generic, non-account-specific templates in `examples/`. Portability first: everything works with a **standard SDF project + the `suitecloud` CLI**. The `magic-netsuite` MCP server, if connected, is an optional convenience — never a requirement.

## Templates are generic

The `examples/*.xml` use a neutral `acme_` prefix and placeholder labels/ids. They are structural templates, not real objects. **Always replace** the prefix (`acme_` → your own account/project code), `scriptid`s, labels, descriptions, and `[scriptid=...]` references before deploying.

## Step 0 — Locate the target SDF project (do this FIRST, never assume)

**Do not assume the working directory is the project root, and do not assume the layout is `src/`.** A workspace often holds **multiple SDF projects nested at varying depths** — a parent repo can contain child projects, and a project can even sit *inside another project's FileCabinet*. Guessing means editing the wrong `deploy.xml` / `Objects/` and deploying to the wrong place.

1. **Find the project root** = the directory containing **`suitecloud.config.js`** (the authoritative SuiteCloud CLI project marker — not `manifest.xml`, which also appears in nested projects).
   ```bash
   # from the workspace; there may be MORE THAN ONE
   find . -name suitecloud.config.js -not -path '*/node_modules/*'
   ```
2. **If several exist, pick the one whose subtree contains the file(s) you're creating/editing** — the nearest config root that owns the target area. Nested example seen in the wild: a repo root project *and* a separate project under `.../FileCabinet/SuiteScripts/<AppName>/`. **If it's ambiguous which project the task belongs to, ASK the user — don't guess.**
3. **Read that `suitecloud.config.js` for `defaultProjectFolder`** — it names the folder (commonly `src`, but configurable) that holds `manifest.xml`, `deploy.xml`, `Objects/`, `FileCabinet/`. Use that path, not a hardcoded `src/`.
4. **Read that project's `manifest.xml` `projecttype`** — `ACCOUNTCUSTOMIZATION` (ACP) vs `SUITEAPP`. SuiteApps nest FileCabinet/object paths under a publisher/app id; ACP does not. Layout differs.
5. **Run every `suitecloud` command from that project root** (its directory), and make all object/file/`deploy.xml` edits relative to `<projectRoot>/<defaultProjectFolder>/`.

Throughout this skill, `src/…` is shorthand for **`<defaultProjectFolder>/…` of the located project** — substitute the real folder.

## Clarify before building — use the AskUserQuestion tool

**When a scope- or correctness-defining detail is ambiguous, ask via the harness `AskUserQuestion` tool (structured options), not a prose bullet list and not a guess.** Deploying the wrong object or to the wrong project is costly to unwind.

Ask (batched, 2–4 concrete options each) whenever these can't be determined from the project/code:
- **Which project** the work targets, when Step 0 finds more than one root.
- **Object type / prefix ownership** — e.g. `ctk` (shippable product) vs `ctkc` (client customization); custom record vs custom field family.
- **The target binding** — which record type a field/script attaches to; which subsidiary/audience/roles a deployment serves.
- **Create vs update** — new object, or edit an existing one you should import first.
- **Field specifics that change the object** — `fieldtype`, mandatory, the `[scriptid=...]` a SELECT sources from.

Then **echo the resolved plan back** (target project, object type, ids, references) and confirm before deploying — especially for anything irreversible or account-wide.

Don't over-ask: skip what you can read from the project, verify on-account, or default sensibly (state the default instead). Reserve the tool for decisions whose answer actually changes what you build.

## Two deploy paths

**A. Standard SuiteCloud CLI (portable — use this by default):**
```bash
suitecloud object:list --type <objecttype>                 # discover on-account objects
suitecloud object:import --type <objecttype> --scriptid <id> --destinationfolder /Objects
# author/edit src/Objects/<id>.xml (+ src/FileCabinet/... for scripts)
# reference each object + file in src/deploy.xml
suitecloud project:adddependencies                         # AUTO-populate manifest <dependencies> — do NOT hand-edit
suitecloud project:validate --server
suitecloud project:deploy
```
Redeploy with the same `scriptid` = update. Scripts are real SDF XML here (`<usereventscript>`, `<suitelet>`, …) — see `reference/scripts.md`.

**Dependencies: always run `suitecloud project:adddependencies`.** It scans the project's object/file/module references and writes the correct `<dependencies>` (features, objects, files) into `manifest.xml`. Do NOT hand-guess features — a wrong or missing feature passes validation but fails at runtime (e.g. forgetting `SUITEANALYTICSWORKBOOK` for `N/query`, or the wrong `required` flag). Run it after every object add/change, before `validate`. It reports "no dependencies to add" when the manifest is already complete. Only hand-edit the manifest for something the command genuinely cannot infer, and say so.

**B. magic-netsuite MCP (only if that server is connected):**
- `netsuite_sdf_list_objects` — enumerate objects by type/scriptid.
- `netsuite_sdf_import_object` — pull one object's XML (NOT scripts; one scriptId per call, arrays collapse).
- `netsuite_sdf_deploy` — structured payloads (`scriptType`+`scriptFile`+`deployments`, `customRecords[]`, `templates[]`) OR raw `objects:[{xml}]`.
- `netsuite_update_metadata_record` — fast in-place edit of an existing record/field/script.

If the MCP tools are absent, everything is still doable through path A — never block on the extension.

## Golden rules

1. **Never invent XML for a type you have no example of.** Follow the UNKNOWN-TYPE PROTOCOL below (import → analyze → reconstruct → save example → document).
2. **Genericize before reuse.** Swap the `acme_` prefix and every id/label/reference for the target project's.
3. **Keep references resolvable.** A SELECT/record/deployment pointing at `[scriptid=...]` (or a native negative id) must have its target on-account or in the same deploy.
4. **Prefix + suffix conventions** (see per-type docs): `customscript_`/`customdeploy_`, `customrecord_`, `custentity_`, `custbody_`, `custcol_`, `custitem_`, `custevent_`, `customlist_`, `custrecord_` (other/child field), `custtab_`, `custscript_` (param).
5. **Small edit vs structural change.** Rename/label tweaks are safer done in-account (UI or `netsuite_update_metadata_record`); adding/removing fields or changing `fieldtype` goes through a validated deploy.

## Decision tree — which reference

| I want to create/edit… | Reference |
|------------------------|-----------|
| Any SuiteScript + deployment | `reference/scripts.md` |
| Custom record type (+ its fields) | `reference/custom-records.md` |
| Standalone custom field (entity/body/column/item/crm/other) | `reference/custom-fields.md` |
| Custom list | `reference/custom-lists.md` |
| Any other object type (role, savedsearch, advancedpdftemplate, workflow, customsegment, customtransactiontype, subtab, savedcsvimport, translationcollection, kpi, …) | UNKNOWN-TYPE PROTOCOL |

## Standard workflow (known types)

1. Read the relevant `reference/*.md` + the closest `examples/*.xml`.
2. Copy the example; replace prefix/`scriptid`/label and the type-specific tags.
3. Custom fields: set ≥1 **applies-to** flag `T`; pick `fieldtype` + `displaytype`; SELECT → set `<selectrecordtype>`.
4. Place XML in `src/Objects/` (+ JS in `src/FileCabinet/` for scripts), list in `src/deploy.xml`, run `project:adddependencies`, then `project:validate --server`, `project:deploy`. (Or MCP deploy.)
5. On validation error, read it — it names the offending tag/reference. Fix, redeploy.

## UNKNOWN-TYPE PROTOCOL (self-extending)

When asked for an SDF object type **not covered** by a `reference/*.md` + `examples/` pair:

1. **Discover** a real instance to learn from: `suitecloud object:list --type <thetype>` (or `netsuite_sdf_list_objects type:["<thetype>"]`).
2. **Import** one: `suitecloud object:import --type <thetype> --scriptid <id>` (or `netsuite_sdf_import_object` — one scriptId per call; templates return `templateXml` too).
3. **Analyze** the XML: root tag, `scriptid` prefix, required vs optional tags, reference syntax (`[scriptid=...]` / negative internal ids), child collections.
4. **Reconstruct** the requested object from that template to meet the requirements. **Genericize** any account-specific ids/labels.
5. **Deploy** via CLI (`project:deploy`) or MCP (`objects:[{xml}]`, plus `template.content` for templates).
6. **Extend this skill** so next time is a known type:
   - Save a **genericized** copy to `examples/<type>_<variant>.xml` (neutral `acme_` prefix, no real account ids — customvalue/machine ids and account numbers must be scrubbed).
   - Add/append `reference/<type>.md` documenting prefix, required tags, reference syntax, gotchas.
   - Add a row to the Decision tree above.

Keep files split by type — SDF objects are large with many niche cases; one focused file per family beats one giant file.

## What's seeded

- **Scripts** — portable SDF XML for client/user-event/scheduled/map-reduce/suitelet/restlet (+ notes on portlet/massupdate/workflowaction).
- **customrecordtype** — `examples/customrecordtype_with_select_fields.xml`, `examples/customrecordtype_full_taglist.xml`.
- **Custom fields** — one example per family: entitycustomfield (INLINEHTML button + HIDDEN text), transactionbodycustomfield, transactioncolumncustomfield, itemcustomfield, crmcustomfield, othercustomfield.
- **customlist** — `examples/customlist_ordered.xml`.

Everything else → UNKNOWN-TYPE PROTOCOL.
