import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Continue with another model (UI Maker continue-with-another-model, r3):
// the session menu turns into a model list; the draft opens beside the source
// (split pane) or in the pinned panel, with the source attached and linked.
const claudeId = "11111111-1111-4111-8111-111111111111";

async function fixture(context: BrowserContext) {
  const cookie = (await context.cookies()).find((item) => item.name === "orvane-test-workspace")!;
  const directory = join(process.cwd(), ".orvane", "tests", cookie.value);
  const project = join(directory, "project");
  const claude = join(directory, "claude-projects", "test-project");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(claude, { recursive: true })]);
  await copyFile(join(process.cwd(), "tests", "helpers", "agent-cli.cjs"), join(directory, "agent-cli.cjs"));
  const line = (uuid: string, type: string, content: unknown) =>
    JSON.stringify({ uuid, type, sessionId: claudeId, cwd: project, timestamp: new Date().toISOString(), message: { content } }) + "\n";
  await writeFile(
    join(claude, claudeId + ".jsonl"),
    line("u1", "user", "Browser focus zoom: keep the page zoom") +
      line("a0", "assistant", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(project, "src", "App.vue") } }]) +
      line("r0", "user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]) +
      line("a1", "assistant", "The toolbar now draws at 1x.\n\nForwarding the keys needs a preload change. Want me to add it?"),
  );
  return { directory, project };
}

async function openApp(page: Page) {
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent sessions", exact: true }).click();
  const app = page.locator(".agent-sessions-app").first();
  await expect(app).toBeVisible({ timeout: 30_000 });
  return app;
}

test("continue a session with another model beside it, linked both ways", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { directory } = await fixture(context);
  const app = await openApp(page);
  const top = ":scope > .agent-tiles-layer > ";
  const tiles = app.locator(".cs-tiles").first();
  const hostTile = tiles.locator(top + ".agent-tile[data-tile=host]");
  await app.getByRole("button", { name: /Browser focus zoom/ }).first().click();
  await expect(hostTile.locator(".cs-assistant").last()).toContainText("Want me to add it?", { timeout: 20_000 });

  // The session menu lists the new action; it turns into the model list.
  await hostTile.getByRole("button", { name: "More session actions" }).click();
  await hostTile.getByRole("menuitem", { name: /Continue with another model/ }).click();
  const picker = hostTile.getByRole("dialog", { name: "Continue with another model" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("combobox", { name: "Find a model" })).toBeFocused();
  await expect(picker).toContainText("Opens beside this chat");
  // The model this session uses is listed but cannot be picked.
  await expect(picker.getByRole("option", { name: /this session/ })).toHaveAttribute("aria-disabled", "true");
  // Esc closes it and nothing opens.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(tiles.locator(top + ".agent-tile")).toHaveCount(1);

  // Ctrl+Alt+M opens it straight away; type to filter, Enter opens the draft.
  await hostTile.getByRole("textbox", { name: "Message", exact: true }).press("Control+Alt+m");
  await expect(picker).toBeVisible();
  await page.keyboard.type("test codex");
  await expect(picker.getByRole("option", { name: "Test Codex model" })).toBeVisible();
  await expect(picker.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");

  // The draft lands beside the source; its composer has the reference and focus.
  const pane = tiles.locator(top + ".agent-tile:not([data-tile=host])");
  await expect(pane).toHaveCount(1);
  await expect(pane.locator(".cs-session-header strong").first()).toHaveText("New Codex session");
  const card = pane.getByRole("region", { name: "Continues from" });
  await expect(card).toContainText("Browser focus zoom: keep the page zoom");
  await expect(card).toContainText("Want me to add it?");
  await expect(card.locator(".cs-ref-files")).toContainText("src/App.vue");
  await expect(pane.locator(".cs-quotes li")).toContainText("full transcript");
  const draft = pane.getByRole("textbox", { name: "Message", exact: true });
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue('Continue from "Browser focus zoom: keep the page zoom". ');
  await expect(pane.locator(".cs-continue-model")).toContainText("Test Codex model");
  // Both headers link to each other.
  await expect(pane.locator(".cs-lineage")).toContainText("from Browser focus zoom");
  await expect(hostTile.locator(".cs-lineage")).toContainText("continued in New Codex session");
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath("continue-split.png") });

  // The transcript lists the turns; a turn opens the source pane.
  await card.getByRole("button", { name: /Read transcript/ }).click();
  await expect(card.locator(".cs-ref-turns li")).toHaveCount(3);
  await card.locator(".cs-ref-turns button").first().click();
  await expect(tiles.locator(":scope > .agent-tiles-frames > .agent-tile-frame.focused")).toHaveCount(1);
  await expect(hostTile).toHaveClass(/focused/);
  await expect(hostTile.locator(".cs-flash")).toHaveCount(1);
  // "continued in" goes back to the draft.
  await hostTile.locator(".cs-lineage").click();
  await expect(pane).toHaveClass(/focused/);

  // The gap between them still resizes the split.
  const gap = app.getByRole("separator", { name: "Resize session panes" });
  const g = (await gap.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 100, g.y + g.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(Number(await gap.getAttribute("aria-valuenow"))).toBeLessThan(45);

  // Sending passes the transcript path and the summary to the new agent.
  await draft.click();
  await draft.press("End");
  await draft.pressSequentially("Pick up the preload change.");
  await draft.press("Enter");
  await expect(pane.locator(".cs-message.cs-assistant").last()).toContainText("Codex started", { timeout: 20_000 });
  const inputs = (await readFile(join(directory, "inputs.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  // The last line may be the "suggest next message" helper; take the real turn.
  const sent = inputs.map((input) => input.message as string).find((message) => message.startsWith("Continue from"))!;
  expect(sent).toContain('Continue from "Browser focus zoom: keep the page zoom". Pick up the preload change.');
  expect(sent).toContain(`${claudeId}.jsonl`);
  expect(sent).toContain("Open: Forwarding the keys needs a preload change. Want me to add it?");
  // The sent message shows the reference as a chip, not as its full text.
  const sentMessage = pane.locator(".cs-message.cs-user").last();
  await expect(sentMessage.locator(".cs-sent-ref")).toContainText("@Browser focus zoom: keep the page zoom");
  await expect(sentMessage).not.toContainText("Its full transcript");
  await expect(hostTile.locator(".cs-lineage")).toContainText("continued in Continue from");
  // The new session keeps its link, and nests under the source in the list.
  await expect(pane.locator(".cs-lineage")).toContainText("from Browser focus zoom", { timeout: 20_000 });
  await expect(app.locator(".cs-session.cs-child")).toHaveCount(1, { timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("continue-sent.png") });
  expect(errors).toEqual([]);
});

test("continue from the pinned chat opens the draft in the panel, with a way back", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fixture(context);
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/");
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
  const key = await page.evaluate(async () => {
    const response = await fetch("/__orvane/agents/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const { sessions } = await response.json();
    return sessions[0].key as string;
  });
  await page.evaluate((value) => localStorage.setItem("orvane.side-chat.v1", JSON.stringify({ key: value, open: true })), key);
  await page.reload();
  const side = page.getByRole("complementary", { name: "Pinned AI session" });
  await expect(side.locator(".cs-assistant").last()).toContainText("Want me to add it?", { timeout: 30_000 });

  await side.getByRole("button", { name: "More session actions" }).click();
  await side.getByRole("menuitem", { name: /Continue with another model/ }).click();
  const picker = side.getByRole("dialog", { name: "Continue with another model" });
  await expect(picker).toContainText("Opens in this panel");
  // The list stays inside the narrow panel.
  const panel = (await side.boundingBox())!;
  const list = (await picker.boundingBox())!;
  expect(list.x).toBeGreaterThanOrEqual(panel.x);
  expect(list.x + list.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
  await page.keyboard.type("test codex");
  await expect(picker.getByRole("option", { name: "Test Codex model" })).toBeVisible();
  await page.keyboard.press("Enter");

  // The panel switches to the draft; its composer takes focus.
  const draft = side.getByRole("textbox", { name: "Message", exact: true });
  await expect(side.getByRole("region", { name: "Continues from" })).toBeVisible();
  await expect(draft).toHaveValue(/^Continue from "Browser focus zoom/);
  await expect(draft).toBeFocused();
  await draft.pressSequentially("Keep this text");
  await page.screenshot({ path: info.outputPath("continue-pinned.png") });

  // Opening the source keeps the draft one click away.
  await side.locator(".cs-lineage").click();
  await expect(side.locator(".cs-assistant").last()).toContainText("Want me to add it?", { timeout: 20_000 });
  const back = side.locator(".side-chat-back");
  await expect(back).toContainText("Draft · New Codex session");
  // The reference stays with the draft, not with the source's composer.
  await expect(side.locator(".cs-quotes li")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("continue-pinned-source.png") });
  await back.getByRole("button", { name: "Back to draft" }).click();
  await expect(draft).toHaveValue(/Keep this text$/);
  await expect(side.locator(".side-chat-back")).toHaveCount(0);
  expect(errors).toEqual([]);
});
