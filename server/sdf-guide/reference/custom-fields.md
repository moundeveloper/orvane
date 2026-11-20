# Custom Fields

Each field family is its own SDF object type with its own `scriptid` prefix and its own "applies to" tag set. Each is one XML file in `src/Objects/`. Deploy with the CLI (`suitecloud project:deploy`) or, if the magic-netsuite MCP is connected, `netsuite_sdf_deploy objects:[{xml}]`. When unsure of the exact tags, import a sibling first (`suitecloud object:import` or the MCP import) and edit it.

## Field object types

| SDF type | prefix | attaches to | "applies to" tags | example |
|----------|--------|-------------|-------------------|---------|
| `entitycustomfield` | `custentity_` | entities (customer, vendor, employee, project, contact, partner, group…) | `appliestocustomer`, `appliestovendor`, `appliestoemployee`, `appliestoproject`, `appliestocontact`, `appliestopartner`, `appliestogroup`, `appliestoothername`, `appliestopricelist`, `appliestostatement`, `appliestowebsite`, `appliestogenericrsrc`, `appliestoprojecttemplate` | `examples/entitycustomfield_inlinehtml_button.xml`, `examples/entitycustomfield_hidden_text.xml` |
| `transactionbodycustomfield` | `custbody_` | transaction header | `bodysale`, `bodypurchase`, `bodyjournal`, `bodyitemfulfillment`, `bodyitemreceipt`, `bodycustomerpayment`, `bodyopportunity`, `bodyexpensereport`, `bodyprintflag`, `bodystore`, `bodytransferorder`, `bodyvendorpayment`, … | `examples/transactionbodycustomfield_select.xml` |
| `transactioncolumncustomfield` | `custcol_` | transaction line / item column | `colsale`, `colpurchase`, `coljournal`, `colexpense`, `colopportunity`, `colstore`, `colitemfulfillment`, `colitemreceipt`, `coltime`, `coltransferorder`, `colkititem`, `colprintflag`, … | `examples/transactioncolumncustomfield_select.xml` |
| `itemcustomfield` | `custitem_` | items | `appliestoinventory`, `appliestononinventory`, `appliestoservice`, `appliestoothercharge`, `appliestokit`, `appliestoitemassembly`, `appliestogroup`, `appliestosubplan`, `appliestopricelist`, `appliestospecificitems` + `itemsubtype` (SALE/PURCHASE/BOTH), `itemmatrix` | `examples/itemcustomfield_select.xml` |
| `crmcustomfield` | `custevent_` | CRM records | `appliestocase`, `appliestoevent`, `appliestotask`, `appliestophonecall`, `appliestoissue`, `appliestoprojecttask` | `examples/crmcustomfield_clob.xml` |
| `othercustomfield` | `custrecord_` | "other" native records (subsidiary, account, department, location…) — target set by `<rectype>` internal id | uses `<rectype>` (e.g. `-117` subsidiary), not appliesto flags | `examples/othercustomfield_text.xml` |

> `custrecord_` prefix is shared by `othercustomfield` AND custom-record child fields. Context = the object type, not the prefix.

## `fieldtype` catalog (data type)

`TEXT`, `TEXTAREA`, `CLOBTEXT` (long text / rich), `RICHTEXT`, `SELECT`, `MULTISELECT`, `CHECKBOX`, `DATE`, `DATETIMETZ`, `TIMEOFDAY`, `INTEGER`, `FLOAT`, `CURRENCY`, `PERCENT`, `EMAIL`, `PHONE`, `URL`, `INLINEHTML` (render-only HTML, `storevalue=F`), `IMAGE`, `DOCUMENT`, `PASSWORD`, `HELP`.

## `displaytype`

`NORMAL` (editable), `DISABLED`, `HIDDEN`, `INLINE` (read-only inline), `LOCKED` (visible, non-editable), `STATICTEXT`.

## SELECT / MULTISELECT sourcing

`<fieldtype>SELECT</fieldtype>` + `<selectrecordtype>`:
- custom list/record → `[scriptid=customlist_x]` or `[scriptid=customrecord_x]`
- native record → negative internal id (`-30` transaction, `-117` subsidiary, `-128` tax code, `-112` employee…)
- `<onparentdelete>` (`NO_ACTION` | `SET_NULL`) governs behavior when the referenced record is deleted.

## Common tags (all field types)

`scriptid` (attr), `label`, `fieldtype`, `displaytype`, `ismandatory`, `defaultvalue`, `defaultchecked` (CHECKBOX), `storevalue`, `isformula`+`defaultvalue` (formula field), `help`, `description`, `displaywidth`/`displayheight`, `maxlength`, `minvalue`/`maxvalue`, `subtab` (`ENTITYMAIN` or `[scriptid=custtab_x]`), `accesslevel`/`searchlevel` (0 none,1 view/edit,2 full), `globalsearch`, `encryptatrest`.

## Gotchas

- **At least one applies-to flag must be `T`**, or the field attaches to nothing.
- INLINEHTML/formula fields → `storevalue=F`.
- `defaultvalue` HTML must be XML-escaped (`&lt;`, `&quot;`) — see the INLINEHTML button example.
- `subtab` referencing a `custtab_` requires that subtab object to exist / be in the deploy.
- `othercustomfield` uses `<rectype>` (native record internal id), no appliesto tags.
