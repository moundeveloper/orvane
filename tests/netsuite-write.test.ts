import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NETSUITE_EXECUTOR_WRITES,
  NETSUITE_WRITE_TOOLS,
  parseNetSuiteWrite,
  shapeScriptResult,
} from "../server/netsuite-write-operations.ts";
import { createNetSuiteReadService } from "../electron/netsuite-read-service.mjs";
import {
  EXECUTOR_WRITES,
  createExecutorGateway,
  writeArgs,
} from "../electron/netsuite-broker-protocol.mjs";

test("executor write list matches the server and write args are rebuilt from known fields", () => {
  assert.deepEqual([...EXECUTOR_WRITES], [...NETSUITE_EXECUTOR_WRITES]);
  assert.deepEqual(writeArgs("run-script", { code: "return 1", timeoutMs: 5000, extra: 1 }), { code: "return 1", timeoutMs: 5000 });
  assert.deepEqual(writeArgs("save-file", { id: 4, content: "x" }), { id: 4, content: "x" });
  for (const [operation, args] of [
    ["run-script", { code: " ", timeoutMs: 5000 }],
    ["run-script", { code: "x", timeoutMs: 120000 }],
    ["upload-file", { folderId: 1, name: "a/b.js", base64: "", overwrite: false }],
    ["upload-file", { folderId: 1, name: "a.js", base64: "not base64!", overwrite: false }],
    ["upload-file", { folderId: 1, name: "a.js", base64: "", overwrite: "yes" }],
    ["delete-items", { folderId: 1, fileIds: [], folderIds: [] }],
    ["rename-item", {}],
  ] as const)
    assert.throws(() => writeArgs(operation, args), { code: "INVALID_EXECUTOR_REQUEST" });
});

test("a read command can never run a write; a write command can", async () => {
  const host = { id: 7, isDestroyed: () => false };
  const seen: any[] = [];
  const gateway = createExecutorGateway({
    hosts: () => [host],
    service: { run: async (_h: unknown, _o: string, operation: string, args: any) => (seen.push({ operation, args }), { ok: true }) },
  });
  const base = { hostId: 7, origin: "https://1-sb1.app.netsuite.com" };
  for (const operation of NETSUITE_EXECUTOR_WRITES)
    await assert.rejects(gateway({ ...base, kind: "read", operation, args: {} }), { code: "READ_ONLY_EXECUTOR" });
  await assert.rejects(gateway({ ...base, kind: "write", operation: "query", args: { sql: "SELECT 1" } }), { code: "READ_ONLY_EXECUTOR" });
  await gateway({ ...base, kind: "write", operation: "run-script", args: { code: "return 1", timeoutMs: 2000, sql: "x" } });
  assert.deepEqual(seen.at(-1), { operation: "run-script", args: { code: "return 1", timeoutMs: 2000 } });
});

test("script results and logs are capped, with hints for common mistakes", () => {
  const big = shapeScriptResult({ ok: true, result: "x".repeat(3000), logs: [{ level: "log", text: "hi" }] }, 1000);
  assert.equal(big.result, null);
  assert.equal((big.resultPreview as string).length, 1000);
  assert.match(big.note as string, /3002 characters/);
  assert.deepEqual(big.logs, [{ level: "log", text: "hi" }]);
  const failed = shapeScriptResult({ ok: false, error: { name: "SyntaxError", message: "await is only valid in async functions", line: 3 }, logs: [] }, 1000);
  assert.match(failed.hint as string, /for\.\.\.of/);
  const many = shapeScriptResult({ ok: true, result: 1, logs: Array.from({ length: 50 }, () => ({ level: "log", text: "y".repeat(1000) })) }, 1000);
  assert.equal((many.logs as unknown[]).length, 20);
  assert.equal(many.logsTruncated, 30);
});

test("file-write validation", () => {
  const base = { operation: "write", tool: "file-write", targetId: "t", identityToken: "i" };
  assert.throws(() => parseNetSuiteWrite({ ...base, action: "upload", folderId: 5, name: "a.js" }), { code: "INVALID_WRITE" });
  assert.throws(() => parseNetSuiteWrite({ ...base, action: "upload", folderId: 5, name: "a.js", content: "x", base64: "eA==" }), { code: "INVALID_WRITE" });
  assert.throws(() => parseNetSuiteWrite({ ...base, action: "upload", folderId: 5, content: "x", localPath: "C:/a.js" }), { code: "INVALID_WRITE" });
  assert.throws(() => parseNetSuiteWrite({ ...base, action: "delete" }), { code: "INVALID_WRITE" });
  assert.throws(() => parseNetSuiteWrite({ ...base, action: "upload", folderId: 0, name: "a", content: "x" }), { code: "INVALID_WRITE" });
  assert.equal(parseNetSuiteWrite({ ...base, action: "upload", folderId: 5, name: "a.js", content: "x" }).args.overwrite, false);
});

function fixture() {
  const host = { id: 3, isDestroyed: () => false };
  const writes: { operation: string; args: any }[] = [];
  let role = 3;
  const dispatch = createNetSuiteReadService({
    hosts: () => [host],
    instanceId: "writes",
    service: {
      environments: async () => [{ id: "https://123-sb1.app.netsuite.com" }],
      run: async (_h: unknown, _o: string, operation: string, args: any) => {
        if (operation === "user") return { account: "123_SB1", id: 5, role };
        if (/FROM file WHERE id IN/.test(args.sql)) return { rows: [{ id: 11, folder: 40 }, { id: 12, folder: 41 }] };
        if (/FROM MediaItemFolder WHERE id IN/.test(args.sql)) return { rows: [{ id: 50, parent: 40 }] };
        return { rows: [] };
      },
      write: async (_h: unknown, _o: string, operation: string, args: any) => {
        writes.push({ operation, args });
        if (operation === "run-script") return { ok: true, result: { n: 1 }, logs: [{ level: "debug", text: "t d" }] };
        if (operation === "delete-items") return { deleted: args.fileIds.length + args.folderIds.length, remaining: [], errors: [] };
        if (operation === "upload-file") return { id: 99, name: args.name, created: true, verified: true };
        return { id: 1 };
      },
    },
  });
  return {
    writes,
    bumpRole: () => role++,
    async request(tool: string, args: object) {
      const status = await dispatch({ operation: "status" });
      const targetId = status.environments[0].targetId;
      const inspected = await dispatch({ operation: "status", action: "inspect", targetId });
      return { dispatch, status, base: { operation: "write", tool, targetId, identityToken: inspected.identity.identityToken, ...args } };
    },
  };
}

test("writes advertise capabilities, run scripts with the requested timeout and convert text uploads", async () => {
  const f = fixture();
  const script = await f.request("run-suitescript", { code: "return { n: 1 }", timeoutSeconds: 12 });
  assert(script.status.capabilities.includes(NETSUITE_WRITE_TOOLS["run-suitescript"]));
  assert(script.status.capabilities.includes(NETSUITE_WRITE_TOOLS["file-write"]));
  // Task runs need the run tracker, which this fixture does not provide.
  assert(!script.status.capabilities.includes(NETSUITE_WRITE_TOOLS.task));
  assert.equal(script.status.readOnly, false);
  const ran = await script.dispatch(script.base);
  assert.deepEqual(ran.data, { ok: true, result: { n: 1 }, logs: [{ level: "debug", text: "t d" }] });
  assert.deepEqual(f.writes[0], { operation: "run-script", args: { code: "return { n: 1 }", timeoutMs: 12000 } });
  const upload = await f.request("file-write", { action: "upload", folderId: 3847, name: "a.txt", content: "héllo", overwrite: true });
  assert.equal((await upload.dispatch(upload.base)).data.id, 99);
  assert.deepEqual(f.writes[1], { operation: "upload-file", args: { folderId: 3847, name: "a.txt", base64: Buffer.from("héllo").toString("base64"), overwrite: true } });
});

test("delete groups items by parent folder and reports unknown IDs", async () => {
  const f = fixture();
  const del = await f.request("file-write", { action: "delete", fileIds: [11, 12, 13], folderIds: [50] });
  const { data } = await del.dispatch(del.base);
  assert.deepEqual(f.writes.map((w) => w.args), [
    { folderId: 40, fileIds: [11], folderIds: [50] },
    { folderId: 41, fileIds: [12], folderIds: [] },
  ]);
  assert.deepEqual(data, { deleted: 3, remaining: [], errors: [], notFound: ["File 13"] });
});

test("a stale identity writes nothing", async () => {
  const f = fixture();
  const script = await f.request("run-suitescript", { code: "return 1" });
  await assert.rejects(script.dispatch({ ...script.base, identityToken: "stale" }), { code: "IDENTITY_CHANGED" });
  f.bumpRole();
  await assert.rejects(script.dispatch(script.base), { code: "IDENTITY_CHANGED" });
  assert.equal(f.writes.length, 0);
});
