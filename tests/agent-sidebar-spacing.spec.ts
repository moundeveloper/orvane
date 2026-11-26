import { test, expect } from "./fixtures";
import { readFile } from "node:fs/promises";
test.setTimeout(120_000);
test.beforeEach(({ page }) => { page.setDefaultNavigationTimeout(90_000); });

test("the scrolling session list keeps a gap above Settings", async ({ page }, info) => {
  // Exercise the shipped layout CSS directly, without booting the canvas or
  // background services. This is a geometry regression for a full sidebar.
  const source = await readFile("src/components/AgentSessions.vue", "utf8");
  const css = source.match(/<style scoped>([\s\S]*?)<\/style>/)![1];
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:24px;background:#e9edf0;font:13px Inter,sans-serif}
    :root{--surface:#f7f9fa}${css}</style><div style="width:1100px;height:440px"><div class="agent-sessions-app">
    <header class="cs-toolbar">Agent sessions</header><div class="cs-layout"><nav class="cs-sidebar">
    <button class="cs-schedule-nav">Scheduled</button><label class="cs-search">Find a session</label>
    <div class="cs-session-list"><p class="cs-group">Today</p>${Array.from({length:35},(_,i)=>
      `<button class="cs-session"><strong>Inbound and agent console ${i}</strong><span class="cs-row-meta">Claude Code · GTK-VERTICAL</span></button>`).join("")}</div>
    <button class="cs-schedule-nav cs-settings-nav">Settings</button></nav><main></main></div></div></div>`);
  const list = page.locator(".cs-session-list");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(list.locator(".cs-session")).toHaveCount(35);
  await expect.poll(async () => (await settings.boundingBox())!.y -
    ((await list.boundingBox())!.y + (await list.boundingBox())!.height)).toBeGreaterThanOrEqual(8);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const last = await list.locator(".cs-session").last().boundingBox();
  expect(last!.y + last!.height).toBeLessThanOrEqual((await settings.boundingBox())!.y - 8);
  await page.screenshot({ path: info.outputPath("sidebar-settings-gap.png") });
});

test("Claude accounts can be renamed and chosen with visible keyboard-accessible radios", async ({ page }, info) => {
  const profiles = ["Default", "Work"].map((name, i) => ({ id: i ? "work-one" : "default", name,
    color: "#6f8998", folder: i ? "C:/fixture/work" : "C:/fixture/default", isDefault: !i, inherited: !i,
    generated: false, removed: false, newChats: !i, running: 0, signingIn: false, sessions: 2, mcp: true,
    auth: { loggedIn: true, supported: true, checkedAt: 1 }, usage: null }));
  let renames = 0;
  await page.route("**/__orvane/agents/**", (route) => {
    const op = route.request().url().split("/").pop();
    if (op === "claude-profile-rename") {
      const { id, name } = route.request().postDataJSON();
      renames++;
      if (profiles.some((p) => p.id !== id && p.name.toLowerCase() === name.trim().toLowerCase()))
        return route.fulfill({ status: 400, json: { error: "An account with that name already exists." } });
      profiles.find((p) => p.id === id)!.name = name.trim();
    }
    if (op === "claude-profile-new-chats") {
      const { id } = route.request().postDataJSON();
      profiles.forEach((profile) => { profile.newChats = profile.id === id; });
    }
    return route.fulfill({ json: { profiles, newChatProfileId: profiles.find((profile) => profile.newChats)!.id, draft: { id: "new-account", folder: "C:/fixture/new" } } });
  });
  await page.goto("/tests/agent-sidebar-harness.html?accounts");
  const work = page.getByRole("listitem", { name: "Work", exact: true });
  await expect(work).toBeVisible({ timeout: 60_000 });
  await work.getByRole("button", { name: "Rename", exact: true }).click();
  const input = work.getByRole("textbox", { name: "Account name", exact: true });
  await expect(input).toBeFocused();
  await input.fill("Personal");
  await input.press("Escape");
  expect(renames).toBe(0);
  await work.getByRole("button", { name: "Rename", exact: true }).click();
  await input.fill("Default");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("already exists");
  await input.fill("Personal");
  await input.press("Enter");
  await expect(page.getByRole("listitem", { name: "Personal", exact: true })).toBeVisible();
  expect(profiles[1]!.id).toBe("work-one");
  expect(profiles[1]!.folder).toBe("C:/fixture/work");
  const defaultChoice = page.getByRole("radio", { name: "Use Default for new chats", exact: true });
  const personalChoice = page.getByRole("radio", { name: "Use Personal for new chats", exact: true });
  await expect(defaultChoice).toBeVisible();
  await expect(personalChoice).toBeVisible();
  await defaultChoice.focus();
  await defaultChoice.press("ArrowDown");
  await expect(personalChoice).toBeChecked();
  await expect(defaultChoice).not.toBeChecked();
  await expect(personalChoice).toBeFocused();
  await personalChoice.press("Home");
  await expect(defaultChoice).toBeChecked();
  await personalChoice.click();
  await expect(personalChoice).toBeChecked();
  await expect(page.locator(".ca-foot")).toContainText("New Claude chats use Personal");
  await page.reload();
  await expect(page.getByRole("listitem", { name: "Personal", exact: true })).toBeVisible();
  await expect(personalChoice).toBeChecked();
  await page.screenshot({ path: info.outputPath("renamed-claude-account.png") });
});
