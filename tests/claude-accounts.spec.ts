import { test, expect, type BrowserContext, type Page } from "./fixtures";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const base = "/__orvane/agents/";
const sessionId = "11111111-1111-4111-8111-111111111111";
async function fixture(context: BrowserContext) {
  const namespace = (await context.cookies()).find((cookie) => cookie.name === "orvane-test-workspace")!.value;
  const directory = join(process.cwd(), ".orvane", "tests", namespace);
  const project = join(directory, "project");
  await mkdir(project, { recursive: true });
  await copyFile(join(process.cwd(), "tests/helpers/agent-cli.cjs"), join(directory, "agent-cli.cjs"));
  const api = async (op: string, data: object = {}, status = 200) => {
    // The local server can close an idle keep-alive socket during a long CLI
    // launch. Only reads may retry that transport reset; mutations never do.
    const readOnly = ["inspect-run", "sessions", "read", "usage", "runs", "claude-profiles"].includes(op);
    const response = await context.request.post(base + op, {
      data, headers: { Connection: "close" }, maxRetries: readOnly ? 2 : 0,
    });
    const result = await response.json();
    expect(response.status(), JSON.stringify(result)).toBe(status);
    return result;
  };
  const seed = async (root: string, message: string) => {
    await mkdir(join(root, "test-project"), { recursive: true });
    await writeFile(join(root, "test-project", `${sessionId}.jsonl`), JSON.stringify({
      type: "user", sessionId, cwd: project, timestamp: new Date().toISOString(), message: { content: message },
    }) + "\n");
  };
  return { namespace, directory, project, api, seed };
}

test("Claude accounts isolate duplicate sessions, concurrent runs, queues, usage, MCP and schedules", async ({ context }) => {
  test.setTimeout(240_000);
  const { directory, project, api, seed } = await fixture(context);
  await seed(join(directory, "claude-projects"), "Default existing chat");
  const initial = await api("claude-profiles");
  expect(initial.profiles.map((p: any) => p.id)).toEqual(["default"]);
  const existingWork = join(directory, "existing-work");
  await seed(join(existingWork, "projects"), "Work existing chat");
  const added = await api("claude-profile-add", { id: initial.draft.id, name: "Work", folder: existingWork });
  const workId = added.added;
  const work = added.profiles.find((p: any) => p.id === workId);
  let sessions: any[] = [];
  await expect.poll(async () => { sessions = (await api("sessions")).sessions; return sessions.length; }, { timeout: 10_000 }).toBe(2);
  const defaultSession = sessions.find((s) => s.profileId === "default");
  const workSession = sessions.find((s) => s.profileId === workId);
  expect(defaultSession.sessionId).toBe(workSession.sessionId);
  expect(defaultSession.key).not.toBe(workSession.key);
  expect(workSession.key).toMatch(/^claude@/);
  const first = await api("start", { target: { key: defaultSession.key }, message: "Default permission" }, 202);
  const second = await api("start", { target: { key: workSession.key }, message: "Work permission" }, 202);
  try {
    await expect.poll(async () => (await api("inspect-run", { id: first.id })).permissions.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await api("inspect-run", { id: second.id })).permissions.length, { timeout: 30_000 }).toBe(1);
    expect((await api("read", { key: defaultSession.key, includeRun: true })).run.id).toBe(first.id);
    expect((await api("read", { key: workSession.key, includeRun: true })).run.id).toBe(second.id);
    await api("stop", { id: second.id });
    await expect.poll(async () => (await api("inspect-run", { id: second.id })).status).toBe("stopped");
    expect((await api("inspect-run", { id: first.id })).status).toBe("running");
    await api("permission", { id: first.id, requestId: "permission-1", allow: true });
    await expect.poll(async () => (await api("inspect-run", { id: first.id })).status).toBe("completed");
    expect((await api("usage", { profileId: "default" })).claude.fiveHour.used).toBe(39);
    expect((await api("usage", { profileId: workId })).claude).toBeNull();
    const resumed = await api("start", { target: { key: workSession.key }, message: "Work resumed" }, 202);
    await expect.poll(async () => (await api("inspect-run", { id: resumed.id })).permissions.length, { timeout: 30_000 }).toBe(1);
    await api("queue", { id: resumed.id, message: "Work queued" });
    await api("permission", { id: resumed.id, requestId: "permission-1", allow: true });
    let next = "";
    await expect.poll(async () => { next = (await api("inspect-run", { id: resumed.id })).next; return !!next; }).toBe(true);
    await expect.poll(async () => (await api("inspect-run", { id: next })).permissions.length, { timeout: 30_000 }).toBe(1);
    expect((await api("inspect-run", { id: next })).profileId).toBe(workId);
    await api("permission", { id: next, requestId: "permission-1", allow: true });
    await expect.poll(async () => (await api("inspect-run", { id: next })).status).toBe("completed");
    const inputs = (await readFile(join(directory, "inputs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    for (const input of inputs.filter((item) => item.message.startsWith("Work"))) {
      expect(input.configDir).toBe(work.folder);
      expect(input.args[input.args.indexOf("--resume") + 1]).toBe(join(work.folder, "projects", "test-project", `${sessionId}.jsonl`));
    }
    const defaultConfig = join(directory, ".claude.json");
    const before = await readFile(defaultConfig, "utf8").catch(() => "");
    await api("mcp-install", { provider: "claude", profileId: workId });
    expect(JSON.parse(await readFile(join(work.folder, ".claude.json"), "utf8")).mcpServers.orvane).toBeTruthy();
    await api("mcp-remove", { provider: "claude", profileId: workId });
    expect(await readFile(defaultConfig, "utf8").catch(() => "")).toBe(before);
    expect((await api("usage", { profileId: workId })).claude.fiveHour.used).toBe(39);
    await writeFile(join(work.folder, "auth-email"), "changed@fixture.example");
    await api("claude-profile-check", { id: workId });
    expect((await api("usage", { profileId: workId })).claude).toBeNull();
    expect((await api("usage", { profileId: "default" })).claude.fiveHour.used).toBe(39);
    const saved = await api("schedule-save", { provider: "claude", profileId: workId, folder: project,
      prompt: "Work scheduled", enabled: false, schedule: { kind: "interval", minutes: 60 } });
    expect(saved.schedules[0].profileId).toBe(workId);
    const scheduled = (await api("schedule-run", { id: saved.schedules[0].id })).run;
    expect(scheduled.profileId).toBe(workId);
    await expect.poll(async () => (await api("inspect-run", { id: scheduled.id })).permissions.length, { timeout: 30_000 }).toBe(1);
    await api("permission", { id: scheduled.id, requestId: "permission-1", allow: true });
    await expect.poll(async () => (await api("inspect-run", { id: scheduled.id })).status).toBe("completed");
    expect((await api("schedules")).schedules[0].lastSessionProfileId).toBe(workId);
    expect((await api("claude-profile-remove", { id: workId }, 400)).error).toContain("Scheduled prompts");
    await api("schedule-delete", { id: saved.schedules[0].id });
    await writeFile(join(work.folder, "keep.txt"), "keep account files");
    await api("claude-profile-remove", { id: workId });
    expect(existsSync(join(work.folder, "keep.txt"))).toBe(true);
    expect((await api("read", { key: workSession.key })).session.profileId).toBe(workId);
    expect((await api("start", { target: { key: workSession.key }, message: "Must fail" }, 400)).error).toContain("removed");
  } finally {
    for (const run of (await api("runs")).runs) if (["running", "stopping"].includes(run.status)) await api("stop", { id: run.id });
  }
});

test("desktop delegation keeps Default and its run ID with Claude accounts enabled", async ({ context }) => {
  test.setTimeout(90_000);
  const { api, project } = await fixture(context);
  const requestId = randomUUID();
  const input = { action: "start", requestId, provider: "claude", folder: project, message: "Review delegation" };
  try {
    expect((await api("delegation", input)).runId).toBe(requestId);
    expect((await api("delegation", input)).runId).toBe(requestId);
    const inspect = () => api("inspect-run", { id: requestId });
    await expect.poll(async () => (await inspect()).permissions.length, { timeout: 30_000 }).toBe(1);
    expect((await inspect()).profileId).toBe("default");
    expect((await inspect()).delegationId).toBe(requestId);
    await api("permission", { id: requestId, requestId: "permission-1", allow: true });
    await expect.poll(async () => (await inspect()).status).toBe("completed");
    const nextId = randomUUID();
    await api("delegation", { action: "follow_up", runId: requestId, requestId: nextId, message: "Review again" });
    await expect.poll(async () => (await api("inspect-run", { id: nextId })).permissions.length, { timeout: 30_000 }).toBe(1);
    expect((await api("inspect-run", { id: nextId })).profileId).toBe("default");
    expect((await api("inspect-run", { id: nextId })).delegationId).toBe(requestId);
  } finally {
    for (const run of (await api("runs")).runs) if (["running", "stopping"].includes(run.status)) await api("stop", { id: run.id });
  }
});

async function openApp(page: Page) {
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent sessions", exact: true }).click();
  const app = page.locator(".agent-sessions-app").first();
  await expect(app).toBeVisible({ timeout: 30_000 });
  return app;
}

test("approved account settings and picker work in the app with keyboard and outside dismissal", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const { api, project } = await fixture(context);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const app = await openApp(page);
  await app.getByRole("button", { name: "Settings", exact: true }).click();
  await app.getByRole("button", { name: "Add account", exact: true }).click();
  await app.getByRole("textbox", { name: "Name", exact: true }).fill("Work");
  await app.getByRole("button", { name: "Create account", exact: true }).click();
  // Creation checks the isolated CLI's auth status before returning the row.
  await expect(app.getByRole("listitem", { name: "Work", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(app.getByText("Folder ready", { exact: true })).toBeVisible();
  await app.locator(".as-settings").evaluate((element) => { element.scrollTop = 0; });
  await app.screenshot({ path: info.outputPath("claude-accounts-settings.png") });
  const work = (await api("claude-profiles")).profiles.find((p: any) => p.name === "Work");
  await app.getByRole("button", { name: "Claude", exact: true }).click();
  await app.getByRole("textbox", { name: "Project folder", exact: true }).fill(project);
  const trigger = app.locator(".ap-trigger");
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.press("ArrowDown");
  const picker = page.getByRole("listbox", { name: "Claude account for this chat", exact: true });
  await expect(picker).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("option", { selected: true })).toContainText("Default");
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText("Work");
  await expect(picker).toHaveCount(0);
  await trigger.click();
  await expect(picker).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("claude-account-picker.png") });
  await page.evaluate(() => window.dispatchEvent(new Event("orvane:guest-pointer-down")));
  await expect(picker).toHaveCount(0);
  await trigger.click();
  const outside = app.getByRole("textbox", { name: "Find a session", exact: true });
  await outside.click();
  await expect(picker).toHaveCount(0);
  await expect(outside).toBeFocused();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Run on Work");
  const started = page.waitForRequest((request) => request.url().endsWith(base + "start"), { timeout: 15_000 });
  await composer.press("Enter");
  expect((await started).postDataJSON().target.profileId).toBe(work.id);
  await expect(app.locator(".cs-acct-lock")).toContainText("Work");
  for (const run of (await api("runs")).runs) if (run.status === "running") await api("stop", { id: run.id });
  expect(errors).toEqual([]);
});

test("profile sign-in starts only the fixture CLI in a bound Terminal", async ({ page, context }) => {
  test.setTimeout(120_000);
  const { directory, api } = await fixture(context);
  const initial = await api("claude-profiles");
  const added = await api("claude-profile-add", { id: initial.draft.id, name: "Work" });
  const work = added.profiles.find((p: any) => p.id === added.added);
  await writeFile(join(work.folder, "signed-out"), "fixture");
  await writeFile(join(directory, "slow-login"), "fixture");
  await api("claude-profile-check", { id: work.id });
  const app = await openApp(page);
  await app.getByRole("button", { name: "Settings", exact: true }).click();
  const row = app.getByRole("listitem", { name: "Work", exact: true });
  await row.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".terminal-pane")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => existsSync(join(work.folder, "login-marker")), { timeout: 15_000 }).toBe(true);
  const launches = (await readFile(join(directory, "logins.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(launches).toHaveLength(1);
  expect(launches[0].configDir).toBe(work.folder);
  expect(launches[0].args).toEqual(["auth", "login"]);
  await page.reload();
  await page.getByRole("navigation", { name: "Canvas apps", exact: true }).getByRole("button", { name: "Agent sessions", exact: true }).click();
  const restoredApp = page.locator(".agent-sessions-app").first();
  await restoredApp.getByRole("button", { name: "Settings", exact: true }).click();
  await restoredApp.getByRole("listitem", { name: "Work", exact: true }).getByRole("button", { name: "Show Terminal", exact: true }).click();
  await expect(page.locator(".terminal-pane")).toBeInViewport();
  await api("claude-profile-login-cancel", { id: work.id });
  await expect.poll(async () => (await api("claude-profiles")).profiles.find((p: any) => p.id === work.id).signingIn).toBe(false);
});

test("removed-account history remains readable with a read-only composer", async ({ page, context }) => {
  test.setTimeout(90_000);
  const { api, seed } = await fixture(context);
  const initial = await api("claude-profiles");
  const added = await api("claude-profile-add", { id: initial.draft.id, name: "Work" });
  const work = added.profiles.find((profile: any) => profile.id === added.added);
  await seed(join(work.folder, "projects"), "Removed Work history");
  await api("claude-profile-remove", { id: work.id });
  const app = await openApp(page);
  await app.getByRole("button", { name: /Removed Work history/ }).first().click();
  await expect(app.getByRole("textbox", { name: "Message", exact: true })).not.toBeEditable();
  await expect(app.locator(".ac-chip")).toContainText("Work · removed");
  await expect(app.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(app.getByLabel("Session conversation")).toContainText("Removed Work history");
});
