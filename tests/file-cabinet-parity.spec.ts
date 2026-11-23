// File Cabinet features ported from Magic NetSuite, each against an in-memory
// NetSuite (tests/file-cabinet-parity-harness.ts).
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
// The first test also pays for Vite's cold compile of the app and harness.
test.describe.configure({ timeout: 120_000 });

async function mount(page: Page, state?: Record<string, unknown>) {
  await page.goto("/");
  await page.evaluate(async (state) => {
    const module = "/tests/file-cabinet-parity-harness.ts";
    (window as any).fc = (await import(module)).mountCabinet({ state });
  }, state);
  const root = page.locator("#parity-fixture");
  await expect(root.locator('[data-key="file:10"]')).toBeVisible();
  return root;
}
const fake = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).fc.state)));
const calls = (page: Page) => page.evaluate(() => (window as any).fc.calls as { op: string; args: any }[]);

test("saving keeps the replaced content as a version to diff and restore", async ({ page }) => {
  const root = await mount(page);
  await root.locator('[data-key="file:10"]').dblclick();
  const editor = root.getByRole("textbox", { name: "File content" });
  await expect(editor).toContainText("const b = 2;");
  await root.locator(".fc-switch").click();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nconst c = 3;");
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await fake(page)).files.find((f: any) => f.id === 10).content).toContain("const c = 3;");

  const history = root.locator(".fc-history-button");
  await expect(history).toContainText("1");
  await history.click();
  const menu = root.getByRole("listbox", { name: "Saved versions" });
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu.getByRole("option").first()).toContainText("+1");
  await expect(menu.getByRole("option").first()).toContainText("2 lines");
  await menu.getByRole("option").first().click();

  await expect(root.locator(".fc-diff")).toBeVisible();
  await expect(root.getByRole("textbox", { name: "Left side" })).not.toContainText("const c = 3;");
  await expect(root.getByRole("textbox", { name: "Right side" })).toContainText("const c = 3;");
  await root.getByRole("button", { name: "Restore this version" }).click();
  await expect(root.locator(".fc-diff")).toHaveCount(0);
  await expect(editor).not.toContainText("const c = 3;");
  await expect(root.getByText("Unsaved draft · kept locally")).toBeVisible();

  await history.click();
  await root.getByRole("button", { name: "Clear history" }).click();
  await expect(history).toContainText("0");
});

test("Compare diffs the saved file against pasted text and swaps sides", async ({ page }) => {
  const root = await mount(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: async () => "const a = 1;\nconst pasted = true;", writeText: async () => {} },
    });
  });
  await root.locator('[data-key="file:10"]').click({ button: "right" });
  await root.locator(".fc-context-menu").getByRole("menuitem", { name: "Compare" }).click();
  const left = root.getByRole("textbox", { name: "Left side" }),
    right = root.getByRole("textbox", { name: "Right side" });
  await expect(left).toContainText("const b = 2;");
  await root.getByRole("button", { name: "Paste clipboard" }).click();
  await expect(right).toContainText("const pasted = true;");
  await root.getByRole("button", { name: "Swap" }).click();
  await expect(left).toContainText("const pasted = true;");
  await expect(right).toContainText("const b = 2;");
  await right.click();
  await page.keyboard.press("Escape");
  await expect(root.locator(".fc-diff")).toHaveCount(0);
  await expect(root.getByRole("textbox", { name: "File content" })).toBeVisible();
});

test("deleting a non-empty folder empties it, keeps it in trash and restores it", async ({ page }) => {
  const root = await mount(page);
  await root.locator('[data-key="folder:3"]').click({ button: "right" });
  await root.locator(".fc-context-menu").getByRole("menuitem", { name: "Delete" }).click();
  const dialog = root.getByRole("dialog", { name: "Delete" });
  await expect(dialog.locator(".fc-warning")).toContainText("1 file(s) and 1 subfolder(s)");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await fake(page)).folders.map((f: any) => f.id).sort()).toEqual([1, 2, 5, 6]);
  expect((await fake(page)).files.map((f: any) => f.id)).toEqual([10]);
  await expect(root.locator('[data-key="folder:3"]')).toHaveCount(0);

  await root.getByRole("button", { name: /^Trash/ }).click();
  const row = root.locator(".fc-trash-row", { hasText: "Old" });
  await expect(row).toContainText("3 file(s), 1 subfolder(s) inside");
  await row.getByRole("button", { name: "Restore" }).click();
  await expect(root.locator(".fc-toast", { hasText: "Restored Old" })).toContainText("1 binary file(s) could not be restored");
  const state = await fake(page),
    old = state.folders.find((f: any) => f.name === "Old"),
    deep = state.folders.find((f: any) => f.name === "Deep");
  expect(old.parent).toBe(2);
  expect(deep.parent).toBe(old.id);
  expect(state.files.find((f: any) => f.name === "a.js")).toMatchObject({ folder: old.id, content: "alpha" });
  expect(state.files.find((f: any) => f.name === "b.txt")).toMatchObject({ folder: deep.id, content: "beta" });
  await expect(root.locator(".fc-trash-row", { hasText: "Old" })).toHaveCount(0);
});

test("restoring into a folder that no longer exists asks where to put it", async ({ page }) => {
  const root = await mount(page);
  await root.locator('[data-key="file:10"]').click({ button: "right" });
  await root.locator(".fc-context-menu").getByRole("menuitem", { name: "Delete" }).click();
  await root.getByRole("dialog", { name: "Delete" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await fake(page)).files.some((f: any) => f.id === 10)).toBe(false);
  // The original folder disappears in NetSuite meanwhile.
  await page.evaluate(() => {
    const s = (window as any).fc.state;
    s.folders = s.folders.filter((f: any) => f.id !== 2 && f.id !== 3 && f.id !== 4);
  });
  await root.getByRole("button", { name: /^Trash/ }).click();
  await root.locator(".fc-trash-row", { hasText: "ctk_ue_invoice.js" }).getByRole("button", { name: "Restore" }).click();
  const picker = root.getByRole("dialog", { name: "Restore to folder" });
  await expect(picker.getByRole("option", { name: /SuiteScripts/ })).toBeVisible();
  await picker.getByRole("textbox", { name: "Search folders" }).fill("Targ");
  await picker.getByRole("option", { name: /Target/ }).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(async () => (await fake(page)).files.find((f: any) => f.name === "ctk_ue_invoice.js")?.folder).toBe(5);
});

test("dropping items on another pane's empty area moves them into its folder", async ({ page }) => {
  const root = await mount(page, {
    filePanes: {
      fixture: {
        active: "left",
        layout: { left: ["left"], right: ["right"], leftActive: "left", rightActive: "right", ratio: 50 },
        panes: [
          { id: "left", path: [{ id: 1, name: "SuiteScripts" }, { id: 2, name: "CTK" }] },
          { id: "right", path: [{ id: 1, name: "SuiteScripts" }, { id: 5, name: "Target" }] },
        ],
      },
    },
  });
  const rightPane = root.locator('.fc-pane[data-pane="right"] .fc-content');
  await expect(rightPane).toContainText("This folder is empty");
  await page.evaluate(() => {
    const fixture = document.querySelector("#parity-fixture")!;
    const row = fixture.querySelector('.fc-pane[data-pane="left"] [data-key="file:10"]')!;
    const area = fixture.querySelector('.fc-pane[data-pane="right"] .fc-content')!;
    const data = new DataTransfer();
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    area.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
    area.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  const dialog = root.getByRole("dialog", { name: "Move" });
  await expect(dialog).toContainText("Target");
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect.poll(async () => (await fake(page)).files.find((f: any) => f.id === 10).folder).toBe(5);
  const move = (await calls(page)).find((c) => c.op === "move-items")!;
  expect(move.args).toMatchObject({ folderId: 2, targetId: 5, fileIds: [10], folderIds: [] });
});

test("Scripts Using This File opens the script in the Scripts app", async ({ page }) => {
  const root = await mount(page);
  await root.locator('[data-key="file:10"]').click({ button: "right" });
  await root.locator(".fc-context-menu").getByRole("menuitem", { name: "Scripts Using This File" }).click();
  await root.getByRole("button", { name: "Open CTK UE Invoice in Scripts" }).click();
  expect(await page.evaluate(() => (window as any).fc.emitted)).toEqual([
    { event: "open-script", args: [{ id: 501, scriptid: "customscript_ctk_ue_invoice" }] },
  ]);
  await expect(root.getByRole("dialog", { name: "Referencing Scripts" })).toHaveCount(0);

  await page.evaluate(async () => {
    (window as any).fc.unmount();
    const module = "/tests/file-cabinet-parity-harness.ts";
    (window as any).scripts = (await import(module)).mountScripts({ id: 501, scriptid: "customscript_ctk_ue_invoice" });
  });
  const scripts = page.locator("#parity-fixture");
  await expect(scripts.getByText("CTK UE Invoice").first()).toBeVisible();
  await expect(scripts.getByText("CTK Other")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).scripts.calls.some((c: any) => c.op === "deployments"))).toBe(true);
  expect(await page.evaluate(() => (window as any).scripts.emitted)).toContain("opened-initial");
});

test("file bookmarks follow moved files and pick up renamed names", async ({ page }) => {
  const root = await mount(page, {
    fileBookmarks: [
      {
        environment: "fixture",
        id: 10,
        name: "old_name.js",
        kind: "file",
        path: [{ id: 1, name: "SuiteScripts" }, { id: 5, name: "Target" }],
      },
    ],
  });
  const bookmark = root.locator(".fc-bookmark", { hasText: "ctk_ue_invoice.js" });
  await expect(bookmark).toBeVisible();
  await bookmark.click();
  await expect(root.getByRole("textbox", { name: "File content" })).toContainText("const a = 1;");
  await expect(root.locator(".fc-breadcrumb")).toContainText("CTK");
  await expect
    .poll(() => page.evaluate(() => JSON.parse((window as any).fc.block.value).fileBookmarks[0]))
    .toMatchObject({ name: "ctk_ue_invoice.js", path: [{ id: 1 }, { id: 2, name: "CTK" }] });
});

test("NetSuite folder types get their own icons and a Type in Folder Info", async ({ page }) => {
  const root = await mount(page);
  await root.locator(".fc-breadcrumb").getByRole("button", { name: "Root" }).click();
  const bundles = root.locator('[data-key="folder:6"]');
  await expect(bundles.locator('svg[class*="lucide-box"]')).toHaveCount(1);
  await expect(root.locator('[data-key="folder:1"] svg[class*="lucide-folder"]')).toHaveCount(1);
  await root.locator('[data-key="folder:6"]').dblclick();
  const info = root.locator(".fc-info");
  await expect(info).toContainText("Type");
  await expect(info).toContainText("SuiteBundles");
});
