import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileNetSuiteRead,
  netSuiteReadOperations,
} from "../server/netsuite-read-operations.ts";
import { createNetSuiteReadService } from "../electron/netsuite-read-service.mjs";

const base = {
  operation: "read",
  targetId: "target",
  identityToken: "identity",
};

test("typed policies compile fixed SELECTs, deterministic pages and valid negative system folders", () => {
  for (const [action, policy] of Object.entries(netSuiteReadOperations)) {
    const read = compileNetSuiteRead({
      ...base,
      action,
      ...(action === "deployments"
        ? { id: 42 }
        : action === "files"
          ? { id: -15 }
          : {}),
      page: 2,
    });
    assert.equal(read.policy.capability, policy.capability);
    assert.equal(read.policy.effect, "read");
    assert.equal(read.policy.cache, "none");
    assert.equal(read.policy.retry, "neverAutomatic");
    assert.equal(read.offset, 200);
    assert.match(read.sql, /^SELECT /);
    assert(!read.sql.includes(";"));
    assert.match(read.sql, /ORDER BY .+, .+$/);
  }
  assert.match(
    compileNetSuiteRead({ ...base, action: "folders" }).sql,
    /IsTopLevel = 'T'/,
  );
  assert.match(
    compileNetSuiteRead({ ...base, action: "folders", id: -15 }).sql,
    /parent = -15/,
  );
  assert.match(
    compileNetSuiteRead({ ...base, action: "files", id: -15 }).sql,
    /folder = -15/,
  );
});

test("unknown fields, injected IDs, invalid action-specific IDs and out-of-range pages are rejected before execution", () => {
  for (const input of [
    { action: "scripts", sql: "DELETE FROM file" },
    { action: "scripts", effect: "write" },
    { action: "scripts", offset: 100 },
    { action: "scripts", id: 1 },
    { action: "deployments" },
    { action: "deployments", id: -1 },
    { action: "files" },
    { action: "files", id: 0 },
    { action: "files", id: "1 OR 1=1" },
    { action: "files", id: 1.5 },
    { action: "folders", id: Number.MAX_SAFE_INTEGER + 1 },
    { action: "folders", page: -1 },
    { action: "folders", page: 10001 },
    { action: "folders", page: 1.2 },
    { action: "folders", page: "1" },
    { action: "files", id: 1, shareInFlight: "true" },
    { action: "delete-files" },
    { action: "__proto__" },
  ])
    assert.throws(() => compileNetSuiteRead({ ...base, ...input }), {
      code: "INVALID_READ",
    });
});

async function fixture() {
  const host = { id: 2, isDestroyed: () => false };
  const calls: { operation: string; args: any }[] = [];
  let role = 3,
    changeRole = false,
    oversized = false;
  const dispatch = createNetSuiteReadService({
    hosts: () => [host],
    instanceId: "typed-reads",
    service: {
      environments: async () => [{ id: "https://123-sb1.app.netsuite.com" }],
      run: async (
        _host: unknown,
        _origin: string,
        operation: string,
        args: any,
      ) => {
        calls.push({ operation, args });
        if (operation === "user") return { account: "123_SB1", id: 5, role };
        if (changeRole) role++;
        return {
          rows: Array.from({ length: oversized ? 101 : 1 }, (_, i) => ({
            id: args.offset + i + 1,
          })),
          pageSize: 100,
          offset: args.offset,
        };
      },
    },
  });
  const status = await dispatch({ operation: "status" });
  const targetId = status.environments[0].targetId;
  const inspected = await dispatch({
    operation: "status",
    action: "inspect",
    targetId,
  });
  return {
    dispatch,
    calls,
    status,
    request: {
      ...base,
      targetId,
      identityToken: inspected.identity.identityToken,
    },
    changeRole: () => {
      changeRole = true;
    },
    oversized: () => {
      oversized = true;
    },
  };
}

test("all typed actions use the existing query executor and keep explicit identity and page metadata", async () => {
  const f = await fixture();
  for (const action of Object.keys(netSuiteReadOperations)) {
    const request = {
      ...f.request,
      action,
      ...(action === "deployments"
        ? { id: 42 }
        : action === "files"
          ? { id: -15 }
          : {}),
    };
    const first = await f.dispatch(request);
    const second = await f.dispatch({ ...request, page: 1 });
    assert.equal(first.read.action, action);
    assert.equal(first.read.page, 0);
    assert.equal(second.read.page, 1);
    assert.equal(second.read.pagination, "live-offset");
    assert.equal(first.data.rows[0].id, 1);
    assert.equal(second.data.rows[0].id, 101);
    assert.equal(first.identity.identityToken, f.request.identityToken);
    assert.equal(first.identity.serverRuntimeVerified, false);
  }
  assert.equal(f.calls.filter((call) => call.operation === "query").length, 8);
  assert(f.calls.every((call) => ["user", "query"].includes(call.operation)));
  for (const policy of Object.values(netSuiteReadOperations))
    assert(f.status.capabilities.includes(policy.capability));
});

test("typed reads reject missing/stale identity, unsafe arguments, changed runtime identity and oversized pages", async () => {
  const f = await fixture();
  const request = { ...f.request, action: "scripts" };
  const before = f.calls.length;
  await assert.rejects(f.dispatch({ ...request, sql: "SELECT * FROM file" }), {
    code: "INVALID_READ",
  });
  assert.equal(f.calls.length, before);
  await assert.rejects(f.dispatch({ ...request, identityToken: "wrong" }), {
    code: "IDENTITY_CHANGED",
  });
  assert.equal(f.calls.filter((call) => call.operation === "query").length, 0);
  f.changeRole();
  await assert.rejects(f.dispatch(request), { code: "IDENTITY_CHANGED" });
  const large = await fixture();
  large.oversized();
  await assert.rejects(
    large.dispatch({ ...large.request, action: "scripts" }),
    { code: "INVALID_QUERY_RESULT" },
  );
});

test("typed and raw opted-in reads may share an identical execution without leaking their descriptors", async () => {
  const f = await fixture();
  const typedRequest = {
    ...f.request,
    action: "files",
    id: -15,
    shareInFlight: true,
  };
  const compiled = compileNetSuiteRead(typedRequest);
  const typed = f.dispatch(typedRequest);
  const raw = f.dispatch({
    operation: "query",
    targetId: f.request.targetId,
    identityToken: f.request.identityToken,
    sql: compiled.sql,
    offset: compiled.offset,
    shareInFlight: true,
  });
  const answers = await Promise.all([typed, raw]);
  assert.equal(f.calls.filter((call) => call.operation === "query").length, 1);
  assert.equal(answers[0].read.action, "files");
  assert.equal(answers[1].read, undefined);
  assert.equal(
    answers[0].readSharing.executionId,
    answers[1].readSharing.executionId,
  );
});
