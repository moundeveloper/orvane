import { test, expect } from "./fixtures";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The AI launcher's Sessions tab opens an existing session's chat in place,
// and pins it to the right side of the window (Ctrl+Shift+J toggles it).
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
    line("u1", "user", "Check the ritenuta on bill VB-2026-0418") + line("a1", "assistant", "The ritenuta is 200,00 and the bill pays 1.020,00."),
  );
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/");
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });

  // Launcher → Sessions → the session → its chat, here.
  await page.keyboard.press("Control+Shift+K");
  const launcher = page.getByRole("dialog", { name: "AI launcher" });
  await expect(launcher).toBeVisible();
  await launcher.getByRole("tab", { name: "Sessions" }).click();
  const row = launcher.getByRole("option", { name: /Check the ritenuta on bill/ });
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.click();
  await expect(launcher.locator(".cs-assistant")).toContainText("The ritenuta is 200,00", { timeout: 30000 });
  await expect(launcher.locator("textarea").last()).toBeVisible();

  // Pin: the launcher closes, the chat stays on the right.
  await launcher.getByRole("button", { name: "Pin to side" }).click();
  await expect(launcher).toHaveCount(0);
  const side = page.getByRole("complementary", { name: "Pinned AI session" });
  await expect(side).toBeVisible();
  await expect(side.getByRole("button", { name: "Switch session" })).toContainText("Check the ritenuta on bill");
  await expect(side.locator(".cs-assistant")).toContainText("The ritenuta is 200,00", { timeout: 30000 });
  const box = (await side.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.round(box.x + box.width)).toBeGreaterThan(viewport.width - 20);

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
  await page.keyboard.press("Escape");
  await expect(page.locator(".side-chat-list")).toHaveCount(0);
  expect(errors).toEqual([]);
});
