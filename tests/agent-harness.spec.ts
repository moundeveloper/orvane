// Agent sessions harness: dropped files, @sessions, selections and app
// snapshots as context, steering a working turn, the activity bell, the
// suggested next message and checkpoints with rewind.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const claudeId = "11111111-1111-4111-8111-111111111111";
const otherId = "33333333-3333-4333-8333-333333333333";
const seededReply = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function fixture(context: BrowserContext) {
  const cookie = (await context.cookies()).find((item) => item.name === "orvane-test-workspace")!;
  const directory = join(process.cwd(), ".orvane", "tests", cookie.value);
  const project = join(directory, "project");
  const claude = join(directory, "claude-projects", "test-project");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(claude, { recursive: true })]);
  await copyFile(join(process.cwd(), "tests", "helpers", "agent-cli.cjs"), join(directory, "agent-cli.cjs"));
  const record = (sessionId: string, type: string, uuid: string, content: string, minutes: number) =>
    JSON.stringify({
      type,
      uuid,
      sessionId,
      cwd: project,
      timestamp: new Date(Date.now() - minutes * 60_000).toISOString(),
      message: { content },
    });
  await writeFile(
    join(claude, claudeId + ".jsonl"),
    [
      record(claudeId, "user", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Existing Claude project", 5),
      record(claudeId, "assistant", seededReply, "Seeded reply", 5),
    ].join("\n") + "\n",
  );
  await writeFile(
    join(claude, otherId + ".jsonl"),
    [
      record(otherId, "user", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Other session notes", 30),
      record(otherId, "assistant", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "The other session found the bug in parser.ts", 30),
    ].join("\n") + "\n",
  );
  return { directory, project };
}

async function openApp(page: Page, first?: string) {
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/");
  if (first) {
    await page.getByRole("button", { name: "Workspace options", exact: true }).click();
    await page.getByRole("button", { name: first, exact: true }).click();
    await expect(page.locator(".canvas-app")).toHaveCount(1, { timeout: 20_000 });
  }
  await page.getByRole("button", { name: "Workspace options", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent sessions", exact: true }).click();
  const app = page.locator(".agent-sessions-app");
  await expect(app).toBeVisible({ timeout: 30_000 });
  return app;
}

const inputs = async (directory: string) =>
  (await readFile(join(directory, "inputs.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; message: string });

test("dropped files, @sessions, selections and snapshots join the next message", async ({ page, context }, info) => {
  test.setTimeout(180_000);
  const { directory, project } = await fixture(context);
  const app = await openApp(page, "Create Notes");
  const notes = page.locator(".canvas-app").filter({ has: page.locator(".notes-workspace") });

  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeVisible();

  // A file dragged from Orvane's File Explorer.
  const dropped = join(project, "dropped.txt");
  await app.locator(".cs-compose").evaluate((form, path) => {
    const data = new DataTransfer();
    data.setData("application/x-orvane-files", JSON.stringify({ paths: [path], dirs: [] }));
    for (const type of ["dragenter", "dragover", "drop"])
      form.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  }, dropped);
  await expect(app.locator(".cs-attachment", { hasText: "dropped.txt" })).toBeVisible();

  // "@" lists other sessions; picking one quotes its latest reply.
  await composer.fill("Compare @Other");
  const picker = app.getByRole("listbox", { name: "Add context" });
  await expect(picker.getByRole("option", { name: /Other session notes/ })).toBeVisible();
  await composer.press("Tab");
  const quotes = app.getByRole("list", { name: "Context sent with the message" });
  await expect(quotes.getByText("@Other session notes")).toBeVisible({ timeout: 20_000 });
  await expect(composer).toHaveValue("Compare ");

  // Text selected in Notes goes to the composer with Ctrl+Shift+L.
  const selected = await notes.locator(".notes-workspace main p").first().evaluate((app) => {
    const walker = document.createTreeWalker(app, NodeFilter.SHOW_TEXT, (node) =>
      node.textContent!.trim().length > 2 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    );
    const text = walker.nextNode()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    (document.activeElement as HTMLElement | null)?.blur();
    return text.textContent!.trim();
  });
  await page.keyboard.press("Control+Shift+L");
  await expect(quotes.locator("li.selection")).toContainText(selected, { timeout: 15_000 });

  // Ctrl+Alt+S snapshots an app; Tab switches to text only.
  await composer.focus();
  await composer.press("Control+Alt+s");
  const snapshot = app.getByRole("listbox", { name: "Snapshot an app" });
  await expect(snapshot).toBeFocused();
  await expect(snapshot.getByRole("option").first()).toContainText(/Notes/);
  await page.keyboard.press("Tab");
  await expect(snapshot.getByRole("button", { name: "Text only" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await expect(quotes.locator("li.snapshot")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: info.outputPath("agent-context-quotes.png") });

  await composer.press("Enter");
  await expect(quotes).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => (await inputs(directory).catch(() => [])).at(-1)?.message ?? "", { timeout: 20_000 }).toContain("Compare");
  const sent = (await inputs(directory)).at(-1)!.message;
  expect(sent).toContain("The other session found the bug in parser.ts");
  expect(sent).toContain(`session ${otherId}`);
  expect(sent).toContain("Selected in Notes");
  expect(sent).toContain(selected);
  expect(sent).toContain("Snapshot of the Notes app");
  expect(sent).toContain(`Local attachments:\n${JSON.stringify(dropped)}`);
  await app.getByRole("group", { name: "Permission request for Write" }).getByRole("button", { name: "Deny", exact: true }).click({ timeout: 20_000 });
  await expect(app.getByText("Write denied")).toBeVisible({ timeout: 15_000 });
});

test("Ctrl+Enter steers a working Claude turn, the bell answers approvals and a next message is suggested", async ({
  page,
  context,
}, info) => {
  test.setTimeout(90_000);
  const { directory } = await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  const chat = app.getByLabel("Session conversation");
  // The fixture turn waits for a Write approval, still working.
  await composer.fill("Allow this change");
  await composer.press("Enter");
  await expect(app.getByRole("group", { name: "Permission request for Write" })).toBeVisible({ timeout: 20_000 });
  await expect(app.getByText("Keeping PC awake").or(app.getByText("PC may sleep"))).toBeVisible();

  // Ctrl+Enter hands the message to the working turn, not the queue.
  await composer.fill("Steer this way");
  await composer.press("Control+Enter");
  await expect(chat.locator(".cs-steered").getByText("Steer this way")).toBeVisible();
  await expect(app.getByRole("region", { name: "Queued follow-ups" })).toHaveCount(0);
  await expect.poll(async () => (await inputs(directory)).at(-1)?.message).toBe("Steer this way");

  // The steered message asks for a write; the bell lists it and answers it.
  const bell = app.getByRole("button", { name: "Agent activity" });
  await expect(bell).toContainText("1", { timeout: 15_000 });
  await bell.click();
  const panel = app.getByRole("dialog", { name: "Agent activity" });
  await expect(panel.getByText("Waiting for you")).toBeVisible();
  await page.screenshot({ path: info.outputPath("agent-activity.png") });
  await panel.getByRole("button", { name: "Allow once" }).click();
  await expect(chat.getByText("Write approved")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  // A suggested next message waits in the empty composer; Tab takes it.
  await expect(composer).toHaveAttribute("placeholder", "Import the record before deploying.", { timeout: 15_000 });
  await composer.focus();
  await composer.press("Tab");
  await expect(composer).toHaveValue("Import the record before deploying.");
  const job = (await inputs(directory)).at(-1)!;
  expect(job.args).toContain("--no-session-persistence");
  expect(JSON.parse(job.message).reply).toContain("Write approved");
});

test("a checkpoint before a turn restores its files and rewinds the chat", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const { directory, project } = await fixture(context);
  await writeFile(join(project, "a.txt"), "one\n");
  const app = await openApp(page);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  const chat = app.getByLabel("Session conversation");
  await composer.fill("Allow this change");
  await composer.press("Enter");
  const approval = app.getByRole("group", { name: "Permission request for Write" });
  await expect(approval).toBeVisible({ timeout: 20_000 });
  // The "agent" edits one file and adds another.
  await writeFile(join(project, "a.txt"), "one\ntwo\n");
  await writeFile(join(project, "b.txt"), "new\n");
  await approval.getByRole("button", { name: "Allow once" }).click();
  await expect(chat.getByText("Write approved")).toBeVisible({ timeout: 15_000 });

  const message = chat.locator(".cs-message.cs-user", { hasText: "Allow this change" });
  await message.getByRole("button", { name: /Checkpoint/ }).click();
  const rewind = app.getByRole("dialog", { name: "Rewind to checkpoint" });
  await expect(rewind.getByText("a.txt")).toBeVisible();
  await expect(rewind.getByText("b.txt")).toBeVisible();
  await page.screenshot({ path: info.outputPath("agent-rewind.png") });
  await page.keyboard.press("f");
  await expect(rewind).toHaveCount(0);
  await expect.poll(() => readFile(join(project, "a.txt"), "utf8")).toBe("one\n");
  expect(existsSync(join(project, "b.txt"))).toBe(false);

  // Ctrl+Alt+Z opens the latest checkpoint; C rewinds only the chat.
  await composer.focus();
  await composer.press("Control+Alt+z");
  await expect(rewind).toBeVisible();
  await expect(rewind.getByText("The files are the same as at this checkpoint.")).toBeVisible();
  await page.keyboard.press("c");
  await expect(composer).toHaveValue("Allow this change");
  await expect(app.getByText(/continues from before this message/)).toBeVisible();
  await composer.press("Enter");
  await expect.poll(async () => (await inputs(directory)).at(-1)?.args.join(" ") ?? "").toContain("--resume-session-at");
  const args = (await inputs(directory)).at(-1)!.args;
  expect(args).toEqual(expect.arrayContaining(["--resume-session-at", seededReply, "--fork-session"]));
  await app.getByRole("group", { name: "Permission request for Write" }).getByRole("button", { name: "Deny", exact: true }).click();
});

test("the effort popover opens above its pill and the model search stays above a scrolling list", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  // Room below the composer, as on a canvas where the app sits high up.
  await page.setViewportSize({ width: 1280, height: 1600 });
  const effort = app.getByRole("button", { name: "Effort", exact: true });
  const room = await effort.evaluate((el) => innerHeight - el.getBoundingClientRect().bottom);
  expect(room).toBeGreaterThan(200);
  await effort.click();
  const popover = page.getByRole("dialog", { name: "Effort" });
  await expect(popover).toBeVisible();
  const pill = (await effort.boundingBox())!;
  expect((await popover.boundingBox())!.y + (await popover.boundingBox())!.height).toBeLessThanOrEqual(pill.y + 1);
  await page.keyboard.press("Escape");

  await app.getByRole("combobox", { name: "Model" }).click();
  const list = page.locator(".select-popover.select-fixed-search");
  await expect(list).toBeVisible();
  const search = list.getByRole("combobox", { name: "Find a model" });
  const options = list.locator(".select-options");
  // Only the list scrolls: the search sits above it, outside the scroll area.
  expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe("hidden");
  expect(await options.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  expect((await search.boundingBox())!.y + (await search.boundingBox())!.height).toBeLessThanOrEqual((await options.boundingBox())!.y + 1);
  await options.evaluate((el) => (el.scrollTop = el.scrollHeight));
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  await page.screenshot({ path: info.outputPath("model-list.png") });
});

// Claude's AskUserQuestion shows its questions (not a generic Allow once) and
// sends the owner's answers back in the tool's updated input; Skip denies it.
test("Claude's questions are answered in a question card, or skipped", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  const chat = app.getByLabel("Session conversation");
  await composer.fill("Ask me questions");
  await composer.press("Enter");
  const card = app.getByRole("group", { name: "Questions from Claude Code" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(app.getByRole("group", { name: "Permission request for AskUserQuestion" })).toHaveCount(0);
  await expect(card).toContainText("Which zoom should focus mode use?");
  await expect(card.getByRole("button", { name: "Send answers" })).toHaveCount(0);

  // Question 1: pick an option (its preview shows) and add a note.
  await card.getByRole("radio", { name: /UI 1x, page keeps zoom/ }).click();
  await expect(card.getByLabel("Preview")).toContainText("PAGE 0.83x");
  await card.getByRole("textbox", { name: "Note for Focus zoom" }).fill("keep the limits");
  await page.screenshot({ path: info.outputPath("agent-questions.png") });
  // Question 2 with the arrows: number keys toggle, Other adds own text.
  await card.getByRole("radio", { name: /UI 1x/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(card).toContainText("Where should Ctrl+arrows switch apps?");
  await page.keyboard.press("1");
  await page.keyboard.press("3");
  await expect(card.getByRole("checkbox", { name: /Canvas/ })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("checkbox", { name: /Timeline/ })).toHaveAttribute("aria-checked", "true");
  await card.getByRole("textbox", { name: "Other answer for Ctrl+arrows" }).fill("Browser later");
  await expect(card).toContainText("2 of 2 answered");
  await card.getByRole("button", { name: /Send answers/ }).click();
  await expect(chat.getByText(
    'Answers {"Which zoom should focus mode use?":"UI 1x, page keeps zoom","Where should Ctrl+arrows switch apps?":"Canvas, Timeline, Browser later"} ' +
      'notes {"Which zoom should focus mode use?":{"notes":"keep the limits","preview":"PAGE 0.83x"}}',
  )).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveCount(0);

  // Skip denies the questions.
  await composer.fill("Ask me questions");
  await composer.press("Enter");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "Skip" }).click();
  await expect(chat.getByText("Questions skipped")).toBeVisible({ timeout: 15_000 });
});

test("pin a new Codex draft, answer Plan questions and preview a viewed image", async ({ page, context }, info) => {
  test.setTimeout(150_000);
  const { directory, project } = await fixture(context);
  await writeFile(join(project, "layout.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXQAAAAASUVORK5CYII=", "base64",
  ));
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    if (!localStorage.getItem("orvane.agent-launcher.v1"))
      localStorage.setItem("orvane.agent-launcher.v1", JSON.stringify({ provider: "codex", models: { codex: "test-codex" } }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "AI launcher", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "AI launcher" });
  await launcher.getByRole("textbox", { name: "Message", exact: true }).fill("Choose the panel layout");
  await launcher.getByRole("button", { name: "Pin new session" }).click();
  const side = page.getByRole("complementary", { name: "Pinned AI session" });
  const composer = side.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toHaveValue("Choose the panel layout", { timeout: 30_000 });
  await expect(side.getByText("Codex can write in the workspace.", { exact: false })).toHaveCount(0);
  await side.getByRole("textbox", { name: "Project folder" }).fill(project);
  await side.getByRole("button", { name: "Edits: Auto-accept" }).click();
  await expect(side.getByRole("button", { name: "Edits: Plan only" })).toBeVisible();
  await composer.fill("Choose the panel layout and review layout.png");
  await page.reload();
  await expect(composer).toHaveValue("Choose the panel layout and review layout.png", { timeout: 30_000 });
  await expect(side.getByRole("textbox", { name: "Project folder" })).toHaveValue(project);
  await expect(side.getByRole("button", { name: "Edits: Plan only" })).toBeVisible();
  await composer.press("Enter");
  const card = side.getByRole("group", { name: "Questions from Codex" });
  await expect(card).toBeVisible({ timeout: 25_000 });
  await side.getByRole("region", { name: "Run steps" }).getByRole("button", { name: "layout.png" }).click();
  const peek = page.getByRole("dialog", { name: "Peek: layout.png" });
  await expect(peek.locator(".image-peek-stage img")).toBeVisible();
  await page.keyboard.press("Escape");
  await card.getByRole("radio", { name: /Above the dock/ }).click();
  await expect(card.getByRole("textbox", { name: "Other answer for Layout" })).toHaveCount(0);
  await card.getByRole("button", { name: /Next/ }).click();
  const privateAnswer = card.getByLabel("Answer for Private marker");
  await expect(privateAnswer).toHaveAttribute("type", "password");
  await privateAnswer.fill("fixture value");
  await page.screenshot({ path: info.outputPath("codex-question.png") });
  await card.getByRole("button", { name: /Send answers/ }).click();
  await expect(side.getByText("Plan answers received", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(side.getByRole("button", { name: "Switch session" })).toContainText("Choose the panel layout");
  const history = side.locator(".run-activity.strip").first();
  await history.locator("summary").click();
  await history.getByRole("button", { name: /Viewed image/ }).click();
  await history.getByRole("button", { name: "Preview layout.png" }).click();
  await expect(peek.locator(".image-peek-stage img")).toBeVisible();
  await page.keyboard.press("Escape");
  const readPacket = async (name: string) => JSON.parse((await readFile(join(directory, name), "utf8")).trim().split("\n")[0]!);
  expect((await readPacket("codex-plan-thread.jsonl")).params).toMatchObject({ sandbox: "read-only", model: "test-codex" });
  expect((await readPacket("codex-plan-turn.jsonl")).params.collaborationMode.mode).toBe("plan");
  expect(await readPacket("codex-plan-answers.jsonl")).toEqual({ answers: {
    layout: { answers: ["Above the dock"] }, marker: { answers: ["fixture value"] },
  } });

  await composer.fill("Ask another Plan question");
  await composer.press("Enter");
  await expect(card).toBeVisible({ timeout: 25_000 });
  await card.getByRole("button", { name: "Skip" }).click();
  await expect(side.getByText("Plan questions skipped", { exact: true })).toBeVisible({ timeout: 20_000 });
});

// New chats start in the default mode from Settings; while a turn works its
// text sits between its steps (as it happened) with the loader below them; a
// failed tool call is a red cross; a reader scrolled up is never pulled down.
test("default mode, live order of text and steps, failed cross, scrolled-up view stays", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const { directory, project } = await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: "Settings", exact: true }).click();
  const modes = app.getByRole("radiogroup", { name: "Default mode for Claude Code" });
  await expect(modes.getByRole("radio", { name: "Ask first" })).toHaveAttribute("aria-checked", "true");
  await modes.getByRole("radio", { name: "Auto-accept" }).click();
  await expect(modes.getByRole("radio", { name: "Auto-accept" })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: info.outputPath("default-mode.png") });

  await app.getByRole("button", { name: "Claude", exact: true }).click();
  await app.getByRole("textbox", { name: "Project folder" }).fill(project);
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Allow this change");
  await composer.press("Enter");
  await expect(app.getByRole("group", { name: "Permission request for Write" })).toBeVisible({ timeout: 20_000 });
  const args = (await inputs(directory)).at(-1)!.args;
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");

  // While it works: steps, then the text written after them, then the loader.
  const trail = app.getByRole("region", { name: "Run steps" });
  await expect(trail.locator(".trail-text")).toContainText("Preparing request");
  const order = await trail.evaluate((section) => {
    const all = [...section.querySelectorAll(".trail-step, .trail-text, .trail-head")];
    const at = (test: (el: Element) => boolean) => all.findIndex(test);
    return {
      step: at((el) => el.matches(".trail-step") && /workspace_status/.test(el.textContent ?? "")),
      text: at((el) => el.matches(".trail-text") && /Preparing request/.test(el.textContent ?? "")),
      head: at((el) => el.matches(".trail-head")),
      count: all.length,
    };
  });
  expect(order.step).toBeGreaterThanOrEqual(0);
  expect(order.text).toBeGreaterThan(order.step);
  expect(order.head).toBe(order.count - 1);
  await expect(app.locator(".cs-live")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("live-order.png") });

  // Scrolled up while it works: the reply arriving and being laid out again
  // must not pull the view down.
  const chat = app.getByLabel("Session conversation");
  await chat.evaluate((box) => {
    (box as HTMLElement).style.flex = "none";
    (box as HTMLElement).style.height = "140px";
  });
  await expect.poll(() => chat.evaluate((box) => box.scrollHeight - box.clientHeight)).toBeGreaterThan(40);
  // Scroll down, then up, as a reader does (each fires a scroll event).
  await chat.evaluate((box) => box.scrollTo(0, box.scrollHeight));
  await page.waitForTimeout(100);
  await chat.evaluate((box) => box.scrollTo(0, 0));
  await page.waitForTimeout(100);
  // dispatchEvent: Playwright's own click would scroll the chat to the button.
  await app.getByRole("group", { name: "Permission request for Write" }).getByRole("button", { name: "Allow once" }).dispatchEvent("click");
  await expect(chat.getByText("Write approved")).toBeAttached({ timeout: 15_000 });
  // The failed MCP call shows a red cross, not the word.
  const failed = app.locator(".state.is-failed").first();
  await expect(failed.locator('svg.cross[aria-label="Failed"]')).toHaveCount(1);
  expect(await failed.evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join(""))).toBe("");
  await page.waitForTimeout(1500);
  expect(await chat.evaluate((box) => box.scrollTop)).toBe(0);
});

test("pasted screenshots show as tiles in the composer and sent message", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const { directory } = await fixture(context);
  const app = await openApp(page);
  await app.getByRole("button", { name: /Existing Claude project/ }).click();
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.focus();
  const paste = (kind: "image" | "text", color = "#d9e5ee") =>
    composer.evaluate(async (field, { kind, color }) => {
      const data = new DataTransfer();
      if (kind === "image") {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 300;
        const paint = canvas.getContext("2d")!;
        paint.fillStyle = "#f7f9fa";
        paint.fillRect(0, 0, 480, 300);
        paint.fillStyle = color;
        paint.fillRect(0, 0, 480, 92);
        paint.fillStyle = "#273f50";
        paint.font = "18px system-ui";
        paint.fillText("Agent sessions", 24, 56);
        paint.fillStyle = "#d3dee5";
        for (let y = 128; y < 270; y += 28) paint.fillRect(24, y, 320, 8);
        const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
        data.items.add(new File([blob], "image.png", { type: "image/png" }));
      } else data.setData("text/plain", "just text");
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    }, { kind, color });
  expect(await paste("text")).toBe(false);
  await expect(app.locator(".cs-attachment")).toHaveCount(0);
  expect(await paste("image", "#e7d8c9")).toBe(true);
  expect(await paste("image")).toBe(true);
  const tiles = app.getByRole("list", { name: "Pictures sent with the message" });
  await expect(tiles.locator("img")).toHaveCount(2, { timeout: 15_000 });
  for (const image of await tiles.locator("img").all()) {
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(480);
  }
  const remove = tiles.getByRole("button", { name: /^Remove / }).first();
  const iconOffset = await remove.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const icon = button.querySelector("svg")!.getBoundingClientRect();
    return [Math.abs(box.x + box.width / 2 - icon.x - icon.width / 2),
      Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2)];
  });
  expect(Math.max(...iconOffset)).toBeLessThan(1);
  const first = tiles.getByRole("button", { name: /^Open / }).first();
  await first.click();
  const preview = page.getByRole("dialog", { name: /^Peek: snapshot-/ });
  await expect(preview.locator(".image-peek-stage img")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Select", exact: true })).toHaveCount(0);
  await expect(preview.locator(".image-peek-count")).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(preview.locator(".image-peek-count")).toHaveText("2 / 2");
  await expect(preview.locator(".image-peek-stage img")).toBeVisible();
  await page.screenshot({ path: info.outputPath("attachment-preview.png") });
  const thumbnails = preview.getByRole("group", { name: "Preview images" }).getByRole("button");
  await expect(thumbnails.nth(1)).toHaveAttribute("aria-current", "true");
  await thumbnails.first().click();
  await expect(preview.locator(".image-peek-count")).toHaveText("1 / 2");
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(first).toBeFocused();
  await tiles.getByRole("button", { name: /^Remove / }).last().focus();
  await page.keyboard.press("Enter");
  await expect(tiles.locator("img")).toHaveCount(1);

  await composer.fill("Review this screenshot");
  await page.screenshot({ path: info.outputPath("attachment-composer.png") });
  await composer.press("Enter");
  const sent = app.getByRole("list", { name: "Pictures sent", exact: true });
  await expect(sent.getByRole("button", { name: /^Open / })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await inputs(directory).catch(() => [])).at(-1)?.message).toMatch(
    /Review this screenshot[\s\S]*agent-attachments.*snapshot-.*\.png/,
  );
  await sent.getByRole("button", { name: /^Open / }).click();
  await expect(preview.locator(".image-peek-stage img")).toBeVisible();
});
