import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { agentSessionsApi } from "../server/agent-sessions-api.ts";
import { localStorageApi } from "../server/storage-api.ts";
import { mcpDiscovery } from "../server/discovery.ts";
import type { AgentDelegationInput } from "../src/agentDelegation.ts";

test("agent_delegate runs in the desktop runner, replays safely, resumes and stops", async ({ page, context }) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "orvane-delegate-"));
  const namespace = randomUUID();
  const fixture = join(directory, "tests", namespace);
  const folder = join(fixture, "project");
  await Promise.all([
    mkdir(folder, { recursive: true }),
    mkdir(join(fixture, "claude-projects", "test-project"), { recursive: true }),
  ]);
  await copyFile(resolve("tests/helpers/agent-cli.cjs"), join(fixture, "agent-cli.cjs"));
  const vite = await createServer({
    configFile: false,
    mode: "test-storage",
    cacheDir: join(directory, "vite-cache"),
    plugins: [vue(), localStorageApi(directory), agentSessionsApi(directory), mcpDiscovery(directory)],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  const client = new Client({ name: "coordinator-test", version: "1.0.0" });
  const delegate = new Client({ name: "delegate-test", version: "1.0.0" });
  try {
    await vite.listen();
    const binding = vite.httpServer?.address();
    if (!binding || typeof binding === "string") throw Error("No workspace listener.");
    const origin = `http://127.0.0.1:${binding.port}`;
    await context.setExtraHTTPHeaders({ "x-orvane-test-workspace": namespace });
    await context.addCookies([{ name: "orvane-test-workspace", value: namespace, url: origin }]);
    const env = {
      ORVANE_MCP_STATE_DIR: directory, ORVANE_DATA_DIR: directory,
      ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: origin,
    };
    const transport = (extra: Record<string, string> = {}) => new StdioClientTransport({
      command: process.execPath, args: [resolve("server/launch.mjs")], env: { ...env, ...extra }, stderr: "pipe",
    });
    await client.connect(transport());
    const raw = (request: AgentDelegationInput) => client.callTool({ name: "agent_delegate", arguments: { request } });
    const call = async (request: AgentDelegationInput) => {
      const result = await raw(request);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: Record<string, unknown> }).result;
    };
    await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
    await page.goto(origin);
    await expect.poll(async () => {
      const status = await client.callTool({ name: "workspace_status" });
      return (status.structuredContent as { result: { connected: boolean } }).result.connected;
    }).toBe(true);

    const runId = randomUUID();
    const start = { action: "start", requestId: runId, provider: "claude", folder, model: "opus", message: "Review the mock" } as const;
    const [first, replay] = await Promise.all([call(start), call(start)]);
    expect(first.runId).toBe(runId);
    expect(replay.runId).toBe(runId);
    expect((await raw({ ...start, message: "Different brief" })).isError).toBe(true);
    const status = (id = runId) => call({ action: "status", runId: id });
    const restartReady = async () => {
      const response = await page.request.post(origin + "/__orvane/agents/desktop-restart-ready", { data: {} });
      expect(response.ok()).toBe(true);
      return (await response.json()).ready;
    };
    const waitForApproval = (id: string) => expect.poll(async () => {
      const view = await status(id);
      if (view.status === "failed") throw Error(String(view.error));
      return view.awaitingApproval;
    }, { timeout: 30_000 }).toBe(true);
    await waitForApproval(runId);
    expect(await restartReady()).toBe(false);
    expect((await raw({ action: "follow_up", runId, requestId: randomUUID(), message: "Too soon" })).isError).toBe(true);
    const approve = (id: string, allow: boolean) =>
      page.request.post(origin + "/__orvane/agents/permission", { data: { id, requestId: "permission-1", allow } });
    expect((await approve(runId, true)).ok()).toBe(true);
    await expect.poll(async () => (await status()).result).toBe("Write approved");
    await expect.poll(restartReady).toBe(true);
    expect((await status()).sessionKey).toBeTruthy();

    const saveClaudeMode = async (claude: "ask" | "full") => {
      const response = await page.request.post(origin + "/__orvane/agents/default-modes", { data: { claude } });
      expect(response.ok()).toBe(true);
    };
    await saveClaudeMode("full");

    const nextId = randomUUID();
    const next = await call({ action: "follow_up", runId, requestId: nextId, message: "Check the preview again" });
    expect(next.delegationId).toBe(runId);
    expect(next.sessionId).toBe((await status()).sessionId);
    await waitForApproval(nextId);
    expect((await approve(nextId, false)).ok()).toBe(true);
    await expect.poll(async () => (await status(nextId)).result).toBe("Write denied");
    const logged = (await readFile(join(fixture, "inputs.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(logged.map((entry) => entry.message)).toEqual(["Review the mock", "Check the preview again"]);
    expect(logged[1].args).toContain("--resume");

    const stoppedId = randomUUID();
    await call({ ...start, requestId: stoppedId, mode: "ask", message: "Review the settings mock" });
    await waitForApproval(stoppedId);
    await call({ action: "stop", runId: stoppedId });
    await expect.poll(async () => (await status(stoppedId)).status).toBe("stopped");

    const fullId = randomUUID();
    await call({ ...start, requestId: fullId, message: "Preview in full access" });
    await expect.poll(async () => {
      const view = await status(fullId);
      if (view.awaitingApproval || view.status === "failed") return view;
      return view.result;
    }).toBe("Preview ready");
    await saveClaudeMode("ask");
    expect((await call({ ...start, requestId: fullId, message: "Preview in full access" })).result).toBe("Preview ready");
    const overrideId = randomUUID();
    await call({ ...start, requestId: overrideId, mode: "full", message: "Preview in full access" });
    await expect.poll(async () => (await status(overrideId)).result).toBe("Preview ready");

    const codexId = randomUUID();
    await call({ ...start, requestId: codexId, provider: "codex", model: undefined, message: "Review the host plan" });
    await expect.poll(async () => (await status(codexId)).result, { timeout: 30_000 }).toBe("Codex started");

    await delegate.connect(transport({ ORVANE_DELEGATED_RUN: runId }));
    const names = (await delegate.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("uimaker_lab_write");
    expect(names).not.toContain("agent_delegate");
    expect(names).not.toContain("desktop_restart");
  } finally {
    await delegate.close();
    await client.close();
    await page.close();
    await vite.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
  }
});
