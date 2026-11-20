import { test, expect, _electron as electron } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Full screen (F11 or Workspace options → Window) is remembered for the next
// launch; a saved monitor that is not connected falls back to the one in use.
test("full screen toggles with F11, is remembered, and a missing monitor falls back", async ({}, info) => {
  test.setTimeout(180_000);
  const data = info.outputPath("data");
  const profile = info.outputPath("profile");
  mkdirSync(profile, { recursive: true });
  // A monitor that is not connected.
  writeFileSync(join(profile, "window.json"), JSON.stringify({ displayId: 987654321 }));
  const launch = () =>
    electron.launch({
      args: ["electron/main.mjs"],
      env: {
        ...(Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined),
        ) as Record<string, string>),
        ORVANE_PORT: "5236",
        ORVANE_DATA_DIR: data,
        ORVANE_MCP_STATE_DIR: data,
        ORVANE_USER_DATA: profile,
      },
    });
  const state = (app: Awaited<ReturnType<typeof launch>>) =>
    app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
      const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
      return {
        fullScreen: window.isFullScreen(),
        onCursorDisplay: screen.getDisplayMatching(window.getBounds()).id === cursor,
      };
    });
  const saved = () => JSON.parse(readFileSync(join(profile, "window.json"), "utf8"));

  let app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await expect.poll(() => state(app)).toEqual({ fullScreen: false, onCursorDisplay: true });
    // A real key press (Playwright's keyboard skips before-input-event).
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: "F11" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "F11" });
    });
    await expect.poll(async () => (await state(app)).fullScreen).toBe(true);
    expect(saved()).toEqual({ displayId: 987654321, fullScreen: true });
  } finally {
    await app.close();
  }

  app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await expect.poll(async () => (await state(app)).fullScreen).toBe(true);
    // Workspace options → Window → Maximized leaves full screen.
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("combobox", { name: "Orvane window size" }).click();
    await page.getByRole("option", { name: "Maximized" }).click();
    await expect.poll(async () => (await state(app)).fullScreen).toBe(false);
    expect(saved().fullScreen).toBe(false);
  } finally {
    await app.close();
  }
});
