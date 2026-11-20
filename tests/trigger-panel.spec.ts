import { expect, test } from "./fixtures";
import { applyCommands } from "../src/automation";
import { emptyWorkspace } from "../src/model";
import { nextOccurrence, type Trigger } from "../src/triggers";

// Action library → Triggers: a person can see, pause, run, edit, add and
// delete a workflow's scheduled triggers without an agent.
test("nextOccurrence gives the next run, or none while paused", () => {
  const at = (h: number, m: number, day = 19) => new Date(2026, 10, day, h, m).getTime();
  const base: Trigger = {
    id: "t",
    name: "T",
    workflowId: "w",
    inputs: {},
    enabled: true,
    schedule: { kind: "interval", minutes: 15 },
    createdAt: at(8, 0),
  };
  expect(nextOccurrence(base, at(8, 5))).toBe(at(8, 15));
  expect(nextOccurrence({ ...base, lastRun: at(8, 45) }, at(8, 50))).toBe(at(9, 0));
  expect(nextOccurrence({ ...base, enabled: false }, at(8, 5))).toBeNull();
  const nine = { ...base, schedule: { kind: "daily" as const, time: "09:00" } };
  expect(nextOccurrence(nine, at(8, 0))).toBe(at(9, 0));
  expect(nextOccurrence(nine, at(9, 0))).toBe(at(9, 0, 20));
  // 20 Nov 2026 is a Friday: weekdays only, the next is Monday 23.
  const weekdays = { ...base, schedule: { kind: "daily" as const, time: "09:00", days: [1, 2, 3, 4, 5] } };
  expect(nextOccurrence(weekdays, at(10, 0, 20))).toBe(at(9, 0, 23));
});

test("Action library shows a workflow's triggers and manages them", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = applyCommands(emptyWorkspace(), [
    { operation: "app_create", args: { id: "log", properties: { name: "Log", x: 120, y: 100, width: 420, height: 360 } } },
    { operation: "component_create", args: { appId: "log", id: "items", kind: "list", properties: { label: "Runs" } } },
    { operation: "app_update", args: { appId: "log", patch: { exposed: true } } },
    {
      operation: "workflow_set",
      args: {
        id: "note",
        name: "Note",
        inputs: ["text"],
        steps: [{ action: "add-item", appId: "log", target: "items", value: "{text}" }],
      },
    },
    {
      operation: "trigger_set",
      args: { id: "tick", name: "Tick", workflowId: "note", inputs: { text: "tick" }, schedule: { kind: "interval", minutes: 30 } },
    },
  ]).workspace;
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
    }
  }, workspace);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const openLibrary = async () => {
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Action library", exact: true }).click();
    const library = page.getByRole("region", { name: "Workspace action library" });
    await expect(library).toBeVisible({ timeout: 60_000 });
    await library.getByRole("button", { name: /^Note/ }).click();
    return library.getByRole("region", { name: "Triggers" });
  };
  let triggers = await openLibrary();
  const library = page.getByRole("region", { name: "Workspace action library" });
  // The library row counts the workflow's triggers.
  await expect(library.getByRole("button", { name: /^Note/ }).locator(".action-trigger-count")).toHaveText("1");

  const tick = triggers.getByRole("article", { name: "Trigger Tick" });
  await expect(tick).toContainText("Every 30 minutes");
  await expect(tick).toContainText(/Next today|Next tomorrow/);
  await expect(tick).toContainText("Not run yet");

  // Pause and resume.
  await tick.getByRole("button", { name: "Pause" }).click();
  await expect(tick).toContainText("Paused");
  await tick.getByRole("button", { name: "Resume" }).click();
  await expect(tick).not.toContainText("Paused");

  // Run now runs the workflow with the trigger's inputs.
  await tick.getByRole("button", { name: "Run now" }).click();
  await expect(triggers.getByRole("status").filter({ hasText: "Tick ran." })).toBeVisible();
  await expect(tick).toContainText("Last ran just now");
  await expect(page.locator('[data-app-id="log"] .list-item')).toHaveText(["tick"]);

  // Edit: daily at a time on chosen days.
  await tick.getByRole("button", { name: "Edit trigger Tick" }).click();
  const form = triggers.getByRole("form", { name: "Edit trigger" });
  await form.getByLabel("Trigger name").fill("Morning");
  await form.getByRole("combobox", { name: "Trigger repeat" }).click();
  await page.getByRole("option", { name: "At a time of day" }).click();
  await form.getByRole("button", { name: "Mon" }).click();
  await form.getByRole("button", { name: "Fri" }).click();
  await form.getByLabel("Trigger input text").fill("morning");
  await form.getByRole("button", { name: "Save trigger" }).click();
  const morning = triggers.getByRole("article", { name: "Trigger Morning" });
  await expect(morning).toContainText("Mon, Fri at 09:00");
  // A changed schedule starts again: the earlier run is no longer counted.
  await expect(morning).toContainText("Not run yet");

  // Add a second trigger; its form needs the workflow's input.
  await triggers.getByRole("button", { name: "Add trigger" }).click();
  const added = triggers.getByRole("form", { name: "New trigger" });
  await added.getByLabel("Trigger name").fill("Hourly");
  await added.getByRole("spinbutton", { name: "Trigger minutes" }).fill("60");
  await added.getByRole("spinbutton", { name: "Trigger minutes" }).press("Tab");
  await added.getByLabel("Trigger input text").fill("hour");
  await added.getByRole("button", { name: "Save trigger" }).click();
  await expect(triggers.getByRole("article", { name: "Trigger Hourly" })).toContainText("Every hour");
  await expect(library.getByRole("button", { name: /^Note/ }).locator(".action-trigger-count")).toHaveText("2");

  // Escape closes the form without saving.
  await triggers.getByRole("button", { name: "Add trigger" }).click();
  await triggers.getByRole("form", { name: "New trigger" }).getByLabel("Trigger name").press("Escape");
  await expect(triggers.getByRole("form")).toHaveCount(0);
  await expect(library).toBeVisible();

  // Delete one.
  await triggers.getByRole("button", { name: "Delete trigger Hourly" }).click();
  await expect(triggers.getByRole("article", { name: "Trigger Hourly" })).toHaveCount(0);

  // Everything is saved: reopen after a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  triggers = await openLibrary();
  await expect(triggers.getByRole("article")).toHaveCount(1);
  const saved = triggers.getByRole("article", { name: "Trigger Morning" });
  await expect(saved).toContainText("Mon, Fri at 09:00");
  await saved.getByRole("button", { name: "Edit trigger Morning" }).click();
  await expect(triggers.getByLabel("Trigger input text")).toHaveValue("morning");
});
