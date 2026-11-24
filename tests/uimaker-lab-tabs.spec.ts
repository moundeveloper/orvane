import { test, expect } from "./fixtures";

const page = (text: string) =>
  `<!doctype html><html><body style="margin:0;display:grid;place-items:center;height:100vh"><button id="card" onclick="this.dataset.clicked = 'yes'">${text}</button></body></html>`;

const labels = ["Thinking trail", "Effort and mode", "Slash skills", "Files changed", "Message actions", "Session timeline", "Workflow library"];

test("UI Maker Lab wraps its tabs and zooms live variants", async ({ page: p }, info) => {
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
  const frame = app.locator(".lab-stage iframe");
  const card = frame.contentFrame().locator("#card");
  await expect(card).toHaveText("Effort and mode");
  const width = (await card.boundingBox())!.width;
  const viewport = () => frame.evaluate((el: HTMLIFrameElement) => el.contentWindow?.innerWidth);
  const previewWidth = await viewport();
  const canvasScale = () => app.evaluate(el => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
  const before = await canvasScale();
  await frame.hover();
  await p.keyboard.down("Control");
  await p.mouse.wheel(0, -240);
  await p.keyboard.up("Control");
  await expect.poll(canvasScale).toBeGreaterThan(before * 1.1);
  await p.keyboard.down("Control");
  await p.mouse.wheel(0, 240);
  await p.keyboard.up("Control");
  await expect.poll(canvasScale).toBeLessThan(before * 1.02);

  const previewScale = () => frame.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  await app.getByRole("button", { name: "Zoom preview out" }).click();
  await expect.poll(previewScale).toBeCloseTo(0.8, 2);
  expect(await viewport()).toBe(previewWidth);
  expect((await card.boundingBox())!.width).toBeLessThan(width);
  await card.click();
  await expect(card).toHaveAttribute("data-clicked", "yes");
  await p.screenshot({ path: info.outputPath("lab-zoomed-out.png"), animations: "disabled" });
  await app.getByRole("button", { name: "Zoom preview in" }).click();
  await app.getByRole("button", { name: "Zoom preview in" }).click();
  await expect.poll(previewScale).toBeCloseTo(1.25, 2);
  expect(await viewport()).toBe(previewWidth);
  await app.getByRole("button", { name: "Reset preview zoom" }).click();
  await expect.poll(previewScale).toBeCloseTo(1, 2);
  await expect(card).toHaveAttribute("data-clicked", "yes");

  // Canvas panning works even when the live preview owns the pointer or focus.
  const appLeft = async () => (await app.boundingBox())!.x;
  await card.hover();
  const start = (await card.boundingBox())!;
  const center = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  const beforeDrag = await appLeft();
  await p.mouse.down({ button: "middle" });
  await p.mouse.move(center.x + 70, center.y + 20, { steps: 5 });
  await p.mouse.up({ button: "middle" });
  await expect.poll(appLeft).toBeGreaterThan(beforeDrag + 50);
  await card.click();
  await expect(card).toBeFocused();
  const next = (await card.boundingBox())!;
  const beforeSpace = await appLeft();
  await p.keyboard.down("Space");
  await p.mouse.move(next.x - 60, next.y + 20, { steps: 5 });
  await p.keyboard.up("Space");
  await expect.poll(appLeft).toBeLessThan(beforeSpace - 40);
  await expect(p.locator(".pan-shield")).not.toHaveClass(/armed/);
  await p.screenshot({ path: "artifacts/uimaker-lab-tabs.png" });
});
