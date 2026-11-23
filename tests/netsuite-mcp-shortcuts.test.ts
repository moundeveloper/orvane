// Fewer calls per NetSuite task: origin instead of list + inspect, sorted and
// limited reads, and one-call script detail. Run: pnpm exec tsx --test <file>
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startNetSuiteRpc } from "../electron/netsuite-rpc.mjs";
import { createNetSuiteReadService } from "../electron/netsuite-read-service.mjs";

async function setup(t: any) {
  const host = { id: 4, isDestroyed: () => false };
  const state = { role: 3 };
  const calls: { operation: string; sql?: string }[] = [];
  const service = {
    environments: async () => [
      { id: "https://123-sb1.app.netsuite.com", label: "Sandbox", status: "ready" },
      { id: "https://123.app.netsuite.com", label: "Production", status: "ready" },
    ],
    run: async (_host: unknown, _origin: string, operation: string, args: any) => {
      calls.push({ operation, sql: args?.sql });
      if (operation === "user") return { account: "123_SB1", id: 25, role: state.role };
      const sql = String(args.sql);
      const rows = /FROM script LEFT JOIN entity ON script\.owner = entity\.id LEFT JOIN file ON file\.id = script\.scriptfile LEFT JOIN MediaItemFolder/.test(sql)
        ? [{ id: 7, scriptid: "customscript_x", name: "X", fileid: 3, scriptfile: "x.js", folderid: 9, foldername: "CTK" }]
        : /FROM scriptdeployment/.test(sql)
          ? [{ id: 11, scriptid: "customdeploy_x" }]
          : [{ sql }];
      return { rows, offset: args.offset, pageSize: 100, totalCount: rows.length };
    },
  };
  const dispatch = createNetSuiteReadService({ hosts: () => [host], service, instanceId: "shortcut-test" });
  const directory = await mkdtemp(join(tmpdir(), "orvane-ns-shortcut-"));
  const rpc = await startNetSuiteRpc({ directory: join(directory, "netsuite-broker"), dispatch });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      ORVANE_DATA_DIR: directory,
      ORVANE_MCP_PROFILE: "netsuite",
    },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  const client = new Client({ name: "shortcut-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await transport.close();
    await rpc.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const answer: any = await client.callTool({ name, arguments: args });
    return answer.isError
      ? { error: JSON.parse(answer.content[0].text) }
      : { result: answer.structuredContent.result };
  };
  return { tool, calls, state };
}

test("origin replaces list + inspect, and a reused inspection refreshes once after a role change", async (t) => {
  const { tool, calls, state } = await setup(t);
  const sql = "SELECT id FROM employee ORDER BY id";
  const first = await tool("orvane_netsuite_query", { origin: "123_SB1", sql });
  assert.equal(first.error, undefined);
  assert.equal(first.result.origin, "https://123-sb1.app.netsuite.com");
  const users = () => calls.filter((c) => c.operation === "user").length;
  const before = users();
  await tool("orvane_netsuite_query", { origin: "https://123-sb1.app.netsuite.com/", sql });
  // Reused inspection: only the broker's own before/after identity checks.
  assert.equal(users() - before, 2);
  state.role = 4;
  const changed = await tool("orvane_netsuite_query", { origin: "123_SB1", sql });
  assert.equal(changed.error, undefined);
  assert.equal(changed.result.identity.roleId, "4");
});

test("missing or unknown environments answer with the environments to choose from", async (t) => {
  const { tool } = await setup(t);
  const missing = await tool("orvane_netsuite_read", { action: "scripts" });
  assert.equal(missing.error.code, "TARGET_REQUIRED");
  assert.deepEqual(
    missing.error.environments.map((e: any) => e.origin).sort(),
    ["https://123-sb1.app.netsuite.com", "https://123.app.netsuite.com"],
  );
  const unknown = await tool("orvane_netsuite_read", { origin: "999", action: "scripts" });
  assert.equal(unknown.error.code, "TARGET_UNAVAILABLE");
  assert.equal(unknown.error.environments.length, 2);
  const both = await tool("orvane_netsuite_read", { origin: "123_SB1", targetId: "x", identityToken: "y", action: "scripts" });
  assert.equal(both.error.code, "INVALID_TARGET");
});

test("reads sort and limit in one call", async (t) => {
  const { tool, calls } = await setup(t);
  const newest = await tool("orvane_netsuite_read", {
    origin: "123_SB1",
    action: "scripts",
    filters: { owner: "Sabri" },
    sort: "-id",
    limit: 5,
  });
  assert.equal(newest.error, undefined);
  const sql = calls.filter((c) => c.operation === "query").at(-1)!.sql!;
  assert.match(sql, /ORDER BY script\.id DESC, script\.id\) WHERE ROWNUM <= 5$/);
  assert.match(sql, /INSTR\(LOWER\(entity\.entityid\), LOWER\('Sabri'\)\) > 0/);
  const files = await tool("orvane_netsuite_read", { origin: "123_SB1", action: "files", id: 9, sort: "-modified" });
  assert.equal(files.error, undefined);
  assert.match(calls.filter((c) => c.operation === "query").at(-1)!.sql!, /ORDER BY lastmodifieddate DESC, id$/);
  const bad = await tool("orvane_netsuite_read", { origin: "123_SB1", action: "scripts", sort: "-created" });
  assert.equal(bad.error.code, "INVALID_READ");
});

test("script action returns the script, its file folder, deployments and links in one call", async (t) => {
  const { tool } = await setup(t);
  const detail = await tool("orvane_netsuite_read", {
    origin: "123_SB1",
    action: "script",
    filters: { scriptId: "customscript_x" },
  });
  assert.equal(detail.error, undefined);
  assert.equal(detail.result.script.folderid, 9);
  assert.deepEqual(detail.result.deployments, [{ id: 11, scriptid: "customdeploy_x" }]);
  assert.deepEqual(detail.result.links, {
    script: "/app/common/scripting/script.nl?id=7",
    file: "/app/common/media/mediaitem.nl?id=3",
    folder: "/app/common/media/mediaitemfolders.nl?folder=9",
  });
  const neither = await tool("orvane_netsuite_read", { origin: "123_SB1", action: "script" });
  assert.equal(neither.error.code, "INVALID_READ");
});

test("NetSuite page addresses come from kind + ID, never guessed", async () => {
  const { netSuitePagePath } = await import("../server/netsuite-tools.ts");
  assert.equal(netSuitePagePath("script", 2153), "/app/common/scripting/script.nl?id=2153");
  assert.equal(netSuitePagePath("deployment", 4646), "/app/common/scripting/scriptrecord.nl?id=4646");
  assert.equal(netSuitePagePath("file", 26898), "/app/common/media/mediaitem.nl?id=26898");
  assert.equal(netSuitePagePath("folder", 3847), "/app/common/media/mediaitemfolders.nl?folder=3847");
  assert.equal(netSuitePagePath("record", 5, "SalesOrder"), "/app/accounting/transactions/transaction.nl?id=5");
  assert.equal(netSuitePagePath("record", 6, "customer"), "/app/common/entity/entity.nl?id=6");
  assert.equal(netSuitePagePath("record", 7, "inventoryitem"), "/app/common/item/item.nl?id=7");
  assert.equal(netSuitePagePath("record", 8, "customrecord_ctk_x"), "/app/common/custom/custrecordentry.nl?rectype=customrecord_ctk_x&id=8");
  assert.equal(netSuitePagePath("record", 9, "unknowntype"), "");
});
