import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyWorkspace, makeBlock } from "../src/model";
import { test, expect } from "./fixtures";

/** A short silent WAV, so Peek shows a real audio player. */
function silentWav(seconds = 1, rate = 8000) {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples, 40);
  buffer.fill(128, 44);
  return buffer;
}

test("Peek steps with Up and Down from the player and the side rail, and moves the File Explorer with it", async ({ page }) => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "orvane-peek-"));
  await writeFile(join(root, "a-notes.txt"), "First file");
  await writeFile(join(root, "b-sound.wav"), silentWav());
  await writeFile(join(root, "c-notes.txt"), "Last file");
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
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const app = page.locator('[data-app-id="file-fixture"]');
    await app.locator(".fx-address-fill").click();
    await app.getByRole("textbox", { name: "Folder path" }).fill(root);
    await app.getByRole("textbox", { name: "Folder path" }).press("Enter");
    await app.getByText("b-sound.wav", { exact: true }).click();
    await page.keyboard.press("Space");
    const peek = (name: string) => app.getByRole("dialog", { name: "Peek: " + name });
    const cursor = app.locator(".fx-item.cursor");
    await expect(peek("b-sound.wav")).toBeVisible();

    // With the audio (or video) player focused, Down and Up still step Peek.
    const player = peek("b-sound.wav").locator("audio");
    await expect(player).toBeVisible();
    await player.focus();
    await page.keyboard.press("ArrowDown");
    await expect(peek("c-notes.txt")).toBeVisible();
    await expect(cursor).toContainText("c-notes.txt");
    await page.keyboard.press("ArrowUp");
    await expect(peek("b-sound.wav")).toBeVisible();

    // Left and Right no longer step Peek.
    await peek("b-sound.wav").locator(".peek-title").click();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await expect(peek("b-sound.wav")).toBeVisible();

    // After clicking the side rail, the keys move Peek and the File Explorer together.
    await app.getByRole("button", { name: "Next file" }).click();
    await expect(peek("c-notes.txt")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(peek("a-notes.txt")).toBeVisible();
    await expect(cursor).toContainText("a-notes.txt");
    await app.locator(".peek-rail-line").first().click();
    await page.keyboard.press("ArrowUp");
    await expect(peek("c-notes.txt")).toBeVisible();
    await expect(cursor).toContainText("c-notes.txt");

    // Escape from the rail still closes Peek.
    await page.keyboard.press("Escape");
    await expect(app.getByRole("dialog", { name: /^Peek:/ })).toHaveCount(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
