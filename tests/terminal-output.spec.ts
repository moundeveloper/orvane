import { test, expect } from "./fixtures";
import { OutputHold } from "../src/terminalHold";

test("off-screen terminal output is held, then written once and in order", () => {
  const written: string[] = [];
  const hold = new OutputHold((data) => written.push(data), 10);
  hold.output("a");
  expect(written).toEqual(["a"]);
  hold.visible(false);
  hold.output("b");
  hold.output("c");
  expect(written).toEqual(["a"]);
  hold.visible(true);
  expect(written).toEqual(["a", "bc"]);
  // A large backlog is written early instead of growing without bound.
  hold.visible(false);
  hold.output("0123456789");
  hold.output("X");
  expect(written).toEqual(["a", "bc", "0123456789X"]);
  // A replay replaces anything held; release writes what is left.
  hold.output("lost");
  hold.discard();
  hold.output("kept");
  hold.release();
  expect(written.at(-1)).toBe("kept");
});

test("output printed while a terminal is panned away appears when it comes back", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator('main[data-editable="true"]').waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create Terminal", exact: true }).click();
  const terminal = page.locator(".terminal-pane .xterm");
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  const rows = page.locator(".terminal-pane .xterm-rows");
  await expect(rows).not.toHaveText(/^\s*$/, { timeout: 20_000 }); // prompt
  await terminal.click();
  await page.keyboard.type(`node -e "setTimeout(()=>{for(let i=0;i<50;i++)console.log('away '+i);console.log('BACK'+'MARK')},3000)"`);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  const pan = (dx: number) =>
    page.evaluate((dx) => window.dispatchEvent(new CustomEvent("orvane-canvas-pan", { detail: { dx, dy: 0 } })), dx);
  await pan(-6000);
  await expect(terminal).not.toBeInViewport();
  await page.waitForTimeout(5000);
  await pan(6000);
  await expect(rows).toContainText("BACKMARK", { timeout: 10_000 });
  await expect(rows).toContainText("away 49");
});
