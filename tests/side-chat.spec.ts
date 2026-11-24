import { test, expect } from "./fixtures";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The AI launcher's Sessions tab opens an existing session's chat in place,
// and pins it to the right side of the window (Ctrl+Shift+J toggles it,
// Ctrl+Shift+A types in it). Built from docs/handoff/ai-launcher-sessions.
test("pick a session in the AI launcher, chat in place, pin it to the side", async ({ page, context }, info) => {
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
    JSON.stringify({
      uuid: "a1", type: "assistant", sessionId, cwd: "C:/Example/Side",
      timestamp: "2026-11-23T10:00:00Z",
      message: { content: "The ritenuta is 200,00 and the bill pays 1.020,00.", usage: { input_tokens: 124000 } },
    }) + "\n",
  );
  await page.route("**/__orvane/agents/usage", (route) => route.fulfill({ json: {
    claude: { at: Date.now(), fiveHour: { used: 32 } },
  } }));
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

  // Ctrl+Shift+J pins the chat below the header and above the dock.
  const headerBefore = (await page.locator(".topbar").boundingBox())!;
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
  // The dock stays where it was (centred on the window, same width); the
  // panel ends above its row and never covers it.
  const dockAfter = (await page.locator(".dock").boundingBox())!;
  expect(await page.locator(".topbar").boundingBox()).toEqual(headerBefore);
  expect(box.y).toBeGreaterThanOrEqual(headerBefore.y + headerBefore.height);
  expect(Math.abs(dockAfter.x - dockBefore.x)).toBeLessThan(1);
  expect(Math.abs(dockAfter.width - dockBefore.width)).toBeLessThan(1);
  expect(Math.abs(dockAfter.x + dockAfter.width / 2 - viewport.width / 2)).toBeLessThan(3);
  expect(box.y + box.height).toBeLessThanOrEqual(dockAfter.y - 4);
  await page.screenshot({ path: info.outputPath("pinned-chat.png") });

  // The left edge resizes it: drag, keys, limits; the width is kept.
  const edge = side.getByRole("separator", { name: "Resize side chat" });
  const width = async () => Math.round((await side.boundingBox())!.width);
  const start = await width();
  const grip = (await edge.boundingBox())!;
  await page.mouse.move(grip.x + 4, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(width).toBe(start);
  await page.mouse.down();
  await page.mouse.move(grip.x + 4 - 100, grip.y + grip.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(width).toBe(start + 100);
  await side.getByRole("button", { name: "Edits: Ask first" }).click();
  await side.getByRole("button", { name: "Edits: Auto-accept" }).click();
  await side.getByRole("button", { name: "Edits: Plan only" }).click();
  const toolbar = side.locator(".cs-composer .cs-compose-actions");
  const overflow = () => toolbar.evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const panel = row.closest(".side-chat")!.getBoundingClientRect();
    return Math.max(
      0, panel.left - bounds.left, bounds.right - panel.right,
      ...Array.from(row.querySelectorAll("button, .cr-ring"), (control) => {
        const box = control.getBoundingClientRect();
        return Math.max(bounds.left - box.left, box.right - bounds.right);
      }),
    );
  });
  await expect(toolbar.locator(".cr-ring")).toBeVisible();
  await expect(toolbar.locator(".au-pill")).toContainText("32%");
  // Check while the pointer is down as well as at either keyboard limit.
  const drag = (await edge.boundingBox())!;
  await page.mouse.move(drag.x + 4, drag.y + drag.height / 2);
  await page.mouse.down();
  for (const target of [470, 448, 420, 384, 320]) {
    await page.mouse.move(drag.x + 4 + start + 100 - target, drag.y + drag.height / 2);
    await expect.poll(width).toBe(target);
    expect(await overflow(), `toolbar overflow at ${target}px`).toBeLessThan(1);
    const usage = (await toolbar.locator(".au-pill").boundingBox())!;
    const send = (await toolbar.getByRole("button", { name: "Send", exact: true }).boundingBox())!;
    expect(Math.abs(usage.y + usage.height / 2 - send.y - send.height / 2)).toBeLessThan(1);
  }
  await page.mouse.up();
  const modelControl = (await toolbar.getByRole("combobox", { name: "Model" }).boundingBox())!;
  const editControl = (await toolbar.getByRole("button", { name: "Edits: Full access" }).boundingBox())!;
  expect(Math.abs(modelControl.y + modelControl.height / 2 - editControl.y - editControl.height / 2)).toBeLessThan(1);
  expect(await side.locator(".side-chat-keys").evaluate((footer) => footer.scrollWidth - footer.clientWidth)).toBeLessThan(1);
  await page.screenshot({ path: info.outputPath("pinned-chat-narrow.png") });
  await edge.focus();
  await page.keyboard.press("End");
  await expect.poll(width).toBe(Math.min(720, Math.round(viewport.width / 2)));
  await page.keyboard.press("Home");
  await expect.poll(width).toBe(320);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBe(336);

  // Alt+U after a press on the panel itself (its footer focuses nothing) opens
  // the panel's usage, once.
  await side.locator(".side-chat-keys").click({ position: { x: 24, y: 8 } });
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("Alt+u");
  const usage = page.getByRole("dialog", { name: "Usage" });
  await expect(usage).toHaveCount(1);
  await page.keyboard.press("Alt+u");
  await expect(usage).toHaveCount(0);

  // Ctrl+Shift+A jumps into its composer.
  await page.locator("main").click({ position: { x: 20, y: 300 } });
  await page.keyboard.press("Control+Shift+A");
  await expect(side.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");

  // Ctrl+Shift+J folds the panel into a small face at the middle of the right
  // edge (the canvas gets its width back) and opens it again.
  await page.keyboard.press("Control+Shift+J");
  await expect(side).toBeHidden();
  const bubble = page.getByRole("button", { name: /Open pinned chat: Check the ritenuta/ });
  await expect(bubble).toBeVisible();
  const spot = (await bubble.boundingBox())!;
  expect(Math.abs(spot.y + spot.height / 2 - viewport.height / 2)).toBeLessThan(3);
  expect(spot.x + spot.width).toBeGreaterThan(viewport.width - 20);
  await expect.poll(async () => {
    const dock = (await page.locator(".dock").boundingBox())!;
    return Math.abs(dock.x + dock.width / 2 - viewport.width / 2);
  }).toBeLessThan(3);
  await page.keyboard.press("Control+Shift+J");
  await expect(side).toBeVisible();
  await expect(bubble).toHaveCount(0);
  // The header button collapses, the bubble opens.
  await side.getByRole("button", { name: "Collapse side chat" }).click();
  await expect(side).toBeHidden();
  await bubble.click();
  await expect(side).toBeVisible();
  // Ctrl+Shift+A opens a collapsed chat and types in it.
  await page.keyboard.press("Control+Shift+J");
  await expect(side).toBeHidden();
  await page.locator("main").click({ position: { x: 20, y: 300 } });
  await page.keyboard.press("Control+Shift+A");
  await expect(side.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  // Unpin removes it; it survives a reload once pinned again.
  await side.getByRole("button", { name: "Unpin side chat" }).click();
  await expect(side).toHaveCount(0);
  await expect(bubble).toHaveCount(0);
  await page.keyboard.press("Control+Shift+J");
  await expect(side).toBeVisible();
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Pinned AI session" })).toBeVisible({ timeout: 60000 });
  await expect.poll(async () => Math.round((await page.getByRole("complementary", { name: "Pinned AI session" }).boundingBox())!.width)).toBe(336);

  // The switcher lists sessions.
  await page.getByRole("button", { name: "Switch session" }).click();
  await expect(page.locator(".side-chat-list").getByRole("option", { name: /Check the ritenuta/ })).toBeVisible();
  await expect(page.locator(".side-chat-list").getByRole("textbox", { name: "Search sessions" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".side-chat-list")).toHaveCount(0);
  expect(errors).toEqual([]);
});
