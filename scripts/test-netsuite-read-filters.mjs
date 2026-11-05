import assert from "node:assert/strict";

// Criteria come only from reads of the already selected, authorized sandbox.
// Never log discovered names, IDs, owner labels, SQL or filter text.
export async function checkNetSuiteReadFilters({
  call,
  client,
  targetId,
  identity,
  record,
}) {
  const evidence = { checks: [], skipped: [] };
  const read = async (action, options = {}) => {
    const answer = await call(client, "orvane_netsuite_read", {
      action,
      targetId,
      identityToken: identity.identityToken,
      ...options,
    });
    assert.equal(answer.identity.identityToken, identity.identityToken);
    assert.equal(answer.identity.serverRuntimeVerified, false);
    assert.equal(answer.read.schemaVersion, 2);
    assert.equal(answer.read.page, options.page ?? 0);
    assert(Array.isArray(answer.data.rows) && answer.data.rows.length <= 100);
    const history = await call(client, "orvane_netsuite_status", {
      action: "requests",
      limit: 100,
    });
    const entry = history.requests.find(
      (item) => item.requestId === answer.requestId,
    );
    assert.equal(entry?.operation, `read.${action}`);
    assert.equal(entry?.state, "completed");
    assert(!JSON.stringify(history).includes(identity.identityToken));
    assert(
      history.requests.every(
        (item) => !("sql" in item) && !("filters" in item) && !("rows" in item),
      ),
    );
    return answer;
  };
  const eligible = (value) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 160 &&
    !/[\u0000-\u001f\u007f;]/.test(value);
  const check = async (label, action, options, validate) => {
    const answer = await read(action, options);
    validate(answer.data.rows);
    record(label);
    evidence.checks.push({
      action,
      rowCount: answer.data.rows.length,
      filtered: !!options.filters,
    });
    return answer.data.rows;
  };
  const scripts = (await read("scripts")).data.rows;
  const script = scripts.find((row) =>
    [row.scriptid, row.name, row.scripttype, row.owner].every(eligible),
  );
  if (script) {
    await check(
      "script filters: exact ID/type and name/owner substrings match discovered metadata",
      "scripts",
      {
        filters: {
          scriptId: script.scriptid.trim(),
          scriptType: script.scripttype.trim().toLowerCase(),
          name: script.name.trim(),
          owner: script.owner.trim(),
        },
      },
      (rows) => {
        assert(rows.some((row) => Number(row.id) === Number(script.id)));
        assert(
          rows.every(
            (row) =>
              row.scriptid === script.scriptid &&
              row.scripttype.toLowerCase() === script.scripttype.toLowerCase(),
          ),
        );
      },
    );
    await check(
      "contradictory script filters: predicates combine with AND",
      "scripts",
      {
        filters: {
          scriptId: script.scriptid,
          name: "orvane-no-match-6f30b9f5-dbb8-473e-851e-572a2d5af486",
        },
      },
      (rows) => assert.equal(rows.length, 0),
    );
  } else
    evidence.skipped.push(
      "No script with bounded ID/type/name/owner criteria; script filter live checks skipped.",
    );
  const roots = (await read("folders")).data.rows;
  const folder = roots.find(
    (row) =>
      Number.isSafeInteger(Number(row.id)) &&
      Number(row.id) !== 0 &&
      Number(row.numfolderfiles) > 0 &&
      eligible(row.name),
  );
  if (folder) {
    await check(
      "global folder search: discovered exact folder ID and name match",
      "find-folders",
      { id: Number(folder.id), filters: { name: folder.name.trim() } },
      (rows) => {
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].id), Number(folder.id));
      },
    );
    await check(
      "scoped folder name filter: top-level results retain matching name",
      "folders",
      { filters: { name: folder.name.trim() } },
      (rows) =>
        assert(rows.some((row) => Number(row.id) === Number(folder.id))),
    );
    const files = (await read("files", { id: Number(folder.id) })).data.rows;
    const file = files.find(
      (row) =>
        Number.isSafeInteger(Number(row.id)) &&
        Number(row.id) > 0 &&
        eligible(row.name),
    );
    if (file) {
      await check(
        "global file search: discovered exact file ID and name match",
        "find-files",
        { id: Number(file.id), filters: { name: file.name.trim() } },
        (rows) => {
          assert.equal(rows.length, 1);
          assert.equal(Number(rows[0].id), Number(file.id));
        },
      );
      await check(
        "global filename search: lookup works without folder or file ID",
        "find-files",
        { filters: { name: file.name.trim() } },
        (rows) => {
          assert(rows.length > 0);
          assert(
            rows.every((row) =>
              row.name.toLowerCase().includes(file.name.trim().toLowerCase()),
            ),
          );
        },
      );
      await check(
        "scoped file name filter: matching metadata stays in the requested folder",
        "files",
        { id: Number(folder.id), filters: { name: file.name.trim() } },
        (rows) => {
          assert(rows.some((row) => Number(row.id) === Number(file.id)));
          assert(rows.every((row) => Number(row.folder) === Number(folder.id)));
        },
      );
    } else
      evidence.skipped.push(
        "No bounded file name in discovered folder; file search/filter live checks skipped.",
      );
  } else
    evidence.skipped.push(
      "No populated root folder with a bounded name; folder/file search live checks skipped.",
    );
  return evidence;
}
