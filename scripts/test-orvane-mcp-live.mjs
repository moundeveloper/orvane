import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkTypedNetSuiteReads } from "./test-netsuite-typed-reads.mjs";
import { checkNetSuiteReadFilters } from "./test-netsuite-read-filters.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    account: { type: "string" },
    user: { type: "string" },
    role: { type: "string" },
    batch: { type: "string", default: "2" },
    report: {
      type: "string",
      default: join(root, "artifacts/netsuite-mcp-live.json"),
    },
  },
});
if (
  !values.origin ||
  !/^https:\/\/[a-z0-9-]+-sb\d+\.app\.netsuite\.com$/i.test(values.origin) ||
  !values.account
)
  throw Error(
    "Specify an explicitly authorized sandbox --origin and --account. This checker refuses production targets.",
  );
const sql =
  "SELECT id FROM (SELECT id FROM employee ORDER BY id) WHERE ROWNUM <= 1";
const expectedBatch = Number(values.batch);
assert(
  [2, 3, 4, 5, 6].includes(expectedBatch),
  "Supported --batch values: 2, 3, 4, 5, 6",
);
const report = {
  startedAt: new Date().toISOString(),
  scope:
    "real installed configurations; background MCP clients; no GUI control",
  origin: values.origin,
  expectedAccount: values.account,
  sql,
  checks: [],
  notRun: [
    "closing/restarting Desktop",
    "closing user views",
    "signing out or changing roles",
    "killing the live worker",
  ],
  passed: false,
};
const connections = [];
const record = (name, details = {}) => {
  report.checks.push({ name, passed: true, ...details });
  console.log("PASS", name);
};
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = {};
    }
    // Don't persist tool arguments, identity tokens or unbounded remote errors.
    throw Object.assign(
      new Error(`MCP ${name} failed (${value.code || "UNKNOWN"})`),
      { code: value.code, requestId: value.requestId },
    );
  }
  return result.structuredContent?.result;
}
async function connect(label, path) {
  const config = JSON.parse(
    (await readFile(path, "utf8")).replace(/^\uFEFF/, ""),
  );
  const entry = config.mcpServers?.orvane;
  assert(entry, `${label} has no orvane entry`);
  assert(
    !entry.type || entry.type === "stdio",
    "The installed profile must be stdio",
  );
  assert(
    Array.isArray(entry.args) && entry.args.length === 1,
    "Expected the installed single-entrypoint profile",
  );
  assert.equal(entry.env?.ORVANE_MCP_PROFILE, "netsuite");
  assert.equal(
    resolve(entry.args?.[0]).toLowerCase(),
    resolve(root, "server/launch.mjs").toLowerCase(),
  );
  assert.equal(
    resolve(entry.env.ORVANE_DATA_DIR).toLowerCase(),
    resolve(root, ".orvane").toLowerCase(),
  );
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...process.env, ...entry.env },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  const client = new Client({ name: `orvane-live-${label}`, version: "1.0.0" });
  const connection = { label, client, transport };
  connections.push(connection);
  await client.connect(transport);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ["orvane_netsuite_query", "orvane_netsuite_read", "orvane_netsuite_status"],
  );
  record(`${label}: installed read-only MCP profile connects`);
  return connection;
}
try {
  const clients = await Promise.all([
    connect(
      "desktop-config",
      join(
        process.env.APPDATA || join(homedir(), "AppData/Roaming"),
        "Claude/claude_desktop_config.json",
      ),
    ),
    connect("code-config", join(homedir(), ".claude.json")),
  ]);
  const statuses = await Promise.all(
    clients.map(({ client }) =>
      call(client, "orvane_netsuite_status", { action: "list" }),
    ),
  );
  for (const status of statuses) {
    assert.equal(
      status.available,
      true,
      "Desktop must already be running; this checker never starts/restarts it",
    );
    assert.equal(status.batch, expectedBatch);
    assert.equal(status.execution.mode, "broker-worker");
    assert.notEqual(status.execution.brokerPid, status.execution.desktopPid);
  }
  assert.equal(statuses[0].desktopId, statuses[1].desktopId);
  assert.equal(
    statuses[0].execution.brokerPid,
    statuses[1].execution.brokerPid,
  );
  report.execution = statuses[0].execution;
  record("both installed profiles share the same separate broker", {
    batch: expectedBatch,
  });
  for (let index = 0; index < clients.length; index++) {
    const { label, client } = clients[index];
    const matches = statuses[index].environments.filter(
      (environment) => environment.origin === values.origin,
    );
    assert.equal(
      matches.length,
      1,
      "Sandbox must be explicitly unambiguous; no automatic alternative account selection",
    );
    const targetId = matches[0].targetId;
    const inspected = await call(client, "orvane_netsuite_status", {
      action: "inspect",
      targetId,
    });
    assert.equal(inspected.identity.accountId, values.account);
    if (values.user) assert.equal(inspected.identity.userId, values.user);
    if (values.role) assert.equal(inspected.identity.roleId, values.role);
    assert.equal(inspected.identity.source, "client-runtime");
    assert.equal(inspected.identity.serverRuntimeVerified, false);
    if (expectedBatch >= 3) {
      assert.equal(inspected.identity.sessionEpochSupported, true);
      assert(Number.isSafeInteger(inspected.identity.sessionEpoch));
      assert(inspected.identity.sessionEpoch > 0);
      record(
        `${label}: live Desktop reports source session-generation support`,
      );
    }
    record(`${label}: explicit sandbox and reported identity match`, {
      serverRuntimeVerified: false,
    });
    const answer = await call(client, "orvane_netsuite_query", {
      targetId,
      identityToken: inspected.identity.identityToken,
      sql,
    });
    assert(
      answer.identity.identityToken === inspected.identity.identityToken,
      "Reported identity changed while reading; tokens omitted",
    );
    assert.equal(answer.execution.brokerPid, report.execution.brokerPid);
    assert(Array.isArray(answer.data.rows));
    assert.equal(answer.data.rows.length, 1);
    assert(Number.isSafeInteger(Number(answer.data.rows[0].id)));
    record(
      `${label}: real ordered SELECT returns one row with matching identity`,
      { rowCount: 1, pageSize: answer.data.pageSize },
    );
    if (expectedBatch >= 3) {
      assert.match(answer.requestId, /^[a-f\d-]{36}$/i);
      assert.equal(
        answer.identity.sessionEpoch,
        inspected.identity.sessionEpoch,
      );
      const history = await call(client, "orvane_netsuite_status", {
        action: "requests",
        limit: 100,
      });
      const logged = history.requests.find(
        (item) => item.requestId === answer.requestId,
      );
      assert(logged, "Live query must appear in the active Desktop journal");
      assert.equal(logged.operation, "query.select");
      assert.equal(logged.state, "completed");
      const serialized = JSON.stringify(history);
      assert(!serialized.includes(sql));
      assert(!serialized.includes(inspected.identity.identityToken));
      assert(
        history.requests.every((item) => !("rows" in item) && !("sql" in item)),
      );
      record(
        `${label}: live journal records completed read with metadata only`,
      );
    }
    await assert.rejects(
      call(client, "orvane_netsuite_status", {
        action: "inspect",
        targetId: "invalid-live-check-target",
      }),
      { code: "TARGET_UNAVAILABLE" },
    );
    await assert.rejects(
      call(client, "orvane_netsuite_query", {
        targetId,
        identityToken: "invalid-live-check-identity",
        sql,
      }),
      (error) => {
        assert.equal(error.code, "IDENTITY_CHANGED");
        if (expectedBatch >= 3)
          assert.match(error.requestId, /^[a-f\d-]{36}$/i);
        return true;
      },
    );
    record(`${label}: invalid target and identity are rejected`);
    if (expectedBatch < 5) {
      await assert.rejects(
        call(client, "orvane_netsuite_read", {
          action: "scripts",
          targetId,
          identityToken: inspected.identity.identityToken,
        }),
        { code: "UPGRADE_PENDING" },
      );
      record(
        `${label}: older active broker rejects typed reads before submission`,
      );
    } else {
      const evidence = await checkTypedNetSuiteReads({
        call,
        client,
        targetId,
        identity: inspected.identity,
        record,
      });
      report.typedReads ??= [];
      report.typedReads.push({ profile: label, ...evidence });
    }
    if (expectedBatch < 6) {
      for (const options of [
        { action: "scripts", filters: { name: "test" } },
        { action: "find-files", id: 1 },
      ])
        await assert.rejects(
          call(client, "orvane_netsuite_read", {
            ...options,
            targetId,
            identityToken: inspected.identity.identityToken,
          }),
          { code: "UPGRADE_PENDING" },
        );
      record(
        `${label}: older active broker rejects filters and global search before submission`,
      );
    } else {
      const evidence = await checkNetSuiteReadFilters({
        call,
        client,
        targetId,
        identity: inspected.identity,
        record,
      });
      report.readFilters ??= [];
      report.readFilters.push({ profile: label, ...evidence });
    }
    if (expectedBatch < 4) {
      await assert.rejects(
        call(client, "orvane_netsuite_query", {
          targetId,
          identityToken: inspected.identity.identityToken,
          sql,
          shareInFlight: true,
        }),
        { code: "UPGRADE_PENDING" },
      );
      record(
        `${label}: older active broker explicitly rejects opted-in sharing`,
      );
    }
  }
  if (expectedBatch >= 4) {
    const target = statuses[0].environments.find(
      (item) => item.origin === values.origin,
    );
    const inspected = await call(clients[0].client, "orvane_netsuite_status", {
      action: "inspect",
      targetId: target.targetId,
    });
    const args = {
      targetId: target.targetId,
      identityToken: inspected.identity.identityToken,
      sql,
      shareInFlight: true,
    };
    const shared = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        call(
          clients[index % clients.length].client,
          "orvane_netsuite_query",
          args,
        ),
      ),
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
          !item.readSharing.cacheHit &&
          item.data.rows.length === 1,
      ),
    );
    record(
      "five concurrent live reads share one execution and preserve distinct request IDs",
    );
    const fresh = await call(clients[0].client, "orvane_netsuite_query", args);
    assert.notEqual(
      fresh.readSharing.executionId,
      shared[0].readSharing.executionId,
    );
    assert.equal(fresh.readSharing.joined, false);
    record("later identical live read starts a new execution");
  }
  await clients[0].client.close();
  await clients[0].transport.close();
  const surviving = await call(clients[1].client, "orvane_netsuite_status", {
    action: "list",
  });
  assert.equal(surviving.execution.brokerPid, report.execution.brokerPid);
  record(
    "disconnecting one test client leaves the shared broker and other client usable",
  );
  report.passed = true;
} catch (error) {
  report.failure = {
    code: error.code || "CHECK_FAILED",
    message: error.message,
  };
  process.exitCode = 1;
  console.error("FAIL", report.failure.code, report.failure.message);
} finally {
  for (const { client, transport } of connections) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(values.report), { recursive: true });
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log("Redacted report:", values.report);
}
