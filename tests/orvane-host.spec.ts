import { test, expect, request } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner } from "../server/agent-runner.ts";
import { defaultModesKey, HostAgentChat } from "../server/orvane-host-chat.ts";
import { LocalDatabase } from "../server/database.ts";
import { makeHostPasswordVerifier, startOrvaneHost } from "../server/orvane-host.ts";
import { SessionTranscripts } from "../server/session-transcripts.ts";

const testTls = async () => ({
  cert: await readFile("tests/fixtures/netsuite-login/cert.pem"),
  key: await readFile("tests/fixtures/netsuite-login/key.pem"),
});

test("Host serves live status after HTTPS sign-in and revokes the browser on sign-out", async ({ browser }, info) => {
  const password = "fixture host access";
  const options = {
    address: "127.0.0.1",
    port: 0,
    tls: await testTls(),
    verifier: await makeHostPasswordVerifier(password),
    recent: () => [{ id: "example", provider: "claude", folder: "private-path", title: "Compare the two versions", status: "running", awaitingApproval: true }] as const,
  };
  await expect(startOrvaneHost({ ...options, address: "0.0.0.0", recent: () => [] })).rejects.toThrow("private IPv4");
  const host = await startOrvaneHost({ ...options, recent: () => [...options.recent()] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const api = await request.newContext({ ignoreHTTPSErrors: true, baseURL: host.url });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(host.url);
    await expect(page.getByRole("heading", { name: "Connect to host" })).toBeVisible();
    await expect.poll(() => page.locator(".wordmark img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(async () => (await document.fonts.load('13px "Inter Variable"')).length)).toBe(1);
    await page.screenshot({ path: info.outputPath("laptop-sign-in.png") });
    expect((await api.get("/api/runs")).status()).toBe(401);
    expect((await api.get("/watch.js")).status()).toBe(401);
    expect((await api.post("/login", { headers: { Origin: "https://another.site" }, form: { password } })).status()).toBe(403);
    await page.getByLabel("Access password").fill("incorrect");
    const rejected = page.waitForResponse((response) => response.url() === host.url + "/login");
    await page.getByRole("button", { name: "Connect" }).click();
    expect((await rejected).status()).toBe(401);
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByLabel("Access password").fill(password);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Compare the two versions")).toBeVisible();
    await expect(page.getByText("Needs approval")).toBeVisible();
    await page.screenshot({ path: info.outputPath("orvane-host.png") });
    const cookie = (await context.cookies()).find((entry) => entry.name === "__Host-orvane")!;
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Strict" });
    const auth = { cookie: cookie.name + "=" + cookie.value };
    expect(await (await api.get("/api/runs", { headers: auth })).json()).toEqual({
      runs: [{ provider: "Claude Code", title: "Compare the two versions", status: "running", awaitingApproval: true }],
    });
    expect((await api.get("/__orvane/agents/sessions", { headers: auth })).status()).toBe(404);
    expect((await api.post("/__orvane/agents/desktop-restart-ready", {
      headers: { ...auth, origin: host.url }, data: {},
    })).status()).toBe(404);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Connect to host" })).toBeVisible();
    expect((await api.get("/api/runs", { headers: auth })).status()).toBe(401);
  } finally {
    await api.dispose();
    await context.close();
    await host.close();
  }
});

test("Host sends use the desktop's default edit mode instead of always asking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvane-host-mode-"));
  const shared = join(directory, "shared");
  const fixture = join(directory, "agent-cli.cjs");
  await mkdir(shared, { recursive: true });
  await copyFile("tests/helpers/agent-cli.cjs", fixture);
  const claude = new SessionTranscripts(directory, join(directory, "claude-projects"));
  const codex = new SessionTranscripts(directory, join(directory, "codex-sessions"), undefined, "codex");
  const runner = new AgentRunner(directory, () => undefined, () => ({ file: process.execPath, args: [fixture] }));
  const file = join(directory, "workspace.sqlite");
  const db = new LocalDatabase(file);
  db.saveAppData(defaultModesKey, { claude: "full", codex: "plan" });
  db.close();
  const chat = new HostAgentChat([shared], { claude, codex }, runner, file);
  try {
    const [project] = await chat.projects();
    const claudeRun = await chat.act({ action: "start", project: project!.id, requestId: randomUUID(), provider: "claude", message: "One" });
    const codexRun = await chat.act({ action: "start", project: project!.id, requestId: randomUUID(), provider: "codex", message: "Two" });
    expect(runner.inspect(claudeRun.runId)?.mode).toBe("full");
    expect(runner.inspect(codexRun.runId)?.mode).toBe("plan");
  } finally {
    for (const run of runner.recent()) runner.stop(run.id);
    await chat.close();
    runner.close();
    claude.close();
    codex.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
  }
});

test("Host opens shared transcripts and resumes one turn after a lost acknowledgement", async ({ browser }, info) => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "orvane-host-chat-"));
  const shared = join(directory, "shared");
  const privateProject = join(directory, "shared-private");
  const fixture = join(directory, "agent-cli.cjs");
  const codexRoot = join(directory, "codex-sessions");
  const claudeRoot = join(directory, "claude-projects");
  const claudeFolder = join(claudeRoot, "test-project");
  const dateFolder = join(codexRoot, "2026", "11", "21");
  await Promise.all([shared, privateProject, claudeFolder, dateFolder].map((folder) => mkdir(folder, { recursive: true })));
  await copyFile("tests/helpers/agent-cli.cjs", fixture);
  const codexId = "22222222-2222-4222-8222-222222222222";
  const seed = (id: string, cwd: string, title: string) => [
    { type: "session_meta", payload: { id, cwd } },
    { type: "event_msg", payload: { type: "user_message", message: title } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Original host reply" }] } },
  ].map((record) => JSON.stringify({ ...record, timestamp: "2026-11-21T10:00:00.000Z" })).join("\n") + "\n";
  await writeFile(join(dateFolder, "rollout.jsonl"), seed(codexId, shared, "Shared Codex work"));
  await writeFile(join(dateFolder, "private.jsonl"), seed("33333333-3333-4333-8333-333333333333", privateProject, "Private transcript"));
  const claudeId = "11111111-1111-4111-8111-111111111111";
  await writeFile(join(claudeFolder, claudeId + ".jsonl"), JSON.stringify({
    type: "user", cwd: shared, sessionId: claudeId, message: { content: "Shared Claude work" },
  }) + "\n");
  const claude = new SessionTranscripts(directory, claudeRoot);
  const codex = new SessionTranscripts(directory, codexRoot, undefined, "codex");
  const runner = new AgentRunner(directory, () => { claude.invalidate(); codex.invalidate(); },
    () => ({ file: process.execPath, args: [fixture] }));
  const chat = new HostAgentChat([shared], { claude, codex }, runner, join(directory, "workspace.sqlite"));
  const password = "fixture host access";
  const host = await startOrvaneHost({
    address: "127.0.0.1", port: 0, tls: await testTls(),
    verifier: await makeHostPasswordVerifier(password), recent: () => runner.recent(), chat,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 850, height: 720 } });
  try {
    const page = await context.newPage();
    await page.goto(host.url);
    expect((await page.request.get(host.url + "/api/sessions")).status()).toBe(401);
    await page.getByLabel("Access password").fill(password);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: /Shared Codex work/ }).click();
    await expect(page.getByText("Original host reply")).toBeVisible();
    await expect(page.getByRole("button", { name: /Private transcript/ })).toHaveCount(0);
    const { sessions, csrf } = await (await page.request.get(host.url + "/api/sessions")).json();
    expect(sessions).toHaveLength(2);
    expect(JSON.stringify(sessions)).not.toContain(shared);
    const privateKey = "codex:" + Buffer.from("2026/11/21/private.jsonl").toString("base64url");
    const privateId = createHash("sha256").update("codex\0" + privateKey).digest("hex");
    expect((await page.request.get(host.url + "/api/chat?session=" + privateId)).status()).toBe(404);
    const session = sessions.find((entry: { provider: string }) => entry.provider === "Codex");
    const action = { action: "send", session: session.id, requestId: codexId, message: "Unauthorised attempt" };
    expect((await page.request.post(host.url + "/api/chat", { headers: { Origin: host.url }, data: action })).status()).toBe(403);
    expect((await page.request.post(host.url + "/api/chat", {
      headers: { Origin: host.url, "X-Orvane-CSRF": csrf }, data: { ...action, session: privateId },
    })).status()).toBe(404);
    expect((await page.request.post(host.url + "/api/chat", {
      headers: { Origin: host.url, "X-Orvane-CSRF": csrf },
      data: { ...action, message: 'Review\n\nLocal attachments:\n"C:/agent-attachments/snapshot-private.png"' },
    })).status()).toBe(400);

    let dropped = false;
    await page.route("**/api/chat", async (route) => {
      if (dropped || route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      dropped = true;
      await route.abort("failed");
    });
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue from the laptop");
    await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
    await expect(page.getByText("Send not confirmed.", { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Continue from the laptop");
    await page.getByRole("button", { name: "Retry send" }).click();
    await expect(page.getByText("Codex resumed", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
    await expect(page.getByText("Continue from the laptop", { exact: true })).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("laptop-chat-850.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: info.outputPath("laptop-chat-1280.png") });
    const sent = (await readFile(join(directory, "inputs.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(sent.map(({ message }) => message)).toEqual(["Continue from the laptop"]);
    expect(sent[0].args).toEqual(expect.arrayContaining(["resume", codexId]));

    await page.getByRole("button", { name: /Shared Claude work/ }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Check the plan");
    await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
    await expect(page.getByText("Needs approval in desktop Agent Sessions.")).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => runner.recent().find((run) => run.provider === "claude")?.status).toBe("stopped");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  } finally {
    await context.close();
    await host.close();
    runner.close();
    claude.close();
    codex.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
  }
});
