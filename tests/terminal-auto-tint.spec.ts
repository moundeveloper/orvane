import { readFile } from "node:fs/promises";
import { test, expect, _electron as electron, type Page, type TestInfo } from "./fixtures";

async function verifyTint(page: Page, info: TestInfo) {
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
  await page.evaluate(() => {
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof read>) {
      if (this.canvas.width === 16 && this.canvas.height === 16)
        document.documentElement.dataset.tintSamples = String(Number(document.documentElement.dataset.tintSamples || 0) + 1);
      return read.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create Terminal", exact: true }).click();
  const terminal = page.locator(".app-frosted");
  const rows = terminal.locator(".xterm-rows");
  await expect(rows).not.toHaveText(/^\s*$/, { timeout: 30_000 });
  const id = await terminal.locator(".terminal-pane").getAttribute("data-terminal-pane");
  // Existing output and the xterm instance must survive material changes.
  await terminal.locator(".xterm").evaluate((node) => node.setAttribute("data-tint-instance", "original"));
  await terminal.locator(".xterm").click();
  await page.keyboard.type('node -e "console.log(\'TINT\'+\'KEEP\')"');
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("TINTKEEP");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: /^Palette and background/ }).click();
  const panel = page.getByRole("region", { name: "Appearance settings" });
  await panel.getByRole("radio", { name: "Image", exact: true }).click();
  async function image(color: string) {
    const png = await page.evaluate((color) => {
      const c = document.createElement("canvas"); c.width = c.height = 32;
      const ctx = c.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, 32, 32);
      return c.toDataURL().split(",")[1]!;
    }, color);
    await panel.locator('input[type="file"]').setInputFiles({ name: "tint.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  }
  await image("#101820");
  await expect(terminal).toHaveCSS("background-color", "rgba(24, 36, 44, 0.46)");
  await expect(terminal).toHaveCSS("backdrop-filter", "blur(18px) saturate(1.3)");
  await expect(terminal.locator(".app-title")).toHaveCSS("color", "rgb(223, 232, 237)");
  await expect(terminal.locator(".xterm-screen")).toHaveCSS("filter", "none");
  await expect(rows).toHaveCSS("color", "rgb(223, 232, 237)");
  await panel.getByRole("button", { name: /^Apply/ }).click();
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Close workspace settings" }).click();
  await page.screenshot({ path: info.outputPath("terminal-dark.png") });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: /^Palette and background/ }).click();
  // Soften alone can turn a dark source into a light background.
  const samples = await page.locator("html").getAttribute("data-tint-samples");
  await panel.getByRole("slider", { name: "Soften background" }).press("End");
  await expect(terminal).toHaveCSS("background-color", "rgba(247, 250, 252, 0.42)");
  await expect(rows).toHaveCSS("color", "rgb(43, 58, 68)");
  await panel.getByRole("slider", { name: "Soften background" }).press("Home");
  await expect(rows).toHaveCSS("color", "rgb(223, 232, 237)");
  await expect(page.locator("html")).toHaveAttribute("data-tint-samples", samples!);
  await image("#f5f7fa");
  await expect(terminal).toHaveCSS("background-color", "rgba(247, 250, 252, 0.42)");
  await expect(rows).toHaveCSS("color", "rgb(43, 58, 68)");
  await panel.getByRole("button", { name: /^Apply/ }).click();
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Close workspace settings" }).click();
  await page.screenshot({ path: info.outputPath("terminal-light.png") });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: /^Palette and background/ }).click();
  await panel.getByRole("radio", { name: "Video", exact: true }).click();
  // Imported videos have no bundled poster. Sample their first decoded frame.
  const beforeVideo = Number(await page.locator("html").getAttribute("data-tint-samples"));
  await panel.locator('input[type="file"]').setInputFiles({ name: "rain.webm", mimeType: "video/webm", buffer: await readFile("public/themes/rain.webm") });
  await expect(page.locator(".theme-wallpaper video")).toHaveAttribute("src", /^blob:/);
  await expect.poll(async () => Number(await page.locator("html").getAttribute("data-tint-samples"))).toBeGreaterThan(beforeVideo);
  await expect(terminal).toHaveCSS("background-color", "rgba(247, 250, 252, 0.42)");
  await expect(rows).toHaveCSS("color", "rgb(43, 58, 68)");
  await panel.getByRole("radio", { name: "Plain", exact: true }).click();
  await expect(terminal).toHaveCSS("background-color", "rgba(247, 250, 252, 0.08)");
  await expect(terminal).toHaveCSS("backdrop-filter", "blur(8px) saturate(1.2)");
  await panel.getByRole("button", { name: /^Discard/ }).click();
  await expect(terminal).toHaveCSS("background-color", "rgba(247, 250, 252, 0.42)");
  expect(await terminal.locator(".terminal-pane").getAttribute("data-terminal-pane")).toBe(id);
  await expect(rows).toContainText("TINTKEEP");
  await expect(terminal.locator(".xterm")).toHaveAttribute("data-tint-instance", "original");
}

test("Terminal Auto tint switches the live shell between dark, light and Plain", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await verifyTint(page, info);
});

test("desktop Terminal Auto tint matches the approved wallpaper materials", async ({}, info) => {
  test.setTimeout(180_000);
  const data = info.outputPath("data");
  const app = await electron.launch({ args: ["electron/main.mjs"], env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    ORVANE_PORT: "5248", ORVANE_DATA_DIR: data, ORVANE_MCP_STATE_DIR: data, ORVANE_USER_DATA: info.outputPath("profile"),
  } });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await verifyTint(page, info);
  } finally { await app.close(); }
});
