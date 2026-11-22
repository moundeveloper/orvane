import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesService } from "../server/files";
import { emptyWorkspace, makeBlock } from "../src/model";
import { test, expect } from "./fixtures";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orvane-folder-cards-"));
  const project = join(root, "orvane-fixture");
  await mkdir(join(project, ".git"), { recursive: true });
  const old = new Date(Date.now() - 3 * 86_400_000);
  for (const [name, text, when] of [
    ["oldest.md", "# Oldest", old],
    ["README.md", "# Orvane\nLocal-first desktop workspace", new Date(Date.now() - 7_200_000)],
    ["main.mjs", "export function snapshot(folder) {}", new Date(Date.now() - 600_000)],
    ["notes.txt", "Newest notes line", new Date()],
  ] as const) {
    await writeFile(join(project, name), text);
    await utimes(join(project, name), when, when);
  }
  await mkdir(join(root, "netsuite-fixture"));
  await writeFile(join(root, "netsuite-fixture", "manifest.xml"), "<manifest/>");
  await mkdir(join(root, "scratch-fixture"));
  await writeFile(join(root, "loose-file.txt"), "loose");
  return { root, project };
}

test("folder cards summarise the newest files and the project kind", async () => {
  const { root, project } = await fixture();
  try {
    const service = createFilesService(root);
    const result = (await service.invoke("folder-cards", {
      paths: [project, join(root, "netsuite-fixture"), join(root, "scratch-fixture")],
    })) as Record<string, { count: number; badge: string; sheets: { name: string; text?: string }[] }>;
    const card = result[project]!;
    expect(card.badge).toBe("git");
    expect(card.count).toBe(5);
    expect(card.sheets.map((sheet) => sheet.name)).toEqual(["notes.txt", "main.mjs", "README.md"]);
    expect(card.sheets[2]!.text).toBe("# Orvane\nLocal-first desktop workspace");
    expect(result[join(root, "netsuite-fixture")]!.badge).toBe("SDF");
    expect(result[join(root, "scratch-fixture")]).toMatchObject({ count: 0, badge: "", sheets: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("File Explorer shows folders as cards and keeps files as rows", async ({ page }) => {
  test.setTimeout(240_000);
  const { root } = await fixture();
  try {
    const workspace = emptyWorkspace();
    const files = makeBlock("files");
    files.value = JSON.stringify({
      layout: { tabs: ["pane-1"], active: "pane-1", left: [], right: [], ratio: 50 },
      panes: [{ id: "pane-1", path: root, view: "list" }],
    });
    workspace.apps.push({
      id: "file-fixture",
      name: "File Explorer fixture",
      icon: "folder",
      x: 120,
      y: 140,
      width: 900,
      height: 620,
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
    const app = page.locator('[data-app-id="file-fixture"]');
    await app.locator(".fx-address-fill").click();
    await app.getByRole("textbox", { name: "Folder path" }).fill(root);
    await app.getByRole("textbox", { name: "Folder path" }).press("Enter");
    await expect(app.getByText("loose-file.txt", { exact: true })).toBeVisible();
    await app.getByRole("button", { name: "Folder cards view" }).click();
    await expect(app.getByRole("button", { name: "Folder cards view" })).toHaveAttribute("aria-pressed", "true");

    const project = app.locator(".fx-card", { hasText: "orvane-fixture" });
    await expect(project.locator(".fx-front b")).toHaveText("git", { timeout: 30_000 });
    await expect(project.locator(".fx-sheet")).toHaveCount(3);
    await expect(project.locator(".fx-sheet.s1")).toContainText("Newest notes line");
    await expect(project.locator(".fx-card-meta")).toHaveText("5 items · notes.txt, main.mjs");
    await expect(app.locator(".fx-card", { hasText: "netsuite-fixture" }).locator(".fx-front b")).toHaveText("SDF");
    await expect(app.locator(".fx-card", { hasText: "scratch-fixture" }).locator(".fx-sheet")).toHaveText("Empty");
    await expect(app.locator(".fx-section")).toHaveText("Files");
    const loose = app.locator(".fx-item.fx-cols", { hasText: "loose-file.txt" });
    await expect(loose).toBeVisible();

    // Arrows walk the cards, then drop into the file rows.
    await app.locator(".fx-card", { hasText: "netsuite-fixture" }).click();
    await page.keyboard.press("ArrowRight");
    await expect(app.locator(".fx-card.cursor")).toContainText("orvane-fixture");
    await page.keyboard.press("ArrowDown");
    await expect(loose).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowUp");
    await expect(app.locator(".fx-card.cursor")).toContainText("scratch-fixture");

    // Double-click opens the folder like the other views.
    await project.dblclick();
    await expect(app.getByText("README.md", { exact: true })).toBeVisible();
    await expect(app.locator(".fx-section")).toHaveCount(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("folder cards are not read or downloaded again on quiet reloads", async ({ page }) => {
  test.setTimeout(240_000);
  const { root } = await fixture();
  // A folder whose newest file is a picture.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNgYGD4z8DAwMDAxMDAAAAMBAEA6YgBDgAAAABJRU5ErkJggg==",
    "base64",
  );
  await mkdir(join(root, "pictures-fixture"));
  await writeFile(join(root, "pictures-fixture", "photo.png"), PNG);
  try {
    const workspace = emptyWorkspace();
    const files = makeBlock("files");
    files.value = JSON.stringify({
      layout: { tabs: ["pane-1"], active: "pane-1", left: [], right: [], ratio: 50 },
      panes: [{ id: "pane-1", path: root, view: "list" }],
    });
    workspace.apps.push({
      id: "file-fixture", name: "File Explorer fixture", icon: "folder", x: 120, y: 140, width: 900, height: 620,
      blocks: [files], archived: false, group: "", exposed: false, accent: "#6f8998", padding: 12, gap: 12, radius: 8,
    });
    await page.addInitScript((data) => {
      localStorage.setItem("orvane.examples.v1", "installed");
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
    }, workspace);
    let cardReads = 0,
      pictures = 0;
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/__orvane/files/folder-cards")) cardReads++;
      if (url.includes("/__orvane/files/raw") && url.includes("photo.png")) pictures++;
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const app = page.locator('[data-app-id="file-fixture"]');
    await app.locator(".fx-address-fill").click();
    await app.getByRole("textbox", { name: "Folder path" }).fill(root);
    await app.getByRole("textbox", { name: "Folder path" }).press("Enter");
    await expect(app.getByText("loose-file.txt", { exact: true })).toBeVisible();
    await app.getByRole("button", { name: "Folder cards view" }).click();
    const photo = app.locator(".fx-card", { hasText: "pictures-fixture" }).locator(".fx-sheet img");
    await expect(photo).toBeVisible({ timeout: 30_000 });
    await expect(photo).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => cardReads).toBeGreaterThan(0);
    await page.waitForTimeout(600);
    const reads = cardReads;
    expect(pictures).toBe(1);

    // A live reload (a new file at this level) leaves the folders untouched:
    // their cards and pictures stay as they are.
    await writeFile(join(root, "another-file.txt"), "new");
    await expect(app.getByText("another-file.txt", { exact: true })).toBeVisible({ timeout: 15_000 });
    // Leaving the cards view and coming back redraws every card.
    await app.getByRole("button", { name: "Details view" }).click();
    await app.getByRole("button", { name: "Folder cards view" }).click();
    await expect(photo).toBeVisible();
    await page.waitForTimeout(600);
    expect(cardReads).toBe(reads);
    expect(pictures).toBe(1);

    // A changed folder is read again.
    await writeFile(join(root, "pictures-fixture", "caption.txt"), "Fresh caption");
    await writeFile(join(root, "touch.txt"), "x");
    await expect(app.locator(".fx-card", { hasText: "pictures-fixture" }).locator(".fx-sheet.s1")).toContainText("Fresh caption", {
      timeout: 15_000,
    });
    expect(cardReads).toBeGreaterThan(reads);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
