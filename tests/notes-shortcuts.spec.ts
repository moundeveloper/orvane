import { expect, test } from "./fixtures";
import { emptyWorkspace, makeBlock } from "../src/model";

// Inside Notes, Ctrl+K opens the workspace palette like everywhere else;
// the Notes search moved to Alt+K.
test("Ctrl+K opens the palette inside Notes and Alt+K opens Notes search", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const timestamp = "2026-11-20";
  await page.route("**/__orvane/notes/data", async (route) => {
    const args = route.request().postDataJSON();
    await route.fulfill({
      json:
        args.action !== "list"
          ? {}
          : args.collection === "blocks"
            ? [
                {
                  id: "line",
                  pageId: "a",
                  type: "text",
                  html: "Hello",
                  indent: 0,
                  position: 0,
                  caption: "",
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ]
            : [
                {
                  id: "a",
                  title: "Shortcuts",
                  type: "page",
                  parentId: null,
                  icon: null,
                  position: 0,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ],
    });
  });
  const workspace = emptyWorkspace();
  const notes = makeBlock("notes");
  notes.value = JSON.stringify({ active: "a", tabs: ["a"] });
  workspace.apps.push({
    id: "notes-app",
    name: "Notes fixture",
    icon: "text",
    x: 120,
    y: 180,
    width: 800,
    height: 620,
    blocks: [notes],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 12,
    gap: 12,
    radius: 8,
  });
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const line = page.locator(".block-content").first();
  await line.click();
  await line.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search and commands" });
  await expect(palette).toBeVisible();
  await expect(page.getByPlaceholder("Search pages and content…")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await line.click();
  await line.press("Alt+k");
  await expect(page.getByPlaceholder("Search pages and content…")).toBeVisible();
  await expect(palette).toBeHidden();
});
