import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  unlink,
  rmdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startNetSuiteBroker } from "../electron/netsuite-broker.mjs";
import { createExecutorGateway } from "../electron/netsuite-broker-protocol.mjs";
import { desktopNetSuiteRequest } from "../server/netsuite-client.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function workspace(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "orvane-broker-"));
  const brokerDirectory = join(directory, "netsuite-broker");
  await mkdir(brokerDirectory);
  t.after(async () => {
    // Dedicated fixture directory: only remove known descriptor/socket files, never recurse.
    for (const name of await readdir(brokerDirectory)) {
      assert.match(name, /^(desktop\.json|rpc-[a-f\d-]{36}\.sock)$/i);
      await unlink(join(brokerDirectory, name));
    }
    await rmdir(brokerDirectory);
    await rmdir(directory);
  });
  return { directory, brokerDirectory };
}
function fixtureService() {
  const host = { id: 8, isDestroyed: () => false };
  const calls: string[] = [];
  return {
    host,
    calls,
    service: {
      environments: async () => [
        {
          id: "https://123-sb1.app.netsuite.com",
          status: "ready",
          label: "Test sandbox",
        },
      ],
      run: async (_host: unknown, _origin: string, op: string, args: any) => {
        calls.push(op);
        if (op === "user") return { account: "123_SB1", id: 5, role: 3 };
        assert.equal(op, "query");
        return {
          rows: [{ sql: args.sql }],
          offset: args.offset,
          pageSize: 100,
        };
      },
    },
  };
}
const request = (directory: string, value: object): Promise<any> =>
  desktopNetSuiteRequest(directory, value);
test(
  "worker owns RPC/identity state, keeps explicit targets and serves two MCP clients",
  { timeout: 20000 },
  async (t) => {
    const { directory, brokerDirectory } = await workspace(t);
    const fixture = fixtureService();
    const broker = await startNetSuiteBroker({
      directory: brokerDirectory,
      hosts: () => [fixture.host],
      service: fixture.service,
      execPath: process.execPath,
    });
    try {
      assert.notEqual(broker.pid, process.pid);
      const descriptor = JSON.parse(
        await readFile(join(brokerDirectory, "desktop.json"), "utf8"),
      );
      assert.equal(descriptor.pid, broker.pid);
      assert.equal(descriptor.desktopPid, process.pid);
      const listed = await request(directory, { operation: "status" });
      assert.equal(listed.batch, 2);
      assert.deepEqual(listed.execution, {
        mode: "broker-worker",
        brokerPid: broker.pid,
        desktopPid: process.pid,
        protocol: 1,
      });
      const targetId = listed.environments[0].targetId;
      const inspected = await request(directory, {
        operation: "status",
        action: "inspect",
        targetId,
      });
      const sql =
        "SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1";
      const answer = await request(directory, {
        operation: "query",
        targetId,
        identityToken: inspected.identity.identityToken,
        sql,
      });
      assert.equal(answer.data.rows[0].sql, sql);
      const clients: { client: Client; transport: StdioClientTransport }[] = [];
      try {
        for (let i = 0; i < 2; i++) {
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [resolve("server/launch.mjs")],
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  (item): item is [string, string] => item[1] !== undefined,
                ),
              ),
              ORVANE_DATA_DIR: directory,
              ORVANE_MCP_PROFILE: "netsuite",
            },
            stderr: "pipe",
          });
          transport.stderr?.resume();
          const client = new Client({
            name: `worker-client-${i}`,
            version: "1.0.0",
          });
          clients.push({ client, transport });
          await client.connect(transport);
        }
        const results = await Promise.all(
          clients.map(({ client }) =>
            client.callTool({ name: "orvane_netsuite_status", arguments: {} }),
          ),
        );
        for (const result of results)
          assert.equal(
            (result.structuredContent as any).result.execution.brokerPid,
            broker.pid,
          );
      } finally {
        for (const { client, transport } of clients) {
          await client.close();
          await transport.close();
        }
      }
    } finally {
      await broker.close();
    }
    await assert.rejects(readFile(join(brokerDirectory, "desktop.json")), {
      code: "ENOENT",
    });
  },
);

test("Electron private gateway rejects writes, non-owned windows and invalid SELECT before service dispatch", async () => {
  const fixture = fixtureService();
  const gateway = createExecutorGateway({
    hosts: () => [fixture.host],
    service: fixture.service,
  });
  const base = {
    kind: "read",
    hostId: 8,
    origin: "https://123-sb1.app.netsuite.com",
    operation: "query",
    args: { sql: "SELECT id FROM employee" },
  };
  await assert.rejects(gateway({ ...base, operation: "save-file" }), {
    code: "READ_ONLY_EXECUTOR",
  });
  await assert.rejects(gateway({ ...base, hostId: 55 }), {
    code: "TARGET_UNAVAILABLE",
  });
  await assert.rejects(gateway({ ...base, origin: "https://evil.example" }), {
    code: "INVALID_EXECUTOR_REQUEST",
  });
  await assert.rejects(
    gateway({ ...base, args: { sql: "DELETE FROM employee" } }),
    { code: "INVALID_QUERY" },
  );
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(await gateway({ kind: "hosts" }), [{ id: 8 }]);
});

test(
  "worker crash disconnects an in-flight read without replay and a fresh worker invalidates old targets",
  { timeout: 15000 },
  async (t) => {
    const { directory, brokerDirectory } = await workspace(t);
    const fixture = fixtureService();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = fixture.service.run;
    fixture.service.run = async (...args) => {
      if (args[2] === "query") {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(...args);
    };
    const broker = await startNetSuiteBroker({
      directory: brokerDirectory,
      hosts: () => [fixture.host],
      service: fixture.service,
      execPath: process.execPath,
    });
    let fresh;
    try {
      const listed = await request(directory, { operation: "status" });
      const targetId = listed.environments[0].targetId;
      const inspected = await request(directory, {
        operation: "status",
        action: "inspect",
        targetId,
      });
      const reading = request(directory, {
        operation: "query",
        targetId,
        identityToken: inspected.identity.identityToken,
        sql: "SELECT id FROM employee",
      });
      const rejected = assert.rejects(reading, (error) =>
        ["DESKTOP_DISCONNECTED", "DESKTOP_UNAVAILABLE"].includes(
          (error as any).code,
        ),
      );
      await entered;
      process.kill(broker.pid!, "SIGKILL");
      await broker.exited;
      await rejected;
      release();
      await request(directory, { operation: "status" }).then(
        () => assert.fail("No main-process fallback is allowed"),
        (error) => assert.equal(error.code, "DESKTOP_UNAVAILABLE"),
      );
      fresh = await startNetSuiteBroker({
        directory: brokerDirectory,
        hosts: () => [fixture.host],
        service: fixture.service,
        execPath: process.execPath,
      });
      const again = await request(directory, { operation: "status" });
      assert.notEqual(again.environments[0].targetId, targetId);
      await assert.rejects(
        request(directory, {
          operation: "status",
          action: "inspect",
          targetId,
        }),
        { code: "TARGET_UNAVAILABLE" },
      );
      assert.equal(fixture.calls.filter((call) => call === "query").length, 1);
    } finally {
      release();
      await broker.close();
      await fresh?.close();
    }
  },
);

test(
  "Desktop termination does not orphan its worker and stale discovery is reclaimed",
  { timeout: 15000 },
  async (t) => {
    const { directory, brokerDirectory } = await workspace(t);
    const parent = fork(
      resolve("tests/fixtures/netsuite-broker-parent.mjs"),
      [brokerDirectory],
      {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    parent.stderr?.resume();
    const exited = new Promise<void>((resolve) =>
      parent.once("exit", () => resolve()),
    );
    try {
      const brokerPid = await new Promise<number>((resolve, reject) => {
        parent.once("message", (value: any) => resolve(value.brokerPid));
        parent.once("error", reject);
        parent.once("exit", () =>
          reject(Error("Fixture parent exited before broker startup")),
        );
      });
      assert.equal(
        (await request(directory, { operation: "status" })).execution.brokerPid,
        brokerPid,
      );
      parent.kill("SIGKILL");
      await exited;
      const deadline = Date.now() + 5000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(brokerPid, 0);
        } catch {
          alive = false;
        }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(
        alive,
        false,
        "Worker must not outlive its private Desktop parent channel",
      );
      await assert.rejects(request(directory, { operation: "status" }), {
        code: "DESKTOP_UNAVAILABLE",
      });
      // A hard OS termination may prevent cleanup; never mistake a stale file for a live broker.
      const fresh = await startNetSuiteBroker({
        directory: brokerDirectory,
        hosts: () => [],
        service: {},
        execPath: process.execPath,
      });
      try {
        assert.equal(
          (await request(directory, { operation: "status" })).execution
            .brokerPid,
          fresh.pid,
        );
      } finally {
        await fresh.close();
      }
      await assert.rejects(readFile(join(brokerDirectory, "desktop.json")), {
        code: "ENOENT",
      });
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill("SIGKILL");
        await exited;
      }
    }
  },
);

test(
  "missing Node executable rejects startup without leaving a worker or listener",
  { timeout: 5000 },
  async (t) => {
    const { brokerDirectory } = await workspace(t);
    await assert.rejects(
      startNetSuiteBroker({
        directory: brokerDirectory,
        hosts: () => [],
        service: {},
        execPath: join(tmpdir(), "orvane-nonexistent-node.exe"),
      }),
      { code: "ENOENT" },
    );
    await assert.rejects(readFile(join(brokerDirectory, "desktop.json")), {
      code: "ENOENT",
    });
  },
);

test(
  "a second worker cannot replace an active profile owner",
  { timeout: 10000 },
  async (t) => {
    const { directory, brokerDirectory } = await workspace(t);
    const broker = await startNetSuiteBroker({
      directory: brokerDirectory,
      hosts: () => [],
      service: {},
      execPath: process.execPath,
    });
    try {
      await assert.rejects(
        startNetSuiteBroker({
          directory: brokerDirectory,
          hosts: () => [],
          service: {},
          execPath: process.execPath,
        }),
        /already owns/,
      );
      assert.equal(
        (await request(directory, { operation: "status" })).execution.brokerPid,
        broker.pid,
      );
    } finally {
      await broker.close();
    }
  },
);
