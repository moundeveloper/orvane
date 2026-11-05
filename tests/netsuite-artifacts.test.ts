import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  unlink,
  rmdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openNetSuiteArtifactStore } from "../electron/netsuite-artifact-store.mjs";
import {
  serializeNetSuitePage,
  createNetSuiteArtifactService,
} from "../electron/netsuite-artifact-service.mjs";
import {
  ARTIFACT_LIMITS,
  validateNetSuiteArtifact,
} from "../server/netsuite-artifact-protocol.ts";
import { removeTestArtifactDirectory } from "../scripts/netsuite-artifact-test-cleanup.mjs";
import { startNetSuiteBroker } from "../electron/netsuite-broker.mjs";
import { desktopNetSuiteRequest } from "../server/netsuite-client.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const owner = {
  origin: "https://123-sb1.app.netsuite.com",
  accountId: "123_SB1",
  userId: "5",
  roleId: "3",
};
const source = {
  kind: "query",
  action: null,
  offset: 0,
  rowCount: 1,
  observedAt: "2026-11-05T12:00:00.000Z",
  sessionEpoch: 1,
};
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "orvane-artifact-"));
  const brokerDirectory = join(root, "netsuite-broker"),
    directory = join(brokerDirectory, "artifacts");
  t.after(async () => {
    await removeTestArtifactDirectory(root);
    for (const name of await readdir(brokerDirectory)) {
      assert.match(
        name,
        /^(desktop\.json|rpc-[a-f\d-]{36}\.sock|requests\.sqlite(?:-wal|-shm)?)$/i,
      );
      await unlink(join(brokerDirectory, name));
    }
    await rmdir(brokerDirectory);
    await rmdir(root);
  });
  return { root, brokerDirectory, directory };
}

test("page serialization preserves NDJSON values and quotes CSV while prefixing formula-looking strings/headers", () => {
  const rows = [
    {
      "=header": "=SUM(A1)",
      text: 'one,"two"\r\nthree',
      number: -5,
      nil: null,
    },
    { "=header": "  @cmd", text: "\t=run", object: { a: 1 } },
  ];
  const ndjson = serializeNetSuitePage(rows, "ndjson");
  assert.deepEqual(ndjson.trim().split("\n").map(JSON.parse), rows);
  const csv = serializeNetSuitePage(rows, "csv");
  assert(csv.startsWith('"\'=header","text","number","nil","object"\r\n'));
  assert(csv.includes('"\'=SUM(A1)"'));
  assert(csv.includes('"\'  @cmd"'));
  assert(csv.includes('"\'\t=run"'));
  assert(csv.includes('"one,""two""\r\nthree"'));
  assert(csv.includes('"-5",""'));
  assert(serializeNetSuitePage([{ text: "＝1+1" }], "csv").includes("'＝1+1"));
  assert.equal(serializeNetSuitePage([], "csv"), "");
  assert.throws(() => serializeNetSuitePage(Array(101).fill({}), "csv"), {
    code: "INVALID_QUERY_RESULT",
  });
  assert.throws(
    () =>
      serializeNetSuitePage(
        [
          {
            ...Object.fromEntries(
              Array.from({ length: 257 }, (_, i) => [`c${i}`, i]),
            ),
          },
        ],
        "csv",
      ),
    { code: "ARTIFACT_TOO_LARGE" },
  );
});

test("artifact schemas reject paths, mixed actions, oversized ranges and arbitrary source operations", () => {
  const base = {
    operation: "artifact",
    targetId: "target",
    identityToken: "identity",
  };
  for (const input of [
    { action: "export" },
    { action: "export", source: { kind: "query", sql: "DELETE FROM file" } },
    { action: "export", source: { kind: "code", js: "alert(1)" } },
    { action: "read", artifactId: "../secret" },
    {
      action: "read",
      artifactId: "00000000-0000-4000-8000-000000000000",
      length: 16001,
    },
    {
      action: "read",
      artifactId: "00000000-0000-4000-8000-000000000000",
      source: { kind: "query", sql: "SELECT 1" },
    },
    {
      action: "inspect",
      artifactId: "00000000-0000-4000-8000-000000000000",
      offset: 0,
    },
    {
      action: "export",
      source: { kind: "query", sql: "SELECT 1" },
      path: "C:/secret",
    },
  ])
    assert.throws(() => validateNetSuiteArtifact({ ...base, ...input }), {
      code: "INVALID_ARTIFACT_REQUEST",
    });
});

test("content-addressed artifacts survive reopening, isolate identities and read bounded Unicode ranges", async (t) => {
  const { directory } = await fixture(t);
  let store = await openNetSuiteArtifactStore(directory);
  try {
    const values = await Promise.all([
      store.put("a😀b", { format: "ndjson", owner, source }),
      store.put("a😀b", { format: "ndjson", owner, source }),
    ]);
    assert.notEqual(values[0].artifactId, values[1].artifactId);
    assert.equal(values[0].hash, values[1].hash);
    assert.equal(
      (await readdir(directory)).filter((name) => name.startsWith("blob-"))
        .length,
      1,
    );
    const first = await store.read(values[0].artifactId, owner, {
      offset: 0,
      length: 2,
    });
    assert.equal(first.content, "a");
    assert.equal(first.nextOffset, 1);
    const second = await store.read(values[0].artifactId, owner, {
      offset: first.nextOffset,
      length: 2,
    });
    assert.equal(second.content, "😀");
    assert.equal(second.nextOffset, 3);
    await assert.rejects(
      store.read(values[0].artifactId, owner, { offset: 2 }),
      { code: "INVALID_ARTIFACT_RANGE" },
    );
    await assert.rejects(
      store.inspect(values[0].artifactId, { ...owner, roleId: "7" }),
      { code: "ARTIFACT_UNAVAILABLE" },
    );
    await assert.rejects(
      store.inspect(values[0].artifactId, {
        ...owner,
        origin: "https://other.app.netsuite.com",
      }),
      { code: "ARTIFACT_UNAVAILABLE" },
    );
    await store.close();
    store = await openNetSuiteArtifactStore(directory);
    assert.equal(
      (await store.read(values[0].artifactId, owner)).content,
      "a😀b",
    );
    const metadataText = await readFile(
      join(directory, `artifact-${values[0].artifactId}.json`),
      "utf8",
    );
    assert(!metadataText.includes("a😀b"));
    await writeFile(join(directory, `blob-${values[0].hash}.txt`), "bad");
    await assert.rejects(store.read(values[0].artifactId, owner), {
      code: "ARTIFACT_CORRUPT",
    });
  } finally {
    await store.close();
  }
});

test("expiry, unique-byte quota, count budgets and orphan cleanup bound the store", async (t) => {
  const { directory } = await fixture(t);
  let clock = 1000;
  const limits = {
    ...ARTIFACT_LIMITS,
    maxBytes: 6,
    quotaBytes: 8,
    maxArtifacts: 2,
    ttlMs: 50,
  };
  let store = await openNetSuiteArtifactStore(directory, {
    limits,
    now: () => clock++,
  });
  try {
    const a = await store.put("aaaa", { format: "ndjson", owner, source });
    const b = await store.put("bbbb", { format: "ndjson", owner, source });
    const c = await store.put("cccc", { format: "ndjson", owner, source });
    await assert.rejects(store.inspect(a.artifactId, owner), {
      code: "ARTIFACT_UNAVAILABLE",
    });
    assert.equal((await store.inspect(b.artifactId, owner)).sizeBytes, 4);
    await assert.rejects(
      store.put("too-big", { format: "ndjson", owner, source }),
      { code: "ARTIFACT_TOO_LARGE" },
    );
    assert.equal((await store.inspect(c.artifactId, owner)).sizeBytes, 4);
    await store.close();
    const orphan = "blob-" + "a".repeat(64) + ".txt";
    await writeFile(join(directory, orphan), "orphan");
    clock = 2000;
    store = await openNetSuiteArtifactStore(directory, {
      limits,
      now: () => clock,
    });
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(store.inspect(c.artifactId, owner), {
      code: "ARTIFACT_UNAVAILABLE",
    });
  } finally {
    await store.close();
  }
});

test("unknown files block artifact startup without deleting user data", async (t) => {
  const { directory } = await fixture(t);
  const store = await openNetSuiteArtifactStore(directory);
  await store.close();
  const unknown = join(directory, "keep-user.txt");
  await writeFile(unknown, "retained");
  try {
    await assert.rejects(openNetSuiteArtifactStore(directory), {
      code: "ARTIFACT_STORE_INVALID",
    });
    assert.equal(await readFile(unknown, "utf8"), "retained");
  } finally {
    await unlink(unknown);
  }
});

test("a changed identity during local publication discards the export response", async (t) => {
  const { brokerDirectory } = await fixture(t);
  let inspections = 0,
    queries = 0;
  const identity = {
    accountId: owner.accountId,
    userId: owner.userId,
    roleId: owner.roleId,
    identityToken: "valid",
    sessionEpoch: 1,
  };
  const service = createNetSuiteArtifactService({
    directory: brokerDirectory,
    dispatch: async (request: any) => {
      if (request.operation === "status") {
        inspections++;
        return {
          desktopId: "fixture",
          origin: owner.origin,
          identity: {
            ...identity,
            identityToken: inspections > 1 ? "changed" : "valid",
          },
        };
      }
      queries++;
      return {
        identity,
        observedAt: source.observedAt,
        data: { rows: [{ id: 1 }], offset: 0 },
      };
    },
  });
  try {
    await assert.rejects(
      service.dispatch({
        operation: "artifact",
        action: "export",
        targetId: "target",
        identityToken: "valid",
        source: { kind: "query", sql: "SELECT id FROM employee" },
      }),
      { code: "IDENTITY_CHANGED" },
    );
    assert.equal(inspections, 2);
    assert.equal(queries, 1);
  } finally {
    await service.close();
  }
});

test(
  "two real MCP clients export/read an identity-bound page and reuse it after broker restart without requerying",
  { timeout: 20000 },
  async (t) => {
    const { root, brokerDirectory } = await fixture(t);
    const host = { id: 1, isDestroyed: () => false };
    let queries = 0,
      role = 3;
    const start = () =>
      startNetSuiteBroker({
        directory: brokerDirectory,
        hosts: () => [host],
        execPath: process.execPath,
        service: {
          environments: async () => [{ id: owner.origin }],
          run: async (_host: unknown, _origin: string, operation: string) => {
            if (operation === "user")
              return { account: owner.accountId, id: 5, role };
            queries++;
            return {
              rows: [{ id: -5, text: "private-artifact-value" }],
              offset: 0,
              pageSize: 100,
            };
          },
        },
      });
    let broker = await start();
    const connections: { client: Client; transport: StdioClientTransport }[] =
      [];
    const rpc = (request: object): Promise<any> =>
      desktopNetSuiteRequest(root, request);
    try {
      for (let i = 0; i < 2; i++) {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [resolve("server/launch.mjs")],
          env: {
            ...(process.env as Record<string, string>),
            ORVANE_DATA_DIR: root,
            ORVANE_MCP_PROFILE: "netsuite",
          },
          stderr: "pipe",
        });
        transport.stderr?.resume();
        const client = new Client({ name: `artifact-${i}`, version: "1.0.0" });
        connections.push({ client, transport });
        await client.connect(transport);
      }
      const target = async () => {
        const status = await rpc({ operation: "status" });
        const targetId = status.environments[0].targetId;
        const inspected = await rpc({
          operation: "status",
          action: "inspect",
          targetId,
        });
        return { targetId, identityToken: inspected.identity.identityToken };
      };
      let identity = await target();
      const exported = await connections[0].client.callTool({
        name: "orvane_netsuite_artifact",
        arguments: {
          action: "export",
          ...identity,
          source: { kind: "query", sql: "SELECT id FROM employee" },
        },
      });
      assert.notEqual(exported.isError, true);
      const result = (exported.structuredContent as any).result;
      assert.equal(result.artifact.source.rowCount, 1);
      assert.equal(result.artifact.source.isLive, false);
      assert(!JSON.stringify(result).includes("private-artifact-value"));
      const chunk = await connections[1].client.callTool({
        name: "orvane_netsuite_artifact",
        arguments: {
          action: "read",
          ...identity,
          artifactId: result.artifact.artifactId,
          length: 16000,
        },
      });
      const read = (chunk.structuredContent as any).result;
      assert(read.data.content.includes("private-artifact-value"));
      assert.equal(
        createHash("sha256").update(read.data.content).digest("hex"),
        result.artifact.sha256,
      );
      assert.equal(queries, 1);
      const history = await rpc({
        operation: "status",
        action: "requests",
        limit: 100,
      });
      assert.equal(
        history.requests.find(
          (item: any) => item.requestId === result.requestId,
        ).operation,
        "artifact.export",
      );
      assert.equal(
        history.requests.find((item: any) => item.requestId === read.requestId)
          .operation,
        "artifact.read",
      );
      assert(!JSON.stringify(history).includes("private-artifact-value"));
      await broker.close();
      broker = await start();
      identity = await target();
      const reopened = await rpc({
        operation: "artifact",
        action: "read",
        ...identity,
        artifactId: result.artifact.artifactId,
      });
      assert.equal(reopened.data.content, read.data.content);
      assert.equal(queries, 1);
      role = 7;
      identity = await target();
      await assert.rejects(
        rpc({
          operation: "artifact",
          action: "inspect",
          ...identity,
          artifactId: result.artifact.artifactId,
        }),
        { code: "ARTIFACT_UNAVAILABLE" },
      );
      assert.equal(queries, 1);
    } finally {
      for (const { client, transport } of connections) {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
      await broker.close();
    }
  },
);
