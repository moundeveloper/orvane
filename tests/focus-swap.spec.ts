import { expect, test } from "./fixtures";
import { emptyWorkspace, makeBlock } from "../src/model";

// In focus mode, Ctrl+Left/Right swaps to the previous/next app in dock
// order, wrapping at the ends; text fields keep Ctrl+arrows.
test("Ctrl+Left/Right swaps the focused app in dock order", async ({ page }) => {
  test.setTimeout(90_000);
  const workspace = emptyWorkspace();
  for (const [index, name] of ["Alpha", "Beta", "Gamma"].entries()) {
    const field = makeBlock("input");
    workspace.apps.push({
      id: `app-${name.toLowerCase()}`,
      name,
      icon: "text",
      x: 120 + index * 460,
      y: 180,
      width: 420,
      height: 300,
      blocks: [field],
      archived: false,
      group: "",
      exposed: false,
      accent: "#6f8998",
      padding: 12,
      gap: 12,
      radius: 8,
    });
  }
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const focusedName = () =>
    page.locator(".canvas-app.focused-app").getAttribute("data-app-id");
  // Not in focus mode: nothing happens.
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await page.keyboard.press("Control+ArrowRight");
  await expect(page.locator(".canvas-app.focused-app")).toHaveCount(0);

  await page.locator('[data-app-id="app-beta"]').click({ position: { x: 200, y: 20 } });
  await page.keyboard.press("f");
  await expect.poll(focusedName).toBe("app-beta");
  await page.keyboard.press("Control+ArrowRight");
  await expect.poll(focusedName).toBe("app-gamma");
  await page.keyboard.press("Control+ArrowRight");
  await expect.poll(focusedName).toBe("app-alpha");
  await page.keyboard.press("Control+ArrowLeft");
  await expect.poll(focusedName).toBe("app-gamma");
  // Inside a text field Ctrl+arrows move by word instead.
  await page.locator('[data-app-id="app-gamma"] input').first().click();
  await page.keyboard.press("Control+ArrowLeft");
  await expect.poll(focusedName).toBe("app-gamma");
});
