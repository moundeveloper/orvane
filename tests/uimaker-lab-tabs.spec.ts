import { test, expect } from "./fixtures";

const page = (text: string) =>
  `<!doctype html><html><body style="margin:0;display:grid;place-items:center;height:100vh"><div id="card">${text}</div></body></html>`;

const labels = ["Thinking trail", "Effort and mode", "Slash skills", "Files changed", "Message actions", "Session timeline", "Workflow library"];

test("UI Maker Lab wraps many variant tabs instead of running under the Pick button and Rounds panel", async ({ page: p }) => {
  test.setTimeout(90_000);
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.goto("/");
  p.setDefaultTimeout(8000);
  await p.getByRole("button", { name: "Workspace options" }).click();
  await p.getByRole("button", { name: "Create UI Maker" }).click();
  const app = p.locator(".canvas-app").last();
  await p.locator(".help").waitFor({ timeout: 30_000 });
  await p.locator(".help").dispatchEvent("pointerdown");
  await app.getByTitle("New component").click();
  await app.getByLabel("New component name").fill("Card");
  await app.getByLabel("New component name").press("Enter");
  await app.locator(".library-item").first().click();
  await app.locator(".top .pills").getByRole("button", { name: "Lab" }).click();

  const api = (op: string, body: object) => p.request.post(`/__orvane/uimaker/${op}`, { data: body });
  expect((await api("lab-start", { c: "card", title: "Board ideas: agent sessions", kind: "new" })).ok()).toBe(true);
  for (const [i, label] of labels.entries()) {
    expect((await api("lab-write", { c: "card", variant: `v${i}`, label, html: page(label) })).ok()).toBe(true);
  }

  const tabs = app.getByRole("tablist", { name: "Variants" }).getByRole("tab");
  await expect(tabs).toHaveText(labels);
  const pick = app.locator(".lab-bar").getByRole("button", { name: "Pick" });
  await expect(pick).toBeVisible();

  const bar = (await app.locator(".lab-bar").boundingBox())!;
  const pickBox = (await pick.boundingBox())!;
  const side = (await app.locator(".right.lab-side").boundingBox())!;
  const tops = new Set<number>();
  for (let i = 0; i < labels.length; i++) {
    const box = (await tabs.nth(i).boundingBox())!;
    tops.add(Math.round(box.y));
    // Every tab stays fully inside the header, left of the Pick button and the Rounds panel.
    expect(box.x + box.width).toBeLessThanOrEqual(pickBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(side.x);
    expect(box.y).toBeGreaterThanOrEqual(bar.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
  }
  // The tabs wrap onto more than one row rather than scrolling sideways.
  expect(tops.size).toBeGreaterThan(1);
  const strip = app.locator(".lab-tabs");
  expect(await strip.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);

  // Selecting still works by click and by number key.
  await tabs.nth(6).click();
  await expect(tabs.nth(6)).toHaveAttribute("aria-selected", "true");
  await expect(app.frameLocator(".lab-stage iframe").locator("#card")).toHaveText("Workflow library");
  // The variant page gets Orvane's scrollbars, first in <head> so its own styles still win.
  await expect.poll(() => app.locator(".lab-stage iframe").evaluate((f: HTMLIFrameElement) =>
    f.contentDocument?.head.firstElementChild?.id)).toBe("orvane-scrollbars");
  await app.locator(".lab-stage").hover();
  await p.keyboard.press("2");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(6)).toHaveAttribute("aria-selected", "false");
  await p.screenshot({ path: "artifacts/uimaker-lab-tabs.png" });
});
