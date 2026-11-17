import { test, expect } from "./fixtures";

test("widening a PowerShell split reveals the names from a single dir run while narrow", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/tests/terminal-scroll-live-big-local.html", { waitUntil: "domcontentloaded" });
  const terminal = page.locator(".terminal-view");
  await expect(terminal.locator(".xterm-rows")).toContainText("PS ", { timeout: 60_000 });
  await terminal.getByRole("button", { name: "Split right", exact: true }).click();
  const pane = terminal.locator(".terminal-pane").first();
  await pane.locator(".xterm-screen").click();
  const divider = terminal.locator(".terminal-divider");
  const bounds = (await divider.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const width = () => pane.evaluate((element) => element.getBoundingClientRect().width);
  const initialWidth = await width();
  async function drag(from: number, to: number) {
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move(to, y, { steps: 8 });
    await page.mouse.up();
  }
  await drag(x, x - 420);
  await expect.poll(width).toBeLessThan(initialWidth / 2);
  await pane.locator(".terminal-host").click({ position: { x: 20, y: 20 } });
  const directoryCommand = "dir $PSHOME\\powershell.exe";
  await page.keyboard.insertText(directoryCommand);
  await page.keyboard.press("Enter");
  await expect(pane.locator(".xterm-rows")).toContainText("LastWriteTime");
  const fullHeader = pane.locator(".xterm-rows > div").filter({ hasText: /Mode\s+LastWriteTime\s+Length\s+Name/ });
  await drag(x - 420, x);
  await expect.poll(width).toBeGreaterThan(initialWidth - 20);
  await expect(fullHeader).toHaveCount(1);
  await expect(pane.locator(".xterm-rows > div").filter({
    hasText: /\d\s+powershell\.exe\s*$/i,
  })).toHaveCount(1);
});

// Dragging split dividers in a live PowerShell must not push prompt-only
// panes into scrollback.
test("live PowerShell split resizing leaves prompt-only panes without scrollback", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/tests/terminal-scroll-live-big-local.html", { waitUntil: "domcontentloaded" });
  const terminal = page.locator(".terminal-view");
  const panes = terminal.locator(".terminal-pane");
  const prompts = async (n: number) => {
    await expect(panes).toHaveCount(n, { timeout: 20000 });
    await expect.poll(async () => (await terminal.locator(".xterm-rows").allTextContents()).filter((t) => t.includes("PS ")).length, { timeout: 20000 }).toBe(n);
    await page.waitForTimeout(800);
  };
  await prompts(1);
  await terminal.getByRole("button", { name: "Split right", exact: true }).click();
  await prompts(2);
  await panes.nth(1).click();
  await terminal.getByRole("button", { name: "Split down", exact: true }).click();
  await prompts(3);
  const dividers = terminal.locator(".terminal-divider");
  for (let d = 0; d < (await dividers.count()); d++) {
    const box = (await dividers.nth(d).boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const vertical = box.height > box.width;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const delta of [-250, 200, -150, 300, -100, 0]) {
      await page.mouse.move(vertical ? x + delta : x, vertical ? y : y + delta, { steps: 12 });
      await page.waitForTimeout(120);
    }
    await page.mouse.up();
  }
  await page.waitForTimeout(2000);
  const state = await page.evaluate(() => (window as any).capturedTerms
    .filter((t: any) => t.element?.isConnected).map((t: any) => ({
      cols: t.cols, rows: t.rows, baseY: t.buffer.active.baseY,
      text: Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true)).filter(Boolean),
    })));
  console.log(JSON.stringify(state, null, 1));
  for (const s of state) expect(s.baseY, JSON.stringify(s.text)).toBe(0);
});
