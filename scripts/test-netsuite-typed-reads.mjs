import assert from "node:assert/strict";

// Called only after a parent checker selects and validates the authorized sandbox.
// Keep returned rows/tokens in memory; reports contain counts and dispositions only.
export async function checkTypedNetSuiteReads({
  call,
  client,
  targetId,
  identity,
  record,
}) {
  const evidence = { checks: [], skipped: [] };
  const run = async (action, options = {}) => {
    const answer = await call(client, "orvane_netsuite_read", {
      action,
      targetId,
      identityToken: identity.identityToken,
      ...options,
    });
    assert.equal(answer.identity.identityToken, identity.identityToken);
    assert.equal(answer.identity.serverRuntimeVerified, false);
    assert.equal(answer.read.action, action);
    assert.equal(answer.read.page, options.page ?? 0);
    assert.equal(answer.data.offset, (options.page ?? 0) * 100);
    assert(Array.isArray(answer.data.rows) && answer.data.rows.length <= 100);
    assert.match(answer.requestId, /^[a-f\d-]{36}$/i);
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
      history.requests.every((item) => !("rows" in item) && !("sql" in item)),
    );
    const label = `${action}: fixed bounded page and durable metadata-only read outcome`;
    record(label);
    evidence.checks.push({
      action,
      page: options.page ?? 0,
      rowCount: answer.data.rows.length,
    });
    return answer.data.rows;
  };
  const scripts = await run("scripts");
  await run("scripts", { page: 1 });
  const script = scripts.find(
    (row) => Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0,
  );
  if (script) await run("deployments", { id: Number(script.id) });
  else
    evidence.skipped.push(
      "No script ID returned; deployments live read not exercised.",
    );
  const folders = await run("folders");
  const validFolder = (row) =>
    Number.isSafeInteger(Number(row.id)) && Number(row.id) !== 0;
  const folder =
    folders.find((row) => validFolder(row) && Number(row.numfolderfiles) > 0) ||
    folders.find(validFolder);
  if (folder) {
    const children = await run("folders", { id: Number(folder.id) });
    const populated =
      [folder, ...children].find(
        (row) => validFolder(row) && Number(row.numfolderfiles) > 0,
      ) || folder;
    const files = await run("files", { id: Number(populated.id) });
    if (files.length) {
      assert(
        files.every(
          (row) =>
            Number.isSafeInteger(Number(row.id)) &&
            typeof row.name === "string",
        ),
      );
      assert(files.every((row) => !("content" in row) && !("base64" in row)));
    } else
      evidence.skipped.push(
        "Files page was empty; non-empty file metadata shape not exercised.",
      );
  } else
    evidence.skipped.push(
      "No root folder ID returned; child folders/files live reads not exercised.",
    );
  return evidence;
}
