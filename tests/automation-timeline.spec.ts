import { expect, test } from "./fixtures";
import { applyCommands } from "../src/automation";
import { emptyWorkspace } from "../src/model";
import { addRun, overlaps, plannedRuns, RUN_KEEP_MS, RUN_LIMIT, type AutomationRun } from "../src/automationRuns";
import type { Trigger } from "../src/triggers";

const at = (h: number, m: number, day = 20) => new Date(2026, 10, day, h, m).getTime();

test("run history keeps a week and a few hundred runs, newest last", () => {
  const now = at(12, 0);
  const run = (id: string, end: number): AutomationRun => ({ id, workflowId: "w", source: "trigger", start: end - 1000, end });
  const kept = addRun([run("old", now - RUN_KEEP_MS - 1), run("recent", now - 1000)], run("new", now), now);
  expect(kept.map((r) => r.id)).toEqual(["recent", "new"]);
  let many: AutomationRun[] = [];
  for (let i = 0; i < RUN_LIMIT + 5; i++) many = addRun(many, run(`r${i}`, now), now);
  expect(many).toHaveLength(RUN_LIMIT);
  expect(many.at(-1)!.id).toBe(`r${RUN_LIMIT + 4}`);
});

test("overlaps are spans where runs of different workflows ran together", () => {
  expect(
    overlaps([
      { lane: "a", start: at(11, 0), end: at(11, 10) },
      { lane: "b", start: at(11, 5), end: at(11, 20) },
      { lane: "a", start: at(11, 30), end: at(11, 40) },
      { lane: "a", start: at(11, 35), end: at(11, 45) },
    ]),
  ).toEqual([[at(11, 5), at(11, 10)]]);
});

test("planned runs follow the trigger's schedule to the end of the day", () => {
  const trigger: Trigger = {
    id: "t",
    name: "T",
    workflowId: "w",
    inputs: {},
    enabled: true,
    schedule: { kind: "interval", minutes: 120 },
    createdAt: at(8, 0),
    lastRun: at(16, 0),
  };
  expect(plannedRuns(trigger, at(17, 0), at(23, 59))).toEqual([at(18, 0), at(20, 0), at(22, 0)]);
  const daily = { ...trigger, schedule: { kind: "daily" as const, time: "16:00" } };
  expect(plannedRuns(daily, at(12, 0), at(23, 59))).toEqual([at(16, 0)]);
});

test("Action library timeline shows runs as bars, failures and planned runs", async ({ page }) => {
  test.setTimeout(240_000);
  const workspace = applyCommands(emptyWorkspace(), [
    { operation: "app_create", args: { id: "log", properties: { name: "Log", x: 120, y: 100, width: 420, height: 360 } } },
    { operation: "component_create", args: { appId: "log", id: "items", kind: "list", properties: { label: "Runs" } } },
    { operation: "app_update", args: { appId: "log", patch: { exposed: true } } },
    {
      operation: "workflow_set",
      args: { id: "note", name: "Note", inputs: ["text"], steps: [{ action: "add-item", appId: "log", target: "items", value: "{text}" }] },
    },
    {
      operation: "workflow_set",
      args: { id: "export", name: "Export", inputs: [], steps: [{ action: "add-item", appId: "log", target: "items", value: "x" }] },
    },
    {
      operation: "trigger_set",
      args: { id: "tick", name: "Tick", workflowId: "note", inputs: { text: "tick" }, schedule: { kind: "interval", minutes: 30 } },
    },
  ]).workspace;
  // An earlier failed Export that overlapped a Note run, both an hour ago.
  const hourAgo = Date.now() - 3_600_000;
  workspace.runs = [
    { id: "r1", workflowId: "note", source: "trigger", triggerId: "tick", start: hourAgo, end: hourAgo + 120_000 },
    { id: "r2", workflowId: "export", source: "button", start: hourAgo + 60_000, end: hourAgo + 180_000, error: "Sign-in expired" },
  ];
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
    }
  }, workspace);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Run the trigger now from the library, then look at the timeline.
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Action library", exact: true }).click();
  const library = page.getByRole("region", { name: "Workspace action library" });
  await expect(library).toBeVisible({ timeout: 60_000 });
  await library.getByRole("button", { name: /^Note/ }).click();
  await library.getByRole("region", { name: "Triggers" }).getByRole("button", { name: "Run now" }).click();
  await expect(page.locator('[data-app-id="log"]').getByText("tick")).toBeVisible();

  await library.getByRole("button", { name: "Timeline" }).click();
  const timeline = library.getByRole("region", { name: "Automation timeline" });
  await expect(timeline.getByText(/^Today · 3 runs · 1 failed · 1 overlap$/)).toBeVisible();
  const note = timeline.locator(".at-lane").first();
  await expect(timeline.locator(".at-name").first()).toContainText("Note");
  await expect(timeline.locator(".at-name").first()).toContainText("Every 30 minutes");
  await expect(note.locator(".at-run.ok")).toHaveCount(2);
  await expect(note.locator(".at-run.plan").first()).toBeVisible();
  await expect(timeline.locator(".at-overlap")).toHaveCount(1);
  await expect(timeline.locator(".at-now")).toHaveCount(1);

  // A failed run explains itself and names what ran alongside.
  await timeline.locator(".at-run.fail").click();
  const detail = timeline.getByRole("dialog", { name: "Run details" });
  await expect(detail).toContainText("Sign-in expired");
  await expect(detail).toContainText("App button");
  await expect(detail).toContainText("Note");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(library).toBeVisible();

  // Filters and day navigation.
  await timeline.getByRole("button", { name: "Failed", exact: true }).click();
  await expect(timeline.locator(".at-name")).toHaveCount(1);
  await timeline.getByRole("button", { name: "All", exact: true }).click();
  await timeline.getByRole("button", { name: "Previous day" }).click();
  await expect(timeline.getByText(/^(?!Today)/).first()).toBeVisible();
  await timeline.getByRole("button", { name: "Today", exact: true }).click();

  // Clicking a lane opens that workflow in the Actions view.
  await timeline.locator(".at-name", { hasText: "Export" }).click();
  await expect(library.getByRole("button", { name: "Actions", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(library.getByRole("textbox", { name: "Action name" })).toHaveValue("Export");
});
