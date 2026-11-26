import { test, expect, request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAgentGateway, type AgentOperate } from "../server/orvane-host-agents.ts";
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

test("Host serves the desktop Agent Sessions page and scopes its operations to shared projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvane-host-agents-"));
  const shared = join(directory, "shared");
  const privateProject = join(directory, "shared-private");
  const claudeRoot = join(directory, "claude-projects");
  const claudeFolder = join(claudeRoot, "test-project");
  const app = join(directory, "dist");
  await Promise.all([shared, privateProject, claudeFolder, join(app, "assets"), join(shared, "src")]
    .map((folder) => mkdir(folder, { recursive: true })));
  await writeFile(join(app, "host-agents.html"),
    '<script type="module" crossorigin src="/assets/host-test.js"></script><link rel="stylesheet" crossorigin href="/assets/host-test.css">');
  await writeFile(join(app, "assets", "host-test.js"), "export {};");
  await writeFile(join(app, "assets", "host-test.css"), "body{}");
  const seed = (id: string, cwd: string, title: string) =>
    writeFile(join(claudeFolder, id + ".jsonl"), JSON.stringify({ type: "user", cwd, sessionId: id, message: { content: title } }) + "\n");
  await seed("11111111-1111-4111-8111-111111111111", shared, "Shared Claude work");
  await seed("33333333-3333-4333-8333-333333333333", privateProject, "Private transcript");
  const claude = new SessionTranscripts(directory, claudeRoot);
  const codex = new SessionTranscripts(directory, join(directory, "codex-sessions"), undefined, "codex");
  const file = join(directory, "workspace.sqlite");
  const db = new LocalDatabase(file);
  db.saveAppData(defaultModesKey, { claude: "full", codex: "plan" });
  db.close();
  const runs: Record<string, { folder: string; title: string }> = {
    [randomUUID()]: { folder: shared, title: "Shared run" },
    [randomUUID()]: { folder: privateProject, title: "Private run" },
  };
  const [sharedRun, privateRun] = Object.keys(runs);
  // The desktop operations themselves are covered by the Agent Sessions specs;
  // here they only record what the gateway let through.
  const calls: string[] = [];
  const operate: AgentOperate = async (op, _args, _url, _res, reply) => {
    calls.push(op);
    if (op === "claude-profiles") return reply(200, {
      newChatProfileId: "default", draft: { id: "new-account", folder: privateProject },
      profiles: [{ id: "default", name: "Default", folder: privateProject, sessions: 42, running: 3, mcp: true }],
    });
    if (op === "sessions")
      return reply(200, {
        sessions: [...await claude.list(), ...await codex.list()],
        runs: Object.entries(runs).map(([id, run]) => ({ id, provider: "claude", status: "running", awaitingApproval: false, ...run })),
      });
    reply(200, { ok: op });
  };
  const chat = new HostAgentChat([shared], file);
  const agents = hostAgentGateway(chat, { claude, codex },
    { inspect: (id: string) => (runs[id] ? { id, ...runs[id] } : null) as never },
    operate, directory, join(directory, "agent-attachments"));
  const password = "fixture host access";
  const host = await startOrvaneHost({
    address: "127.0.0.1", port: 0, tls: await testTls(), app,
    verifier: await makeHostPasswordVerifier(password), recent: () => [], chat, agents,
  });
  const api = await request.newContext({ ignoreHTTPSErrors: true, baseURL: host.url });
  try {
    expect((await api.post("/__orvane/agents/sessions", { headers: { Origin: host.url }, data: {} })).status()).toBe(401);
    expect((await api.get("/assets/host-test.js")).status()).toBe(401);
    expect((await api.post("/login", { headers: { Origin: host.url }, form: { password } })).status()).toBe(200);
    const page = await (await api.get("/")).text();
    expect(page).toContain('<meta name="orvane-host"');
    expect(page).toContain('<script type="module" crossorigin src="/assets/host-test.js"></script>');
    expect(page).toContain('content="{&#34;claude&#34;:&#34;full&#34;,&#34;codex&#34;:&#34;plan&#34;}"');
    expect(await (await api.get("/assets/host-test.js")).text()).toBe("export {};");
    expect((await api.get("/assets/..%2Fhost-agents.html")).status()).toBe(404);
    const csrf = /name="orvane-csrf" content="([a-f0-9]{64})"/.exec(page)![1]!;
    const call = (area: string, op: string, data: object = {}, headers: Record<string, string> = { "X-Orvane-CSRF": csrf }) =>
      api.post(`/__orvane/${area}/${op}`, { headers: { Origin: host.url, ...headers }, data });

    expect((await call("agents", "sessions", {}, {})).status()).toBe(403);
    expect((await call("agents", "sessions", {}, { "X-Orvane-CSRF": csrf, Origin: "https://another.site" })).status()).toBe(403);
    const listed = await (await call("agents", "sessions")).json();
    expect(listed.sessions.map((session: { title: string }) => session.title)).toEqual(["Shared Claude work"]);
    expect(listed.runs.map((run: { title: string }) => run.title)).toEqual(["Shared run"]);
    const keys = Object.fromEntries((await claude.list()).map((session) => [session.title, session.key]));

    const accounts = await (await call("agents", "claude-profiles")).json();
    expect(accounts.draft).toBeNull();
    expect(accounts.profiles).toEqual([{ id: "default", name: "Default", folder: "", sessions: 0, running: 0, mcp: false }]);
    expect((await call("agents", "claude-profile-add", { name: "Work" })).status()).toBe(404);

    calls.length = 0;
    expect((await call("agents", "read", { key: keys["Private transcript"] })).status()).toBe(404);
    expect((await call("agents", "read", { key: keys["Shared Claude work"] })).status()).toBe(200);
    expect((await call("agents", "start", { message: "Go", target: { provider: "codex", folder: privateProject } })).status()).toBe(404);
    expect((await call("agents", "start", { message: "Go", target: { provider: "codex" } })).status()).toBe(404);
    expect((await call("agents", "start", {
      message: `Review\n\nLocal attachments:\n${JSON.stringify(join(privateProject, "secret.png"))}`, target: { provider: "codex", folder: shared },
    })).status()).toBe(404);
    expect((await call("agents", "start", { message: "Go", target: { provider: "codex", folder: join(shared, "src") } })).status()).toBe(200);
    expect((await call("agents", "inspect-run", { id: privateRun })).status()).toBe(404);
    expect((await call("agents", "stop", { id: sharedRun })).status()).toBe(200);
    expect((await call("agents", "permission", { id: sharedRun, requestId: "r", allow: true })).status()).toBe(403);
    expect((await api.get(`/__orvane/agents/run-events?id=${privateRun}`)).status()).toBe(404);
    for (const desktopOnly of ["host-settings", "mcp-install", "delegation", "schedules", "default-modes", "launcher", "notes-rewrite"])
      expect((await call("agents", desktopOnly)).status()).toBe(404);
    expect(calls).toEqual(["read", "start", "stop"]);

    const roots = await (await call("files", "roots")).json();
    expect(roots.places.map((place: { path: string }) => place.path)).toEqual([roots.home]);
    expect((await call("files", "list", { path: privateProject })).status()).toBe(404);
    expect((await call("files", "list", { path: directory })).status()).toBe(404);
    expect((await call("files", "read", { path: join(shared, "src") })).status()).toBe(404);
    const folder = await (await call("files", "list", { path: shared })).json();
    expect(folder.entries.map((entry: { name: string }) => entry.name)).toEqual(["src"]);
  } finally {
    await api.dispose();
    await host.close();
    claude.close();
    codex.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
  }
});

// Host that was on comes back on at the next launch (also after a restart,
// which suspends it); turning it off keeps it off.
test("Host turns back on at launch when it was on, and stays off once turned off", async () => {
  const { HostSettings } = await import("../server/orvane-host-settings.ts");
  const directory = await mkdtemp(join(tmpdir(), "orvane-host-restore-"));
  const file = join(directory, "workspace.sqlite");
  const launch = () => new HostSettings(directory, file, () => ({ recent: () => [] }));
  const start = {
    action: "start", address: "127.0.0.1", port: 0, projects: [], password: "fixture host access",
    approvals: false, uiMaker: false, terminal: false, browser: false, keepAwake: false,
  } as const;
  try {
    let host = launch();
    expect((await host.execute(start, "http://localhost:5173")).enabled).toBe(true);
    await host.close();
    host = launch();
    expect((await host.execute({ action: "status" }, "")).enabled).toBe(false);
    await host.restore();
    expect((await host.execute({ action: "status" }, "")).enabled).toBe(true);
    // A laptop signs in; the sign-in outlives restarts.
    const url = () => host.execute({ action: "status" }, "").then((status) => status.url!);
    const laptop = await request.newContext({ ignoreHTTPSErrors: true });
    const signedIn = async () => (await (await laptop.get(await url() + "/")).text()).includes("Connect to host") === false;
    try {
      const at = await url();
      expect((await laptop.post(at + "/login", { headers: { Origin: at }, form: { password: start.password }, maxRedirects: 0 })).status()).toBe(303);
      expect(await signedIn()).toBe(true);
      // A desktop restart suspends Host without forgetting it was on.
      await host.execute({ action: "suspend" }, "");
      await host.close();
      host = launch();
      await host.restore();
      expect((await host.execute({ action: "status" }, "")).enabled).toBe(true);
      expect(await signedIn()).toBe(true);
      // Quitting Orvane (close without suspend) keeps it too.
      await host.close();
      host = launch();
      await host.restore();
      expect(await signedIn()).toBe(true);
      // Turning Host off ends every sign-in.
      await host.execute({ action: "stop" }, "");
      await host.close();
      host = launch();
      await host.restore();
      expect((await host.execute({ action: "status" }, "")).enabled).toBe(false);
      expect((await host.execute(start, "http://localhost:5173")).enabled).toBe(true);
      expect(await signedIn()).toBe(false);
      await host.close();
    } finally {
      await laptop.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
