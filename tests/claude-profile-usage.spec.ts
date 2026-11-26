import { test, expect } from "./fixtures";
import { join } from "node:path";
import { LocalDatabase } from "../server/database";

test("saved Claude limits remain unknown until the current login identity is confirmed", async ({ context }) => {
  const namespace = (await context.cookies()).find((cookie) => cookie.name === "orvane-test-workspace")!.value;
  const database = new LocalDatabase(join(process.cwd(), ".orvane", "tests", `${namespace}.sqlite`));
  try {
    database.saveAppData("agent-usage", {
      claudeProfiles: {
        default: { fingerprint: "previous-login", usage: { at: Date.now(), fiveHour: { used: 91 } } },
      },
    });
  } finally {
    database.close();
  }
  const response = await context.request.post("/__orvane/agents/usage", { data: {} });
  expect(response.ok()).toBe(true);
  const usage = await response.json();
  expect(usage.claude).toBeNull();
  expect(usage.claudeProfiles.default).toBeNull();
});

test("a delayed usage response cannot replace the newly selected account's limits", async ({ page }) => {
  let releaseDefault!: () => void;
  const holdDefault = new Promise<void>((resolve) => { releaseDefault = resolve; });
  let defaultRequested!: () => void;
  const requested = new Promise<void>((resolve) => { defaultRequested = resolve; });
  await page.route("**/__orvane/agents/usage", async (route) => {
    const profile = route.request().postDataJSON().profileId;
    if (profile === "default") {
      defaultRequested();
      await holdDefault;
    }
    await route.fulfill({ json: {
      claude: { at: Date.now(), fiveHour: { used: profile === "default" ? 39 : 82 } }, codex: null,
    } });
  });
  try {
    await page.goto("/tests/claude-usage-harness.html");
    await requested;
    await page.evaluate(() => (window as any).selectUsageProfile("work-one"));
    await expect(page.locator(".au-pill")).toHaveText("5h 82%");
    const finished = page.waitForResponse((response) =>
      response.url().endsWith("/__orvane/agents/usage") && response.request().postDataJSON().profileId === "default");
    releaseDefault();
    await (await finished).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".au-pill")).toHaveText("5h 82%");
  } finally {
    releaseDefault();
  }
});

test("the launcher session list only marks the matching account's duplicate UUID as working", async ({ page }) => {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const defaults = { key: "default-key", profileId: "default", sessionId, title: "Default chat", project: "fixture", updatedAt: Date.now(), bytes: 1 };
  const work = { ...defaults, key: "claude@work-one:work-key", profileId: "work-one", title: "Work chat" };
  await page.route("**/__orvane/agents/sessions", (route) => route.fulfill({ json: {
    sessions: [defaults, work], runs: [{ id: "work-run", provider: "claude", profileId: "work-one", key: work.key, sessionId, status: "running" }],
  } }));
  await page.route("**/__orvane/agents/claude-profiles", (route) => route.fulfill({ json: {
    profiles: [{ id: "default", name: "Default", color: "#6f8998" }, { id: "work-one", name: "Work", color: "#5f8a74" }],
    newChatProfileId: "default", draft: { id: "fixture-new", folder: "fixture" },
  } }));
  await page.goto("/tests/claude-usage-harness.html?sessions");
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.locator(".session-state.working")).toHaveCount(1);
  await expect(page.getByRole("option", { name: /Work chat/ }).locator(".session-state")).toContainText("working");
  await expect(page.getByRole("option", { name: /Default chat/ }).locator(".session-state")).not.toContainText("working");
});
