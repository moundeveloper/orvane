import { test, expect } from "./fixtures";
test("live PowerShell nested splits leave prompt-only scrollbars hidden", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 820 });
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
  await panes.nth(2).click();
  await terminal.getByRole("button", { name: "Split right", exact: true }).click();
  await prompts(4);
  for (const w of [1200, 1100, 1000, 900, 950, 1050, 1000]) {
    await page.evaluate((w) => { document.getElementById("term")!.style.width = w + "px"; }, w);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1500);
  const drag = async (from: number, to: number, fx: number, fy: number) => {
    const a = (await panes.nth(from).boundingBox())!, b = (await panes.nth(to).boundingBox())!;
    await page.keyboard.down("Shift");
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + (b.x + b.width * fx - a.x) * i / 10, a.y + (b.y + b.height * fy - a.y) * i / 10);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.waitForTimeout(1200);
  };
  await drag(0, 3, 0.5, 0.95);
  await drag(1, 0, 0.05, 0.5);
  await drag(3, 2, 0.5, 0.05);
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => (window as any).capturedTerms
    .filter((t: any) => t.element?.isConnected).map((t: any) => ({
      cols: t.cols, rows: t.rows, baseY: t.buffer.active.baseY,
      text: Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true)).filter(Boolean),
      displayed: getComputedStyle(t.element.querySelector(".scrollbar.vertical")).display,
    })));
  console.log(JSON.stringify(state, null, 1));
  console.log("mounted terms:", await page.evaluate(() => (window as any).capturedTerms.length));
  for (const s of state) expect(s.baseY, JSON.stringify(s.text)).toBe(0);
});
