import { ipcMain, webContents } from "electron";

// Only the Orvane window can address its own browser guests. No arbitrary page
// JavaScript or credentials are exposed through this bridge.

const WRITES = ["save-file", "create-folder", "upload-file", "rename-item", "move-items", "delete-items", "run-script", "run-task", "set-deployment-status", "save-deployment-parameters", "clear-script-logs"];
/** Whether the page still has a NetSuite session: signed out, NetSuite
 * redirects its home page to the login page. Unknown counts as signed in. */
async function signedIn(contents) {
  if (contents.isDestroyed?.()) return false;
  const probe = "fetch('/app/center/card.nl', { redirect: 'manual', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) }).then((r) => r.type !== 'opaqueredirect')";
  return Promise.resolve()
    .then(() => contents.mainFrame?.executeJavaScript(probe) ?? contents.executeJavaScript(probe))
    .then((value) => value !== false)
    .catch(() => true);
}
export function setupNetSuite(isOrvane, partition, processing, lifecycle = {}) {
  const queues = new Map();
  const refreshedEpochs = new Map();
  const allowed = (event) =>
    !event.sender.isDestroyed() && isOrvane(event.sender.getURL());
  function schedule(key, parallel, execute) {
    const queue = queues.get(key) ?? { waiting: [], running: 0, serial: false };
    queues.set(key, queue);
    function drain() {
      while (queue.waiting.length && !queue.serial && queue.running < 2) {
        const job = queue.waiting[0];
        if (!job.parallel && queue.running) return;
        queue.waiting.shift();
        queue.running++;
        queue.serial = !job.parallel;
        let reservation = Promise.resolve();
        const hold = (execution) => { reservation = execution.then(() => {}, () => {}); };
        const pending = Promise.resolve().then(() => job.execute(hold));
        void pending.then(job.resolve, job.reject).finally(async () => {
          await reservation;
          queue.running--;
          queue.serial = false;
          drain();
          if (!queue.running && !queue.waiting.length && queues.get(key) === queue) queues.delete(key);
        });
      }
    }
    return new Promise((resolve, reject) => {
      queue.waiting.push({ parallel, execute, resolve, reject });
      drain();
    });
  }
  ipcMain.handle("orvane:netsuite-tabs", async (event) => {
    if (!allowed(event)) throw Error("Unauthorized request.");
    return processing.environments(event.sender);
  });
  ipcMain.handle("orvane:netsuite-open-record", (event, origin, kind, id) => {
    if (!allowed(event)) throw Error("Unauthorized request.");
    return processing.openRecord(event.sender, origin, kind, id);
  });
  ipcMain.handle("orvane:netsuite-open-page", (event, origin, url, background) => {
    if (!allowed(event)) throw Error("Unauthorized request.");
    return processing.openPage(event.sender, origin, url, background);
  });
  const run = async (event, id, operation, args, expectedSessionEpoch) => {
    const options = typeof args === "string" ? { sql: args } : args || {};
    if (!allowed(event)) throw Error("Unauthorized request.");
    if (typeof id !== "string") throw Error("Choose a NetSuite environment.");
    if (
      ![
        "user",
        "scripts",
        "deployments",
        "script-logs",
        "folders",
        "folder",
        "file",
        "save-file",
        "create-folder",
        "upload-file",
        "search-files",
        "rename-item",
        "move-items",
        "delete-items",
        "tables",
        "table-detail",
        "query",
        "record-preview",
        // Read-only metadata reads for the MCP tools (server/netsuite-metadata-operations.ts).
        "bundles",
        "bundle-contents",
        "file-content",
        "catalog-tables",
        "catalog-table",
        "log-search",
        "run-script",
        "run-task",
        "set-deployment-status",
        "task-status",
        // Scripts view (port of Magic NetSuite's script page).
        "deployment-parameters",
        "save-deployment-parameters",
        "clear-script-logs",
        "suitelet-url",
        "record-deployments",
      ].includes(operation)
    )
      throw Error("Unknown NetSuite operation.");
    if (["run-task", "set-deployment-status", "task-status", "deployment-parameters", "save-deployment-parameters", "clear-script-logs", "suitelet-url"].includes(operation) && (!Number.isSafeInteger(options.deploymentId) || options.deploymentId <= 0))
      throw Error("Choose a deployment (scriptdeployment.primarykey).");
    if (operation === "set-deployment-status" && !["NOTSCHEDULED", "SCHEDULED", "TESTING", "RELEASED"].includes(options.status))
      throw Error("Invalid deployment status.");
    if (operation === "bundles" && !["I", "S"].includes(options.bundleType))
      throw Error("Choose installed or created bundles.");
    if (
      operation === "bundle-contents" &&
      (!Number.isSafeInteger(options.bundleId) || options.bundleId <= 0)
    )
      throw Error("Choose a bundle ID.");
    if (
      operation === "catalog-table" &&
      (typeof options.table !== "string" ||
        !/^[a-z][a-z0-9_]{0,199}$/i.test(options.table))
    )
      throw Error("Invalid table name.");
    if (operation === "log-search") {
      const ids = (value) =>
        Array.isArray(value) &&
        value.length <= 50 &&
        value.every((n) => Number.isSafeInteger(n) && n > 0);
      const date = (value) =>
        typeof value === "string" &&
        value.length <= 40 &&
        !Number.isNaN(Date.parse(value));
      if (
        !date(options.from) ||
        !date(options.to) ||
        !Array.isArray(options.levels) ||
        !options.levels.every((level) =>
          ["DEBUG", "AUDIT", "ERROR", "EMERGENCY", "SYSTEM"].includes(level),
        ) ||
        !ids(options.scriptIds) ||
        !ids(options.deploymentIds)
      )
        throw Error("Invalid log filters.");
    }
    if (
      operation === "record-preview" &&
      (!Number.isSafeInteger(options.id) || options.id <= 0 ||
        typeof options.kind !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(options.kind))
    ) throw Error("Choose a SuiteScript record type and a positive internal ID.");
    if (
      operation === "query" &&
      (typeof options.sql !== "string" ||
        options.sql.length > 20000 ||
        !/^\s*select\b/i.test(options.sql) ||
        /;/.test(options.sql))
    )
      throw Error(
        "Enter one SELECT query without a semicolon (up to 20,000 characters).",
      );
    if (
      ["deployments", "script-logs", "folder", "file", "save-file", "file-content"].includes(
        operation,
      ) &&
      (!Number.isSafeInteger(options.id) ||
        options.id === 0 ||
        (operation !== "folder" && options.id < 0))
    )
      throw Error("A valid internal ID is required.");
    if (
      ["create-folder", "upload-file"].includes(operation) &&
      (!Number.isSafeInteger(options.folderId) ||
        options.folderId === 0 ||
        typeof options.name !== "string" ||
        !options.name.trim() ||
        options.name.length > 200 ||
        /[\\/]/.test(options.name))
    )
      throw Error("Choose a folder and a valid name.");
    if (
      operation === "upload-file" &&
      (typeof options.base64 !== "string" ||
        options.base64.length > 7000000 ||
        !/^[a-z0-9+/]*={0,2}$/i.test(options.base64))
    )
      throw Error("Invalid file or file exceeds 5 MB.");
    if (
      operation === "save-file" &&
      (typeof options.content !== "string" ||
        // MCP callers may omit original: the save then skips the conflict check.
        (options.original !== undefined && typeof options.original !== "string") ||
        options.content.length > 2000000 ||
        (options.original?.length ?? 0) > 2000000)
    )
      throw Error("Invalid file content.");
    if (operation === "upload-file" && options.overwrite !== undefined && typeof options.overwrite !== "boolean")
      throw Error("overwrite must be true or false.");
    if (
      operation === "run-script" &&
      (typeof options.code !== "string" ||
        !options.code.trim() ||
        options.code.length > 100000 ||
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1000 ||
        options.timeoutMs > 60000)
    )
      throw Error("Enter SuiteScript code (up to 100,000 characters) and a timeout of 1–60 seconds.");
    if (
      operation === "search-files" &&
      (typeof options.search !== "string" ||
        !options.search.trim() ||
        options.search.length > 100)
    )
      throw Error("Enter a search term of up to 100 characters.");
    if (
      operation === "table-detail" &&
      (typeof options.table !== "string" ||
        !/^[a-z0-9_]+$/i.test(options.table) ||
        options.table.length > 200)
    )
      throw Error("Invalid table name.");
    const ids = (value) =>
      Array.isArray(value) &&
      value.length <= 200 &&
      value.every((n) => Number.isSafeInteger(n) && n > 0);
    if (
      operation === "rename-item" &&
      (!["file", "folder"].includes(options.kind) ||
        !Number.isSafeInteger(options.id) ||
        options.id <= 0 ||
        !Number.isSafeInteger(options.folderId) ||
        typeof options.name !== "string" ||
        !options.name.trim() ||
        options.name.length > 200 ||
        /[\\/]/.test(options.name))
    )
      throw Error("Choose an item and a valid name.");
    if (
      operation === "move-items" &&
      (!Number.isSafeInteger(options.folderId) ||
        !Number.isSafeInteger(options.targetId) ||
        options.folderId === options.targetId ||
        !ids(options.fileIds) ||
        !ids(options.folderIds) ||
        !(options.fileIds.length + options.folderIds.length) ||
        options.folderIds.includes(options.targetId))
    )
      throw Error("Choose items and a different destination folder.");
    if (
      operation === "delete-items" &&
      (!Number.isSafeInteger(options.folderId) ||
        !ids(options.fileIds) ||
        !ids(options.folderIds) ||
        !(options.fileIds.length + options.folderIds.length))
    )
      throw Error("Choose files or folders to delete.");
    if (operation === "save-deployment-parameters") {
      const values = options.values;
      const plain = (v) =>
        v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) ||
        (typeof v === "string" && v.length <= 100000);
      if (
        !values || typeof values !== "object" || Array.isArray(values) ||
        !Object.keys(values).length || Object.keys(values).length > 100 ||
        !Object.entries(values).every(([key, v]) =>
          /^custscript[a-z0-9_]*$/i.test(key) &&
          (plain(v) || (Array.isArray(v) && v.length <= 1000 && v.every((item) => typeof item === "string" || typeof item === "number"))))
      )
        throw Error("Only custscript parameters with plain values can be saved.");
    }
    if (
      operation === "record-deployments" &&
      options.recordType !== undefined &&
      (typeof options.recordType !== "string" || !/^[a-z0-9_]{1,100}$/i.test(options.recordType))
    )
      throw Error("Invalid record type.");
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw Error("Invalid result offset.");
    const input = JSON.stringify({
      operation,
      options: {
        sql: options.sql,
        id: options.id,
        search: options.search,
        table: options.table,
        content: options.content,
        original: options.original,
        folderId: options.folderId,
        name: options.name,
        base64: options.base64,
        kind: options.kind,
        targetId: options.targetId,
        fileIds: options.fileIds,
        folderIds: options.folderIds,
        offset,
        bundleType: options.bundleType,
        bundleId: options.bundleId,
        from: options.from,
        to: options.to,
        levels: options.levels,
        scriptIds: options.scriptIds,
        deploymentIds: options.deploymentIds,
        code: options.code,
        overwrite: options.overwrite,
        deploymentId: options.deploymentId,
        status: options.status,
        values: options.values,
        recordType: options.recordType,
      },
      origin: id,
    }).replace(/</g, "\\u003c");
    // The result and any error come back as JSON text: NetSuite values and
    // errors (N.error objects) that structured clone can't copy would
    // otherwise fail the whole call with "An object could not be cloned".
    const code = `(async () => { try { return JSON.stringify({ result: await (async () => {
      const input = ${input};
      if (location.origin !== input.origin || !/^[a-z0-9-]+\\.app\\.netsuite\\.com$/i.test(location.hostname)) throw Error('NetSuite tab changed.');
      if (input.operation === 'tables' || input.operation === 'table-detail') {
        const action = input.operation === 'tables' ? 'getRecordTypes' : 'getRecordTypeDetail';
        const data = input.operation === 'tables' ? { structureType: 'FLAT' } : { scriptId: input.options.table, detailType: 'SS_ANAL' };
        const url = '/app/recordscatalog/rcendpoint.nl?action=' + action + '&data=' + encodeURIComponent(JSON.stringify(data));
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
        if (response.redirected) {
          const path = new URL(response.url).pathname.toLowerCase();
          if (path.startsWith('/app/login/') || path === '/pages/customerlogin.jsp')
            throw Object.assign(Error('NetSuite sign-in required.'), { code: 'SIGN_IN_REQUIRED' });
        }
        if (!response.ok) throw Error('Could not load the record catalog: HTTP ' + response.status);
        return await response.json();
      }
      const fetchChecked = async (url, what) => {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (response.redirected) {
          const path = new URL(response.url).pathname.toLowerCase();
          if (path.startsWith('/app/login/') || path === '/pages/customerlogin.jsp')
            throw Object.assign(Error('NetSuite sign-in required.'), { code: 'SIGN_IN_REQUIRED' });
        }
        if (!response.ok) throw Error('Could not load ' + what + ': HTTP ' + response.status);
        return response;
      };
      if (input.operation === 'catalog-tables' || input.operation === 'catalog-table') {
        const detail = input.operation === 'catalog-table';
        const data = detail ? { scriptId: input.options.table, detailType: 'SS_ANAL' } : { structureType: 'FLAT' };
        const url = '/app/recordscatalog/rcendpoint.nl?action=' + (detail ? 'getRecordTypeDetail' : 'getRecordTypes') + '&data=' + encodeURIComponent(JSON.stringify(data));
        const json = await (await fetchChecked(url, 'the record catalog').catch(error => {
          // The catalog answers HTTP 500 for an unknown table ID.
          if (detail && / 500$/.test(error.message)) throw Error('The record catalog has no table "' + input.options.table + '". Find its ID with action tables.');
          throw error;
        })).json();
        const body = json?.data ?? json;
        if (!detail) return { tables: (Array.isArray(body) ? body : []).map(t => ({ id: t?.id, label: t?.label })) };
        if (!body || (!Array.isArray(body.fields) && !Array.isArray(body.joins)))
          throw Error('The record catalog has no table "' + input.options.table + '". Find its ID with action tables.');
        return {
          fields: (body.fields || []).map(f => ({ id: f?.id, label: f?.label, dataType: f?.dataType ?? null, isColumn: f?.isColumn })),
          joins: (body.joins || []).map(j => ({ id: j?.id, label: j?.label, joinType: j?.joinType ?? null, cardinality: j?.cardinality ?? null, targetTable: j?.sourceTargetType?.id ?? null, joinCondition: j?.sourceTargetType?.joinPairs?.[0]?.label ?? null }))
        };
      }
      if (input.operation === 'bundles' || input.operation === 'bundle-contents') {
        // NetSuite has no SuiteScript API for bundles; read the same CSV exports as Setup > Bundles.
        const url = input.operation === 'bundles'
          ? '/app/bundler/bundlelist.csv?type=' + input.options.bundleType + '&sortcol=bundlename&sortdir=ASC&csv=Export'
          : '/app/bundler/bundlecontents.csv?csv=Export&OfficeXML=F&id=' + input.options.bundleId + '&fetchcompid=' + location.hostname.split('.')[0].toLowerCase().replace(/-/g, '_');
        const csv = await (await fetchChecked(url, 'the bundle export')).text();
        if (csv.length > 900000) throw Error('The bundle export is larger than 900 KB.');
        if (csv.trimStart().startsWith('<')) throw Error('NetSuite returned a page instead of the bundle CSV export. Check that this role can view bundles.');
        return { csv };
      }
      const requireN = () => new Promise(resolve => {
        if (typeof window.require !== 'function') return resolve(null);
        let done = false; const finish = n => { if (!done) { done = true; clearTimeout(timer); resolve(n || null); } };
        const timer = setTimeout(() => finish(null), 5000);
        try { window.require(['N'], finish, () => finish(null)); } catch { finish(null); }
      });
      let N = await requireN();
      if (!N) {
        const q = 'NS_VER=2026.1&minver=14&buildver=' + (location.search.match(/[?&]buildver=(\\d+)/)?.[1] || '30054');
        const load = src => new Promise(resolve => { const s = document.createElement('script'); s.src = src + '?' + q; s.onload = s.onerror = resolve; (document.head || document.documentElement).appendChild(s); });
        for (const src of ['/assets/suitescript_nsrequire/147491859.js','/assets/suitescript_bootstrap/1633197298.js','/assets/suitescript_event/2156200013.js']) await load(src);
        await Promise.all(['/javascript/suitescript/2.1/client/N.js','/javascript/suitescript/ts/bundle/NU-bundle.js'].map(load));
        N = await requireN();
      }
      if (!N) throw Error('NetSuite SuiteScript is unavailable on this page. Open a signed-in NetSuite page and try again.');
      if (input.operation === 'user') { const u = N.runtime.getCurrentUser(); return { account: N.runtime.accountId, id: u.id, name: u.name, email: u.email, role: u.role, roleId: u.roleId }; }
      if (input.operation === 'record-preview') {
        if (!N.record?.load) throw Error('Record loading is unavailable for this NetSuite role.');
        const options = { type: input.options.kind, id: input.options.id };
        const record = N.record.load.promise ? await N.record.load.promise(options) : N.record.load(options);
        const fields = [];
        for (const fieldId of record.getFields()) {
          let value;
          try { value = record.getValue({ fieldId }); } catch { continue; }
          if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
          let label = fieldId;
          try {
            const field = record.getField({ fieldId });
            label = field?.label || fieldId;
            if (field?.type === 'select' || field?.type === 'multiselect') {
              const text = record.getText({ fieldId });
              if (text != null && text !== '' && (!Array.isArray(text) || text.length)) value = text;
            }
          } catch { /* A field's value can still be shown without its label. */ }
          const display = Array.isArray(value) ? value.join(', ') : String(value);
          fields.push({ id: fieldId, label, value: display.length > 2000 ? display.slice(0, 2000) + '…' : display });
        }
        return { fields };
      }
      const run = async (query, params = []) => (await N.query.runSuiteQL.promise({ query, params })).asMappedResults();
      if (input.operation === 'task-status') {
        // A deployment's latest runs (SuiteQL's scheduledscriptinstance has no deployment link; the search does).
        if (!N.search?.create || !N.format?.parse) throw Error('Script run status is unavailable for this role.');
        const names = ['status', 'percentcomplete', 'mapreducestage', 'datecreated', 'startdate', 'enddate', 'taskid', 'queue'];
        const columns = names.map(name => N.search.createColumn({ name, ...(name === 'datecreated' ? { sort: N.search.Sort.DESC } : {}) }));
        const search = N.search.create({ type: 'scheduledscriptinstance', filters: [['scriptdeployment.internalid', 'anyof', input.options.deploymentId]], columns });
        const page = await search.runPaged.promise({ pageSize: 10 });
        const data = page.pageRanges.length ? (await page.fetch.promise({ index: 0 })).data : [];
        const iso = value => { try { return value ? N.format.parse({ value, type: N.format.Type.DATETIME }).toISOString() : null; } catch { return null; } };
        const [deployment] = await run('SELECT sd.primarykey, sd.status, sd.isdeployed, sd.scriptid, s.scripttype, s.name FROM scriptdeployment sd JOIN script s ON s.id = sd.script WHERE sd.primarykey = ?', [input.options.deploymentId]);
        return {
          deployment: deployment ?? null,
          instances: data.map(r => ({ status: r.getValue({ name: 'status' }), percent: r.getValue({ name: 'percentcomplete' }), stage: r.getValue({ name: 'mapreducestage' }) || null,
            created: iso(r.getValue({ name: 'datecreated' })), started: iso(r.getValue({ name: 'startdate' })), ended: iso(r.getValue({ name: 'enddate' })), taskId: r.getValue({ name: 'taskid' }) || null }))
        };
      }
      if (input.operation === 'set-deployment-status') {
        if (!N.record?.submitFields) throw Error('Changing a deployment is unavailable for this role.');
        await N.record.submitFields.promise({ type: 'scriptdeployment', id: input.options.deploymentId, values: { status: input.options.status } });
        const [row] = await run('SELECT status FROM scriptdeployment WHERE primarykey = ?', [input.options.deploymentId]);
        if (row?.status !== input.options.status) throw Error('NetSuite did not confirm the new status (it is ' + (row?.status ?? 'unknown') + ').');
        return { deploymentId: input.options.deploymentId, status: row.status };
      }
      if (input.operation === 'run-task') {
        // The user's flow: put the deployment in Not Scheduled, then press NetSuite's own "Save and Execute".
        const id = input.options.deploymentId;
        const [deployment] = await run('SELECT sd.primarykey, sd.status, sd.isdeployed, sd.scriptid, s.scripttype, s.name FROM scriptdeployment sd JOIN script s ON s.id = sd.script WHERE sd.primarykey = ?', [id]);
        if (!deployment) throw Error('Deployment ' + id + ' not found. Use scriptdeployment.primarykey as the ID.');
        if (!['MAPREDUCE', 'SCRIPTED'].includes(deployment.scripttype)) throw Error('Only map/reduce and scheduled script deployments can be run (this is ' + deployment.scripttype + ').');
        if (deployment.isdeployed !== 'T') throw Error('This deployment is not deployed (Deployed box unchecked).');
        const originalStatus = deployment.status;
        if (originalStatus !== 'NOTSCHEDULED') {
          if (!N.record?.submitFields) throw Error('Changing a deployment is unavailable for this role.');
          await N.record.submitFields.promise({ type: 'scriptdeployment', id, values: { status: 'NOTSCHEDULED' } });
        }
        // If starting fails, put the status back now: no run means nothing to wait for.
        const putBack = async error => {
          if (originalStatus !== 'NOTSCHEDULED') await N.record.submitFields.promise({ type: 'scriptdeployment', id, values: { status: originalStatus } }).catch(() => {});
          throw error;
        };
        try {
        const formUrl = '/app/common/scripting/scriptrecord.nl?id=' + id + '&e=T';
        const html = await (await fetchChecked(formUrl, 'the deployment')).text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const form = doc.querySelector('form#main_form') || [...doc.forms].find(f => /scriptrecord\\.nl/.test(f.getAttribute('action') || ''));
        if (!form || !form.querySelector('[name="submitexecute"]')) throw Error('NetSuite did not offer "Save and Execute" for this deployment.');
        const body = new FormData(form);
        body.set('submitexecute', 'Save and Execute');
        const submittedAt = new Date().toISOString();
        const response = await fetch(new URL(form.getAttribute('action'), location.origin).href, { method: 'POST', body, credentials: 'same-origin' });
        if (!response.ok) throw Error('NetSuite rejected the run: HTTP ' + response.status);
        const text = await response.text();
        const problem = /<title>[^<]*(error|notice)[^<]*<\\/title>/i.test(text) ? (new DOMParser().parseFromString(text, 'text/html').querySelector('.uir-error-page-message, #div__body, body')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : '';
        if (problem) throw Error('NetSuite refused to run the deployment: ' + problem);
        return { deploymentId: id, scriptId: deployment.scriptid, name: deployment.name, scriptType: deployment.scripttype, originalStatus, submittedAt };
        } catch (error) { return await putBack(error); }
      }
      if (input.operation === 'deployment-parameters') {
        // The deployment's custscript parameters, as Magic's script page edits them.
        if (!N.record?.load) throw Error('Reading a deployment is unavailable for this role.');
        const rec = await N.record.load.promise({ type: 'scriptdeployment', id: input.options.deploymentId });
        const plain = v => v instanceof Date ? v.toISOString() : v;
        const parameters = rec.getFields().filter(id => /^custscript/i.test(id)).map(id => {
          let field = null; try { field = rec.getField({ fieldId: id }); } catch {}
          let text = null; try { text = rec.getText({ fieldId: id }); } catch {}
          const value = rec.getValue({ fieldId: id });
          return { id, label: field?.label || id, type: field?.type || null, value: Array.isArray(value) ? value.map(plain) : plain(value ?? null), text: Array.isArray(text) ? text.join(', ') : text ?? null };
        }).sort((a, b) => String(a.label).localeCompare(String(b.label)));
        return { deploymentId: input.options.deploymentId, scriptid: rec.getValue({ fieldId: 'scriptid' }) || null, parameters };
      }
      if (input.operation === 'save-deployment-parameters') {
        if (!N.record?.submitFields) throw Error('Changing a deployment is unavailable for this role.');
        await N.record.submitFields.promise({ type: 'scriptdeployment', id: input.options.deploymentId, values: input.options.values, options: { enableSourcing: true, ignoreMandatoryFields: true } });
        return { deploymentId: input.options.deploymentId, saved: Object.keys(input.options.values) };
      }
      if (input.operation === 'clear-script-logs') {
        // NetSuite's own "Delete" on the deployment's Execution Log subtab (the request Magic sends:
        // script = the deployment number, scripttype = the script's internal ID).
        const [deployment] = await run('SELECT primarykey, deploymentid, script FROM scriptdeployment WHERE primarykey = ?', [input.options.deploymentId]);
        if (!deployment) throw Error('Deployment ' + input.options.deploymentId + ' not found.');
        if (!deployment.deploymentid) throw Error('NetSuite did not return a deployment number for this deployment.');
        await fetchChecked('/app/common/scripting/scriptnote.nl?delete=T&id=&script=' + encodeURIComponent(deployment.deploymentid) + '&scripttype=' + encodeURIComponent(deployment.script), 'the execution log');
        return { deploymentId: deployment.primarykey, scriptId: deployment.script, cleared: true };
      }
      if (input.operation === 'suitelet-url') {
        const [deployment] = await run('SELECT sd.scriptid AS deployment, s.scriptid AS script, s.scripttype FROM scriptdeployment sd JOIN script s ON s.id = sd.script WHERE sd.primarykey = ?', [input.options.deploymentId]);
        if (!deployment) throw Error('Deployment ' + input.options.deploymentId + ' not found.');
        if (deployment.scripttype !== 'SCRIPTLET') throw Error('Only Suitelet deployments have a page to open.');
        const path = N.url.resolveScript({ scriptId: String(deployment.script).toLowerCase(), deploymentId: String(deployment.deployment).toLowerCase(), returnExternalUrl: false });
        return { url: new URL(path, location.origin).href };
      }
      if (input.operation === 'record-deployments') {
        // Magic's "Scripts deployed" view: which scripts run on a record type.
        if (!input.options.recordType)
          return { recordTypes: await run("SELECT sd.recordtype AS recordtype, COUNT(*) AS deployments FROM scriptdeployment sd WHERE sd.recordtype IS NOT NULL GROUP BY sd.recordtype ORDER BY sd.recordtype") };
        return { rows: await run('SELECT s.id, s.name, s.scriptid, s.scripttype, sd.primarykey, sd.scriptid AS deployment, sd.isdeployed, sd.status, sd.loglevel, sd.recordtype FROM scriptdeployment sd JOIN script s ON s.id = sd.script WHERE UPPER(sd.recordtype) = UPPER(?) ORDER BY s.name, sd.scriptid', [input.options.recordType]) };
      }
      if (input.operation === 'run-script') {
        // Like Magic NetSuite's quick script: N modules unpacked, async body. Adds captured logs with levels,
        // a sql() helper, JSON-safe results and the error's line inside the caller's code.
        const logs = [], show = value => { if (typeof value === 'string') return value; try { return JSON.stringify(value); } catch { return String(value); } };
        const push = (level, args) => { if (logs.length < 200) logs.push({ level, text: args.filter(a => a !== undefined).map(show).join(' ').slice(0, 2000) }); };
        const scriptConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...args) => push(level, args)]));
        const nLog = level => (a, b) => push(level, a && typeof a === 'object' && ('title' in a || 'details' in a) ? [a.title, a.details] : [a, b]);
        const modules = { ...N, log: { debug: nLog('debug'), audit: nLog('audit'), error: nLog('error'), emergency: nLog('emergency') } };
        const sql = async (query, params = []) => run(query, params);
        const names = Object.keys(modules).filter(name => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !['N', 'console', 'sql'].includes(name));
        let compiled;
        try {
          compiled = new Function('N', 'console', 'sql', '"use strict"; const { ' + names.join(', ') + ' } = N;\\nreturn (async () => {\\n' + input.options.code + '\\n})();');
        } catch (error) {
          return { ok: false, error: { name: error?.name, message: String(error?.message || error), phase: 'compile' }, logs };
        }
        try {
          const value = await compiled(modules, scriptConsole, sql);
          let result = null;
          try { result = value === undefined ? null : JSON.parse(JSON.stringify(value, (key, v) => typeof v === 'bigint' ? String(v) : v) ?? 'null'); }
          catch { result = String(value); }
          return { ok: true, result, logs };
        } catch (error) {
          // new Function puts 2 header lines before the body, plus our 2: caller line = stack line - 4.
          const at = String(error?.stack || '').match(/<anonymous>:(\\d+):(\\d+)/);
          return { ok: false, error: { name: error?.name || null, message: String(error?.message || error), line: at ? Number(at[1]) - 4 : null, column: at ? Number(at[2]) : null, phase: 'run' }, logs };
        }
      }
      if (input.operation === 'file-content') {
        const rows = await run('SELECT id, name, url, filetype, folder FROM file WHERE id = ?', [input.options.id]);
        if (!rows.length || !rows[0].url) throw Error('File not found or not accessible.');
        const url = new URL(rows[0].url, location.origin);
        if (url.origin !== location.origin) throw Error('File URL is outside the selected NetSuite account.');
        const max = 600000, tooLarge = size => Error('The file is ' + size + ' bytes; MCP reads files up to ' + max + ' bytes. Open it in the File Explorer instead.');
        const response = await fetchChecked(url.href, 'the file');
        const length = Number(response.headers.get('content-length') || 0);
        if (length > max) throw tooLarge(length);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > max) throw tooLarge(bytes.length);
        const contentType = response.headers.get('content-type') || '';
        // Locked bundle files (Hide in SuiteBundle) are served as NetSuite's "Page Not Found" page.
        if (contentType.toLowerCase().startsWith('text/html') && rows[0].filetype !== 'HTMLDOC' &&
            new TextDecoder().decode(bytes.subarray(0, 2000)).includes('<title>NetSuite | Page Not Found'))
          throw Error('NetSuite does not serve this file\\'s content (it answered "Page Not Found"). Files hidden in a locked bundle cannot be read.');
        const base = { id: rows[0].id, name: rows[0].name, filetype: rows[0].filetype, folder: rows[0].folder, filesize: bytes.length, contentType };
        if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
          let raw = ''; for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
          return { ...base, kind: 'pdf', base64: btoa(raw) };
        }
        if (!bytes.includes(0)) {
          try { return { ...base, kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch {}
          const type = contentType.toLowerCase();
          if (type.startsWith('text') || ['json', 'xml', 'javascript', 'csv'].some(t => type.includes(t)))
            return { ...base, kind: 'text', content: new TextDecoder('windows-1252').decode(bytes) };
        }
        return { ...base, kind: 'binary' };
      }
      if (input.operation === 'log-search') {
        if (!N.search?.create || !N.format?.parse) throw Error('Script execution logs are unavailable for this role.');
        const o = input.options, day = value => N.format.format({ value: new Date(value), type: N.format.Type.DATE });
        const filters = [['date', 'within', day(o.from), day(o.to)]];
        if (o.levels.length) filters.push('AND', ['type', 'anyof', o.levels]);
        if (o.scriptIds.length) filters.push('AND', ['script.internalid', 'anyof', o.scriptIds]);
        if (o.deploymentIds.length) filters.push('AND', ['scriptdeployment.internalid', 'anyof', o.deploymentIds]);
        const spec = [['internalid'], ['title'], ['type'], ['date'], ['time'], ['user'], ['scripttype'], ['detail'], ['internalid', 'script'], ['name', 'script'], ['internalid', 'scriptDeployment'], ['scriptid', 'scriptDeployment']];
        const page = async sorted => {
          const columns = spec.map(([name, join], i) => N.search.createColumn({ name, join, ...(sorted && i === 0 ? { sort: N.search.Sort.DESC } : {}) }));
          const paged = await N.search.create({ type: 'scriptexecutionlog', filters, columns }).runPaged.promise({ pageSize: 400 });
          return { paged, data: paged.pageRanges.length ? (await paged.fetch.promise({ index: 0 })).data : [] };
        };
        // Newest first when the account allows sorting by internal ID; the caller sorts again either way.
        const { paged, data } = await page(true).catch(() => page(false));
        const iso = (date, time) => {
          try {
            const d = N.format.parse({ value: date, type: N.format.Type.DATE });
            const m = String(time || '').trim().toLowerCase().match(/^(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(am|pm)?/);
            if (m) { let h = Number(m[1]) % (m[4] ? 12 : 24); if (m[4] === 'pm') h += 12; d.setHours(h, Number(m[2]), Number(m[3] || 0), 0); }
            return d.toISOString();
          } catch { return null; }
        };
        const rows = data.map(r => {
          const value = (name, join) => r.getValue({ name, join });
          const text = name => { try { return r.getText({ name }); } catch { return null; } };
          const detail = String(value('detail') ?? '');
          return {
            id: Number(value('internalid')), datetime: iso(value('date'), value('time')), date: value('date'), time: value('time'),
            level: value('type'), title: value('title'), detail: detail.slice(0, 1000), detailTruncated: detail.length > 1000,
            user: text('user') || value('user'), scriptType: text('scripttype') || value('scripttype'),
            scriptId: Number(value('internalid', 'script')) || null, scriptName: value('name', 'script'),
            deploymentId: Number(value('internalid', 'scriptDeployment')) || null, deploymentScriptId: value('scriptid', 'scriptDeployment')
          };
        });
        return { rows, totalCount: paged.count };
      }
      if (input.operation === 'script-logs') {
        if (!N.search?.create) throw Error('Script execution logs are unavailable for this role.');
        const names = ['internalid', 'title', 'type', 'date', 'time', 'user', 'detail'];
        const columns = names.map(name => N.search.createColumn({ name }));
        const search = N.search.create({ type: 'scriptexecutionlog', filters: [['script.internalid', 'anyof', input.options.id]], columns });
        const paged = await search.runPaged.promise({ pageSize: 100 });
        if (!paged.pageRanges.length) return { rows: [], totalCount: paged.count };
        const page = await paged.fetch.promise({ index: 0 });
        return { rows: page.data.map(result => Object.fromEntries(names.map(name => [name, result.getValue({ name })]))), totalCount: paged.count };
      }
      if (input.operation === 'create-folder') {
        if (!N.record?.create) throw Error('Folder creation is unavailable for this NetSuite role.');
        const folder = N.record.create({ type: 'folder', isDynamic: true });
        folder.setValue({ fieldId: 'name', value: input.options.name.trim() });
        folder.setValue({ fieldId: 'parent', value: input.options.folderId });
        const id = folder.save({ enableSourcing: true, ignoreMandatoryFields: true });
        return { id };
      }
      // Reads a file back and compares it byte for byte, so a write is only reported once NetSuite holds the new content.
      const sameContent = async (fileId, bytes) => {
        const [row] = await run('SELECT url FROM file WHERE id = ?', [fileId]);
        if (!row?.url) return false;
        const response = await fetch(new URL(row.url, location.origin).href, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) return false;
        const stored = new Uint8Array(await response.arrayBuffer());
        return stored.length === bytes.length && stored.every((value, index) => value === bytes[index]);
      };
      let replaceId;
      if (input.operation === 'upload-file') {
        const folderId = input.options.folderId, name = input.options.name.trim();
        const duplicates = await run('SELECT id FROM file WHERE folder = ? AND LOWER(name) = LOWER(?)', [folderId, name]);
        if (duplicates.length && !input.options.overwrite) throw Error('A file with that name already exists in this folder. Pass overwrite: true to replace its content (the file keeps its ID).');
        if (duplicates.length) replaceId = duplicates[0].id;
      }
      if (input.operation === 'upload-file' && !replaceId) {
        const folderId = input.options.folderId, name = input.options.name.trim();
        const page = await fetch('/app/common/media/mediaitemfolders.nl?folder=' + encodeURIComponent(folderId), { credentials: 'same-origin' });
        if (!page.ok) throw Error('Could not open the destination folder: HTTP ' + page.status);
        const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
        const csrf = doc.querySelector('input[name="_csrf"]')?.value || document.querySelector('input[name="_csrf"]')?.value;
        if (!csrf) throw Error('NetSuite did not provide an upload token. The file was not uploaded.');
        const decoded = atob(input.options.base64), bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
        if (bytes.length > 5000000) throw Error('File exceeds the 5 MB upload limit.');
        const body = new FormData();
        for (const [key, value] of Object.entries({ sortcol: 'sortname', sortdir: 'ASC', csv: 'HTML', OfficeXML: 'F', pdf: '', size: '50', _csrf: csrf, filetype: 'DOCUMENT', dest_url: '/app/common/media/mediaitemfolders.nl', folder: String(folderId), quickAdd: 'T', mediakeyword: '', unzip: 'F', segment: '' })) body.set(key, value);
        body.set('mediafile', new Blob([bytes]), name);
        const uploaded = await fetch('/app/common/media/importmediabatch.nl', { method: 'POST', body, credentials: 'same-origin' });
        if (!uploaded.ok) throw Error('NetSuite rejected the upload: HTTP ' + uploaded.status);
        const matches = await run('SELECT id, name FROM file WHERE folder = ? AND LOWER(name) = LOWER(?)', [folderId, name]);
        if (!matches.length) throw Error('NetSuite did not confirm the upload. Refresh the folder and check before retrying.');
        if (input.options.overwrite !== undefined && !(await sameContent(matches[0].id, bytes)))
          throw Error('NetSuite created file ' + matches[0].id + ' but its content does not match what was sent. Check the file before retrying.');
        return { id: matches[0].id, name, created: true, verified: input.options.overwrite !== undefined };
      }
      if (input.operation === 'save-file') {
        const rows = await run('SELECT id, name, url, filesize, filetype, folder FROM file WHERE id = ?', [input.options.id]);
        if (!rows.length || !rows[0].url) throw Error('File not found or not accessible.');
        const file = rows[0], fileUrl = new URL(file.url, location.origin);
        if (fileUrl.origin !== location.origin) throw Error('File URL is outside the selected NetSuite account.');
        const read = async () => { const response = await fetch(fileUrl.href, { credentials: 'same-origin', cache: 'no-store' }); if (!response.ok) throw Error('Could not read the current file: HTTP ' + response.status); const text = await response.text(); if (text.length > 2000000) throw Error('File is too large to edit.'); return text; };
        if (input.options.original != null && await read() !== input.options.original) throw Error('This file changed in NetSuite. Reopen it before saving to avoid overwriting newer changes.');
        const editUrl = '/app/common/record/edittextmediaitem.nl?id=' + encodeURIComponent(file.id) + '&e=T&l=T&target=filesize&syntaxHighlighting=T';
        const formResponse = await fetch(editUrl, { credentials: 'same-origin', cache: 'no-store' });
        if (!formResponse.ok) throw Error('Could not open the NetSuite file editor: HTTP ' + formResponse.status);
        const doc = new DOMParser().parseFromString(await formResponse.text(), 'text/html');
        const csrf = doc.querySelector('input[name="_csrf"]')?.value;
        if (!csrf) throw Error('NetSuite did not provide an edit token. The file was not saved.');
        const user = N.runtime.getCurrentUser(), account = location.hostname.split('.')[0].replace(/-/g, '_').toUpperCase();
        const body = new URLSearchParams({ submitter: 'Save', mCharData: input.options.content, _eml_nkey_: account + '~' + user.id + '~' + user.role + '~N', _multibtnstate_: '', selectedtab: '', l: 'T', nsapiPI: '', nsapiSR: '', nsapiVF: '', nsapiFC: '', nsapiPS: '', nsapiVI: '', nsapiVD: '', nsapiPD: '', nsapiVL: '', nsapiRC: '', nsapiLI: '', nsapiLC: '', nsapiCT: String(Date.now()), nsbrowserenv: 'istop=T', type: 'textmediaitem', id: String(file.id), externalid: '', whence: '', customwhence: '', entryformquerystring: 'id=' + file.id + '&e=T&l=T&target=filesize&syntaxHighlighting=T', _csrf: csrf, target: 'filesize', name: String(file.name), sname: String(file.name), folder: String(file.folder), mediaType: String(file.filetype), submitted: 'T', formdisplayview: 'NONE', _button: '' });
        const saved = await fetch('/app/common/record/edittextmediaitem.nl?l=T&l=T', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        if (!saved.ok) throw Error('NetSuite rejected the save: HTTP ' + saved.status);
        if (await read() !== input.options.content) throw Error('NetSuite did not confirm the saved content. Reopen the file to check it before retrying.');
        return { id: file.id, content: input.options.content };
      }
      if (input.operation === 'file') {
        const rows = await run('SELECT id, name, url, filesize, filetype, folder, lastmodifieddate, createddate, description FROM file WHERE id = ?', [input.options.id]);
        if (!rows.length || !rows[0].url) throw Error('File not found or not accessible.');
        const url = new URL(rows[0].url, location.origin);
        if (url.origin !== location.origin) throw Error('File URL is outside the selected NetSuite account.');
        if (Number(rows[0].filesize) > 2000000) throw Error('File is too large to preview (2 MB limit).');
        const response = await fetch(url.href, { credentials: 'same-origin' });
        if (!response.ok) throw Error('Could not read file: HTTP ' + response.status);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 2000000) throw Error('File is too large to preview (2 MB limit).');
        let binary = false, content = '';
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); binary = content.includes('\u0000'); } catch { binary = true; }
        let raw = ''; for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { ...rows[0], content: binary ? '' : content, binary, base64: btoa(raw) };
      }
      const csrfFor = async folderId => {
        const page = await fetch('/app/common/media/mediaitemfolders.nl?folder=' + encodeURIComponent(folderId), { credentials: 'same-origin', cache: 'no-store' });
        if (!page.ok) throw Error('Could not open the folder: HTTP ' + page.status);
        const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
        const csrf = doc.querySelector('input[name="_csrf"]')?.value || document.querySelector('input[name="_csrf"]')?.value;
        if (!csrf) throw Error('NetSuite did not provide a request token. Nothing was changed.');
        return csrf;
      };
      const nsapi = () => ({ _multibtnstate_: '', selectedtab: '', nsapiPI: '', nsapiSR: '', nsapiVF: '', nsapiFC: '', nsapiPS: '', nsapiVI: '', nsapiVD: '', nsapiPD: '', nsapiVL: '', nsapiRC: '', nsapiLI: '', nsapiLC: '', nsapiCT: String(Date.now()), nsbrowserenv: 'istop=T' });
      const sitecategory = { sitecategoryfields: 'website\\x01category_display\\x01category\\x01isdefault\\x01categorydescription', sitecategoryflags: '1\\x018\\x011\\x010\\x010', sitecategoryfieldsets: '\\x01\\x01\\x01\\x01', sitecategorytypes: 'select\\x01text\\x01slaveselect\\x01checkbox\\x01text', sitecategoryorigtypes: '\\x01\\x01\\x01\\x01', sitecategoryparents: '\\x01sitecategory.website\\x01sitecategory.website\\x01\\x01sitecategory.category', sitecategorylabels: 'Site\\x01Site Category\\x01\\x01Preferred Category\\x01Description', sitecategorydata: '', nextsitecategoryidx: '1', sitecategoryvalid: 'T', usernotesloaded: 'F', usernotesdotted: 'F', systemnotesloaded: 'F', systemnotesdotted: 'F' };
      if (input.operation === 'upload-file' && replaceId) {
        // Replace an existing file's content through its edit form (same post as a rename, with the new file), so its ID stays.
        const [row] = await run('SELECT id, name, folder, filetype FROM file WHERE id = ?', [replaceId]);
        if (!row) throw Error('File not found or not accessible.');
        const decoded = atob(input.options.base64), bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
        if (bytes.length > 5000000) throw Error('File exceeds the 5 MB upload limit.');
        const user = N.runtime.getCurrentUser(), account = location.hostname.split('.')[0].replace(/-/g, '_').toUpperCase();
        const body = new FormData();
        for (const [key, value] of Object.entries({ submitter: 'Save', name: String(row.name), filesize: String(bytes.length), folder_display: '', folder: String(row.folder), description: '' })) body.append(key, value);
        body.append('mediafile', new Blob([bytes], { type: 'application/octet-stream' }), String(row.name));
        body.append('*eml_nkey*', account + '~' + user.id + '~' + user.role + '~N');
        for (const [key, value] of Object.entries({ ...nsapi(), type: 'filecabinet', id: String(row.id), externalid: '', whence: '', customwhence: '', entryformquerystring: 'id=' + row.id + '&e=T', _csrf: await csrfFor(row.folder), filetype: String(row.filetype ?? ''), createddate: '', lastmodifieddate: '', uploadrectype: 'filecabinet', package: '', mediatypeiconurl: '', oldfolder: String(row.folder), oldrootfolder: '-15', rootfolder: '-15', textfileencoding: 'UTF-8', caption: '', storedisplaythumbnail: '', sitedescription: '', featureddescription: '', submitted: 'T', formdisplayview: 'NONE', _button: '', ...sitecategory })) body.append(key, value);
        const saved = await fetch('/app/common/media/mediaitem.nl', { method: 'POST', body, credentials: 'same-origin' });
        if (!saved.ok) throw Error('NetSuite rejected the replacement: HTTP ' + saved.status);
        if (!(await sameContent(row.id, bytes))) throw Error('NetSuite did not store the new content of file ' + row.id + '. Check the file before retrying.');
        return { id: row.id, name: row.name, created: false, replaced: true, verified: true };
      }
      // Same form posts Magic NetSuite uses (extension-src/netsuiteApi/mediaItems.ts).
      if (input.operation === 'rename-item') {
        const { kind, id, folderId } = input.options, name = input.options.name.trim();
        if (kind === 'folder') {
          if (!N.record?.submitFields) throw Error('Renaming folders is unavailable for this NetSuite role.');
          const siblings = await run('SELECT id FROM MediaItemFolder WHERE parent = ? AND LOWER(name) = LOWER(?) AND id <> ?', [folderId, name, id]);
          if (siblings.length) throw Error('A folder with that name already exists here.');
          N.record.submitFields({ type: 'folder', id, values: { name } });
        } else {
          const rows = await run('SELECT id, name, folder, filesize, filetype FROM file WHERE id = ?', [id]);
          if (!rows.length) throw Error('File not found or not accessible.');
          const duplicates = await run('SELECT id FROM file WHERE folder = ? AND LOWER(name) = LOWER(?) AND id <> ?', [rows[0].folder, name, id]);
          if (duplicates.length) throw Error('A file with that name already exists in this folder.');
          const user = N.runtime.getCurrentUser(), account = location.hostname.split('.')[0].replace(/-/g, '_').toUpperCase();
          const body = new FormData();
          for (const [key, value] of Object.entries({ submitter: 'Save', name, filesize: String(rows[0].filesize ?? 0), folder_display: '', folder: String(rows[0].folder), description: '' })) body.append(key, value);
          body.append('mediafile', new Blob([], { type: 'application/octet-stream' }), '');
          body.append('*eml_nkey*', account + '~' + user.id + '~' + user.role + '~N');
          for (const [key, value] of Object.entries({ ...nsapi(), type: 'filecabinet', id: String(id), externalid: '', whence: '', customwhence: '', entryformquerystring: 'id=' + id + '&e=T', _csrf: await csrfFor(rows[0].folder), filetype: String(rows[0].filetype ?? ''), createddate: '', lastmodifieddate: '', uploadrectype: 'filecabinet', package: '', mediatypeiconurl: '', oldfolder: String(rows[0].folder), oldrootfolder: '-15', rootfolder: '-15', textfileencoding: 'UTF-8', caption: '', storedisplaythumbnail: '', sitedescription: '', featureddescription: '', submitted: 'T', formdisplayview: 'NONE', _button: '', ...sitecategory })) body.append(key, value);
          const saved = await fetch('/app/common/media/mediaitem.nl', { method: 'POST', body, credentials: 'same-origin' });
          if (!saved.ok) throw Error('NetSuite rejected the rename: HTTP ' + saved.status);
        }
        const check = await run(kind === 'folder' ? 'SELECT name FROM MediaItemFolder WHERE id = ?' : 'SELECT name FROM file WHERE id = ?', [id]);
        if (check[0]?.name !== name) throw Error('NetSuite did not confirm the rename. Refresh the folder and check before retrying.');
        return { id, name };
      }
      if (input.operation === 'move-items') {
        const { folderId, targetId, fileIds, folderIds } = input.options;
        const body = new URLSearchParams({ _csrf: await csrfFor(folderId) });
        for (const id of folderIds) body.append('sa' + id + 'fldT', 'T');
        for (const id of fileIds) body.append('sa' + id + 'fldF', 'T');
        const moved = await fetch('/app/common/media/mediaitemfolders.nl?folder=' + folderId + '&_grpMove=T&folder=' + folderId + '&overwrite=true&newfolder=' + targetId, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
        if (!moved.ok) throw Error('NetSuite rejected the move: HTTP ' + moved.status);
        const list = values => values.map(() => '?').join(',');
        const [files, folders] = await Promise.all([
          fileIds.length ? run('SELECT id FROM file WHERE folder = ? AND id IN (' + list(fileIds) + ')', [targetId, ...fileIds]) : [],
          folderIds.length ? run('SELECT id FROM MediaItemFolder WHERE parent = ? AND id IN (' + list(folderIds) + ')', [targetId, ...folderIds]) : []
        ]);
        const missing = fileIds.length + folderIds.length - files.length - folders.length;
        if (missing) throw Error(missing + ' item(s) were not moved. A file with the same name may already exist in the destination.');
        return { moved: files.length + folders.length };
      }
      if (input.operation === 'delete-items') {
        const { folderId, fileIds, folderIds } = input.options, errors = [];
        const csrf = fileIds.length ? await csrfFor(folderId) : '';
        for (const id of fileIds) {
          try {
            const body = new FormData();
            for (const [key, value] of Object.entries({ delete_media: 'Delete', folder: String(folderId), description: '', ...nsapi(), type: 'filecabinet', id: String(id), externalid: '', customwhence: '', entryformquerystring: 'id=' + id + '&e=T', _csrf: csrf, uploadrectype: 'filecabinet', package: '', oldfolder: String(folderId), caption: '', storedisplaythumbnail: '', sitedescription: '', featureddescription: '', submitted: '', formdisplayview: 'NONE', _button: '', ...sitecategory })) body.append(key, value);
            body.append('mediafile', new Blob([]), '');
            const response = await fetch('/app/common/media/mediaitem.nl', { method: 'POST', body, credentials: 'same-origin' });
            if (!response.ok) throw Error('HTTP ' + response.status);
          } catch (e) { errors.push('File ' + id + ': ' + (e?.message || e)); }
        }
        for (const id of folderIds) {
          try {
            if (!N.record?.delete) throw Error('unavailable for this role');
            N.record.delete({ type: 'folder', id });
          } catch (e) { errors.push('Folder ' + id + ': ' + (e?.message || e)); }
        }
        const list = values => values.map(() => '?').join(',');
        const [files, folders] = await Promise.all([
          fileIds.length ? run('SELECT id FROM file WHERE id IN (' + list(fileIds) + ')', fileIds) : [],
          folderIds.length ? run('SELECT id FROM MediaItemFolder WHERE id IN (' + list(folderIds) + ')', folderIds) : []
        ]);
        const left = [...files.map(r => 'File ' + r.id), ...folders.map(r => 'Folder ' + r.id)];
        return { deleted: fileIds.length + folderIds.length - left.length, remaining: left, errors };
      }
      if (input.operation === 'search-files') {
        const term = input.options.search.trim().toLowerCase();
        const pattern = '%' + term + '%';
        const numeric = /^\\d+$/.test(term) && Number.isSafeInteger(Number(term));
        const condition = numeric ? '(LOWER(name) LIKE ? OR id = ?)' : 'LOWER(name) LIKE ?';
        const params = numeric ? [pattern, Number(term)] : [pattern];
        const [folders, files] = await Promise.all([
          run('SELECT f.id, f.name, f.parent, p.name AS parentname FROM MediaItemFolder f LEFT JOIN MediaItemFolder p ON p.id = f.parent WHERE ' + condition.replace(/name|id/g, 'f.$&') + ' AND ROWNUM <= 100 ORDER BY f.name', params),
          run('SELECT f.id, f.name, f.folder, f.filesize, f.filetype, p.name AS foldername FROM file f LEFT JOIN MediaItemFolder p ON p.id = f.folder WHERE ' + condition.replace(/name|id/g, 'f.$&') + ' AND ROWNUM <= 100 ORDER BY f.name', params)
        ]);
        return { folders, files };
      }
      const folderColumns = 'id, name, parent, foldertype, numfolderfiles, foldersize, lastmodifieddate, description';
      if (input.operation === 'folders') return { rows: await run("SELECT " + folderColumns + " FROM MediaItemFolder WHERE IsTopLevel = 'T' ORDER BY name") };
      if (input.operation === 'folder') {
        const id = input.options.id;
        const breadcrumbs = async () => {
          const chain = [];
          for (let next = id, guard = 0; next != null && next !== '' && guard < 40; guard++) {
            const [row] = await run('SELECT id, name, parent FROM MediaItemFolder WHERE id = ?', [next]);
            if (!row) break;
            chain.unshift({ id: Number(row.id), name: String(row.name) });
            next = row.parent;
          }
          return chain;
        };
        const [folders, files, path] = await Promise.all([
          run('SELECT ' + folderColumns + ' FROM MediaItemFolder WHERE parent = ? ORDER BY name', [id]),
          run('SELECT id, name, filesize, filetype, folder, lastmodifieddate, createddate, description, url FROM file WHERE folder = ? ORDER BY name', [id]),
          breadcrumbs()
        ]);
        return { folders, files, path };
      }
      if (input.operation === 'scripts') {
        const rows = await run('SELECT script.scriptid, script.id, script.name, script.scripttype, entity.entityid AS owner, file.name AS scriptfile, file.id AS fileid FROM script LEFT JOIN entity ON script.owner = entity.id LEFT JOIN file ON file.id = script.scriptfile ORDER BY script.name');
        // Deployment counts for the list (optional: the list still loads without them).
        const counts = await run("SELECT script, COUNT(*) AS deployments, SUM(CASE WHEN isdeployed = 'T' THEN 1 ELSE 0 END) AS deployed FROM scriptdeployment GROUP BY script").catch(() => []);
        const byScript = new Map(counts.map(c => [Number(c.script), c]));
        return { rows: rows.map(r => { const c = byScript.get(Number(r.id)); return c ? { ...r, deployments: Number(c.deployments) || 0, deployed: Number(c.deployed) || 0 } : r; }) };
      }
      if (input.operation === 'deployments') return { rows: await run('SELECT scriptDeployment.scriptid, scriptDeployment.recordtype, scriptDeployment.isdeployed, scriptDeployment.status, scriptDeployment.loglevel, scriptDeployment.primarykey, scriptDeployment.deploymentid FROM scriptdeployment WHERE script = ? ORDER BY scriptDeployment.scriptid', [input.options.id]) };
      const pageSize = 100, index = Math.floor(input.options.offset / pageSize), offset = index * pageSize;
      try {
        const paged = await N.query.runSuiteQLPaged.promise({ query: input.options.sql, pageSize });
        const page = index < paged.pageRanges.length ? await paged.fetch.promise({ index }) : null;
        return { rows: page ? page.data.asMappedResults() : [], totalCount: paged.count, offset, pageSize };
      } catch (primaryError) {
        // Match Magic NetSuite's optional SuiteQL Suitelet fallback for accounts
        // where the client query API cannot execute the request.
        const found = await run("SELECT s.id, d.id AS deploy_id FROM suitelet s JOIN scriptDeployment d ON s.id = d.script WHERE (LOWER(s.name) LIKE '%suiteql query tool%' OR LOWER(s.description) LIKE '%suiteql query tool%' OR LOWER(s.name) LIKE '%suiteql%' OR LOWER(s.description) LIKE '%suiteql%') AND d.isdeployed = 'T' AND d.status = 'RELEASED' AND s.apiversion = 2.1").catch(() => []);
        if (!found.length) throw primaryError;
        const url = new URL('/app/site/hosting/scriptlet.nl', location.origin);
        url.searchParams.set('script', String(found[0].id)); url.searchParams.set('deploy', String(found[0].deploy_id)); url.searchParams.set('compid', location.hostname.split('.')[0].replace(/-/g, '_').toUpperCase());
        const response = await fetch(url.href, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ function: 'queryExecute', query: input.options.sql, rowBegin: offset, rowEnd: offset + pageSize, paginationEnabled: true, viewsEnabled: false, returnTotals: true }) });
        if (!response.ok) throw Error('SuiteQL Suitelet failed: HTTP ' + response.status);
        const data = await response.json();
        if (data.error) throw Error(typeof data.error === 'string' ? data.error : data.error.message || data.error.code || 'SuiteQL failed.');
        return { rows: data.records || [], totalCount: data.totalCount ?? (data.records || []).length, offset, pageSize };
      }

    })() ?? null }); } catch (error) {
      return JSON.stringify({ error: String(error?.message || error?.name || error), signInRequired: error?.code === 'SIGN_IN_REQUIRED' });
    } })()`;
    let processingTab;
    const parallel = processing.supportsParallelReads === true &&
      expectedSessionEpoch === undefined && !WRITES.includes(operation);
    const assertSession = () => {
      if (expectedSessionEpoch !== undefined && lifecycle.sessionEpoch?.(event.sender, id) !== expectedSessionEpoch)
        throw Object.assign(Error("The observed NetSuite session changed. List and inspect a fresh target."), { code: "SESSION_CHANGED" });
    };
    const attempt = async (hold) => {
      assertSession();
      processingTab = await processing.acquire(event.sender, id, { parallel });
      let timer;
      // A timeout does not mean execution has stopped; keep the tab busy until
      // Chromium actually settles so refresh cannot interrupt an in-flight call.
      const execution = Promise.resolve()
        .then(() => {
          assertSession();
          if (expectedSessionEpoch !== undefined) refreshedEpochs.set(`${event.sender.id}:${id}`, expectedSessionEpoch);
          return processingTab.contents.mainFrame?.executeJavaScript(code) ?? processingTab.contents.executeJavaScript(code);
        })
        .then((text) => {
          const answer = JSON.parse(text);
          if (answer?.error !== undefined)
            throw Object.assign(Error(answer.error), { signInRequired: answer.signInRequired === true });
          return answer?.result ?? null;
        })
        .finally(processingTab.release);
      hold(execution);
      try {
        const value = await Promise.race([
          execution,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = Error(
                ["save-file", "create-folder", "upload-file", "run-script"].includes(operation)
                  ? "The request timed out and may have completed. Refresh and check before retrying."
                  : "NetSuite request timed out.",
              );
              error.timedOut = true;
              reject(error);
            }, operation === "run-script" ? options.timeoutMs : 30000);
          }),
        ]);
        assertSession();
        return value;
      } finally {
        clearTimeout(timer);
      }
    };
    const execute = async (hold) => {
      try {
        assertSession();
        if (expectedSessionEpoch !== undefined && refreshedEpochs.get(`${event.sender.id}:${id}`) !== expectedSessionEpoch) {
          await processing.reload?.(event.sender, id);
          assertSession();
        }
        return await attempt(hold);
      } catch (error) {
        // NetSuite can end the session while the page stays put, so calls fail
        // until it is reloaded. Then sign in again (a reload goes through the
        // login page) and run reads once more; writes are only reported.
        if (error?.code === "SESSION_CHANGED" || error?.timedOut || !processingTab || processingTab.temporary ||
            (!error?.signInRequired && await signedIn(processingTab.contents))) throw error;
        if (!(await Promise.resolve(processing.reload?.(event.sender, id)).catch(() => false))) throw error;
        if (WRITES.includes(operation)) throw error;
        return await attempt(hold);
      }
    };
    // UI and MCP share the same executor reservation, including failed calls.
    const key = `${event.sender.id}:${id}`;
    return schedule(key, parallel, execute);
  };
  ipcMain.handle("orvane:netsuite-run", run);
  return {
    environments: host => processing.environments(host),
    run: (host, id, operation, args, expectedSessionEpoch) => run({ sender: host }, id, operation, args, expectedSessionEpoch),
    sessionEpoch: lifecycle.sessionEpoch,
  };
}
