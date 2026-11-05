import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startNetSuiteRpc } from "../electron/netsuite-rpc.mjs";
import { createNetSuiteReadService } from "../electron/netsuite-read-service.mjs";
import { desktopNetSuiteRequest } from "../server/netsuite-client.ts";

function serviceFixture() {
  const host = { id: 4, isDestroyed: () => false };
  const calls: string[] = [];
  const state = {
    account: "123_SB1",
    id: 25,
    role: 3,
    afterQuery: false,
    huge: false,
  };
  const service = {
    environments: async () => [
      {
        id: "https://123-sb1.app.netsuite.com",
        label: "Sandbox",
        status: "ready",
      },
      { id: "https://evil.example", label: "Unrelated", status: "ready" },
    ],
    run: async (
      _host: unknown,
      _origin: string,
      operation: string,
      args: any,
    ) => {
      calls.push(operation);
      if (operation === "user") return { ...state };
      assert.equal(operation, "query");
      if (state.afterQuery) state.role++;
      return {
        rows: [{ value: state.huge ? "x".repeat(1100000) : args.sql }],
        offset: args.offset,
        pageSize: 100,
      };
    },
  };
  const dispatch = createNetSuiteReadService({
    hosts: () => [host],
    service,
    instanceId: "test-instance",
  });
  return { dispatch, state, calls };
}

async function rpcFixture(
  t: any,
  dispatch: (request: any) => Promise<unknown>,
) {
  const directory = await mkdtemp(join(tmpdir(), "orvane-ns-"));
  const brokerDirectory = join(directory, "netsuite-broker");
  const rpc = await startNetSuiteRpc({ directory: brokerDirectory, dispatch });
  t.after(async () => {
    await rpc.close();
    await rmdir(brokerDirectory);
    await rmdir(directory);
  });
  return { directory, brokerDirectory };
}

test("explicit targets enforce identity before and after bounded SELECTs", async () => {
  const { dispatch, state, calls } = serviceFixture();
  const status = await dispatch({ operation: "status" });
  assert.equal(status.environments.length, 1);
  const targetId = status.environments[0].targetId;
  const inspected = await dispatch({
    operation: "status",
    action: "inspect",
    targetId,
  });
  assert.equal(inspected.identity.serverRuntimeVerified, false);
  const request = {
    operation: "query",
    targetId,
    identityToken: inspected.identity.identityToken,
    sql: "SELECT id FROM customer ORDER BY id",
  };
  const answer = await dispatch(request);
  assert.equal(answer.data.pageSize, 100);
  const count = calls.filter((value) => value === "query").length;
  state.role = 5;
  await assert.rejects(dispatch(request), { code: "IDENTITY_CHANGED" });
  assert.equal(calls.filter((value) => value === "query").length, count);
  const current = await dispatch({
    operation: "status",
    action: "inspect",
    targetId,
  });
  state.afterQuery = true;
  await assert.rejects(
    dispatch({ ...request, identityToken: current.identity.identityToken }),
    { code: "IDENTITY_CHANGED" },
  );
  await assert.rejects(dispatch({ ...request, sql: "DELETE FROM customer" }), {
    code: "INVALID_QUERY",
  });
  await assert.rejects(
    dispatch({
      ...request,
      sql: "SELECT id FROM customer; DELETE FROM customer",
    }),
    { code: "INVALID_QUERY" },
  );
  await assert.rejects(dispatch({ ...request, offset: -1 }), {
    code: "INVALID_QUERY",
  });
  await assert.rejects(dispatch({ operation: "save-file" }), {
    code: "UNKNOWN_OPERATION",
  });
  await assert.rejects(dispatch({ ...request, targetId: "unknown-target" }), {
    code: "TARGET_UNAVAILABLE",
  });
  state.account = "999";
  await assert.rejects(
    dispatch({ operation: "status", action: "inspect", targetId }),
    { code: "ACCOUNT_MISMATCH" },
  );
});

test("direct gateway authenticates, bounds payloads, rejects duplicate owners and preserves Unicode", async (t) => {
  const fixture = serviceFixture();
  const { directory, brokerDirectory } = await rpcFixture(t, fixture.dispatch);
  const status: any = await desktopNetSuiteRequest(directory, {
    operation: "status",
  });
  const targetId = status.environments[0].targetId;
  const inspected: any = await desktopNetSuiteRequest(directory, {
    operation: "status",
    action: "inspect",
    targetId,
  });
  const request = {
    operation: "query",
    targetId,
    identityToken: inspected.identity.identityToken,
    sql: "SELECT 'caffè 漢字' AS value FROM employee",
  };
  const answer: any = await desktopNetSuiteRequest(directory, request);
  assert.equal(answer.data.rows[0].value, request.sql);
  const descriptor = JSON.parse(
    await readFile(join(brokerDirectory, "desktop.json"), "utf8"),
  );
  const raw = async (token: string, request: unknown, split = false) =>
    new Promise<any>((resolve, reject) => {
      const socket = net.createConnection(descriptor.endpoint);
      let body = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("connect", () => {
        const bytes = Buffer.from(
          JSON.stringify({ version: 1, token, request }) + "\n",
        );
        if (split) for (const byte of bytes) socket.write(Buffer.from([byte]));
        else socket.write(bytes);
      });
      socket.on("data", (chunk) => {
        body += chunk;
      });
      socket.on("end", () => {
        socket.destroy();
        resolve(JSON.parse(body));
      });
    });
  const count = fixture.calls.length;
  assert.equal((await raw("wrong", request)).code, "UNAUTHORIZED");
  assert.equal(fixture.calls.length, count);
  assert.equal(
    (await raw(descriptor.token, request, true)).data.data.rows[0].value,
    request.sql,
  );
  fixture.state.huge = true;
  await assert.rejects(desktopNetSuiteRequest(directory, request), {
    code: "RESULT_TOO_LARGE",
  });
  await assert.rejects(
    startNetSuiteRpc({
      directory: brokerDirectory,
      dispatch: fixture.dispatch,
    }),
    /already owns/,
  );
  assert.equal(
    ((await desktopNetSuiteRequest(directory, { operation: "status" })) as any)
      .available,
    true,
  );
});

test("two complete NetSuite MCP clients share the gateway without workspace listeners or database writers", async (t) => {
  const fixture = serviceFixture();
  let failStatus = false;
  let legacyBatch5 = false;
  const { directory } = await rpcFixture(t, async (request: any) => {
    if (failStatus && request.operation === "status")
      throw Object.assign(Error("Fixture capability lookup failed"), { code: "TEST_STATUS_FAILURE" });
    const result = await fixture.dispatch(request);
    if (result.capabilities)
      result.capabilities = result.capabilities.filter((value: string) => legacyBatch5
        ? !["read.filters-v1", "read.find-files", "read.find-folders"].includes(value)
        : value !== "query.share-in-flight" && !value.startsWith("read."));
    return result;
  });
  const connections = await Promise.all(
    [0, 1].map(async (index) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve("server/launch.mjs")],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          ORVANE_DATA_DIR: directory,
          ORVANE_MCP_PROFILE: "netsuite",
        },
        stderr: "pipe",
      });
      const client = new Client({
        name: `batch-one-test-${index}`,
        version: "1.0.0",
      });
      transport.stderr?.resume();
      await client.connect(transport);
      return { client, transport };
    }),
  );
  t.after(async () => {
    for (const connection of connections) {
      await connection.client.close();
      await connection.transport.close();
    }
  });
  for (const { client } of connections) {
    const tools = await client.listTools();
    const pendingUpgrade = await client.callTool({
      name: "orvane_netsuite_status",
      arguments: { action: "requests" },
    });
    assert.equal(pendingUpgrade.isError, true);
    assert.equal(
      JSON.parse((pendingUpgrade.content[0] as any).text).code,
      "UPGRADE_PENDING",
    );
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "orvane_netsuite_artifact",
      "orvane_netsuite_query",
      "orvane_netsuite_read",
      "orvane_netsuite_status",
    ]);
    const listed = await client.callTool({
      name: "orvane_netsuite_status",
      arguments: {},
    });
    const status = (listed.structuredContent as any).result;
    const inspected = await client.callTool({
      name: "orvane_netsuite_status",
      arguments: {
        action: "inspect",
        targetId: status.environments[0].targetId,
      },
    });
    const identity = (inspected.structuredContent as any).result.identity;
    const before = fixture.calls.filter((op) => op === "query").length;
    const unsupportedArtifact = await client.callTool({ name: "orvane_netsuite_artifact", arguments: {
      action: "export", targetId: status.environments[0].targetId, identityToken: identity.identityToken,
      source: { kind: "query", sql: "SELECT id FROM employee" },
    } });
    assert.equal(unsupportedArtifact.isError, true);
    assert.equal(JSON.parse((unsupportedArtifact.content[0] as any).text).code, "UPGRADE_PENDING");
    assert.equal(fixture.calls.filter((op) => op === "query").length, before);
    const unsupportedRead = await client.callTool({ name: "orvane_netsuite_read", arguments: {
      targetId: status.environments[0].targetId, identityToken: identity.identityToken, action: "scripts",
    } });
    assert.equal(unsupportedRead.isError, true);
    assert.equal(JSON.parse((unsupportedRead.content[0] as any).text).code, "UPGRADE_PENDING");
    assert.equal(fixture.calls.filter((op) => op === "query").length, before);
    legacyBatch5 = true;
    for (const input of [{ action: "scripts", filters: { name: "test" } }, { action: "find-files", id: 1 }]) {
      const guarded = await client.callTool({ name: "orvane_netsuite_read", arguments: {
        targetId: status.environments[0].targetId, identityToken: identity.identityToken, ...input,
      } });
      assert.equal(guarded.isError, true);
      assert.equal(JSON.parse((guarded.content[0] as any).text).code, "UPGRADE_PENDING");
    }
    assert.equal(fixture.calls.filter((op) => op === "query").length, before);
    legacyBatch5 = false;
    const unsupportedShare = await client.callTool({
      name: "orvane_netsuite_query",
      arguments: {
        targetId: status.environments[0].targetId,
        identityToken: identity.identityToken,
        sql: "SELECT id FROM employee ORDER BY id", shareInFlight: true,
      },
    });
    assert.equal(unsupportedShare.isError, true);
    assert.equal(JSON.parse((unsupportedShare.content[0] as any).text).code, "UPGRADE_PENDING");
    assert.equal(fixture.calls.filter((op) => op === "query").length, before);
    failStatus = true;
    const unavailableShare = await client.callTool({
      name: "orvane_netsuite_query",
      arguments: {
        targetId: status.environments[0].targetId,
        identityToken: identity.identityToken,
        sql: "SELECT id FROM employee ORDER BY id", shareInFlight: true,
      },
    });
    failStatus = false;
    assert.equal(unavailableShare.isError, true);
    assert.equal(JSON.parse((unavailableShare.content[0] as any).text).code, "TEST_STATUS_FAILURE");
    assert.equal(fixture.calls.filter((op) => op === "query").length, before);
    const query = await client.callTool({
      name: "orvane_netsuite_query",
      arguments: {
        targetId: status.environments[0].targetId,
        identityToken: identity.identityToken,
        sql: "SELECT id FROM employee ORDER BY id",
      },
    });
    assert.notEqual(query.isError, true);
    assert.equal((query.structuredContent as any).result.data.pageSize, 100);
  }
  await assert.rejects(readFile(join(directory, "mcp-bridge.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(directory, "workspace.sqlite")), {
    code: "ENOENT",
  });
});

test("missing Desktop is explicit and never falls back to Magic", async () => {
  await assert.rejects(
    desktopNetSuiteRequest(join(tmpdir(), "orvane-ns-absent-profile"), {
      operation: "status",
    }),
    { code: "DESKTOP_UNAVAILABLE" },
  );
});

test("same-origin windows have distinct explicit targets and closed hosts are rejected", async () => {
  const a = { id: 1, isDestroyed: () => false },
    b = { id: 2, isDestroyed: () => false };
  let hosts = [a, b];
  const dispatch = createNetSuiteReadService({
    instanceId: "two-windows",
    hosts: () => hosts,
    service: {
      environments: async () => [
        { id: "https://123.app.netsuite.com", status: "ready" },
      ],
      run: async () => ({ account: "123", id: 5, role: 3 }),
    },
  });
  const status = await dispatch({ operation: "status" });
  assert.equal(status.environments.length, 2);
  assert.notEqual(
    status.environments[0].targetId,
    status.environments[1].targetId,
  );
  const targetId = status.environments[0].targetId;
  hosts = [b];
  await assert.rejects(
    dispatch({ operation: "status", action: "inspect", targetId }),
    { code: "TARGET_UNAVAILABLE" },
  );
});

test("UI and direct service calls serialize on the same processing executor", async () => {
  const handlers: Record<string, Function> = {};
  const host = {
    id: 9,
    isDestroyed: () => false,
    getURL: () => "http://localhost:5173/",
  };
  let running = 0,
    maximum = 0,
    released = 0;
  const guest = {
    executeJavaScript: async () => {
      running++;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      return JSON.stringify({ result: { rows: [] } });
    },
  };
  const sandbox = {
    ipcMain: {
      handle: (name: string, handler: Function) => {
        handlers[name] = handler;
      },
    },
    webContents: {},
  };
  (globalThis as any).__netsuiteQueueTest = sandbox;
  const source = (
    await readFile(resolve("electron/netsuite.mjs"), "utf8")
  ).replace(
    'import { ipcMain, webContents } from "electron";',
    "const { ipcMain, webContents } = globalThis.__netsuiteQueueTest;",
  );
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  const service = module.setupNetSuite(
    (url: string) => url === host.getURL(),
    {},
    {
      acquire: () => ({
        contents: guest,
        release: () => {
          released++;
        },
      }),
    },
  );
  await Promise.all([
    service.run(host, "https://123.app.netsuite.com", "query", {
      sql: "SELECT id FROM employee",
    }),
    handlers["orvane:netsuite-run"](
      { sender: host },
      "https://123.app.netsuite.com",
      "query",
      { sql: "SELECT id FROM employee" },
    ),
  ]);
  assert.equal(maximum, 1);
  assert.equal(released, 2);
  delete (globalThis as any).__netsuiteQueueTest;
});
