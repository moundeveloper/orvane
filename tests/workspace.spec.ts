test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    () =>
      window === window.top &&
      localStorage.setItem("orvane.examples.v1", "installed"),
  );
});
import { test, expect } from "@playwright/test";
import { emptyWorkspace, makeBlock, uid, type CanvasApp } from "../src/model";

function fixtureApp(name: string, x = 140): CanvasApp {
  return {
    id: uid(),
    name,
    icon: "app",
    x,
    y: 160,
    width: 490,
    height: 500,
    blocks: [],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 26,
    gap: 18,
    radius: 8,
  };
}

test("empty start, creation, edit, archive, restore and reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".canvas-app")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/empty-desktop.png" });
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(page.locator(".canvas-app")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("Daily notes");
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page.getByRole("button", { name: "Add your first component" }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Content", exact: true })
    .fill("A place for the next idea.");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A place for the next idea." }),
  ).toBeVisible();
  await page.waitForTimeout(250);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "A place for the next idea." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Options for Daily notes" }).click();
  await page.getByRole("button", { name: "Archive app", exact: true }).click();
  await expect(page.locator(".canvas-app")).toHaveCount(0);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A place for the next idea." }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/app-desktop.png" });
});

test("builds and runs an explicit add-item → clear-field chain", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("A small list");
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  const add = async (name: string) => {
    await page
      .getByRole("button", { name: "Add component", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name, exact: true }).click();
  };
  await add("Text field");
  await page
    .locator(".property")
    .filter({ hasText: /^Label/ })
    .getByRole("textbox")
    .fill("New thought");
  await add("List");
  await add("Button");
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Target component", exact: true })
    .click();
  await page.getByRole("option", { name: "Your items", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Action value", exact: true })
    .fill("{New thought}");
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .nth(1)
    .click();
  await page.getByRole("option", { name: "Clear field", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Target component", exact: true })
    .nth(1)
    .click();
  await page.getByRole("option", { name: "New thought", exact: true }).click();
  await page.getByRole("button", { name: "Expand to graph" }).click();
  await expect(page.locator(".vue-flow__node")).toHaveCount(3);
  await page.screenshot({ path: "artifacts/builder-desktop.png" });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("textbox", { name: "New thought", exact: true })
    .fill("Take a walk");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(page.locator(".list-item")).toContainText("Take a walk");
  await expect(
    page.getByRole("textbox", { name: "New thought", exact: true }),
  ).toHaveValue("");
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator(".list-item")).toContainText("Take a walk");
});

test("gestures preserve app input ownership; move and resize persist", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  const app = page.locator(".canvas-app");
  const before = (await app.boundingBox())!;
  await page.mouse.move(before.x + 70, before.y + 100);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(before.x + 150, before.y + 160, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const moved = (await app.boundingBox())!;
  expect(Math.round(moved.x - before.x)).toBe(80);
  expect(Math.round(moved.y - before.y)).toBe(60);
  await page.mouse.move(moved.x + moved.width - 1, moved.y + moved.height - 1);
  await page.mouse.down();
  await page.mouse.move(
    moved.x + moved.width + 49,
    moved.y + moved.height + 29,
    { steps: 5 },
  );
  await page.mouse.up();
  const resized = (await app.boundingBox())!;
  expect(Math.round(resized.width - moved.width)).toBe(50);
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("nkh space typing");
  await expect(app).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .press("Space");
  expect(await page.locator(".is-panning").count()).toBe(0);
  await page.waitForTimeout(250);
  await page.reload();
  expect(Math.round((await app.boundingBox())!.width)).toBe(
    Math.round(resized.width),
  );
  const width = await app.evaluate((el) => (el as HTMLElement).offsetWidth);
  await page.mouse.move(700, 300);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -80);
  await page.keyboard.up("Control");
  expect(await app.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(
    width,
  );
});

test("small-screen creation and search are usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("Pocket notes");
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page.getByRole("button", { name: "Add your first component" }).click();
  await page.getByRole("button", { name: "Counter", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Increase Counter" }).click();
  await expect(page.locator("output")).toHaveText("1");
  await page.screenshot({ path: "artifacts/app-mobile.png" });
  await page.getByRole("button", { name: "Find an app", exact: true }).click();
  await page.getByRole("textbox", { name: "Search apps" }).fill("Pocket");
  await expect(page.locator(".search-results button")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search apps" }).press("Enter");
  await expect(page.locator(".search-panel")).toHaveCount(0);
});

test("cross-app actions use stable IDs, survive rename and fail visibly after archive", async ({
  page,
}) => {
  const w = emptyWorkspace(),
    source = fixtureApp("Sender"),
    target = fixtureApp("Receiver", 720);
  target.exposed = true;
  const list = makeBlock("list"),
    field = makeBlock("input"),
    button = makeBlock("button");
  field.label = "A message";
  button.label = "Send to receiver";
  button.rules = [
    {
      id: uid(),
      action: "add-item",
      target: list.id,
      appId: target.id,
      value: "{A message}",
    },
  ];
  source.blocks = [field, button];
  target.blocks = [list];
  w.apps = [source, target];
  await page.addInitScript(
    (data) => localStorage.setItem("orvane.workspace.v1", JSON.stringify(data)),
    w,
  );
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .nth(1)
    .fill("Renamed receiver");
  await page
    .getByRole("textbox", { name: "A message", exact: true })
    .fill("An explicit connection");
  await page.getByRole("button", { name: "Send to receiver" }).click();
  await expect(page.locator(".list-item")).toContainText(
    "An explicit connection",
  );
  await page
    .getByRole("button", { name: "Options for Renamed receiver" })
    .click();
  await page.getByRole("button", { name: "Archive app", exact: true }).click();
  await page.getByRole("button", { name: "Send to receiver" }).click();
  await expect(page.locator(".app-error")).toContainText(
    "archived, missing, or no longer exposes",
  );
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByText("Connection activity").click();
  await expect(page.locator(".trace").first()).toContainText("Sender");
});

test("custom action runs in an isolated worker and an infinite loop times out", async ({
  page,
}) => {
  const w = emptyWorkspace(),
    a = fixtureApp("Code actions");
  const field = makeBlock("input"),
    button = makeBlock("button"),
    text = makeBlock("text");
  button.label = "Transform";
  field.value = "quiet";
  text.label = "Result";
  const custom = {
    id: uid(),
    name: "Uppercase",
    code: "return value.toUpperCase()",
  };
  w.customNodes = [custom];
  button.rules = [
    {
      id: uid(),
      action: "custom",
      target: "",
      appId: "",
      value: "",
      nodeId: custom.id,
    },
    { id: uid(), action: "set-text", target: text.id, appId: "", value: "" },
  ];
  a.blocks = [field, button, text];
  w.apps = [a];
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    if (!localStorage.getItem("orvane.workspace.v1"))
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, w);
  await page.goto("/");
  await page.getByRole("button", { name: "Transform", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "QUIET", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit Uppercase", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "JavaScript", exact: true })
    .fill("while(true) {}");
  await page
    .getByRole("button", { name: "Done editing action", exact: true })
    .click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Transform", exact: true }).click();
  await expect(page.locator(".app-error")).toContainText(
    "2-second time limit",
    { timeout: 5000 },
  );
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(page.locator(".canvas-app")).toHaveCount(2);
});

test("shared definitions and detached copies survive reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page.getByRole("button", { name: "Add your first component" }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("button", { name: "Make reusable" }).click();
  await page
    .getByRole("button", { name: "Add component", exact: true })
    .first()
    .click();
  await page
    .locator(".component-picker")
    .getByRole("button", { name: "Something worth keeping." })
    .click();
  await page
    .getByRole("textbox", { name: "Content", exact: true })
    .fill("Together, until detached.");
  await page.getByRole("button", { name: "Update all linked copies" }).click();
  await expect(page.locator(".app-text")).toHaveText([
    "Together, until detached.",
    "Together, until detached.",
  ]);
  await page.getByRole("button", { name: "Detach this copy" }).click();
  await page
    .getByRole("textbox", { name: "Content", exact: true })
    .fill("A thought of my own.");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator(".status-area")).toHaveCount(0);
  await expect(page.locator(".app-text")).toHaveText([
    "Together, until detached.",
    "A thought of my own.",
  ]);
});

test("storage failure is visible without blocking app use", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    Storage.prototype.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(page.locator(".status-area")).toContainText(
    "Saving is unavailable",
  );
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("Still usable");
  await expect(page.locator(".dock-tab")).toContainText("Still usable");
});
