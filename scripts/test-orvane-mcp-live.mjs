import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    account: { type: "string" },
    user: { type: "string" },
    role: { type: "string" },
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
      { code: value.code },
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
    ["orvane_netsuite_query", "orvane_netsuite_status"],
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
    assert.equal(status.batch, 2);
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
    batch: 2,
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
      { code: "IDENTITY_CHANGED" },
    );
    record(`${label}: invalid target and identity are rejected`);
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
