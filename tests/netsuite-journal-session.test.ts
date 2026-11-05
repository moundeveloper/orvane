import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, unlink, rmdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { openRequestJournal } from "../electron/netsuite-request-journal.mjs";
import { createNetSuiteSessionTracker } from "../electron/netsuite-session-tracker.mjs";
import { createExecutorGateway } from "../electron/netsuite-broker-protocol.mjs";
import { startNetSuiteBroker } from "../electron/netsuite-broker.mjs";
import { desktopNetSuiteRequest } from "../server/netsuite-client.ts";

async function directory(t: any) {
  const path = await mkdtemp(join(tmpdir(), "orvane-journal-"));
  t.after(async () => {
    for (const name of await readdir(path)) {
      assert.match(
        name,
        /^(desktop\.json|rpc-[a-f\d-]{36}\.sock|requests\.sqlite(?:-wal|-shm)?)$/i,
      );
      await unlink(join(path, name));
    }
    await rmdir(path);
  });
  return path;
}

test("unavailable journal prevents executor dispatch", async (t) => {
  const journal = openRequestJournal(await directory(t), "closed-instance");
  journal.close();
  let dispatched = false;
  await assert.rejects(
    journal.run({ operation: "query", sql: "SELECT 1" }, async () => {
      dispatched = true;
      return {};
    }),
    { code: "JOURNAL_UNAVAILABLE" },
  );
  assert.equal(dispatched, false);
});

test("durable request IDs, pagination and recovery store metadata without SQL, rows, tokens or error bodies", async (t) => {
  const path = await directory(t);
  let journal = openRequestJournal(path, "first-instance", { retention: 3 });
  try {
    const answer = await journal.run(
      {
        operation: "query",
        targetId: "private-target",
        identityToken: "private-token",
        sql: "SELECT 'private-literal' FROM employee",
      },
      async () => ({
        origin: "https://123.app.netsuite.com",
        data: { rows: [{ privateValue: "private-row" }] },
      }),
    );
    assert.match(answer.requestId, /^[a-f\d-]{36}$/i);
    let failedId;
    await assert.rejects(
      journal.run({ operation: "query", sql: "SELECT private" }, async () => {
        throw Object.assign(Error("private-error"), { code: "READ_FAILED" });
      }),
      (error) => {
        failedId = (error as any).requestId;
        return (error as any).code === "READ_FAILED";
      },
    );
    const first = journal.list({ limit: 1 });
    assert.equal(first.requests[0].requestId, failedId);
    assert.equal(first.requests[0].state, "failed");
    const second = journal.list({
      limit: 1,
      beforeSequence: first.nextBeforeSequence,
    });
    assert.equal(second.requests[0].requestId, answer.requestId);
    const filtered = await journal.run({ operation: "read", action: "find-files", filters: { name: "private-filter" } }, async () => ({}));
    assert.equal(journal.list().requests.find((item: any) => item.requestId === filtered.requestId)?.operation, "read.find-files");
    const encoded = JSON.stringify(journal.list());
    for (const secret of [
      "private-target",
      "private-token",
      "private-literal",
      "private-row",
      "private-error",
      "private-filter",
    ])
      assert(!encoded.includes(secret));
    await journal.run({ operation: "status" }, async () => ({}));
    await journal.run({ operation: "status" }, async () => ({}));
    assert(journal.summary().retained <= 3);
    journal.close();
    // An abandoned intent is recovered as interrupted, never executed.
    const db = new Database(join(path, "requests.sqlite"));
    db.prepare(
      "INSERT INTO requests(request_id,instance_id,operation,input_hash,state,started_at) VALUES('abandoned','old','query.select','hash','running','2026-11-05')",
    ).run();
    db.close();
    journal = openRequestJournal(path, "second-instance");
    const record = journal
      .list()
      .requests.find((item: any) => item.requestId === "abandoned");
    assert.equal(record.state, "interrupted");
    assert.equal(record.errorCode, "BROKER_INTERRUPTED");
  } finally {
    journal.close();
  }
  const disk = await readFile(join(path, "requests.sqlite"));
  for (const secret of [
    "private-target",
    "private-token",
    "private-literal",
    "private-row",
    "private-filter",
    "private-error",
  ])
    assert(!disk.includes(Buffer.from(secret)));
});

test("session tracker invalidates observed navigation/crash/close but ignores frames and same-document navigation", () => {
  const tracker = createNetSuiteSessionTracker();
  const host = { id: 7 };
  const guest: any = new EventEmitter();
  guest.getURL = () => "https://123.app.netsuite.com/app/center/card.nl";
  guest.hostWebContents = host;
  tracker.observe(guest);
  assert.equal(tracker.current(host, "https://123.app.netsuite.com"), 1);
  guest.emit("did-start-navigation", {
    isMainFrame: false,
    url: guest.getURL(),
  });
  guest.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: true,
    url: guest.getURL(),
  });
  assert.equal(tracker.current(host, "https://123.app.netsuite.com"), 1);
  guest.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: guest.getURL(),
  });
  assert.equal(tracker.current(host, "https://123.app.netsuite.com"), 2);
  guest.emit("render-process-gone");
  guest.emit("destroyed");
  assert.equal(tracker.current(host, "https://123.app.netsuite.com"), 4);
});

test("private epoch fence rejects stale, missing and mid-read changed generations", async () => {
  const host = { id: 4, isDestroyed: () => false };
  let epoch = 1,
    calls = 0;
  const gateway = createExecutorGateway({
    hosts: () => [host],
    service: {
      sessionEpoch: () => epoch,
      environments: async () => [{ id: "https://123.app.netsuite.com" }],
      run: async () => {
        calls++;
        epoch++;
        return { rows: [] };
      },
    },
  });
  assert.equal(
    (await gateway({ kind: "environments", hostId: 4 }))[0].sessionEpoch,
    1,
  );
  const command = {
    kind: "read",
    hostId: 4,
    origin: "https://123.app.netsuite.com",
    operation: "query",
    args: { sql: "SELECT id FROM employee" },
  };
  await assert.rejects(gateway(command), { code: "SESSION_CHANGED" });
  await assert.rejects(gateway({ ...command, expectedSessionEpoch: 2 }), {
    code: "SESSION_CHANGED",
  });
  assert.equal(calls, 0);
  await assert.rejects(gateway({ ...command, expectedSessionEpoch: 1 }), {
    code: "SESSION_CHANGED",
  });
  assert.equal(calls, 1);
});

test(
  "real broker exposes bounded history, links errors by request ID and rotates targets after an epoch change",
  { timeout: 15000 },
  async (t) => {
    // The existing client resolves <root>/netsuite-broker; use a dedicated named root.
    const root = await mkdtemp(join(tmpdir(), "orvane-journal-root-"));
    const path = join(root, "netsuite-broker");
    const host = { id: 5, isDestroyed: () => false };
    let epoch = 1;
    const broker = await startNetSuiteBroker({
      directory: path,
      hosts: () => [host],
      execPath: process.execPath,
      service: {
        sessionEpoch: () => epoch,
        environments: async () => [
          { id: "https://123.app.netsuite.com", status: "ready" },
        ],
        run: async (_host: unknown, _origin: string, operation: string) =>
          operation === "user"
            ? { account: "123", id: 4, role: 3 }
            : { rows: [{ id: -5 }], pageSize: 100 },
      },
    });
    try {
      const call = (request: object): Promise<any> =>
        desktopNetSuiteRequest(root, request);
      const listed = await call({ operation: "status" });
      assert.equal(listed.batch, 6);
      assert(listed.capabilities.includes("requests.read"));
      assert.match(listed.requestId, /^[a-f\d-]{36}$/i);
      const targetId = listed.environments[0].targetId;
      const inspected = await call({
        operation: "status",
        action: "inspect",
        targetId,
      });
      assert.equal(inspected.identity.sessionEpochSupported, true);
      assert.equal(inspected.identity.sessionEpoch, 1);
      epoch++;
      let failedId;
      await assert.rejects(
        call({
          operation: "query",
          targetId,
          identityToken: inspected.identity.identityToken,
          sql: "SELECT id FROM employee",
        }),
        (error) => {
          failedId = (error as any).requestId;
          return (
            (error as any).code === "SESSION_CHANGED" &&
            typeof failedId === "string"
          );
        },
      );
      const history = await call({
        operation: "status",
        action: "requests",
        limit: 10,
      });
      assert.equal(
        history.requests.find((item: any) => item.requestId === failedId)
          .errorCode,
        "SESSION_CHANGED",
      );
      const fresh = await call({ operation: "status" });
      assert.notEqual(fresh.environments[0].targetId, targetId);
      await assert.rejects(
        call({ operation: "status", action: "inspect", targetId }),
        { code: "TARGET_UNAVAILABLE" },
      );
      await assert.rejects(
        call({ operation: "status", action: "requests", limit: 500 }),
        { code: "INVALID_REQUEST" },
      );
    } finally {
      await broker.close();
      for (const name of await readdir(path)) {
        assert.match(name, /^requests\.sqlite(?:-wal|-shm)?$/);
        await unlink(join(path, name));
      }
      await rmdir(path);
      await rmdir(root);
    }
  },
);

test("queued Electron reads recheck epochs, refresh hidden processing once, and release on mid-acquire invalidation", async () => {
  const handlers: Record<string, Function> = {};
  const host = {
    id: 9,
    isDestroyed: () => false,
    getURL: () => "http://localhost:5173/",
  };
  let epoch = 1,
    refreshes = 0,
    releases = 0,
    executions = 0,
    invalidateOnAcquire = false;
  (globalThis as any).__epochTest = {
    ipcMain: {
      handle: (name: string, fn: Function) => {
        handlers[name] = fn;
      },
    },
    webContents: {},
  };
  const source = (
    await readFile(resolve("electron/netsuite.mjs"), "utf8")
  ).replace(
    'import { ipcMain, webContents } from "electron";',
    "const { ipcMain, webContents } = globalThis.__epochTest;",
  );
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  const service = module.setupNetSuite(
    (url: string) => url === host.getURL(),
    {},
    {
      reload: async () => {
        refreshes++;
        return true;
      },
      acquire: async () => {
        if (invalidateOnAcquire) epoch++;
        return {
          contents: {
            executeJavaScript: async () => {
              executions++;
              return '{"result":{"rows":[]}}';
            },
          },
          release: () => {
            releases++;
          },
        };
      },
    },
    { sessionEpoch: () => epoch },
  );
  const invoke = (expected: number) =>
    service.run(
      host,
      "https://123.app.netsuite.com",
      "query",
      { sql: "SELECT id FROM employee" },
      expected,
    );
  try {
    await invoke(1);
    await invoke(1);
    assert.equal(refreshes, 1);
    assert.equal(executions, 2);
    epoch = 2;
    await assert.rejects(invoke(1), { code: "SESSION_CHANGED" });
    assert.equal(executions, 2);
    invalidateOnAcquire = true;
    await assert.rejects(invoke(2), { code: "SESSION_CHANGED" });
    assert.equal(releases, 3);
    assert.equal(executions, 2);
  } finally {
    delete (globalThis as any).__epochTest;
  }
});
