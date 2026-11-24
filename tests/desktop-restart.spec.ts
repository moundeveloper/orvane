import { chromium, expect, test, type Browser } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import electron from "electron";

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No test port.");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

test("desktop_restart cancels while saving and relaunches the isolated desktop after saving", async ({}, info) => {
  test.setTimeout(150_000);
  const port = await freePort();
  const debugPort = await freePort();
  const origin = `http://localhost:${port}`;
  const debug = `http://127.0.0.1:${debugPort}`;
  const data = info.outputPath("data");
  const project = join(data, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ORVANE_DATA_DIR: data, ORVANE_MCP_STATE_DIR: data,
    ORVANE_HOST_ENABLED: "0", ORVANE_PORT: String(port), ORVANE_USER_DATA: info.outputPath("profile") };
  const desktop = spawn(electron as unknown as string, ["electron/main.mjs", `--remote-debugging-port=${debugPort}`], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let log = "";
  for (const stream of [desktop.stdout, desktop.stderr]) stream.on("data", (chunk) => { log += chunk; });
  let oldBrowser: Browser | undefined;
  let newBrowser: Browser | undefined;
  const client = new Client({ name: "desktop-restart-test", version: "1.0.0" });
  const endpoint = async () => {
    const response = await fetch(debug + "/json/version", { signal: AbortSignal.timeout(1000) });
    return (await response.json()).webSocketDebuggerUrl as string;
  };
  const call = async (action: "schedule" | "status" | "cancel") => {
    const response = await client.callTool({ name: "desktop_restart", arguments: { action } });
    if (response.isError) throw Error(JSON.stringify(response.content));
    return (response.structuredContent as { result: { state: string; waitingFor?: string } }).result;
  };
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [resolve("server/launch.mjs")], stderr: "pipe",
      env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: origin },
    }));
    const ready = async () => {
      const result = await client.callTool({ name: "workspace_status" });
      return (result.structuredContent as { result?: { connected?: boolean } })?.result?.connected;
    };
    await expect.poll(ready, { timeout: 65_000 }).toBe(true);
    const firstEndpoint = await endpoint();
    oldBrowser = await chromium.connectOverCDP(firstEndpoint);
    const page = oldBrowser.contexts()[0].pages().find((candidate) => candidate.url() === origin + "/")!;
    await expect(page.locator('main[data-ready="true"]')).toBeVisible();
    await expect(page.locator('main[data-saved="true"]')).toBeVisible();
    let releaseSave!: () => void;
    const holdSave = new Promise<void>((done) => { releaseSave = done; });
    const canvasApps = (target: typeof page) => target.locator(".canvas-app")
      .evaluateAll((apps) => apps.map((app) => app.getAttribute("data-app-id")));
    const initialApps = await canvasApps(page);
    let createdApp: string | null | undefined;
    await page.route("**/__orvane/storage/state", async (route) => {
      if (route.request().method() === "PUT") await holdSave;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: "Workspace options" }).click();
      await page.getByRole("button", { name: "Create Notes", exact: true }).click();
      await expect(page.locator('main[data-saved="false"]')).toBeVisible();
      createdApp = (await canvasApps(page)).find((id) => !initialApps.includes(id));
      expect(createdApp).toBeTruthy();
      expect(await call("schedule")).toMatchObject({ state: "pending" });
      expect(await call("schedule")).toMatchObject({ state: "pending" });
      await expect.poll(() => call("status")).toMatchObject({ state: "pending", waitingFor: "workspace-save" });
      expect(await call("cancel")).toEqual({ state: "cancelled" });
    } finally {
      releaseSave();
    }
    await expect(page.locator('main[data-saved="true"]')).toBeVisible();
    await page.unroute("**/__orvane/storage/state");
    expect(await call("status")).toEqual({ state: "cancelled" });
    expect(await endpoint()).toBe(firstEndpoint);

    const hostSettings = "/__orvane/agents/host-settings";
    const host = await page.request.post(origin + hostSettings, { data: {
      action: "start", address: "127.0.0.1", port: 0, projects: [project], password: "desk42",
      approvals: false, uiMaker: false,
    } });
    expect(host.ok()).toBe(true);
    expect((await host.json()).enabled).toBe(true);

    expect(await call("schedule")).toMatchObject({ state: "pending" });
    await expect.poll(() => desktop.exitCode, { timeout: 25_000 }).toBe(0);
    let secondEndpoint = firstEndpoint;
    await expect.poll(async () => {
      secondEndpoint = await endpoint().catch(() => firstEndpoint);
      return secondEndpoint;
    }, { timeout: 60_000 }).not.toBe(firstEndpoint);
    newBrowser = await chromium.connectOverCDP(secondEndpoint);
    const pages = newBrowser.contexts()[0];
    await expect.poll(() => pages.pages().some((candidate) => candidate.url() === origin + "/"), { timeout: 60_000 }).toBe(true);
    const restarted = pages.pages().find((candidate) => candidate.url() === origin + "/")!;
    await expect(restarted.locator('main[data-ready="true"]')).toBeVisible();
    await expect(restarted.locator(`[data-app-id="${createdApp}"]`).first()).toBeVisible();
    await expect.poll(ready).toBe(true);
    expect(await call("status")).toEqual({ state: "idle" });
    const settings = await restarted.request.post(origin + hostSettings, { data: { action: "status" } });
    expect(await settings.json()).toMatchObject({ enabled: false, passwordSet: true });
  } finally {
    await info.attach("desktop-log", { body: log, contentType: "text/plain" });
    await client.close();
    if (newBrowser?.isConnected()) {
      const cdp = await newBrowser.newBrowserCDPSession();
      // Electron may close the transport without completing the CDP call.
      void cdp.send("Browser.close").catch(() => undefined);
      await expect.poll(() => newBrowser?.isConnected(), { timeout: 10_000 }).toBe(false);
    }
    if (oldBrowser?.isConnected()) await oldBrowser.close().catch(() => undefined);
    if (desktop.exitCode === null) desktop.kill();
  }
});
