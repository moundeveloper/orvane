import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  readdir,
  unlink,
  rmdir,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startNetSuiteBroker } from "../electron/netsuite-broker.mjs";
import { checkTypedNetSuiteReads } from "./test-netsuite-typed-reads.mjs";
import { checkNetSuiteReadFilters } from "./test-netsuite-read-filters.mjs";

// Run the new worker in an isolated profile. Its executor relays SELECT/identity
// through the already-running read-only Desktop MCP, without restarting user apps.
const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    account: { type: "string" },
    user: { type: "string" },
    role: { type: "string" },
    report: {
      type: "string",
      default: join(root, "artifacts/netsuite-broker-live.json"),
    },
  },
});
if (
  !/^https:\/\/[a-z0-9-]+-sb\d+\.app\.netsuite\.com$/i.test(
    values.origin || "",
  ) ||
  !values.account
)
  throw Error(
    "Specify the explicitly authorized sandbox --origin and --account; production is refused.",
  );
const report = {
  startedAt: new Date().toISOString(),
  mode: "isolated new broker with real read-only Desktop MCP relay",
  origin: values.origin,
  checks: [],
  passed: false,
  limitations: [
    "Active Desktop is not restarted or upgraded by this test.",
    "Source navigation/session epoch events are fixture-tested; the isolated relay does not forward source lifecycle events.",
    "Server-side identity remains unverified.",
  ],
};
const record = (name) => {
  report.checks.push({ name, passed: true });
  console.log("PASS", name);
};
const connections = [];
async function connect(entry, label) {
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...process.env, ...entry.env },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  const client = new Client({
    name: `orvane-isolated-${label}`,
    version: "1.0.0",
  });
  connections.push({ client, transport });
  await client.connect(transport);
  return client;
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    let error = {};
    try {
      error = JSON.parse(
        result.content.find((item) => item.type === "text")?.text || "{}",
      );
    } catch {}
    throw Object.assign(
      Error(`MCP read rejected (${error.code || "UNKNOWN"}); details omitted`),
      { code: error.code, requestId: error.requestId },
    );
  }
  return result.structuredContent?.result;
}
let broker, temporary;
try {
  const config = JSON.parse(
    (
      await readFile(
        join(
          process.env.APPDATA || join(homedir(), "AppData/Roaming"),
          "Claude/claude_desktop_config.json",
        ),
        "utf8",
      )
    ).replace(/^\uFEFF/, ""),
  );
  const entry = config.mcpServers.orvane;
  assert.equal(entry.env.ORVANE_MCP_PROFILE, "netsuite");
  const live = await connect(entry, "live-relay");
  const initial = await call(live, "orvane_netsuite_status", {
    action: "list",
  });
  assert(initial.available);
  const targets = initial.environments.filter(
    (target) => target.origin === values.origin,
  );
  assert.equal(targets.length, 1, "Target must be explicitly unambiguous");
  const targetId = targets[0].targetId;
  let liveIdentity;
  const inspect = async () => {
    const value = await call(live, "orvane_netsuite_status", {
      action: "inspect",
      targetId,
    });
    assert.equal(value.identity.accountId, values.account);
    if (values.user) assert.equal(value.identity.userId, values.user);
    if (values.role) assert.equal(value.identity.roleId, values.role);
    liveIdentity = value.identity;
    return liveIdentity;
  };
  await inspect();
  record("authorized live sandbox identity matches");
  const host = { id: 1, isDestroyed: () => false };
  let selectCalls = 0;
  const service = {
    environments: async () => [
      { id: values.origin, label: "Authorized sandbox relay", status: "ready" },
    ],
    run: async (_host, origin, operation, args) => {
      assert.equal(origin, values.origin);
      if (operation === "user") {
        const identity = await inspect();
        return {
          account: identity.accountId,
          id: identity.userId,
          role: identity.roleId,
        };
      }
      assert.equal(operation, "query");
      selectCalls++;
      const answer = await call(live, "orvane_netsuite_query", {
        targetId,
        identityToken: liveIdentity.identityToken,
        sql: args.sql,
        offset: args.offset,
      });
      return answer.data;
    },
  };
  temporary = await mkdtemp(join(tmpdir(), "orvane-live-b6-"));
  const directory = join(temporary, "netsuite-broker");
  const start = () =>
    startNetSuiteBroker({
      directory,
      hosts: () => [host],
      service,
      execPath: process.execPath,
    });
  broker = await start();
  const testingEntry = {
    command: process.execPath,
    args: [fileURLToPath(new URL("../server/launch.mjs", import.meta.url))],
    env: { ORVANE_MCP_PROFILE: "netsuite", ORVANE_DATA_DIR: temporary },
  };
  const clients = await Promise.all([
    connect(testingEntry, "new-worker-a"),
    connect(testingEntry, "new-worker-b"),
  ]);
  const statuses = await Promise.all(
    clients.map((client) =>
      call(client, "orvane_netsuite_status", { action: "list" }),
    ),
  );
  for (const status of statuses) {
    assert.equal(status.batch, 6);
    assert.equal(status.execution.brokerPid, broker.pid);
    assert(status.capabilities.includes("requests.read"));
    assert(status.capabilities.includes("query.share-in-flight"));
    for (const action of ["scripts", "deployments", "folders", "files"])
      assert(status.capabilities.includes(`read.${action}`));
    assert(status.capabilities.includes("read.filters-v1"));
  }
  record("two real stdio clients share the isolated Batch 6 worker");
  const shadowTarget = statuses[0].environments[0].targetId;
  const inspected = await call(clients[0], "orvane_netsuite_status", {
    action: "inspect",
    targetId: shadowTarget,
  });
  assert.equal(inspected.identity.serverRuntimeVerified, false);
  assert.equal(
    inspected.identity.sessionEpochSupported,
    false,
    "Isolated relay must not claim source lifecycle events are forwarded",
  );
  const sql =
    "SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1";
  const answer = await call(clients[0], "orvane_netsuite_query", {
    targetId: shadowTarget,
    identityToken: inspected.identity.identityToken,
    sql,
  });
  assert.equal(answer.data.rows.length, 1);
  assert.match(answer.requestId, /^[a-f\d-]{36}$/i);
  record(
    "new worker executes the real ordered SELECT and returns a durable request ID",
  );
  let history = await call(clients[1], "orvane_netsuite_status", {
    action: "requests",
    limit: 20,
  });
  const completed = history.requests.find(
    (item) => item.requestId === answer.requestId,
  );
  assert.equal(completed.state, "completed");
  assert.equal(completed.origin, values.origin);
  assert(!JSON.stringify(history).includes(inspected.identity.identityToken));
  assert(!JSON.stringify(history).includes(sql));
  assert(!JSON.stringify(history).includes('"rows"'));
  record(
    "MCP request history links the completed read without SQL, tokens or row payloads",
  );
  const queryArgs = {
    targetId: shadowTarget,
    identityToken: inspected.identity.identityToken,
    sql,
    shareInFlight: true,
  };
  const beforeSharing = selectCalls;
  const shared = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      call(clients[index % clients.length], "orvane_netsuite_query", queryArgs),
    ),
  );
  assert.equal(
    selectCalls - beforeSharing,
    1,
    "Five overlapping opted-in reads must issue exactly one SELECT through the live relay",
  );
  assert.equal(new Set(shared.map((item) => item.requestId)).size, 5);
  assert.equal(
    new Set(shared.map((item) => item.readSharing.executionId)).size,
    1,
  );
  assert(
    shared.every(
      (item) =>
        item.readSharing.participants === 5 &&
        item.data.rows.length === 1 &&
        !item.readSharing.cacheHit,
    ),
  );
  history = await call(clients[1], "orvane_netsuite_status", {
    action: "requests",
    limit: 100,
  });
  assert(
    shared.every((item) =>
      history.requests.some(
        (row) => row.requestId === item.requestId && row.state === "completed",
      ),
    ),
  );
  report.sharing = {
    callers: 5,
    selectDispatches: selectCalls - beforeSharing,
    completedRequestIds: 5,
    completedCache: false,
  };
  record(
    "five concurrent real MCP reads issue one sandbox SELECT and retain five completed journal IDs",
  );
  const fresh = await call(clients[0], "orvane_netsuite_query", queryArgs);
  assert.equal(selectCalls - beforeSharing, 2);
  assert.notEqual(
    fresh.readSharing.executionId,
    shared[0].readSharing.executionId,
  );
  assert.equal(fresh.readSharing.joined, false);
  record(
    "a later identical read executes again instead of reusing a completed result",
  );
  let failedId;
  await assert.rejects(
    call(clients[0], "orvane_netsuite_query", {
      targetId: shadowTarget,
      identityToken: "deliberately-invalid-identity",
      sql,
    }),
    (error) => {
      failedId = error.requestId;
      return error.code === "IDENTITY_CHANGED" && typeof failedId === "string";
    },
  );
  history = await call(clients[1], "orvane_netsuite_status", {
    action: "requests",
    limit: 20,
  });
  assert.equal(
    history.requests.find((item) => item.requestId === failedId).errorCode,
    "IDENTITY_CHANGED",
  );
  record(
    "rejected identity is traceable by request ID without an account write",
  );
  report.typedReads = await checkTypedNetSuiteReads({
    call,
    client: clients[1],
    targetId: shadowTarget,
    identity: inspected.identity,
    record,
  });
  report.readFilters = await checkNetSuiteReadFilters({
    call,
    client: clients[1],
    targetId: shadowTarget,
    identity: inspected.identity,
    record,
  });
  await broker.close();
  broker = await start();
  history = await call(clients[0], "orvane_netsuite_status", {
    action: "requests",
    limit: 100,
  });
  assert.equal(
    history.requests.find((item) => item.requestId === answer.requestId).state,
    "completed",
  );
  record(
    "history survives an isolated worker restart while user applications stay open",
  );
  const after = await call(live, "orvane_netsuite_status", { action: "list" });
  assert.equal(after.desktopId, initial.desktopId);
  assert.equal(after.execution.brokerPid, initial.execution.brokerPid);
  report.sourceExecution = initial.execution;
  record(
    "the user's original Desktop and broker were not restarted or replaced",
  );
  report.passed = true;
} catch (error) {
  process.exitCode = 1;
  report.failure = {
    code: error.code || "CHECK_FAILED",
    message: error.message,
  };
  console.error("FAIL", report.failure.code, report.failure.message);
} finally {
  for (const { client, transport } of connections) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  await broker?.close();
  if (temporary) {
    const directory = join(temporary, "netsuite-broker");
    for (const name of await readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      assert.match(
        name,
        /^(desktop\.json|rpc-[a-f\d-]{36}\.sock|requests\.sqlite(?:-wal|-shm)?)$/i,
      );
      await unlink(join(directory, name));
    }
    await rmdir(directory).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(temporary);
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(values.report), { recursive: true });
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log("Redacted report:", values.report);
}
