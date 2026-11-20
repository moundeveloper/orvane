# Scripts

A script customization = **a script object** (XML) + **a `.js` file** in the FileCabinet + **one or more deployments**. In a standard SDF project all of this is plain XML — no special tooling required.

## Script object types (root XML element)

| Root element | naming suffix | entry points |
|--------------|---------------|--------------|
| `clientscript`          | `_cl` | `pageInit`, `fieldChanged`, `saveRecord`, `validateField`, … |
| `usereventscript`       | `_ue` | `beforeLoad`, `beforeSubmit`, `afterSubmit` |
| `scheduledscript`       | `_ss` | `execute` |
| `mapreducescript`       | `_mr` | `getInputData`, `map`, `reduce`, `summarize` |
| `suitelet`              | `_sl` | `onRequest` |
| `restlet`               | `_rs` | `get`, `post`, `put`, `delete` |
| `portlet`               | `_pl` | `render` |
| `massupdatescript`      | `_mu` | `each` |
| `workflowactionscript`  | `_wa` | `onAction` |
| `bundleinstallationscript` / `sdfinstallationscript` | `_bi` / `_si` | install/update hooks |

The JS file's JSDoc **`@NScriptType` must match the object type** (e.g. `UserEventScript`) and declare `@NApiVersion` (2.1 recommended), or validation fails.

## Portable SDF script object XML

`src/Objects/customscript_acme_x_ue.xml`:

```xml
<usereventscript scriptid="customscript_acme_x_ue">
  <name>ACME X UE</name>
  <notifyadmins>F</notifyadmins>
  <scriptfile>[/SuiteScripts/acme/acme_x_ue.js]</scriptfile>
  <scriptdeployments>
    <scriptdeployment scriptid="customdeploy_acme_x_ue">
      <status>RELEASED</status>            <!-- RELEASED | TESTING | NOTSCHEDULED -->
      <title>ACME X UE</title>
      <isdeployed>T</isdeployed>
      <loglevel>DEBUG</loglevel>           <!-- DEBUG | AUDIT | ERROR | EMERGENCY -->
      <recordtype>CUSTOMERPAYMENT</recordtype>  <!-- UE/client: required record binding -->
      <allemployees>T</allemployees>
      <allpartners>F</allpartners>
      <allroles>T</allroles>
    </scriptdeployment>
  </scriptdeployments>
</usereventscript>
```

- The `.js` lives at `src/FileCabinet/SuiteScripts/acme/acme_x_ue.js`; `<scriptfile>` uses the FileCabinet path in `[...]`.
- **usereventscript / clientscript** deployments need `<recordtype>` (native id like `CUSTOMERPAYMENT`, `INVOICE`, or `[scriptid=customrecord_acme_x]`). One `<scriptdeployment>` per record type.
- **suitelet / restlet** use audience/role tags (`allroles`, `allemployees`, or `<audslroles>`/`<audemployees>` lists) + `<isonline>` for no-login access.
- **scheduledscript / mapreducescript** default `<status>NOTSCHEDULED`. Schedule via a `<scriptdeployment>` recurrence or the UI. Map/reduce deployment also supports `<concurrencylimit>`, `<buffersize>`, `<queueallstagesatonce>`, `<yieldaftermins>`.

## Script parameters

Inside the script object, before `<scriptdeployments>`:

```xml
<scriptcustomfields>
  <scriptcustomfield scriptid="custscript_acme_api_url">
    <fieldtype>TEXT</fieldtype>
    <label>API URL</label>
    <setting>ENTRY</setting>
    <storevalue>T</storevalue>
  </scriptcustomfield>
</scriptcustomfields>
```

## Deploy paths

**A. Standard SuiteCloud CLI / file-based (works everywhere):**
```bash
suitecloud object:list --type usereventscript          # discover
suitecloud object:import --type usereventscript --scriptid customscript_acme_x_ue --destinationfolder /Objects
# edit src/Objects/*.xml + src/FileCabinet/SuiteScripts/*.js, reference both in src/deploy.xml
suitecloud project:adddependencies                     # auto-fill manifest <dependencies>
suitecloud project:validate --server
suitecloud project:deploy
```
`src/deploy.xml` must list the object path (or `<path>~/Objects/*</path>`) and the FileCabinet path. **Do not hand-declare features in `manifest.xml`** — `project:adddependencies` computes them (e.g. `SERVERSIDESCRIPTING`; `SUITEANALYTICSWORKBOOK` if the script uses `N/query`/SuiteQL) from the actual references. Hand-guessing a feature passes validation but can fail at runtime.

**B. magic-netsuite MCP (optional shortcut, only if that server is connected):** `netsuite_sdf_deploy` with the structured `scriptType`/`scriptFile`/`deployments` payload builds the object XML for you and rejects hand-written script XML on import. Convenient, but NOT required — path A is the portable fallback.

## Gotchas

- Redeploy with the same `scriptid` = update. Removing a deployment from XML does not delete it on-account.
- `scriptid` must be globally unique, `customscript_` prefix; deployment `customdeploy_`.
- `@NScriptType` mismatch or missing `@NApiVersion` → validation error.
- Referenced `<recordtype>[scriptid=...]` custom record must exist / be in the same deploy.
