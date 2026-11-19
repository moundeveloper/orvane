import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesService } from "../server/files";
import { emptyWorkspace, makeBlock } from "../src/model";
import { test, expect } from "./fixtures";

test("file search includes matching roots, nested folders and files once", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "orvane-folder-search-"));
  const root = join(temporary, "Case reports");
  const child = join(root, "Case pictures");
  try {
    await mkdir(child, { recursive: true });
    await writeFile(join(child, "Case.txt"), "fixture");
    const service = createFilesService(temporary);
    const direct = (await service.invoke("search", {
      paths: [root],
      query: "Case",
    })) as { entries: { name: string; dir: boolean }[] };
    expect(direct.entries).toContainEqual(
      expect.objectContaining({ name: "Case reports", dir: true }),
    );
    const result = (await service.invoke("search", {
      paths: [root, temporary],
      query: "Case",
    })) as { entries: { name: string; dir: boolean }[] };
    expect(result.entries.map(({ name, dir }) => ({ name, dir }))).toEqual(
      expect.arrayContaining([
        { name: "Case reports", dir: true },
        { name: "Case pictures", dir: true },
        { name: "Case.txt", dir: false },
      ]),
    );
    expect(result.entries).toHaveLength(3);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Ctrl+K opens a folder inside File Explorer", async ({ page }) => {
  test.setTimeout(90_000);
  const temporary = await mkdtemp(join(tmpdir(), "orvane-palette-test-"));
  const folder = join(temporary, "Fixture receipts folder");
  try {
    await mkdir(folder);
    await writeFile(join(folder, "inside-folder.txt"), "fixture");
    const workspace = emptyWorkspace();
    const files = makeBlock("files");
    files.value = JSON.stringify({ pins: [temporary] });
    workspace.apps.push({
      id: "file-fixture",
      name: "File Explorer fixture",
      icon: "folder",
      x: 120,
      y: 180,
      width: 850,
      height: 650,
      blocks: [files],
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
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Search and commands" });
    await palette
      .getByRole("combobox", { name: "Search" })
      .fill("Fixture receipts folder");
    await expect(palette.getByText("Folders", { exact: true })).toBeVisible();
    await palette.getByText("Fixture receipts folder", { exact: true }).click();
    await expect(
      page
        .locator('[data-app-id="file-fixture"]')
        .getByText("inside-folder.txt", { exact: true }),
    ).toBeVisible();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("removing a shared action updates the library and its wheel assignment", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const workspace = emptyWorkspace();
  workspace.actions = [
    {
      id: "drop-action",
      name: "Remove me",
      icon: "workflow",
      inputs: [],
      rules: [],
    },
  ];
  workspace.wheel = [
    {
      id: "keep-slot",
      parent: "",
      name: "Keep this slot",
      kind: "action",
      appId: "",
      actionId: "drop-action",
      bindings: {},
    },
  ];
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const openLibrary = async () => {
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page
      .getByRole("button", { name: "Action library", exact: true })
      .click();
  };
  await openLibrary();
  const library = page.getByRole("region", {
    name: "Workspace action library",
  });
  await library
    .getByRole("button", { name: "Remove action", exact: true })
    .click();
  await expect(
    library.getByRole("button", { name: "Remove me", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(library).toBeHidden();
  await page.reload({ waitUntil: "domcontentloaded" });
  await openLibrary();
  await expect(library).toBeVisible();
  await expect(
    library.getByRole("button", { name: "Remove me", exact: true }),
  ).toHaveCount(0);
  const saved = await page.evaluate(async () =>
    (await fetch("/__orvane/storage/state")).text(),
  );
  expect(saved).toContain("keep-slot");
  expect(saved).not.toContain("drop-action");
});

test("dock overflow opens, closes with Escape and selects an app", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = emptyWorkspace();
  workspace.apps = Array.from({ length: 16 }, (_, index) => ({
    id: `dock-${index}`,
    name: `Workspace app ${index}`,
    icon: "app",
    x: 300 + index * 500,
    y: 200,
    width: 300,
    height: 200,
    blocks: [],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 24,
    gap: 12,
    radius: 8,
  }));
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.setViewportSize({ width: 800, height: 650 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const overflow = page.getByRole("button", { name: "More apps" });
  const group = page.getByRole("group", { name: "More canvas apps" });
  await overflow.click();
  await expect(group).toBeVisible();
  await group
    .getByRole("button", { name: "Workspace app 15", exact: true })
    .click({ button: "right" });
  const actions = page.getByRole("region", { name: "App quick actions" });
  await expect(actions).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toBeHidden();
  await expect(group).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(group).toBeHidden();
  await expect(overflow).toBeFocused();
  await overflow.press("Enter");
  await group
    .getByRole("button", { name: "Workspace app 15", exact: true })
    .click();
  await expect(group).toBeHidden();
  await expect
    .poll(() => page.locator(".dock-overflow .dock-tab.active").textContent())
    .toContain("Workspace app 15");
  await page.setViewportSize({ width: 2500, height: 650 });
  await expect(overflow).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Workspace app 15", exact: true }),
  ).toBeVisible();
});

test("sticky note shortcut focuses at the pointer and saves into Notes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.mouse.move(400, 320);
  await page.keyboard.press("Control+Shift+N");
  const editor = page.getByRole("textbox", { name: "Sticky note" });
  await expect(editor).toBeFocused();
  expect(await page.locator(".board-note").boundingBox()).toMatchObject({
    x: 400,
    y: 320,
  });
  await editor.fill("Capture title\nA < B");
  const response = page.waitForResponse(
    (result) =>
      result.url().endsWith("/notes/data") &&
      result.request().postDataJSON().action === "saveCapture",
  );
  await page
    .getByRole("button", { name: "Save to Notes", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Save sticky note to Notes" })
    .getByRole("button", { name: "Save to Notes", exact: true })
    .click();
  const saved = await response;
  expect(saved.ok()).toBe(true);
  const { pageId } = await saved.json();
  const capture = await page.evaluate(async (pageId) => {
    const read = async (payload: object) =>
      (
        await fetch("/__orvane/notes/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).json();
    return {
      page: await read({ collection: "pages", action: "get", key: pageId }),
      blocks: await read({ collection: "blocks", action: "list", pageId }),
    };
  }, pageId);
  expect(capture.page).toMatchObject({
    title: "Capture title",
    parentId: null,
  });
  expect(capture.blocks).toEqual([
    expect.objectContaining({ html: "Capture title<br>A &lt; B" }),
  ]);
  await page.mouse.move(680, 320);
  await page.keyboard.press("Control+Shift+N");
  await expect(editor).toBeFocused();
  await editor.fill("Appended in the existing page");
  await page
    .locator(".board-note.selected")
    .getByRole("button", { name: "Save to Notes", exact: true })
    .click();
  const save = page.getByRole("group", { name: "Save sticky note to Notes" });
  await save.getByRole("combobox", { name: "Notes destination" }).click();
  await page
    .getByRole("option", { name: "Capture title", exact: true })
    .click();
  const append = page.waitForResponse(
    (result) =>
      result.url().endsWith("/notes/data") &&
      result.request().postDataJSON().action === "saveCapture",
  );
  await save
    .getByRole("button", { name: "Save to Notes", exact: true })
    .click();
  const appended = await append;
  expect(appended.ok()).toBe(true);
  expect(await appended.json()).toEqual({ pageId });
});
