import { test, expect } from "./fixtures";
import { emptyWorkspace } from "../src/model";

test("sticky notes and apps come forward when clicked", async ({ page }) => {
  test.setTimeout(90_000);
  const workspace = emptyWorkspace();
  workspace.apps = [{
    id: "stack-app", name: "Overlapping app", icon: "app", x: 420, y: 280,
    width: 350, height: 250, blocks: [], archived: false, group: "", exposed: false,
    accent: "#6f8998", padding: 24, gap: 12, radius: 8,
  }];
  workspace.board = {
    notes: [
      { id: "note-left", x: 340, y: 240, width: 210, height: 190, text: "Left note", color: "#fff4b8" },
      { id: "note-top", x: 490, y: 210, width: 180, height: 180, text: "Top note", color: "#fff4b8" },
    ],
    arrows: [],
    strokes: [],
  };
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");

  const app = page.locator('[data-app-id="stack-app"]');
  const left = page.locator('[data-note-id="note-left"]');
  const top = page.locator('[data-note-id="note-top"]');
  const hit = () => left.evaluate((note) => {
    const rect = note.getBoundingClientRect();
    const element = document.elementFromPoint(rect.x + rect.width * 0.85, rect.y + rect.height * 0.5);
    const item = element?.closest<HTMLElement>(".board-note, .canvas-app");
    return item?.dataset.noteId ?? item?.dataset.appId;
  });
  const clickApp = () => app.click({ position: { x: 290, y: 195 } });

  await clickApp();
  await expect.poll(hit).toBe("stack-app");
  await left.click({ position: { x: 25, y: 70 } });
  await expect.poll(hit).toBe("note-left");
  await top.click({ position: { x: 110, y: 12 } });
  await expect.poll(hit).toBe("note-top");
  await clickApp();
  await expect.poll(hit).toBe("stack-app");
  await left.click({ button: "middle", position: { x: 25, y: 70 } });
  await expect.poll(hit).toBe("stack-app");
});
