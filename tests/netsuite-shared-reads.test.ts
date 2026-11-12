import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedNetSuiteReads } from "../electron/netsuite-shared-reads.mjs";
import { createNetSuiteReadService } from "../electron/netsuite-read-service.mjs";
import { mkdtemp, readdir, unlink, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startNetSuiteBroker } from "../electron/netsuite-broker.mjs";
import { desktopNetSuiteRequest } from "../server/netsuite-client.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function deferred() {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const gate = deferred();
  let queries = 0,
    users = 0,
    role = 3,
    epoch = 1;
  let fail = false;
  const host = { id: 1, isDestroyed: () => false };
  const dispatch = createNetSuiteReadService({
    hosts: () => [host],
    instanceId: "sharing-test",
    service: {
      environments: async () => [
        { id: "https://123-sb1.app.netsuite.com", sessionEpoch: epoch },
      ],
      run: async (
        _host: unknown,
        _origin: string,
        operation: string,
        args: any,
        expected: number,
      ) => {
        if (expected !== epoch)
          throw Object.assign(Error("Changed source"), {
            code: "SESSION_CHANGED",
          });
        if (operation === "user") {
          users++;
          return { account: "123_SB1", id: 4, role };
        }
        queries++;
        await gate.promise;
        if (fail)
          throw Object.assign(Error("Fixture failure"), {
            code: "TEST_FAILURE",
          });
        return { rows: [{ id: 1 }], pageSize: 100, offset: args.offset };
      },
    },
  });
  const list = await dispatch({ operation: "status" });
  const targetId = list.environments[0].targetId;
  const inspected = await dispatch({
    operation: "status",
    action: "inspect",
    targetId,
  });
  const request = {
    operation: "query",
    targetId,
    identityToken: inspected.identity.identityToken,
    sql: "SELECT id FROM employee ORDER BY id",
    shareInFlight: true,
  };
  return {
    dispatch,
    request,
    gate,
    counts: () => ({ queries, users }),
    setRole: (value: number) => {
      role = value;
    },
    setEpoch: (value: number) => {
      epoch = value;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

test("five opted-in concurrent SELECTs execute once, isolate results and never reuse a completed observation", async () => {
  const f = await fixture();
  const reads = Array.from({ length: 5 }, () => f.dispatch(f.request));
  f.gate.resolve();
  const answers = await Promise.all(reads);
  assert.equal(f.counts().queries, 1);
  assert.equal(f.counts().users, 3); // inspect, shared before and shared after
  assert.equal(new Set(answers.map((a) => a.readSharing.executionId)).size, 1);
  assert.equal(answers.filter((a) => a.readSharing.joined).length, 4);
  assert(
    answers.every(
      (a) => a.readSharing.participants === 5 && !a.readSharing.cacheHit,
    ),
  );
  answers[0].data.rows[0].id = 999;
  assert.equal(answers[1].data.rows[0].id, 1);
  const fresh = await f.dispatch(f.request);
  assert.equal(f.counts().queries, 2);
  assert.notEqual(
    fresh.readSharing.executionId,
    answers[0].readSharing.executionId,
  );
});

test("independent default reads, different SQL/offset and invalid identities never join a shared read", async () => {
  const f = await fixture();
  const pending = [
    f.dispatch(f.request),
    f.dispatch({ ...f.request, shareInFlight: false }),
    f.dispatch({ ...f.request, shareInFlight: undefined }),
    f.dispatch({ ...f.request, offset: 100 }),
    f.dispatch({ ...f.request, sql: "SELECT id FROM customer" }),
  ];
  await assert.rejects(f.dispatch({ ...f.request, identityToken: "wrong" }), {
    code: "IDENTITY_CHANGED",
  });
  await assert.rejects(f.dispatch({ ...f.request, shareInFlight: "yes" }), {
    code: "INVALID_QUERY",
  });
  f.gate.resolve();
  const results = await Promise.all(pending);
  assert.equal(f.counts().queries, 5);
  assert.equal(results[1].readSharing, undefined);
  assert.equal(results[2].readSharing, undefined);
});

test("changed reported identity discards all shared results; failures are separate objects and never cached", async () => {
  const f = await fixture();
  const reads = [f.dispatch(f.request), f.dispatch(f.request)];
  // Advance through the before-identity await and into the deferred query.
  await new Promise((done) => setImmediate(done));
  f.setRole(7);
  f.gate.resolve();
  const failed = await Promise.allSettled(reads);
  assert(
    failed.every(
      (item) =>
        item.status === "rejected" && item.reason.code === "IDENTITY_CHANGED",
    ),
  );
  const errors = failed.map((item) => (item as PromiseRejectedResult).reason);
  assert.notEqual(errors[0], errors[1]);
  errors[0].requestId = "one-caller";
  assert.equal(errors[1].requestId, undefined);
  f.setRole(3);
  await f.dispatch(f.request);
  assert.equal(f.counts().queries, 2);
  f.setFail(true);
  await assert.rejects(f.dispatch(f.request), { code: "TEST_FAILURE" });
  f.setFail(false);
  await f.dispatch(f.request);
  assert.equal(f.counts().queries, 4);
});

test("old source generations cannot reuse a pending shared read after target rotation", async () => {
  const f = await fixture();
  const oldRead = f.dispatch(f.request);
  await new Promise((done) => setImmediate(done));
  f.setEpoch(2);
  const listed = await f.dispatch({ operation: "status" });
  const targetId = listed.environments[0].targetId;
  assert.notEqual(targetId, f.request.targetId);
  await assert.rejects(f.dispatch(f.request), { code: "TARGET_UNAVAILABLE" });
  const inspected = await f.dispatch({
    operation: "status",
    action: "inspect",
    targetId,
  });
  const current = f.dispatch({
    ...f.request,
    targetId,
    identityToken: inspected.identity.identityToken,
  });
  f.gate.resolve();
  await assert.rejects(oldRead, { code: "SESSION_CHANGED" });
  const answer = await current;
  assert.equal(answer.identity.sessionEpoch, 2);
  assert.equal(answer.readSharing.joined, false);
  assert.equal(f.counts().queries, 2);
});

test("sharing groups are bounded, participants are bounded, and different targets/tokens remain isolated", async () => {
  const share = createSharedNetSuiteReads({ maxGroups: 2, maxParticipants: 2 });
  const gate = deferred();
  let runs = 0;
  const run = async () => {
    runs++;
    await gate.promise;
    return { data: {} };
  };
  const first = share(["target-a", "token-a"], run);
  const joined = share(["target-a", "token-a"], run);
  await assert.rejects(share(["target-a", "token-a"], run), {
    code: "READ_SHARING_BUSY",
  });
  const other = share(["target-b", "token-a"], run);
  await assert.rejects(share(["target-a", "token-b"], run), {
    code: "READ_SHARING_BUSY",
  });
  gate.resolve();
  await Promise.all([first, joined, other]);
  assert.equal(runs, 2);
  const fresh = await share(["target-a", "token-b"], run);
  assert.equal(fresh.readSharing.joined, false);
  assert.equal(runs, 3);
});

test(
  "disconnecting one actual MCP caller preserves a joined read and distinct durable outcomes, including shared failures",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "orvane-shared-worker-"));
    const directory = join(root, "netsuite-broker");
    const host = { id: 5, isDestroyed: () => false };
    let gate = deferred(),
      queries = 0,
      fail = false;
    const broker = await startNetSuiteBroker({
      directory,
      hosts: () => [host],
      execPath: process.execPath,
      service: {
        environments: async () => [{ id: "https://123-sb1.app.netsuite.com" }],
        run: async (_host: unknown, _origin: string, operation: string) => {
          if (operation === "user")
            return { account: "123_SB1", id: 5, role: 3 };
          queries++;
          await gate.promise;
          if (fail)
            throw Object.assign(Error("Shared executor failure"), {
              code: "TEST_FAILURE",
            });
          return { rows: [{ id: 1 }], pageSize: 100 };
        },
      },
    });
    const connections: { client: Client; transport: StdioClientTransport }[] =
      [];
    const call = (request: object): Promise<any> =>
      desktopNetSuiteRequest(root, request);
    const waitForParticipants = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const status = await call({ operation: "status", action: "list" });
        if (status.readSharingBudget.activeParticipants === count) return;
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.fail(
        "Shared participants did not arrive within the fixture deadline",
      );
    };
    try {
      for (let i = 0; i < 2; i++) {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [resolve("server/launch.mjs")],
          env: {
            ...(process.env as Record<string, string>),
            ORVANE_MCP_PROFILE: "netsuite",
            ORVANE_DATA_DIR: root,
          },
          stderr: "pipe",
        });
        transport.stderr?.resume();
        const client = new Client({ name: `shared-${i}`, version: "1.0.0" });
        connections.push({ client, transport });
        await client.connect(transport);
      }
      const listed = await call({ operation: "status" });
      const targetId = listed.environments[0].targetId;
      const inspected = await call({
        operation: "status",
        action: "inspect",
        targetId,
      });
      const args = {
        targetId,
        identityToken: inspected.identity.identityToken,
        sql: "SELECT id FROM employee ORDER BY id",
        shareInFlight: true,
      };
      const abandoned = connections[0].client
        .callTool({ name: "orvane_netsuite_query", arguments: args })
        .then(
          () => "finished",
          () => "disconnected",
        );
      const survivor = connections[1].client.callTool({
        name: "orvane_netsuite_query",
        arguments: args,
      });
      await waitForParticipants(2);
      await connections[0].client.close();
      await connections[0].transport.close();
      assert.equal(await abandoned, "disconnected");
      gate.resolve();
      const answer = (await survivor).structuredContent?.result as any;
      assert.equal(answer.readSharing.participants, 2);
      assert.equal(queries, 1);
      let history = await call({
        operation: "status",
        action: "requests",
        limit: 100,
      });
      const completed = history.requests.filter(
        (item: any) => item.operation === "query.select",
      );
      assert.equal(completed.length, 2);
      assert(completed.every((item: any) => item.state === "completed"));
      assert.equal(
        new Set(completed.map((item: any) => item.requestId)).size,
        2,
      );
      assert(
        completed.some((item: any) => item.requestId === answer.requestId),
      );

      gate = deferred();
      fail = true;
      const failures = [
        call({ operation: "query", ...args }),
        call({ operation: "query", ...args }),
      ];
      const settled = Promise.allSettled(failures);
      await waitForParticipants(2);
      gate.resolve();
      const outcomes = await settled;
      assert(
        outcomes.every(
          (item) =>
            item.status === "rejected" && item.reason.code === "TEST_FAILURE",
        ),
      );
      const ids = outcomes.map(
        (item) => (item as PromiseRejectedResult).reason.requestId,
      );
      assert.equal(new Set(ids).size, 2);
      history = await call({
        operation: "status",
        action: "requests",
        limit: 100,
      });
      assert(
        ids.every((id) =>
          history.requests.some(
            (item: any) =>
              item.requestId === id &&
              item.state === "failed" &&
              item.errorCode === "TEST_FAILURE",
          ),
        ),
      );
      assert.equal(queries, 2);
      assert.equal(
        (await call({ operation: "status" })).readSharingBudget.activeGroups,
        0,
      );
    } finally {
      gate.resolve();
      for (const { client, transport } of connections) {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
      await broker.close();
      for (const name of await readdir(directory)) {
        assert.match(
          name,
          /^(desktop\.json|rpc-[a-f\d-]{36}\.sock|requests\.sqlite(?:-wal|-shm)?)$/i,
        );
        await unlink(join(directory, name));
      }
      await rmdir(directory);
      await rmdir(root);
    }
  },
);
