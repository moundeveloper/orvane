import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  NETSUITE_METADATA_TOOLS,
  NETSUITE_PAGE_READS,
  filterLogs,
  parseBundleContents,
  parseBundleList,
  parseCsv,
  parseNetSuiteMetadata,
  recordSearchQueries,
  suiteQlLimitHint,
} from "../server/netsuite-metadata-operations.ts";
import { extractPdfText } from "../server/netsuite-pdf-text.ts";
import { createNetSuiteReadService } from "../electron/netsuite-read-service.mjs";
import {
  EXECUTOR_PAGE_READS,
  createExecutorGateway,
  pageReadArgs,
} from "../electron/netsuite-broker-protocol.mjs";

test("CSV parsing keeps quoted commas, quotes and newlines", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi""\nthere"\r\n\r\nx,,y\n'), [
    ["a", "b, c", 'say "hi"\nthere'],
    ["x", "", "y"],
  ]);
});

test("bundle list skips NetSuite's title line and maps camelCase fields with type", () => {
  const csv =
    'Installed Bundles\nName,Bundle ID,Version,App ID,Abstract,Created By,Created On,Last Update,Other\n"Tax, IT",123,1.2,com.x,"Line one\nline two",ACME,1/1/2026,2/1/2026,ignored\n,,,\n';
  assert.deepEqual(parseBundleList(csv, "installed"), [
    {
      type: "installed",
      name: "Tax, IT",
      bundleId: "123",
      version: "1.2",
      appId: "com.x",
      abstract: "Line one\nline two",
      createdBy: "ACME",
      createdOn: "1/1/2026",
      lastUpdate: "2/1/2026",
    },
  ]);
  assert.deepEqual(parseBundleList("Nothing here\n", "created"), []);
});

test("bundle components carry category, subcategory, referencedBy and isLocked", () => {
  const csv = [
    "Name,ID,Referenced By,Locked",
    "Custom Objects,,,",
    "Scripts,,,",
    "My UE,customscript_ue,,T",
    "My MR,customscript_mr,Bundle 5,",
    "Records,,,",
    "Rec,customrecord_x,,",
  ].join("\n");
  assert.deepEqual(parseBundleContents(csv), [
    { name: "My UE", id: "customscript_ue", referencedBy: "", isLocked: true, category: "Custom Objects", subCategory: "Scripts" },
    { name: "My MR", id: "customscript_mr", referencedBy: "Bundle 5", isLocked: false, category: "Custom Objects", subCategory: "Scripts" },
    { name: "Rec", id: "customrecord_x", referencedBy: "", isLocked: false, category: "Custom Objects", subCategory: "Records" },
  ]);
});

test("LIMIT is rejected with a ROWNUM hint, but not inside strings, comments or identifiers", () => {
  assert.match(suiteQlLimitHint("SELECT id FROM customer LIMIT 10")!, /ROWNUM/);
  assert.match(suiteQlLimitHint("select id from customer\nlimit 5")!, /ROWNUM/);
  assert.equal(suiteQlLimitHint("SELECT id FROM customer WHERE name = 'LIMIT 10'"), null);
  assert.equal(suiteQlLimitHint("SELECT credit_limit, limit_x FROM customer -- LIMIT 3"), null);
  assert.equal(suiteQlLimitHint("SELECT creditlimit FROM customer WHERE ROWNUM <= 5"), null);
});

test("record search maps transaction types, escapes text and orders newest first without ROWNUM", () => {
  const [sql] = recordSearchQueries("SalesOrder", "O'Brien");
  assert.match(sql!, /FROM transaction WHERE type = 'SalesOrd' AND/);
  assert.match(sql!, /'o''brien'|'O''Brien'/);
  assert.match(sql!, /ORDER BY id DESC$/);
  assert.doesNotMatch(sql!, /ROWNUM/);
  const numeric = recordSearchQueries("customer", "42");
  assert.equal(numeric.length, 6);
  assert(numeric.every((query) => query.includes("id = 42")));
  // One label column per SELECT, so a table missing one column still matches on another.
  assert.equal(numeric[1], "SELECT id, entityid FROM customer WHERE (id = 42 OR INSTR(LOWER(entityid), LOWER('42')) > 0) ORDER BY id DESC");
  assert.equal(recordSearchQueries("customrecord_x").at(-1), "SELECT id FROM customrecord_x ORDER BY id DESC");
});

test("log filtering applies exact times, script type and title, and explains truncation", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    id: i,
    datetime: new Date(Date.UTC(2026, 10, 10, 10, i)).toISOString(),
    scriptType: i % 2 ? "Map/Reduce" : "User Event",
    title: i === 5 ? "Fatal error" : "step",
  }));
  const result = filterLogs(rows, {
    from: "2026-11-10T10:01:00Z",
    to: "2026-11-10T10:05:00Z",
    scriptTypes: ["map/reduce"],
    limit: 2,
  }, 6);
  assert.deepEqual(result.logs.map((row) => row.id), [1, 3]);
  assert.equal(result.matched, 3);
  assert.match(result.note!, /Showing 2 of 3/);
  assert.equal(filterLogs(rows, { title: "fatal", limit: 50 }, 6).logs[0]!.id, 5);
  assert.match(filterLogs(rows, { limit: 50 }, 900).note!, /at least 6.*scanned 6 of 900/);
});

function pdf(content: string, compressed = true) {
  const stream = compressed ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n", "latin1"),
    Buffer.from(`4 0 obj << /Length ${stream.length}${compressed ? " /Filter /FlateDecode" : ""} >> stream\n`, "latin1"),
    stream,
    Buffer.from("\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF", "latin1"),
  ]);
}

test("PDF text comes from Flate-compressed and plain content streams, with page count", () => {
  const text = "BT /F1 12 Tf (Invoice \\(copy\\)) Tj T* [(Tot) -10 (al) -300 (100 EUR)] TJ ET";
  for (const compressed of [true, false]) {
    const result = extractPdfText(pdf(text, compressed));
    assert.equal(result.pageCount, 1);
    assert.equal(result.text, "Invoice (copy)\nTotal 100 EUR");
  }
  assert.deepEqual(extractPdfText(Buffer.from("not a pdf")), { text: "", pageCount: 0 });
});

test("PDF text decodes subset fonts through ToUnicode maps, also from compressed object streams", () => {
  const stream = (n: number, body: string, dict = "") => {
    const data = deflateSync(Buffer.from(body, "latin1"));
    return Buffer.concat([Buffer.from(`${n} 0 obj << /Length ${data.length} /Filter /FlateDecode${dict} >> stream\n`, "latin1"), data, Buffer.from("\nendstream endobj\n", "latin1")]);
  };
  const cmap = "/CIDInit /ProcSet findresource begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0048> <0002> <0069> endbfchar 1 beginbfrange <0003> <0004> <0021> endbfrange endcmap";
  const objStmBody = "5 0 << /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>";
  const file = Buffer.concat([
    Buffer.from("%PDF-1.5\n3 0 obj << /Type /Page /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n", "latin1"),
    stream(4, "BT /F1 12 Tf <00010002> Tj 0 -14 Td <00030004> Tj ET"),
    stream(6, cmap),
    stream(7, objStmBody, ` /Type /ObjStm /N 1 /First 4`),
    Buffer.from("%%EOF", "latin1"),
  ]);
  assert.deepEqual(extractPdfText(file), { text: "Hi\n!\"", pageCount: 1 });
});

test("executor allowlist matches the metadata page reads and rebuilds args from known fields only", () => {
  assert.deepEqual([...EXECUTOR_PAGE_READS], [...NETSUITE_PAGE_READS]);
  assert.deepEqual(pageReadArgs("file-content", { id: 5, sql: "DELETE" }), { id: 5 });
  assert.deepEqual(pageReadArgs("catalog-tables", { anything: 1 }), {});
  for (const [operation, args] of [
    ["file-content", { id: 0 }],
    ["bundles", { bundleType: "X" }],
    ["bundle-contents", { bundleId: "1 OR 1=1" }],
    ["catalog-table", { table: "transaction; DROP" }],
    ["log-search", { from: "x", to: "2026-01-01", levels: [], scriptIds: [], deploymentIds: [] }],
    ["log-search", { from: "2026-01-01", to: "2026-01-02", levels: ["TRACE"], scriptIds: [], deploymentIds: [] }],
    ["save-file", {}],
  ] as const)
    assert.throws(() => pageReadArgs(operation, args), { code: "INVALID_EXECUTOR_REQUEST" });
});

test("executor gateway forwards only sanitized metadata args and still refuses writes", async () => {
  const host = { id: 7, isDestroyed: () => false };
  const seen: any[] = [];
  const gateway = createExecutorGateway({
    hosts: () => [host],
    service: { run: async (_h: unknown, _o: string, operation: string, args: any) => (seen.push({ operation, args }), { ok: true }) },
  });
  const base = { kind: "read", hostId: 7, origin: "https://1-sb1.app.netsuite.com" };
  await gateway({ ...base, operation: "bundles", args: { bundleType: "I", extra: "x" } });
  assert.deepEqual(seen.at(-1), { operation: "bundles", args: { bundleType: "I" } });
  for (const operation of ["save-file", "delete-items", "upload-file", "record-preview"])
    await assert.rejects(gateway({ ...base, operation, args: {} }), { code: "READ_ONLY_EXECUTOR" });
});

function fixture(pages: Record<string, (args: any) => any>, query: (sql: string) => any) {
  const host = { id: 3, isDestroyed: () => false };
  const calls: { operation: string; args: any }[] = [];
  let role = 3;
  const dispatch = createNetSuiteReadService({
    hosts: () => [host],
    instanceId: "metadata",
    service: {
      environments: async () => [{ id: "https://123-sb1.app.netsuite.com" }],
      run: async (_h: unknown, _o: string, operation: string, args: any) => {
        calls.push({ operation, args });
        if (operation === "user") return { account: "123_SB1", id: 5, role };
        if (operation === "query") return query(args.sql);
        // Every page read must pass the real executor validation.
        pageReadArgs(operation, args);
        return pages[operation]!(args);
      },
    },
  });
  return {
    calls,
    bumpRole: () => role++,
    async request(tool: string, args: object = {}) {
      const status = await dispatch({ operation: "status" });
      const targetId = status.environments[0].targetId;
      const inspected = await dispatch({ operation: "status", action: "inspect", targetId });
      return { dispatch, status, base: { operation: "metadata", tool, targetId, identityToken: inspected.identity.identityToken, ...args } };
    },
  };
}

test("metadata tools advertise capabilities and check identity before and after", async () => {
  const f = fixture({ "catalog-tables": () => ({ tables: [{ id: "transaction", label: "Transaction" }, { id: "customer", label: "Customer" }] }) }, () => ({ rows: [] }));
  const { dispatch, status, base } = await f.request("schema", { action: "tables", query: "cust" });
  for (const capability of Object.values(NETSUITE_METADATA_TOOLS)) assert(status.capabilities.includes(capability));
  const answer = await dispatch(base);
  assert.deepEqual(answer.data, { total: 2, matched: 1, tables: [{ id: "customer", label: "Customer" }], note: undefined });
  assert.equal(answer.identity.identityToken, base.identityToken);
  await assert.rejects(dispatch({ ...base, identityToken: "stale" }), { code: "IDENTITY_CHANGED" });
  await assert.rejects(dispatch({ ...base, sql: "SELECT 1" }), { code: "INVALID_METADATA_READ" });
  await assert.rejects(dispatch({ ...base, action: "fields" }), { code: "INVALID_METADATA_READ" });
});

test("field info resolves by script ID and lists custom list options", async () => {
  const sqls: string[] = [];
  const f = fixture({}, (sql) => {
    sqls.push(sql);
    if (sql.includes("FROM customfield"))
      return { rows: [{ internalid: 95, scriptid: "CUSTBODY_X", name: "Approval", fieldtype: "BODY", fieldvaluetype: "List/Record", fieldvaluetyperecord: 12, ismandatory: "T", isshowinlist: "F", isstored: "T", sourcename: "Approval states" }] };
    if (sql.includes("FROM customlist WHERE")) return { rows: [{ internalid: 12, scriptid: "customlist_approval", name: "Approval states" }] };
    if (sql.includes("FROM customlist_approval")) return { rows: [{ id: 1, name: "Pending", isinactive: "F" }, { id: 2, name: "Old", isinactive: "T" }], totalCount: 2 };
    throw Error("unexpected " + sql);
  });
  const { dispatch, base } = await f.request("field-info", { scriptId: "custbody_x" });
  const { data } = await dispatch(base);
  assert.equal(data.label, "Approval");
  assert.equal(data.mandatory, true);
  assert.deepEqual(data.source, { kind: "customlist", id: 12, scriptId: "customlist_approval", name: "Approval states" });
  assert.deepEqual(data.options, [{ value: 1, text: "Pending", inactive: false }, { value: 2, text: "Old", inactive: true }]);
  assert.match(sqls[0]!, /UPPER\(scriptid\) = 'CUSTBODY_X'/);
});

test("find records falls back across name columns and reports label and meta", async () => {
  const f = fixture({}, (sql) => {
    if (/SELECT id, name FROM/.test(sql)) throw Error("Field 'name' for record 'employee' was not found.");
    if (/SELECT id, entityid FROM/.test(sql)) return { rows: [], totalCount: 0 };
    if (/SELECT id, altname FROM/.test(sql)) return { rows: [{ id: 9, altname: "Mario Rossi" }], totalCount: 1 };
    throw Error("unexpected " + sql);
  });
  const { dispatch, base } = await f.request("find-records", { recordType: "employee", query: "rossi" });
  const { data } = await dispatch(base);
  assert.deepEqual(data.records[0], { id: "9", label: "Mario Rossi", meta: "altname: Mario Rossi", raw: { id: 9, altname: "Mario Rossi" } });
  assert.match(data.sql, /altname/);
});

test("file text pages UTF-8 content and turns PDFs into text instead of base64", async () => {
  const f = fixture({
    "file-content": ({ id }) =>
      id === 1
        ? { id: 1, name: "a.js", kind: "text", content: "abcdefghij", filesize: 10 }
        : id === 2
          ? { id: 2, name: "b.pdf", kind: "pdf", base64: pdf("BT (Hello PDF) Tj ET").toString("base64") }
          : { id: 3, name: "c.png", kind: "binary" },
  }, () => ({ rows: [] }));
  const text = await f.request("file-text", { fileId: 1, offset: 2, maxChars: 4 });
  assert.deepEqual(
    (({ content, offset, totalChars, nextOffset }) => ({ content, offset, totalChars, nextOffset }))((await text.dispatch(text.base)).data),
    { content: "cdef", offset: 2, totalChars: 10, nextOffset: 6 },
  );
  const pdfRead = await f.request("file-text", { fileId: 2 });
  const pdfData = (await pdfRead.dispatch(pdfRead.base)).data;
  assert.equal(pdfData.content, "Hello PDF");
  assert.equal(pdfData.pageCount, 1);
  assert.equal(pdfData.base64, undefined);
  const binary = await f.request("file-text", { fileId: 3 });
  assert.equal((await binary.dispatch(binary.base)).data.kind, "binary");
});

test("bundles read both CSV exports; logs default to 7 days and never send script types as levels", async () => {
  const f = fixture({
    bundles: ({ bundleType }) => ({ csv: `Bundles\nName,Bundle ID\nB${bundleType},${bundleType === "I" ? 1 : 2}\n` }),
    "log-search": () => ({
      rows: [{ id: 1, datetime: new Date().toISOString(), level: "ERROR", title: "boom", scriptType: "Suitelet" }],
      totalCount: 1,
    }),
  }, () => ({ rows: [] }));
  const bundles = await f.request("bundles");
  const list = (await bundles.dispatch(bundles.base)).data;
  assert.deepEqual(list.bundles.map((b: any) => [b.type, b.bundleId]), [["installed", "1"], ["created", "2"]]);
  const logs = await f.request("logs", { scriptTypes: ["suitelet"], levels: ["ERROR"] });
  const answer = (await logs.dispatch(logs.base)).data;
  assert.equal(answer.returned, 1);
  const sent = f.calls.find((call) => call.operation === "log-search")!.args;
  assert.deepEqual(sent.levels, ["ERROR"]);
  assert.equal(sent.scriptTypes, undefined);
  const days = (Date.parse(sent.to) - Date.parse(sent.from)) / 86400000;
  assert(Math.abs(days - 7) < 0.01);
});
