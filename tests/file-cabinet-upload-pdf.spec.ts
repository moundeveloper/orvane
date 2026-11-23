// Upload button with split panes, and freeing a PDF's blob URL on Back.
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
test.describe.configure({ timeout: 120_000 });

const split = {
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
};
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
const uploads = (page: Page) =>
  page.evaluate(() =>
    (window as any).fc.calls.filter((c: any) => c.op === "upload-file").map((c: any) => c.args),
  );
const file = { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") };

test("toolbar Upload opens the picker and uploads into its own pane's folder", async ({ page }) => {
  const root = await mount(page, split);
  const right = root.locator('.fc-pane[data-pane="right"]');
  await expect(right).toContainText("This folder is empty");
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
  await right.getByRole("button", { name: "Upload", exact: true }).click();
  await (await chooser).setFiles(file);
  await expect.poll(() => uploads(page)).toEqual([
    expect.objectContaining({ folderId: 5, name: "notes.txt" }),
  ]);
  await expect(right.locator('[data-key^="file:"]')).toHaveCount(1);
});

test("Upload Files in the folder menu opens the picker for that pane", async ({ page }) => {
  const root = await mount(page, split);
  const left = root.locator('.fc-pane[data-pane="left"] .fc-content');
  await left.click({ button: "right", position: { x: 300, y: 300 } });
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
  await root.locator(".fc-context-menu").getByRole("menuitem", { name: "Upload Files" }).click();
  await (await chooser).setFiles(file);
  await expect.poll(() => uploads(page)).toEqual([
    expect.objectContaining({ folderId: 2, name: "notes.txt" }),
  ]);
});

test("Back from a PDF frees its blob URL", async ({ page }) => {
  const root = await mount(page);
  await page.evaluate(() => {
    const w = window as any;
    w.fc.state.files.push({
      id: 14,
      name: "spec.pdf",
      folder: 2,
      filetype: "PDF",
      content: "",
      binary: true,
    });
    w.revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      w.revoked.push(url);
      revoke(url);
    };
  });
  await root.getByRole("button", { name: "Refresh" }).first().click();
  await root.locator('[data-key="file:14"]').dblclick();
  const viewer = root.locator('iframe[title="PDF Viewer"]');
  await expect(viewer).toBeVisible();
  const url = await viewer.getAttribute("src");
  expect(url).toMatch(/^blob:/);
  await root.getByRole("button", { name: "Back" }).click();
  await expect(viewer).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).revoked)).toContain(url);
});
