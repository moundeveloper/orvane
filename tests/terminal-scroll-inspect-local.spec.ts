import { test, expect } from "./fixtures";
test("live PowerShell split leaves prompt-only scrollbars hidden", async ({ page }) => {
  await page.goto("/tests/terminal-scroll-live-local.html", { waitUntil: "domcontentloaded" });
  const terminal = page.locator(".terminal-view");
  await expect(terminal.locator(".xterm")).toBeVisible({ timeout: 20000 });
  await terminal.getByRole("button", { name: "Split right", exact: true }).click();
  await expect(terminal.locator(".xterm")).toHaveCount(2);
  await expect.poll(() => terminal.locator(".xterm-rows").allTextContents(), {timeout:15000})
    .toEqual([expect.stringContaining("PS "), expect.stringContaining("PS ")]);
  await terminal.locator(".terminal-pane").first().hover();
  await page.mouse.wheel(0, -650);
  console.log(await page.evaluate(() => (window as any).capturedTerms
    .filter((t: any) => t.element?.isConnected).map((t: any) => ({
      rows: t.rows, lines: t.buffer.active.length, baseY: t.buffer.active.baseY, viewportY: t.buffer.active.viewportY,
      displayed: getComputedStyle(t.element.querySelector(".scrollbar.vertical")).display,
    }))));
  for (const scrollbar of await terminal.locator(".scrollbar.vertical").all()) await expect(scrollbar).toHaveCSS("display", "none");
});
