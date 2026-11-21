import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { agentEnvironment } from "../server/agent-cli";

const claudeId = "11111111-1111-4111-8111-111111111111";
const codexId = "22222222-2222-4222-8222-222222222222";
const base = "/__orvane/agents/";

test("the AI launcher starts in Surveying and global search can reopen the session", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120_000);
  const { directory } = await fixture(context);
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  const dock = page.getByRole("navigation", { name: "Canvas apps" });
  const aiButton = dock.getByRole("button", {
    name: "AI launcher",
    exact: true,
  });
  const launcher = page.getByRole("dialog", { name: "AI launcher" });
  const menus = page.locator(".agent-launcher-popovers");
  const prompt = launcher.getByRole("textbox", { name: "Task prompt" });
  async function expectDockGap() {
    await expect
      .poll(async () => {
        const box = (await launcher.boundingBox())!;
        const bar = (await dock.boundingBox())!;
        return bar.y - box.y - box.height;
      })
      .toBeCloseTo(10, 0);
  }
  async function openPicker(name: string) {
    const trigger = launcher.getByRole("combobox", { name, exact: true });
    await trigger.click();
    const menu = menus.locator(".select-popover");
    await expect(menu).toBeVisible();
    await expect
      .poll(async () => {
        const control = (await trigger.boundingBox())!;
        const list = (await menu.boundingBox())!;
        return Math.max(
          Math.abs(list.x - control.x),
          Math.abs(control.y - list.y - list.height - 5),
        );
      })
      .toBeLessThan(2);
  }

  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 600 });
  await page.evaluate(() => {
    document.addEventListener("transitionrun", (event) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.id !== "agent-launcher" ||
        event.propertyName !== "opacity"
      )
        return;
      if (target.classList.contains("agent-launcher-enter-active"))
        document.documentElement.dataset.launcherEntered = "true";
      if (target.classList.contains("agent-launcher-leave-active"))
        document.documentElement.dataset.launcherLeft = "true";
    });
  });
  await aiButton.click();
  await expect(prompt).toBeFocused({ timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute(
    "data-launcher-entered",
    "true",
  );
  await expectDockGap();
  const material = (element: Element) => {
    const { backgroundColor, backdropFilter } = getComputedStyle(element);
    return { backgroundColor, backdropFilter };
  };
  const banner = await page.locator(".topbar-frost").evaluate(material);
  expect(banner.backdropFilter).toBe("blur(8px) saturate(1.2)");
  expect(await launcher.evaluate(material)).toEqual(banner);
  await expect(launcher.locator(".agent-composer")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await openPicker("Working folder");
  await menus.getByRole("combobox", { name: "Find a folder" }).press("Escape");
  await aiButton.click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-launcher-left",
    "true",
  );
  await expect(launcher).toBeHidden();
  await page.setViewportSize(viewport);
  await page.keyboard.press("Control+Shift+k");
  await expect(prompt).toBeFocused({ timeout: 15000 });
  await expectDockGap();
  await prompt.fill("Keep this draft");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("orvane:guest-pointer-down")),
  );
  await expect(launcher).toHaveCount(0);
  await page.keyboard.press("Control+Shift+k");
  await expect(prompt).toHaveValue("Keep this draft");
  await expect(
    launcher.getByRole("combobox", { name: "Working folder" }),
  ).toHaveText("Surveying");
  await prompt.press("End");
  await prompt.press("Shift+Enter");
  await expect(prompt).toHaveValue("Keep this draft\n");
  await prompt.press("Escape");
  await expect(launcher).toBeVisible();
  await expect(prompt).not.toBeFocused();
  await openPicker("Provider");
  await menus.getByRole("option", { name: "Claude Code" }).click();
  await openPicker("Model");
  await menus.getByRole("combobox", { name: "Find a model" }).fill("5.2");
  await menus.getByRole("option", { name: "Fable 5.2" }).click();
  await openPicker("Provider");
  await menus.getByRole("option", { name: "Codex", exact: true }).click();
  await openPicker("Model");
  await page.screenshot({ path: info.outputPath("ai-model-menu.png") });
  await menus.getByRole("option", { name: "Test Codex model" }).click();
  await prompt.fill("Survey the launcher workflow");
  await page.screenshot({ path: info.outputPath("ai-launcher.png") });
  await launcher.getByRole("button", { name: "Add context" }).click();
  await launcher
    .getByRole("textbox", { name: "Attachment path" })
    .fill(join(directory, "project"));
  await launcher.getByRole("button", { name: "Add path" }).click();
  await launcher.getByRole("button", { name: "Start task" }).click();
  await expect(launcher).toHaveCount(0, { timeout: 30_000 });
  const app = page.locator(".agent-sessions-app");
  const activity = app.getByRole("list", { name: "Run activity" });
  await expect(
    activity.getByText("orvane / workspace_status", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    activity.getByText("In progress", { exact: true }),
  ).toBeVisible();
  await writeFile(join(directory, "finish-launcher"), "");
  await expect(app.getByText("Codex started", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(
    activity.getByText("Checked the workspace layout."),
  ).toBeVisible();
  await expect(app.getByText("Private fixture output")).toHaveCount(0);
  // Finished steps show a drawn tick, not a struck-through "Done".
  const done = activity.locator(".state.is-completed").first();
  await expect(done.locator("svg.tick")).toBeVisible();
  expect(
    await done.evaluate((node) => getComputedStyle(node).textDecorationLine),
  ).toBe("none");
  // A step opens in place to show what it was given and what it returned.
  const step = activity.getByRole("button", {
    name: /orvane \/ workspace_status/,
  });
  await step.click();
  await expect(step).toHaveAttribute("aria-expanded", "true");
  await expect(activity.getByText("Private fixture output")).toBeVisible();
  const command = activity.getByRole("button", { name: /Shell command/ });
  await command.click();
  await expect(activity.locator("dd", { hasText: "verify" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("ai-step-details.png") });
  await step.click();
  await expect(activity.getByText("Private fixture output")).toHaveCount(0);
  const [input] = (await readFile(join(directory, "inputs.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(input.folder).toBe(join(directory, "Surveying"));
  expect(input.args).toEqual(expect.arrayContaining(["--model", "test-codex"]));
  expect(input.message).toContain("Local attachments:");
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "Search", exact: true });
  await search.fill("Survey the launcher workflow");
  await page
    .getByRole("option", { name: /Survey the launcher workflow/ })
    .click();
  await expect(
    app.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
});

async function isolated(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "orvane-test-workspace",
  )!;
  const directory = join(process.cwd(), ".orvane", "tests", cookie.value);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function fixture(context: BrowserContext) {
  const directory = await isolated(context);
  const project = join(directory, "project");
  const claude = join(directory, "claude-projects", "test-project");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(claude, { recursive: true }),
  ]);
  await copyFile(
    join(process.cwd(), "tests", "helpers", "agent-cli.cjs"),
    join(directory, "agent-cli.cjs"),
  );
  await writeFile(
    join(claude, claudeId + ".jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: claudeId,
      cwd: project,
      message: { content: "Existing Claude project" },
    }) + "\n",
  );
  return { directory, project };
}

async function openApp(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Workspace options", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create Agent sessions", exact: true })
    .click();
  const app = page.locator(".agent-sessions-app");
  await expect(app).toBeVisible({ timeout: 30_000 });
  return app;
}

test("starts and resumes Codex from the sessions app and Ctrl+K", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  const app = await openApp(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("combobox");
  await palette.fill("new codex session");
  await expect(
    page.getByRole("option", { name: /New Codex session/ }),
  ).toBeVisible();
  await palette.press("Enter");
  await app.getByRole("textbox", { name: "Project folder" }).fill(project);
  await app.getByRole("button", { name: "Browse", exact: true }).click();
  await app.getByRole("button", { name: "Use this folder" }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Start Codex here");
  await composer.press("Shift+Enter");
  await composer.press("End");
  await page.keyboard.insertText("Second line");
  await composer.press("Enter");
  const chat = app.getByLabel("Session conversation");
  await expect(chat.getByText("Codex started")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    app.getByRole("textbox", { name: "Project folder" }),
  ).toHaveCount(0);
  await expect(chat.getByText(/Start Codex here/)).toBeVisible();
  await expect(chat.getByText("Injected context")).toHaveCount(0);
  await expect(
    app.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await composer.fill("Continue the same Codex session");
  await composer.press("Enter");
  await expect(chat.getByText("Codex resumed")).toBeVisible({
    timeout: 20_000,
  });
  const inputs = (await readFile(join(directory, "inputs.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(inputs[0].folder).toBe(project);
  expect(inputs[0].message).toBe("Start Codex here\nSecond line");
  expect(inputs[1].args).toEqual(
    expect.arrayContaining([
      "resume",
      codexId,
      "workspace-write",
      "sandbox_workspace_write.network_access=false",
    ]),
  );
});

test("streams Claude, routes both decisions and stops the process tree", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const { directory } = await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  const chat = app.getByLabel("Session conversation");
  const approval = app.getByRole("group", {
    name: "Permission request for Write",
  });
  await composer.fill("Allow this change");
  await composer.press("Enter");
  await expect(chat.getByText("Preparing request")).toBeVisible();
  const activity = chat.getByRole("list", { name: "Run activity" });
  await expect(activity.getByText("Thinking", { exact: true })).toBeVisible();
  await expect(
    activity.getByText("orvane / workspace_status", { exact: true }),
  ).toBeVisible();
  await expect(activity.getByText("Failed", { exact: true })).toBeVisible();
  await expect(app.getByText("Private fixture thought")).toHaveCount(0);
  await expect(
    approval.getByText("fixture.txt", { exact: false }),
  ).toBeVisible();
  const duplicate = await page.request.post(base + "start", {
    data: {
      message: "Double send",
      target: {
        key: Buffer.from(`test-project/${claudeId}.jsonl`).toString(
          "base64url",
        ),
      },
    },
  });
  expect(duplicate.status()).toBe(400);
  expect((await duplicate.json()).error).toContain(
    "already has a running message",
  );
  await approval.getByRole("button", { name: "Allow once" }).click();
  await expect(chat.getByText("Write approved")).toBeVisible();
  await expect(approval).toHaveCount(0);
  await expect(
    app.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
  await composer.fill("Deny this change");
  await composer.press("Enter");
  await approval.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(chat.getByText("Write denied")).toBeVisible();
  await expect(
    app.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
  await composer.fill("Wait for Stop");
  await composer.press("Enter");
  await expect(app.getByText("Using Wait", { exact: true })).toBeVisible();
  const descendant = Number(
    await readFile(join(directory, "descendant.txt"), "utf8"),
  );
  await app.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    app.getByRole("status").getByText("Stopped", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => {
      try {
        process.kill(descendant, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  await expect
    .poll(async () => (await readdir(join(directory, "agent-runs"))).length)
    .toBe(3);
});

test("reports missing CLI and signed-out state and rejects invalid or cross-origin starts", async ({
  page,
  context,
}) => {
  const directory = await isolated(context);
  const target = { provider: "codex", folder: directory };
  const start = (target: unknown, origin?: string) =>
    page.request.post(base + "start", {
      data: { target, message: "test" },
      headers: origin ? { Origin: origin } : {},
    });
  const missing = await start(target);
  expect((await missing.json()).error).toContain("No test CLI fixture");
  const unknown = await start({ key: "missing" });
  expect((await unknown.json()).error).toContain("Session not found");
  expect((await start(target, "https://example.com")).status()).toBe(403);
  await fixture(context);
  await writeFile(join(directory, "signed-out"), "");
  const response = await start(target);
  const run = await response.json();
  const stream = await page.request.get(base + "run-events?id=" + run.id);
  expect(await stream.text()).toContain("Run `codex login`");
  expect(await stream.text()).toContain('"status":"failed"');
});

test("the child environment strips subscription overrides", () => {
  const keys = [
    "OpenAI_API_Key",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "test-placeholder";
    const env = agentEnvironment();
    for (const key of keys) expect(env[key]).toBeUndefined();
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
