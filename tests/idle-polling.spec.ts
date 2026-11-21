import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const count = (page: Page, match: (url: URL) => boolean) => {
  const seen: number[] = [];
  page.on("request", (request) => {
    if (match(new URL(request.url()))) seen.push(Date.now());
  });
  return (since: number) => seen.filter((at) => at >= since).length;
};
const pan = (page: Page, dx: number) =>
  page.evaluate((dx) => window.dispatchEvent(new CustomEvent("orvane-canvas-pan", { detail: { dx, dy: 0 } })), dx);

test("the editing window renews its storage lease every few seconds, not every second", async ({ page }) => {
  test.setTimeout(150_000);
  const leases = count(page, (url) => url.pathname === "/__orvane/storage/lease");
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator('main[data-editable="true"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(5000); // startup settles
  const from = Date.now();
  await page.waitForTimeout(20_000);
  // 20 s at one renewal every 4 s: about 5 (every second would be 20). A
  // slow reply delays the next renewal, so allow a little either way.
  expect(leases(from)).toBeGreaterThanOrEqual(2);
  expect(leases(from)).toBeLessThanOrEqual(8);
});

test("Agent sessions stops polling while panned off screen and resumes on return", async ({ page }) => {
  test.setTimeout(150_000);
  const polls = count(page, (url) => url.pathname.startsWith("/__orvane/agents/"));
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator('main[data-editable="true"]').waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create Agent sessions", exact: true }).click();
  const app = page.locator(".agent-sessions-app");
  await expect(app).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => polls(0), { timeout: 15_000 }).toBeGreaterThan(0);

  await pan(page, -8000);
  await expect(app).not.toBeInViewport();
  await page.waitForTimeout(1000); // a request already in flight may finish
  const away = Date.now();
  await page.waitForTimeout(6000);
  expect(polls(away)).toBe(0);

  const back = Date.now();
  await pan(page, 8000);
  await expect(app).toBeInViewport();
  await expect.poll(() => polls(back), { timeout: 3000 }).toBeGreaterThan(0);
});
