import { test, expect } from "./fixtures";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The AI launcher's Sessions tab opens an existing session's chat in place,
// and pins it to the right side of the window (Ctrl+Shift+J toggles it,
// Ctrl+Shift+A types in it). Built from docs/handoff/ai-launcher-sessions.
test("pick a session in the AI launcher, chat in place, pin it to the side", async ({ page, context }) => {
  test.setTimeout(150000);
  page.setDefaultNavigationTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cookie = (await context.cookies()).find((c) => c.name === "orvane-test-workspace")!.value;
  const folder = join(process.cwd(), ".orvane", "tests", cookie, "claude-projects", "side-chat-fixture");
  await mkdir(folder, { recursive: true });
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const line = (uuid: string, type: string, content: unknown) =>
    JSON.stringify({ uuid, type, sessionId, cwd: "C:/Example/Side", timestamp: "2026-11-23T10:00:00Z", message: { content } }) + "\n";
  await writeFile(
    join(folder, `${sessionId}.jsonl`),
    line("u1", "user", "Check the ritenuta on bill VB-2026-0418") +
      line("a0", "assistant", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:/Example/Side/bills/VB-2026-0418.json" } }]) +
      line("r0", "user", [{ type: "tool_result", tool_use_id: "t1", content: "{}" }]) +
      line("a1", "assistant", "The ritenuta is 200,00 and the bill pays 1.020,00."),
  );
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/");
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });

  // Launcher → Sessions: the list and the selected session's chat show together.
  await page.keyboard.press("Control+Shift+K");
  const launcher = page.getByRole("dialog", { name: "AI launcher" });
  await expect(launcher).toBeVisible();
  await launcher.getByRole("tab", { name: /Sessions/ }).click();
  const row = launcher.getByRole("option", { name: /Check the ritenuta on bill/ });
  await expect(row).toBeVisible({ timeout: 30000 });
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(launcher.getByRole("tab", { name: /Sessions · \d+/ })).toBeVisible();
  // The chat is Agent sessions' own chat; showing it leaves focus in the search.
  await expect(launcher.locator(".cs-assistant").last()).toContainText("The ritenuta is 200,00", { timeout: 30000 });
  const search = launcher.getByRole("textbox", { name: "Search sessions" });
  await expect(search).toBeFocused();
  await expect(launcher.locator(".launcher-keys")).toContainText("session");
  // Search filters the list; the first Esc clears it.
  await search.fill("nothing like this");
  await expect(launcher.getByText("No session matches.")).toBeVisible();
  await search.fill("ritenuta");
  await expect(row).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(launcher).toBeVisible();
  // The list folds away and back; searching unfolds it.
  await launcher.getByRole("button", { name: "Hide sessions" }).click();
  await expect(row).toBeHidden();
  await search.fill("ritenuta");
  await expect(row).toBeVisible();
  await search.fill("");
  // Enter opens it: the composer takes focus; Esc goes back to the list.
  await search.focus();
  await page.keyboard.press("Enter");
  const composer = launcher.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(launcher).toBeVisible();
  await expect(launcher.locator(".session-rows")).toBeFocused();

  // Ctrl+Shift+J pins the launcher's chat: the launcher closes, the chat stays
  // on the right and the canvas (and its dock) end left of it.
  const dockBefore = (await page.locator(".dock").boundingBox())!;
  await page.keyboard.press("Control+Shift+J");
  await expect(launcher).toHaveCount(0);
  const side = page.getByRole("complementary", { name: "Pinned AI session" });
  await expect(side).toBeVisible();
  await expect(side.getByRole("button", { name: "Switch session" })).toContainText("Check the ritenuta on bill");
  await expect(side.locator(".side-chat-provider")).toHaveText("C");
  await expect(side.locator(".cs-assistant").last()).toContainText("The ritenuta is 200,00", { timeout: 30000 });
  const box = (await side.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.round(box.x + box.width)).toBeGreaterThan(viewport.width - 20);
  const dockAfter = (await page.locator(".dock").boundingBox())!;
  const dockCentre = dockAfter.x + dockAfter.width / 2;
  expect(Math.abs(dockCentre - (viewport.width - 396) / 2)).toBeLessThan(3);
  expect(dockCentre).toBeLessThan(dockBefore.x + dockBefore.width / 2 - 100);

  // Ctrl+Shift+A jumps into its composer.
  await page.locator("main").click({ position: { x: 20, y: 300 } });
  await page.keyboard.press("Control+Shift+A");
  await expect(side.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");

  // Ctrl+Shift+J unpins and pins the same session again; it survives a reload.
  await page.keyboard.press("Control+Shift+J");
  await expect(side).toHaveCount(0);
  await page.keyboard.press("Control+Shift+J");
  await expect(side).toBeVisible();
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Pinned AI session" })).toBeVisible({ timeout: 60000 });

  // The switcher lists sessions.
  await page.getByRole("button", { name: "Switch session" }).click();
  await expect(page.locator(".side-chat-list").getByRole("option", { name: /Check the ritenuta/ })).toBeVisible();
  await expect(page.locator(".side-chat-list").getByRole("textbox", { name: "Search sessions" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".side-chat-list")).toHaveCount(0);
  expect(errors).toEqual([]);
});
