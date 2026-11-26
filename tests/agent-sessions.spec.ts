import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { agentArgs, agentEnvironment, codexHasOrvaneMcp } from "../server/agent-cli";

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
  // The shared frost material (the header no longer draws a frost band).
  const banner = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "workspace-frost";
    document.querySelector("main.workspace")!.append(probe);
    const { backgroundColor, backdropFilter } = getComputedStyle(probe);
    probe.remove();
    return { backgroundColor, backdropFilter };
  });
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
  // The full-size helix takes the dot's place on the working step.
  const trail = app.getByRole("region", { name: "Run steps" });
  const running = trail.locator(".trail-step.is-running");
  await expect(
    running.getByText("orvane / workspace_status", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(running.locator(".cs-dna")).toBeVisible();
  await expect(running.locator(".dot")).toHaveCount(0);
  await expect(trail.locator(".cs-dna")).toHaveCount(1);
  const rails = await trail.locator(".trail-step").evaluateAll((rows) =>
    rows.map((row) => ({ running: row.classList.contains("is-running"), joins: row.classList.contains("joins") })),
  );
  for (const [index, row] of rails.entries()) {
    if (row.running || rails[index + 1]?.running) expect(row.joins).toBe(false);
  }
  // One loader only: no spinning AI mark beside the DNA loader while it runs.
  await expect(trail.locator(".trail-head .cs-mark")).toHaveCount(0);
  // While a tool step runs, the head says it is working (not "Writing the answer").
  await expect(trail.locator(".cs-trail-state")).toHaveText("Working");
  // No filler line under the steps ("Then it writes the answer").
  await expect(trail.getByText(/writes the answer/i)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("ai-thinking-trail.png") });
  await writeFile(join(directory, "finish-launcher"), "");
  // Once it finishes, its calls fold into a time strip at the top of the
  // reply: one segment per call, closed until opened.
  await expect(app.getByText("Codex started", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  const strip = app.locator(".run-activity.strip").filter({ hasText: "Checked the workspace layout." });
  const activity = strip.getByRole("list", { name: "Tool calls" });
  await expect(strip.locator("summary")).toContainText(/\d+ calls?/);
  await expect(strip.locator(".bars i")).not.toHaveCount(0);
  await expect(activity).toBeHidden();
  // In a reply from the transcript the strip sits above the text.
  const reply = app.locator(".cs-message.cs-assistant", { has: page.locator(".run-activity.strip") }).last();
  const stripTop = (await reply.locator(".run-activity.strip").boundingBox())!.y;
  const textTop = (await reply.locator(".cs-message-text").boundingBox())!.y;
  expect(stripTop).toBeLessThan(textTop);
  // Strip and rows share one selection. A segment opens the list, selects
  // its call and opens that row; the label names the call.
  const segment = strip.locator('.bars i[title^="orvane / workspace_status"]');
  await segment.click();
  await expect(activity).toBeVisible();
  const statusRow = activity.getByRole("button", { name: /orvane \/ workspace_status/ });
  await expect(statusRow).toHaveAttribute("aria-expanded", "true");
  await expect(statusRow).toHaveAttribute("aria-pressed", "true");
  await expect(segment).toHaveClass(/\bsel\b/);
  await expect(strip.locator(".strip-label")).toContainText(/workspace_status · .+ · \d+ of \d+/);
  await page.screenshot({ path: info.outputPath("time-strip-open.png") });
  // Selecting a row selects its segment instead (and closes the other row).
  await activity.getByRole("button", { name: /Shell command/ }).click();
  await expect(strip.locator('.bars i[title^="Shell command"]')).toHaveClass(/\bsel\b/);
  await expect(segment).not.toHaveClass(/\bsel\b/);
  await expect(statusRow).toHaveAttribute("aria-expanded", "false");
  // Clicking the selected one again clears the selection.
  await activity.getByRole("button", { name: /Shell command/ }).click();
  await expect(strip.locator(".bars i.sel")).toHaveCount(0);
  await expect(strip.locator(".strip-label")).toContainText(/\d+ calls?/);
  // The scrolling dock leaves room around the composer, so its rounded
  // bottom corners and shadow aren't cut into square edges.
  const room = await app.locator(".cs-dock").evaluate((dock) => {
    const box = dock.getBoundingClientRect();
    const composer = dock.querySelector(".cs-composer")!.getBoundingClientRect();
    return {
      left: composer.left - box.left,
      right: box.right - composer.right,
      bottom: box.bottom - composer.bottom,
    };
  });
  expect(room.left).toBeGreaterThanOrEqual(12);
  expect(room.right).toBeGreaterThanOrEqual(12);
  expect(room.bottom).toBeGreaterThanOrEqual(12);
  // The finished answer keeps its AI mark.
  await expect(
    app.locator(".cs-message.cs-assistant .cs-message-meta .cs-mark").first(),
  ).toBeVisible();
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
  await expect(activity.getByText("Private fixture output")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("ai-step-details.png") });
  await command.click();
  await expect(activity.locator("dd", { hasText: "verify" })).toHaveCount(0);
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

test("queued follow-ups drain in order and keep the Codex session", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: "Codex", exact: true }).click();
  await app.getByRole("textbox", { name: "Project folder" }).fill(project);
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Survey the launcher workflow for follow-ups");
  await composer.press("Enter");
  await expect(app.getByRole("region", { name: "Run steps" }).getByText("Thinking", { exact: true })).toBeVisible({ timeout: 15_000 });
  await composer.fill("First queued message");
  await composer.press("Enter");
  const queue = app.getByRole("region", { name: "Queued follow-ups" });
  await expect(queue.getByText("First queued message")).toBeVisible();
  await expect(composer).toHaveValue("");
  await composer.fill("Draft to edit");
  await composer.press("Enter");
  await expect(queue.getByText("Draft to edit")).toBeVisible();
  await expect(composer).toHaveValue("");
  await composer.press("Alt+ArrowUp");
  await expect(composer).toHaveValue("Draft to edit");
  await composer.fill("Second queued message");
  await app.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("queued-followups.png") });
  await writeFile(join(directory, "finish-launcher"), "");
  const chat = app.getByLabel("Session conversation");
  await expect(chat.locator(".cs-message").getByText("Second queued message", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(app.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  const inputs = (await readFile(join(directory, "inputs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(inputs.map((input) => input.message)).toEqual([
    "Survey the launcher workflow for follow-ups", "First queued message", "Second queued message",
  ]);
  for (const input of inputs.slice(1))
    expect(input.args).toEqual(expect.arrayContaining(["resume", codexId]));

  await unlink(join(directory, "finish-launcher"));
  await composer.fill("Survey the launcher workflow before interrupt");
  await composer.press("Enter");
  await expect(app.getByRole("region", { name: "Run steps" }).getByText("orvane / workspace_status")).toBeVisible({ timeout: 15_000 });
  await composer.fill("Interrupt and continue");
  await composer.press("Control+Enter");
  await expect(chat.locator(".cs-message").getByText("Interrupt and continue", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(app.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  const resumed = (await readFile(join(directory, "inputs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  expect(resumed.message).toBe("Interrupt and continue");
  expect(resumed.args).toEqual(expect.arrayContaining(["resume", codexId]));
});

test("a long queued follow-up keeps its buttons inside the conversation", async ({ page, context }) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: "Codex", exact: true }).click();
  await app.getByRole("textbox", { name: "Project folder" }).fill(project);
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Survey the launcher workflow for follow-ups");
  await composer.press("Enter");
  await expect(app.getByRole("region", { name: "Run steps" }).getByText("Thinking", { exact: true })).toBeVisible({ timeout: 15_000 });
  await composer.fill(`Check the overflow ${"longwordwithoutbreaks".repeat(11)}`);
  await composer.press("Enter");
  const queue = app.getByRole("region", { name: "Queued follow-ups" });
  const remove = queue.getByRole("button", { name: "Remove" });
  await expect(remove).toBeVisible();
  const chat = app.getByLabel("Session conversation");
  expect(await chat.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  const box = (await queue.boundingBox())!;
  for (const name of ["Edit", "Send now", "Remove"]) {
    const button = (await queue.getByRole("button", { name }).boundingBox())!;
    expect(button.x + button.width, name).toBeLessThanOrEqual(box.x + box.width);
  }
  await writeFile(join(directory, "finish-launcher"), "");
  await expect(queue).toHaveCount(0, { timeout: 20_000 });
});

test("a long continued-session reference doesn't make the conversation scroll sideways", async ({ page, context }) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  const id = "44444444-4444-4444-8444-444444444444";
  const title = "The Orvane owner asked you to implement the next appearance and style pass on the existing branch ".repeat(2).trim();
  const fence = "`".repeat(3);
  const message = [
    "Picking this up again.", "",
    `Continue from the earlier session "${title}" (Claude Code in orvane, session ${id}).`,
    'Its full transcript (JSONL) is at: "C:\transcript.jsonl"',
    "Read it when you need earlier turns.", fence, "Asked: earlier", fence,
  ].join("\n");
  await writeFile(join(directory, "claude-projects", "test-project", id + ".jsonl"), JSON.stringify({
    type: "user", sessionId: id, cwd: project, message: { content: message },
  }) + "\n");
  const app = await openApp(page);
  await app.getByRole("button", { name: /Picking this up again/ }).click();
  const chat = app.getByLabel("Session conversation");
  await expect(chat.locator(".cs-sent-ref")).toBeVisible();
  expect(await chat.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  const dock = app.locator(".cs-dock");
  expect(await dock.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
});

test("the session list hides from beside the search and comes back from the toolbar", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  await fixture(context);
  const app = await openApp(page);
  const list = app.getByRole("navigation", { name: "Agent sessions" });
  const search = list.getByRole("textbox", { name: "Find a session" });
  const hide = list.getByRole("button", { name: "Hide session list" });
  await expect(hide).toBeVisible();
  // Same row and centre line as the search field.
  const field = (await app.locator(".cs-search").boundingBox())!;
  const button = (await hide.boundingBox())!;
  expect(Math.abs(field.y + field.height / 2 - (button.y + button.height / 2))).toBeLessThan(1);
  expect(button.x).toBeGreaterThan(field.x + field.width);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const chat = app.getByLabel("Session conversation");
  const before = (await chat.boundingBox())!.width;
  await hide.click();
  await expect(list).toBeHidden();
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThan(before + 200);
  await page.screenshot({ path: info.outputPath("session-list-hidden.png") });
  const show = app.locator(".cs-toolbar").getByRole("button", { name: "Show session list" });
  await show.click();
  await expect(list).toBeVisible();
  await expect(show).toHaveCount(0);
  await expect(search).toBeVisible();
  // "/" still finds a session once the list is back.
  await chat.click();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
});

test("session row menu tiles a session and the toolbar shows split shortcuts", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  const secondId = "33333333-3333-4333-8333-333333333333";
  await writeFile(join(directory, "claude-projects", "test-project", secondId + ".jsonl"), JSON.stringify({
    type: "user", sessionId: secondId, cwd: project, message: { content: "Second Claude project" },
  }) + "\n");
  const app = await openApp(page);
  const row = app.getByRole("button", { name: /Existing Claude project/ });
  const second = app.getByRole("button", { name: /Second Claude project/ });
  await row.click();
  await row.click({ modifiers: ["Control"] });
  const tiles = app.locator(".cs-tiles").first().locator(":scope > .agent-tiles-layer > .agent-tile");
  await expect(tiles).toHaveCount(1);
  await second.click({ button: "right" });
  const menu = app.getByRole("menu", { name: "Open session in a tile" });
  const open = menu.getByRole("menuitem", { name: /Open in new pane/ });
  await expect(open).toContainText("Ctrl+click");
  await expect(open).toBeFocused();
  await menu.screenshot({ path: info.outputPath("session-row-menu.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(second).toBeFocused();

  const shortcutButton = app.getByRole("button", { name: "Session shortcuts" });
  await shortcutButton.click();
  const guide = app.getByRole("dialog", { name: "Session shortcuts" });
  await expect(guide).toContainText("Alt+Shift+D");
  await expect(guide).toContainText("Ctrl+Shift+W");
  await guide.screenshot({ path: info.outputPath("session-shortcuts.png"), animations: "disabled" });
  await second.click({ button: "right" });
  await expect(guide).toHaveCount(0);
  await open.click();
  await expect(menu).toHaveCount(0);
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(1).locator(".cs-session-header strong").first()).toHaveText(/Second Claude project/);
  await row.click({ modifiers: ["Control"] });
  await expect(tiles.nth(0)).toHaveClass(/focused/);
  await second.click({ button: "right" });
  await expect(open).toHaveCount(0);
  await menu.getByRole("menuitem", { name: /Focus existing pane/ }).click();
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(1)).toHaveClass(/focused/);
});

// Opening a session from the list leaves Settings, also when it lands in a
// split pane or is already open in one.
test("opening a session from the list closes Settings, split or not", async ({ page, context }) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  const secondId = "33333333-3333-4333-8333-333333333333";
  await writeFile(join(directory, "claude-projects", "test-project", secondId + ".jsonl"), JSON.stringify({
    type: "user", sessionId: secondId, cwd: project, message: { content: "Second Claude project" },
  }) + "\n");
  const app = await openApp(page);
  const row = app.getByRole("button", { name: /Existing Claude project/ });
  const second = app.getByRole("button", { name: /Second Claude project/ });
  const nav = app.getByRole("button", { name: "Settings", exact: true });
  const settings = app.getByRole("region", { name: "Settings" });
  const header = app.locator(".cs-session-header strong").first();
  await row.click();
  await nav.click();
  await expect(settings).toBeVisible();
  await row.click();
  await expect(settings).toHaveCount(0);
  await expect(header).toBeVisible();

  // Split: the second session opens in a pane, then each is reopened from the list.
  await second.click({ modifiers: ["Control"] });
  const tiles = app.locator(".cs-tiles").first().locator(":scope > .agent-tiles-layer > .agent-tile");
  await expect(tiles).toHaveCount(2);
  for (const target of [second, row]) {
    await nav.click();
    await expect(settings).toBeVisible();
    await target.click();
    await expect(settings).toHaveCount(0);
    await expect(tiles).toHaveCount(2);
  }
  await nav.click();
  await second.click({ modifiers: ["Control"] });
  await expect(settings).toHaveCount(0);
  await nav.click();
  await second.click({ button: "right" });
  await app.getByRole("menu", { name: "Open session in a tile" }).getByRole("menuitem", { name: /Focus existing pane/ }).click();
  await expect(settings).toHaveCount(0);
  await expect(tiles.nth(1)).toHaveClass(/focused/);
});

test("sessions split into Hyprland-style tiles that resize, swap, close and persist", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  await fixture(context);
  const host = await openApp(page);
  const tiles = host.locator(".cs-tiles").first();
  // Top-level tiles only: a pane runs its own single-tile layout inside.
  const top = ":scope > .agent-tiles-layer > ";
  const tile = tiles.locator(top + ".agent-tile");
  const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;

  // One session: no gaps, no frame, nothing changes from the plain view.
  await host.getByRole("button", { name: /Existing Claude project/ }).click();
  await expect(tile).toHaveCount(1);
  await expect(tile).toHaveCSS("border-radius", "0px");
  expect(await box(tile)).toEqual(await box(tiles));
  const hostTile = tiles.locator(top + ".agent-tile[data-tile=host]");
  const reading = hostTile.getByRole("status").filter({ hasText: "Reading session" });
  await expect(reading).toHaveCount(0, { timeout: 15_000 });

  // Alt+Shift+= splits right with a new session in the same provider and folder.
  await host.getByRole("textbox", { name: "Message", exact: true }).first().press("Alt+Shift+Equal");
  await expect(tile).toHaveCount(2);
  // The first session stays loaded beside the new pane.
  await expect(reading).toHaveCount(0, { timeout: 15_000 });
  const pane = tiles.locator(top + ".agent-tile:not([data-tile=host])");
  await expect(pane.getByRole("textbox", { name: "Project folder" })).toBeFocused();
  await expect(pane.locator(".cs-session-header strong").first()).toHaveText("New Claude Code session");
  await expect(tiles.locator(":scope > .agent-tiles-frames > .agent-tile-frame.focused")).toHaveCount(1);
  await page.waitForTimeout(600);
  // CSS pixels: the canvas may be zoomed.
  const css = (locator: ReturnType<Page["locator"]>) =>
    locator.evaluate((e: HTMLElement) => ({ x: e.offsetLeft, w: e.offsetWidth }));
  const left = await css(hostTile),
    right = await css(pane);
  expect(left.x).toBe(10);
  expect(right.x - (left.x + left.w)).toBe(10);
  expect(Math.abs(left.w - right.w)).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("agent-split.png") });

  // The gap resizes: drag, then double-click and Enter put it back to even.
  const gap = host.getByRole("separator", { name: "Resize session panes" });
  const g = await box(gap);
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 120, g.y + g.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(Number(await gap.getAttribute("aria-valuenow"))).toBeGreaterThan(55);
  await gap.dblclick();
  await expect(gap).toHaveAttribute("aria-valuenow", "50");
  await gap.focus();
  await gap.press("ArrowLeft");
  await expect(gap).toHaveAttribute("aria-valuenow", "45");
  await gap.press("Enter");
  await expect(gap).toHaveAttribute("aria-valuenow", "50");

  // Alt+arrows move focus, Alt+Shift+arrows swap panes.
  await pane.getByRole("textbox", { name: "Project folder" }).press("Alt+ArrowLeft");
  await expect(hostTile).toHaveClass(/focused/);
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await page.waitForTimeout(600);
  expect((await box(hostTile)).x).toBeGreaterThan((await box(pane)).x);

  // Dragging a pane by its title onto another pane's edge moves it there.
  const grip = await box(pane.locator("[data-tile-grip]").first());
  const target = await box(hostTile);
  await page.mouse.move(grip.x + 20, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 60, grip.y + 40, { steps: 4 });
  await page.mouse.move(target.x + target.width - 30, target.y + target.height / 2, { steps: 10 });
  await expect(host.locator(".agent-tile-drop")).toBeVisible();
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect((await box(pane)).x).toBeGreaterThan((await box(hostTile)).x);
  await pane.getByRole("textbox", { name: "Project folder" }).press("Alt+Shift+ArrowLeft");
  await page.waitForTimeout(600);
  expect((await box(hostTile)).x).toBeGreaterThan((await box(pane)).x);

  // The layout survives a reload.
  await page.waitForTimeout(400);
  await page.reload();
  await expect(tile).toHaveCount(2, { timeout: 30_000 });
  await expect(hostTile.locator(".cs-session-header strong").first()).toHaveText(/Existing Claude project/);
  expect((await box(hostTile)).x).toBeGreaterThan((await box(pane)).x);

  // Ctrl+Shift+W can close successive panes without another click.
  await pane.getByRole("textbox", { name: "Project folder" }).press("Alt+Shift+Minus");
  await expect(tile).toHaveCount(3);
  await expect(tiles.locator(top + ".agent-tile.focused").getByRole("textbox", { name: "Project folder" })).toBeFocused();
  await page.keyboard.press("Control+Shift+W");
  await expect(tile).toHaveCount(2);
  await page.keyboard.press("Control+Shift+W");
  await expect(tile).toHaveCount(1);
  await page.waitForTimeout(600);
  expect(await box(tile)).toEqual(await box(tiles));
  await expect(hostTile.locator(".cs-session-header strong").first()).toHaveText(/Existing Claude project/);
});

test("context ring shows the latest Codex transcript usage", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const { project } = await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: "Codex", exact: true }).click();
  await app.getByRole("textbox", { name: "Project folder" }).fill(project);
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Check context usage");
  await composer.press("Enter");
  const ring = app.getByRole("button", { name: "Context 50% used" });
  await expect(ring).toBeVisible({ timeout: 20_000 });
  // Codex's own limits sit beside the ring: the 5-hour window (the weekly
  // one, at 95%, is in the popover).
  const usage = app.getByRole("button", { name: "Codex usage: 5h 16%" });
  await expect(usage).toBeVisible();
  await expect(usage).not.toHaveClass(/full/);
  await composer.focus();
  await page.keyboard.press("Alt+u");
  const limits = page.getByRole("dialog", { name: "Usage" });
  await expect(limits.locator(".au-row")).toHaveCount(2);
  await expect(limits.locator(".au-row").first()).toContainText("16%");
  await expect(limits.locator(".au-row").last()).toContainText("95%");
  await page.screenshot({ path: info.outputPath("usage.png") });
  await limits.press("Escape");
  await expect(limits).toHaveCount(0);
  // Alt+U also works after clicking the chat text, which focuses nothing.
  await app.getByLabel("Session conversation").locator(".cs-user .cs-message-text").last().click();
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("Alt+u");
  await expect(limits).toBeVisible();
  await limits.press("Escape");
  await expect(limits).toHaveCount(0);
  // The send button inside the round ring is round as well.
  await composer.fill("Next");
  await expect(app.locator(".cr-wrap:has(.cr-ring) .cs-send")).toHaveCSS("border-radius", "50%");
  await ring.click();
  const detail = page.getByRole("dialog", { name: "Context used" });
  await expect(detail.getByText("100k of 200k")).toBeVisible();
  await expect(detail.getByText("60k", { exact: true })).toBeVisible();
  const panel = (await detail.boundingBox())!;
  const trigger = (await ring.boundingBox())!;
  expect(panel.x + panel.width).toBeLessThanOrEqual(page.viewportSize()!.width - 7);
  expect(panel.y + panel.height).toBeLessThanOrEqual(trigger.y);
  await page.screenshot({ path: info.outputPath("context-ring.png") });
  await detail.press("Escape");
  await expect(ring).toBeFocused();
});

test("Settings installs, tests and removes the Orvane MCP for each CLI", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const { directory } = await fixture(context);
  const app = await openApp(page);
  // Settings sits at the bottom of the sidebar, under the session list.
  const nav = app.getByRole("button", { name: "Settings", exact: true });
  const list = (await app.locator(".cs-session-list").boundingBox())!;
  expect((await nav.boundingBox())!.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
  await nav.click();
  await expect(nav).toHaveAttribute("aria-current", "page");
  const settings = app.getByRole("region", { name: "Settings" });
  const claude = settings.getByRole("listitem", { name: "Claude Code" });
  const codex = settings.getByRole("listitem", { name: "Codex" });
  await expect(claude.getByText("Not set up")).toBeVisible({ timeout: 20_000 });
  await expect(codex.getByText("Not set up")).toBeVisible();
  // What Install writes is shown first, and nothing is written yet.
  await expect(settings.locator("pre").last()).toContainText("[mcp_servers.orvane]");
  await expect(settings.locator("pre").last()).toContainText(`ORVANE_DATA_DIR = '${directory}'`);
  expect(existsSync(join(directory, ".claude.json"))).toBe(false);
  await page.screenshot({ path: info.outputPath("agent-settings.png") });

  // Install through the CLI, then the server is started and its tools counted.
  await claude.getByRole("button", { name: "Install" }).click();
  await expect(claude.getByText(/^Connected · \d+ tools$/)).toBeVisible({ timeout: 60_000 });
  const saved = JSON.parse(await readFile(join(directory, ".claude.json"), "utf8")).mcpServers.orvane;
  expect(saved.args.at(-1)).toMatch(/[\\/]server[\\/]launch\.mjs$/);
  expect(saved.env).toEqual({ ORVANE_DATA_DIR: directory });
  // Enter on a row that is not set up installs it.
  await codex.focus();
  await page.keyboard.press("Enter");
  await expect(codex.getByRole("button", { name: "Remove" })).toBeVisible({ timeout: 20_000 });
  await codex.getByRole("button", { name: "Remove" }).click();
  await expect(codex.getByText("Not set up")).toBeVisible({ timeout: 20_000 });
  expect(JSON.parse(await readFile(join(directory, "codex-mcp.json"), "utf8")).mcpServers).toEqual({});

  // The session preference lives here too.
  const suggest = settings.getByRole("switch", { name: "Suggest next message" });
  const before = await suggest.getAttribute("aria-checked");
  await suggest.click();
  await expect(suggest).not.toHaveAttribute("aria-checked", before!);
  await nav.click();
  await expect(settings).toHaveCount(0);
});

test("scheduled prompts can be created, paused, run and reopened", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  const app = await openApp(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("combobox");
  await palette.fill("show scheduled prompts");
  await expect(page.getByRole("option", { name: "Show scheduled prompts" })).toBeVisible();
  await palette.press("Enter");
  const scheduled = app.getByRole("region", { name: "Scheduled prompts" });
  await scheduled.getByRole("button", { name: /^New/ }).click();
  await scheduled.getByRole("textbox", { name: "Prompt", exact: true }).fill("Summarize the latest repo changes");
  await scheduled.getByRole("textbox", { name: "Project folder" }).fill(project);
  await scheduled.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await scheduled.getByRole("textbox", { name: "Prompt", exact: true }).press("Control+Enter");
  await expect(scheduled.getByRole("button", { name: /Summarize the latest repo changes/ })).toHaveAttribute("aria-expanded", "true");
  await scheduled.getByRole("button", { name: /^Pause/ }).click();
  await expect(scheduled.getByRole("heading", { name: "Paused" })).toBeVisible();
  await scheduled.getByRole("button", { name: /^Resume/ }).click();
  await expect(scheduled.getByRole("button", { name: /^Pause/ })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("scheduled-prompts.png") });
  await scheduled.getByRole("button", { name: /^Run now/ }).click();
  const openSession = scheduled.getByRole("button", { name: "Open session" });
  await expect(openSession).toBeVisible({ timeout: 20_000 });
  const input = JSON.parse((await readFile(join(directory, "inputs.jsonl"), "utf8")).trim());
  expect(input.message).toBe("Summarize the latest repo changes");
  expect(input.args).toContain("exec");
  expect(input.args).not.toContain("resume");
  await openSession.click();
  await expect(app.getByLabel("Session conversation").getByText("Codex started")).toBeVisible();
});

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
  // Effort and edit mode ride along with the next message.
  await expect(
    app.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
  await app.getByRole("button", { name: "Effort", exact: true }).click();
  const slider = page.getByRole("slider", { name: "Effort" });
  await expect(slider).toBeFocused();
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "Max");
  await page.screenshot({ path: test.info().outputPath("ai-effort.png") });
  await slider.press("Escape");
  await expect(slider).toHaveCount(0);
  await expect(app.getByRole("button", { name: "Effort", exact: true })).toContainText("Max");
  await composer.fill("Continue the same Codex session");
  await composer.press("Shift+Tab");
  await expect(app.getByRole("button", { name: "Edits: Plan only" })).toBeVisible();
  await expect(composer).toBeFocused();
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
  expect(inputs[0].args).toEqual(expect.arrayContaining(["workspace-write"]));
  expect(inputs[0].args.join(" ")).not.toContain("model_reasoning_effort");
  expect(inputs[1].args).toEqual(
    expect.arrayContaining([
      "resume",
      codexId,
      "read-only",
      'model_reasoning_effort="xhigh"',
      "sandbox_workspace_write.network_access=false",
    ]),
  );
});

test("slash offers skills and saved prompts, and remembers recent skills", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const { directory } = await fixture(context);
  const skill = join(directory, ".claude", "skills", "scoped-fix");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    [
      "---",
      "name: scoped-fix",
      "description: >",
      "  Fix a bug exactly",
      "  where it happens",
      "---",
      "# Body",
    ].join("\n"),
  );
  const app = await openApp(page);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("/sc");
  await composer.press("End");
  await page.keyboard.type("o");
  const menu = app.getByRole("listbox", { name: "Skills and prompts" });
  await expect(menu.getByRole("option", { name: /\/scoped-fix/ })).toBeVisible();
  await expect(menu.getByText("Fix a bug exactly where it happens")).toBeVisible();
  await expect(menu.getByRole("option", { name: /\/compact/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("ai-slash.png") });
  await composer.press("Tab");
  await expect(composer).toHaveValue("/scoped-fix ");
  await expect(menu).toHaveCount(0);
  await expect(app.locator(".cs-skill", { hasText: "/scoped-fix" })).toBeVisible();

  // The current message can be saved as a prompt and comes back under "/".
  await composer.fill("Review the open diff for scope creep");
  await app.getByRole("button", { name: "Save prompt" }).click();
  const name = app.getByRole("textbox", { name: "Prompt name" });
  await expect(name).toHaveValue("review-the-open-diff");
  await name.press("Enter");
  await expect(name).toHaveCount(0);
  await expect(composer).toBeFocused();
  await composer.fill("/rev");
  await composer.press("End");
  await page.keyboard.type("i");
  await expect(menu.getByRole("option", { name: /\/review-the-open-diff/ })).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toHaveValue("Review the open diff for scope creep");
});

test("a finished run lists the files it changed with their diffs", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const { project } = await fixture(context);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
      cwd: project,
      windowsHide: true,
    });
  git("init", "-q");
  await writeFile(join(project, "kept.txt"), "one\n");
  await writeFile(join(project, "dirty-before.txt"), "old\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  // Already changed before the run: not the run's work.
  await writeFile(join(project, "dirty-before.txt"), "old\nchanged earlier\n");
  const app = await openApp(page);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  const chat = app.getByLabel("Session conversation");
  await composer.fill("Allow this change");
  await composer.press("Enter");
  const approval = app.getByRole("group", { name: "Permission request for Write" });
  await expect(approval).toBeVisible();
  // The "agent" edits one file and adds another while the run works.
  await writeFile(join(project, "kept.txt"), "one\ntwo\n");
  await writeFile(join(project, "added.txt"), "new file\n");
  await approval.getByRole("button", { name: "Allow once" }).click();
  await expect(chat.getByText("Write approved")).toBeVisible();
  const card = chat.getByRole("region", { name: "Files changed" });
  const rows = card.locator(".row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("added.txt");
  await expect(rows.nth(0).locator(".badge")).toHaveText("A");
  await expect(rows.nth(1)).toContainText("kept.txt");
  await expect(rows.nth(1).locator(".badge")).toHaveText("M");
  await expect(rows.nth(1)).toContainText("+1");
  await rows.nth(1).click();
  await expect(card.locator("pre .ad", { hasText: "+two" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("ai-files-changed.png") });
  const ask = card.getByRole("textbox", { name: "Ask about the change to kept.txt" });
  await ask.fill("Why add this line?");
  await ask.press("Enter");
  await expect(chat.getByText("Why add this line?")).toBeVisible();
  await expect(chat.getByText(/kept\.txt/).last()).toBeVisible();
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(chat.getByText("Write denied")).toBeVisible();
});

test("message actions copy, send to Notes, save prompts and fork", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const { directory } = await fixture(context);
  const app = await openApp(page);
  page.setDefaultTimeout(10_000);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const chat = app.getByLabel("Session conversation");
  const message = chat.locator(".cs-message").first();
  await message.hover();
  const more = message.getByRole("button", { name: "Message actions" });
  await expect(more).toBeVisible();
  await more.click();
  const menu = page.getByRole("menu", { name: "Message actions" });
  await expect(page.getByRole("textbox", { name: "Search actions" })).toBeFocused();
  await page.keyboard.type("notes");
  await expect(menu.getByRole("menuitem")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("ai-message-actions.png") });
  await page.keyboard.press("Enter");
  await expect(app.getByRole("status").getByText("Sent to Notes")).toBeVisible();
  const pages = await page.request.post("/__orvane/notes/data", {
    data: { collection: "pages", action: "list" },
  });
  expect((await pages.json()).map((p: { title: string }) => p.title)).toContain(
    "Existing Claude project",
  );
  await message.hover();
  await more.click();
  await menu.getByRole("menuitem", { name: "Save as prompt" }).click();
  await expect(app.getByRole("status").getByText("Saved as /existing-claude-project")).toBeVisible();
  // Outside a press, the menu closes.
  await message.hover();
  await more.click();
  await expect(menu).toBeVisible();
  await chat.click({ position: { x: 12, y: 160 } });
  await expect(menu).toHaveCount(0);
  await message.hover();
  await more.click();
  await menu.getByRole("menuitem", { name: "Fork session" }).click();
  await expect(app.getByText("The next message starts a new session branched from this one.")).toBeVisible();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeFocused();
  await composer.fill("Allow this change");
  await composer.press("Enter");
  await expect(app.getByRole("group", { name: "Permission request for Write" })).toBeVisible({ timeout: 20_000 });
  const inputs = (await readFile(join(directory, "inputs.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  // Claude resumes from the account's own transcript file, never a bare ID.
  const args: string[] = inputs.at(-1).args;
  expect(args).toContain("--fork-session");
  expect(args[args.indexOf("--resume") + 1]).toBe(
    await realpath(join(directory, "claude-projects", "test-project", `${claudeId}.jsonl`)),
  );
});

test("Claude and Codex replies show local pictures inline and open them full-window", async ({ page, context }) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  await mkdir(join(project, "shots"), { recursive: true });
  const shot = join(project, "shots", "terminal.png");
  // A real 2×2 PNG.
  await writeFile(shot, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0q4hiYGBgYgADAA02ARyeTxxIAAAAAElFTkSuQmCC", "base64"));
  const at = new Date(Date.UTC(2026, 10, 21, 20, 0)).toISOString();
  await writeFile(join(directory, "claude-projects", "test-project", claudeId + ".jsonl"), [
    { type: "user", uuid: "u1", timestamp: at, sessionId: claudeId, cwd: project, message: { content: "Show the terminal screenshot" } },
    { type: "assistant", uuid: "a1", timestamp: at, message: { content: [{ type: "text",
      text: `Here it is:

![Terminal over a wallpaper](${shot})

![Second shot](shots/terminal.png)

Remote stays text: ![remote](https://example.test/x.png)` }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const codexFolder = join(directory, "codex-sessions", "2026", "11", "22");
  await mkdir(codexFolder, { recursive: true });
  const wrap = (type: string, payload: object) => JSON.stringify({ type, payload, timestamp: at });
  await writeFile(join(codexFolder, "pictures.jsonl"), [
    wrap("session_meta", { id: "33333333-3333-4333-8333-333333333333", cwd: project }),
    wrap("event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Codex picture check" }] } }),
    wrap("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Relative path:\n\n![Codex shot](shots/terminal.png)" }] }),
  ].join("\n") + "\n");
  const app = await openApp(page);
  const chat = app.getByLabel("Session conversation");
  const loaded = (picture: ReturnType<typeof chat.getByRole>) =>
    picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth);

  await app.getByRole("button", { name: /Show the terminal screenshot/ }).click();
  const picture = chat.getByRole("button", { name: "Terminal over a wallpaper" });
  await expect.poll(() => loaded(picture)).toBe(2);
  await expect(chat.getByText("Image: remote")).toBeVisible();
  await expect(chat.locator('img[src^="https:"]')).toHaveCount(0);
  await picture.focus();
  await page.keyboard.press("Enter");
  const peek = page.getByRole("dialog");
  await expect(peek.locator("img").first()).toHaveAttribute("src", /\/__orvane\/agents\/picture\?path=/);
  // ← → and Previous/Next step through the reply's pictures and wrap around.
  await expect(peek.getByText("1 / 2")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(peek.getByText("2 / 2")).toBeVisible();
  await expect(peek.getByText("Second shot", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(peek.getByText("1 / 2")).toBeVisible();
  await peek.getByRole("button", { name: "Next image" }).click();
  await expect(peek.getByText("2 / 2")).toBeVisible();
  await peek.getByRole("button", { name: "Previous image" }).click();
  await expect(peek.getByText("1 / 2")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  await expect(picture).toBeFocused();

  await app.getByRole("button", { name: /Codex picture check/ }).click();
  const codexPicture = chat.getByRole("button", { name: "Codex shot" });
  await expect.poll(() => loaded(codexPicture)).toBe(2);
  // SVG and non-files are refused by the route itself.
  expect((await page.request.get(`/__orvane/agents/picture?path=${encodeURIComponent(join(project, "x.svg"))}`)).status()).toBe(400);
  expect((await page.request.get(`/__orvane/agents/picture?path=${encodeURIComponent(join(project, "missing.png"))}`)).status()).toBe(404);
});

test("the session timeline shows asks, research, approvals, files, failures and answers", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  const at = (minute: number, second = 0) =>
    new Date(Date.UTC(2026, 10, 21, 20, minute, second)).toISOString();
  const tool = (id: string, name: string, input: object, minute: number) => ({
    type: "assistant",
    uuid: "a-" + id,
    timestamp: at(minute),
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const result = (id: string, minute: number, second: number, error = false) => ({
    type: "user",
    uuid: "r-" + id,
    timestamp: at(minute, second),
    message: { content: [{ type: "tool_result", tool_use_id: id, content: error ? "404 Not Found" : "ok", is_error: error }] },
  });
  const records = [
    { type: "user", uuid: "u1", timestamp: at(48), sessionId: claudeId, cwd: project, message: { content: "Search how to make a voxel engine\nand write an md file" } },
    tool("t1", "WebSearch", { query: "voxel engine" }, 48),
    result("t1", 48, 20),
    tool("t2", "Read", { file_path: join(project, "notes.md") }, 48),
    result("t2", 48, 41),
    tool("t3", "Write", { file_path: join(project, "voxel-engine-guide.md"), content: "# Guide" }, 50),
    result("t3", 50, 5),
    tool("t4", "WebFetch", { url: "https://example.test/missing" }, 50),
    result("t4", 50, 20, true),
    { type: "assistant", uuid: "a-done", timestamp: at(50, 30), message: { content: [{ type: "text", text: "Wrote voxel-engine-guide.md with the steps." }] } },
  ];
  await writeFile(
    join(directory, "claude-projects", "test-project", claudeId + ".jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  await mkdir(join(directory, "agent-runs"), { recursive: true });
  await writeFile(
    join(directory, "agent-runs", "run-1.json"),
    JSON.stringify({ id: "run-1", sessionId: claudeId, decisions: [{ tool: "Write", allowed: true, at: at(49) }], finishedAt: at(50, 30) }),
  );
  const app = await openApp(page);
  await app.getByRole("button", { name: /Search how to make a voxel engine/ }).click();
  await app.getByRole("button", { name: "More session actions" }).click();
  await page.getByRole("menuitem", { name: "Session timeline" }).click();
  const timeline = app.getByRole("region", { name: "Session timeline" });
  await expect(timeline).toBeFocused();
  const titles = timeline.locator("li h4");
  await expect(titles).toHaveText([
    "Search how to make a voxel engine",
    "Researched 2 sources",
    "Allowed Write",
    "Created 1 file",
    "WebFetch failed",
    "Answered",
  ]);
  await expect(timeline.getByText("Web · 1 page · 1 file")).toBeVisible();
  await expect(timeline.getByText("41s")).toBeVisible();
  await expect(timeline.locator("li.fail p")).toHaveText("404 Not Found");
  await page.screenshot({ path: test.info().outputPath("ai-session-timeline.png") });
  await timeline.getByRole("button", { name: "Files" }).click();
  await expect(titles).toHaveText(["Created 1 file"]);
  await expect(timeline.getByRole("button", { name: "voxel-engine-guide.md" })).toBeVisible();
  await timeline.getByRole("button", { name: "Approvals" }).click();
  await expect(titles).toHaveText(["Allowed Write"]);
  await page.keyboard.press("Escape");
  await expect(timeline).toHaveCount(0);
  await expect(app.getByLabel("Session conversation").locator(".cs-message").first()).toBeVisible();
});

test("effort and edit mode map onto each CLI's flags", () => {
  const claude = agentArgs("claude", undefined, undefined, "high", "auto");
  expect(claude.join(" ")).toContain("--permission-mode acceptEdits --effort high");
  expect(agentArgs("claude", undefined, undefined, undefined, "plan").join(" ")).toContain("--permission-mode plan");
  expect(agentArgs("claude").join(" ")).toContain("--permission-mode default");
  expect(agentArgs("claude").join(" ")).not.toContain("--effort");
  const codex = agentArgs("codex", undefined, undefined, "low", "auto");
  expect(codex).toEqual(expect.arrayContaining(["workspace-write", 'model_reasoning_effort="low"']));
  // Full access: no approvals and no sandbox in either CLI.
  expect(agentArgs("claude", undefined, undefined, undefined, "full").join(" ")).toContain("--permission-mode bypassPermissions");
  expect(agentArgs("codex", undefined, undefined, undefined, "full")).toEqual(expect.arrayContaining(["-s", "danger-full-access"]));
  // Codex approves Orvane MCP tools only in Full access, and only when its
  // config has the orvane server (the override breaks Codex otherwise).
  const approve = 'mcp_servers.orvane.default_tools_approval_mode="approve"';
  const fullCodex = agentArgs("codex", undefined, undefined, undefined, "full", undefined, undefined, true);
  expect(fullCodex).toContain(approve);
  expect(fullCodex.indexOf(approve)).toBeLessThan(fullCodex.indexOf("exec"));
  expect(agentArgs("codex", undefined, undefined, undefined, "full", undefined, undefined, false)).not.toContain(approve);
  expect(agentArgs("codex", undefined, undefined, undefined, "auto", undefined, undefined, true)).not.toContain(approve);
});

test("Codex's orvane MCP server is detected from its config", async () => {
  const home = await mkdtemp(join(tmpdir(), "orvane-codex-home-"));
  try {
    expect(codexHasOrvaneMcp({ CODEX_HOME: home })).toBe(false);
    await writeFile(join(home, "config.toml"), "[mcp_servers.node_repl]\ncommand = 'node'\n");
    expect(codexHasOrvaneMcp({ CODEX_HOME: home })).toBe(false);
    await writeFile(join(home, "config.toml"), "[mcp_servers.orvane]\ncommand = 'C:\\node\\node.exe'\n\n[mcp_servers.orvane.env]\n");
    expect(codexHasOrvaneMcp({ CODEX_HOME: home })).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
  const trail = chat.getByRole("region", { name: "Run steps" });
  await expect(
    trail.locator(".trail-step.is-completed").getByText("Thinking", { exact: true }),
  ).toBeVisible();
  await expect(
    trail
      .locator(".trail-step.is-failed")
      .getByText("orvane / workspace_status", { exact: true }),
  ).toBeVisible();
  await expect(
    trail.getByText("Waiting for your approval", { exact: true }),
  ).toBeVisible();
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
  // Claude reported its limits during the run; Orvane kept them.
  await expect(app.getByRole("button", { name: "Claude Code usage: 5h 39%" })).toBeVisible();
  await composer.fill("Wait for Stop");
  await composer.press("Enter");
  await expect(app.getByText("Using Wait", { exact: true })).toBeVisible();
  const descendant = Number(
    await readFile(join(directory, "descendant.txt"), "utf8"),
  );
  // While it runs, Stop takes Send's place in the ring wrapper: a 30px icon
  // button (round whenever the ring is drawn), not a wide text button.
  const stop = app.getByRole("button", { name: "Stop", exact: true });
  await expect(app.locator(".cr-wrap").getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const size = (await stop.boundingBox())!;
  expect(Math.round(size.width)).toBe(Math.round(size.height));
  expect(size.width).toBeLessThan(40);
  await expect(stop).toHaveText("");
  await stop.click();
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

