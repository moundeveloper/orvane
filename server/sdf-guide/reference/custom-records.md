# Custom Record Types (`customrecordtype`)

`scriptid` prefix: `customrecord_`. Fields live INSIDE the record under `<customrecordcustomfields>` as `<customrecordcustomfield>` (prefix `custrecord_`).

The object is one XML file, `src/Objects/customrecord_acme_x.xml`. Create/edit it, list it in `src/deploy.xml`, deploy.

Examples: `examples/customrecordtype_with_select_fields.xml` (SELECT→custom record, SELECT→custom list, DATETIMETZ, CLOBTEXT; trimmed to meaningful tags) and `examples/customrecordtype_full_taglist.xml` (full tag set as returned by an import — copy this when you want every default present).

## Record-level tags that matter

| tag | meaning / typical |
|-----|-------------------|
| `recordname` | UI record label |
| `includename` | T = has a Name text field; F = no name field (child/lookup records) |
| `accesstype` | `CUSTRECORDENTRYPERM`, `NONENEEDED`, `CUSTOMRECORDTYPE` |
| `allowuiaccess` | T = usable in UI |
| `enablenumbering` + `numberingprefix`/`numberingsuffix`/`numberingmindigits`/`numberinginit` | auto-numbered records |
| `hierarchical` | T = parent/child tree |
| `enablesystemnotes`, `showcreationdate`, `showlastmodified` | audit columns |
| `iconbuiltin` / `icon` / `iconindex` | record icon |

## Field child tags (customrecordcustomfield)

Same data-type + display model as standalone fields — see `custom-fields.md` for the `fieldtype` catalog, `displaytype`, and SELECT sourcing. Child-only tags: `allowquickadd`, `rolerestrict`, `onparentdelete` (`NO_ACTION` | `SET_NULL` for SELECT fields).

Minimal viable field (rest of tags default): `scriptid` (attr), `label`, `fieldtype`, `displaytype`, `storevalue`, `searchlevel`, `accesslevel`. See the `with_select_fields` example.

## Related objects

- `SELECT` to a custom list/record → `<selectrecordtype>[scriptid=customlist_x]</selectrecordtype>` or `[scriptid=customrecord_x]`. Built-in refs use negative internal ids (`-30` transaction, `-117` subsidiary, `-128` tax code, `-112` employee, …).
- Subtabs on the record → `customrecordtype`-scoped `<subtabs>` / separate `subtab` objects (prefix `custtab_`).

## Deploy paths

- **CLI:** `suitecloud object:import --type customrecordtype --scriptid customrecord_acme_x`; edit; `suitecloud project:adddependencies` (pulls in the `CUSTOMRECORDS` feature + any referenced list/record); `suitecloud project:deploy`. The whole record + its fields deploy as one object.
- **MCP (optional):** structured `customRecords[]` on `netsuite_sdf_deploy` (record + fields in one payload), or raw `objects:[{xml}]`.

## Gotchas

- Keep referenced `[scriptid=...]` targets in the same deploy or already on-account, else validation fails on the dangling reference.
- Field `scriptid` globally unique, `custrecord_` prefix.
- Changing a field's `fieldtype` after data exists can be blocked/destructive. For tiny in-place edits (label/help) an in-account edit (UI, or `netsuite_update_metadata_record` if MCP present) is safer than a structural redeploy.
- Empty tags are optional when authoring; a full import returns all of them.
