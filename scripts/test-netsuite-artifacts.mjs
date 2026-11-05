import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function checkNetSuiteArtifacts({
  call,
  client,
  otherClient = client,
  targetId,
  identity,
  record,
}) {
  const evidence = { checks: [], skipped: [] };
  const args = { targetId, identityToken: identity.identityToken };
  const invoke = (caller, options) =>
    call(caller, "orvane_netsuite_artifact", { ...args, ...options });
  const exported = await invoke(client, {
    action: "export",
    source: {
      kind: "query",
      sql: "SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1",
    },
  });
  assert.equal(exported.artifact.format, "ndjson");
  assert.equal(exported.artifact.source.rowCount, 1);
  assert.equal(exported.artifact.source.scope, "one-page");
  assert.equal(exported.artifact.source.isLive, false);
  assert.equal(exported.data, undefined);
  assert.match(exported.artifact.sha256, /^[a-f\d]{64}$/);
  assert(!("path" in exported.artifact));
  record(
    "artifact export: one live query page becomes a bounded local NDJSON reference",
  );
  evidence.checks.push({ kind: "query", format: "ndjson", rowCount: 1 });
  const artifactId = exported.artifact.artifactId;
  const inspected = await invoke(otherClient, {
    action: "inspect",
    artifactId,
  });
  assert.equal(inspected.artifact.sha256, exported.artifact.sha256);
  let offset = 0,
    text = "";
  for (let i = 0; i < 8; i++) {
    const read = await invoke(otherClient, {
      action: "read",
      artifactId,
      offset,
      length: i === 0 ? 4 : 16000,
    });
    assert.equal(read.identity.identityToken, identity.identityToken);
    assert(read.data.content.length <= (i === 0 ? 4 : 16000));
    text += read.data.content;
    if (read.data.nextOffset === null) break;
    assert(read.data.nextOffset > offset);
    offset = read.data.nextOffset;
  }
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    exported.artifact.sha256,
  );
  assert.equal(Buffer.byteLength(text), exported.artifact.sizeBytes);
  assert(Number.isSafeInteger(Number(JSON.parse(text.trim()).id)));
  record(
    "artifact chunks: another MCP client reconstructs the page with matching size/checksum",
  );
  evidence.checks.push({ kind: "read", checksumMatched: true });
  const csv = await invoke(client, {
    action: "export",
    format: "csv",
    source: {
      kind: "query",
      sql: "SELECT '=1+1' AS formula, id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1",
    },
  });
  const csvRead = await invoke(otherClient, {
    action: "read",
    artifactId: csv.artifact.artifactId,
  });
  assert(csvRead.data.content.includes("'=1+1"));
  assert.equal(csv.artifact.csvFormulaEscaping, true);
  record(
    "artifact CSV: formula-looking string cells are prefixed in the actual live export",
  );
  evidence.checks.push({ kind: "query", format: "csv", formulaEscaped: true });
  const folders = await call(client, "orvane_netsuite_read", {
    ...args,
    action: "folders",
  });
  const folder = folders.data.rows.find(
    (row) => Number.isSafeInteger(Number(row.id)) && Number(row.id) !== 0,
  );
  if (folder) {
    const typed = await invoke(client, {
      action: "export",
      source: { kind: "read", action: "find-folders", id: Number(folder.id) },
    });
    assert.equal(typed.artifact.source.action, "find-folders");
    assert.equal(typed.artifact.source.rowCount, 1);
    record(
      "artifact typed export: discovered folder metadata uses the same page service",
    );
    evidence.checks.push({ kind: "read", format: "ndjson", rowCount: 1 });
  } else
    evidence.skipped.push(
      "No discovered folder ID; typed page export not exercised.",
    );
  await assert.rejects(
    invoke(otherClient, {
      action: "inspect",
      artifactId: "00000000-0000-4000-8000-000000000000",
    }),
    { code: "ARTIFACT_UNAVAILABLE" },
  );
  record(
    "artifact lookup: unknown IDs are explicit and do not resolve arbitrary paths",
  );
  const history = await call(client, "orvane_netsuite_status", {
    action: "requests",
    limit: 100,
  });
  const completed = history.requests.find(
    (item) => item.requestId === exported.requestId,
  );
  assert.equal(completed?.operation, "artifact.export");
  assert.equal(completed?.state, "completed");
  assert(
    history.requests.every(
      (item) => !("sql" in item) && !("content" in item) && !("source" in item),
    ),
  );
  record(
    "artifact journal: intent/outcomes remain metadata-only after local export and chunk reads",
  );
  return {
    evidence,
    retained: { artifactId, sha256: exported.artifact.sha256 },
  };
}
