import { ipcMain, webContents } from "electron";

// Only the Orvane window can address its own browser guests. No arbitrary page
// JavaScript or credentials are exposed through this bridge.
export function setupNetSuite(isOrvane, partition, processing) {
  const allowed = (event) =>
    !event.sender.isDestroyed() && isOrvane(event.sender.getURL());
  ipcMain.handle("orvane:netsuite-tabs", async (event) => {
    if (!allowed(event)) throw Error("Unauthorized request.");
    return processing.environments(event.sender);
  });
  ipcMain.handle("orvane:netsuite-open-record", (event, origin, kind, id) => {
    if (!allowed(event)) throw Error("Unauthorized request.");
    return processing.openRecord(event.sender, origin, kind, id);
  });
  ipcMain.handle("orvane:netsuite-run", async (event, id, operation, args) => {
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
      ].includes(operation)
    )
      throw Error("Unknown NetSuite operation.");
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
      ["deployments", "script-logs", "folder", "file", "save-file"].includes(
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
        typeof options.original !== "string" ||
        options.content.length > 2000000 ||
        options.original.length > 2000000)
    )
      throw Error("Invalid file content.");
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
      },
      origin: id,
    }).replace(/</g, "\\u003c");
    const code = `(async () => {
      const input = ${input};
      if (location.origin !== input.origin || !/^[a-z0-9-]+\\.app\\.netsuite\\.com$/i.test(location.hostname)) throw Error('NetSuite tab changed.');
      if (input.operation === 'tables' || input.operation === 'table-detail') {
        const action = input.operation === 'tables' ? 'getRecordTypes' : 'getRecordTypeDetail';
        const data = input.operation === 'tables' ? { structureType: 'FLAT' } : { scriptId: input.options.table, detailType: 'SS_ANAL' };
        const url = '/app/recordscatalog/rcendpoint.nl?action=' + action + '&data=' + encodeURIComponent(JSON.stringify(data));
        const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
        if (!response.ok) throw Error('Could not load the record catalog: HTTP ' + response.status);
        return await response.json();
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
      const run = async (query, params = []) => (await N.query.runSuiteQL.promise({ query, params })).asMappedResults();
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
      if (input.operation === 'upload-file') {
        const folderId = input.options.folderId, name = input.options.name.trim();
        const duplicates = await run('SELECT id FROM file WHERE folder = ? AND LOWER(name) = LOWER(?)', [folderId, name]);
        if (duplicates.length) throw Error('A file with that name already exists in this folder.');
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
        return { id: matches[0].id, name };
      }
      if (input.operation === 'save-file') {
        const rows = await run('SELECT id, name, url, filesize, filetype, folder FROM file WHERE id = ?', [input.options.id]);
        if (!rows.length || !rows[0].url) throw Error('File not found or not accessible.');
        const file = rows[0], fileUrl = new URL(file.url, location.origin);
        if (fileUrl.origin !== location.origin) throw Error('File URL is outside the selected NetSuite account.');
        const read = async () => { const response = await fetch(fileUrl.href, { credentials: 'same-origin', cache: 'no-store' }); if (!response.ok) throw Error('Could not read the current file: HTTP ' + response.status); const text = await response.text(); if (text.length > 2000000) throw Error('File is too large to edit.'); return text; };
        if (await read() !== input.options.original) throw Error('This file changed in NetSuite. Reopen it before saving to avoid overwriting newer changes.');
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
      if (input.operation === 'scripts') return { rows: await run('SELECT script.scriptid, script.id, script.name, script.scripttype, entity.entityid AS owner, file.name AS scriptfile, file.id AS fileid FROM script LEFT JOIN entity ON script.owner = entity.id LEFT JOIN file ON file.id = script.scriptfile ORDER BY script.name') };
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

    })()`;
    const processingTab = await processing.acquire(event.sender, id);
    let timer;
    // A timeout does not mean execution has stopped; keep the tab busy until
    // Chromium actually settles so refresh cannot interrupt an in-flight call.
    const execution = processingTab.contents
      .executeJavaScript(code)
      .finally(processingTab.release);
    try {
      return await Promise.race([
        execution,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  ["save-file", "create-folder", "upload-file"].includes(
                    operation,
                  )
                    ? "The request timed out and may have completed. Refresh and check before retrying."
                    : "NetSuite request timed out.",
                ),
              ),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
}
