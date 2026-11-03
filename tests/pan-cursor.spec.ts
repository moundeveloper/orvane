import { test, expect } from "./fixtures";

async function setup(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "pan-probe";
    probe.style.cssText =
      "position:fixed;left:120px;top:150px;z-index:2;background:white;padding:20px";
    probe.innerHTML =
      '<button id="probe-button" style="cursor:pointer">Probe action</button><input id="probe-input" value="Text"><div id="probe-editor" contenteditable="true" style="cursor:text;width:300px;margin-top:20px">Selectable editor text</div>';
    document.querySelector(".canvas-app")!.appendChild(probe);
    (window as any).probeClicks = 0;
    probe
      .querySelector("button")!
      .addEventListener("click", () => (window as any).probeClicks++);
  });
  return page.locator(".pan-cursor-surface");
}

test("Space pan uses one grab surface over controls, captures the drag and restores normal input", async ({
  page,
}) => {
  const surface = await setup(page);
  const button = page.locator("#probe-button");
  await expect(surface).toHaveCSS("pointer-events", "none");
  await expect(button).toHaveCSS("cursor", "pointer");
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.click(1100, 110);
  await page.keyboard.down("Space");
  await expect(surface).toHaveCSS("pointer-events", "auto");
  await expect(surface).toHaveCSS("cursor", "grab");
  const before = await page
    .locator(".canvas-plane")
    .evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.move(150, 180);
  await page.mouse.down();
  await expect(surface).toHaveCSS("cursor", "grabbing");
  await expect
    .poll(() => surface.evaluate((el) => el.hasPointerCapture(1)))
    .toBe(true);
  await page.mouse.move(250, 250, { steps: 10 });
  const after = await page
    .locator(".canvas-plane")
    .evaluate((el) => getComputedStyle(el).transform);
  expect(after).not.toBe(before);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  await page.mouse.up();
  await expect(surface).toHaveCSS("cursor", "grab");
  await page.keyboard.up("Space");
  await expect(surface).toHaveCSS("pointer-events", "none");
  expect(await page.evaluate(() => (window as any).probeClicks)).toBe(0);
  await button.click();
  expect(await page.evaluate(() => (window as any).probeClicks)).toBe(1);
  await page.locator("#probe-editor").focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Space");
  await expect(surface).toHaveCSS("pointer-events", "none");
  await expect(page.locator("#probe-editor")).toHaveText(
    "Selectable editor text ",
  );
  await page.keyboard.down("Shift");
  await page.keyboard.press("Home");
  await page.keyboard.up("Shift");
  expect(await page.evaluate(() => getSelection()?.toString())).toContain(
    "Selectable",
  );
  await page.locator("#probe-editor").dblclick({ position: { x: 35, y: 8 } });
  expect(
    (await page.evaluate(() => getSelection()?.toString()))?.length,
  ).toBeGreaterThan(0);
});

test("middle pan, pointer cancellation and blur release the cursor surface and selection suppression", async ({
  page,
}) => {
  const surface = await setup(page);
  await page.mouse.move(500, 500);
  await page.mouse.down({ button: "middle" });
  await expect(surface).toHaveCSS("cursor", "grabbing");
  await surface.dispatchEvent("pointercancel", { pointerId: 1 });
  await expect(surface).toHaveCSS("pointer-events", "none");
  await page.mouse.up({ button: "middle" });
  await page.mouse.down({ button: "middle" });
  await expect(surface).toHaveCSS("pointer-events", "auto");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(surface).toHaveCSS("pointer-events", "none");
  await expect
    .poll(() => surface.evaluate((el) => el.hasPointerCapture(1)))
    .toBe(false);
  await page.mouse.up({ button: "middle" });
  await page.keyboard.down("Space");
  await expect(surface).toHaveCSS("pointer-events", "auto");
  await page.getByRole("button", { name: "App groups", exact: true }).click();
  await expect(page.locator(".groups-panel")).toBeVisible();
  await page.keyboard.up("Space");
  await expect(surface).toHaveCSS("pointer-events", "none");
  await page.screenshot({
    path: "artifacts/performance/pan-cursor-restored.png",
  });
});

test("empty-space left drag and two-finger zoom clear the cursor surface after release", async ({
  page,
}) => {
  const surface = await setup(page);
  await page.mouse.move(20, 500);
  await page.mouse.down();
  await expect(surface).toHaveCSS("cursor", "grabbing");
  await expect
    .poll(() => surface.evaluate((el) => el.hasPointerCapture(1)))
    .toBe(true);
  await page.mouse.move(50, 540);
  await page.mouse.up();
  await expect(surface).toHaveCSS("pointer-events", "none");
  const cdp = await page.context().newCDPSession(page);
  const before = await page
    .locator(".canvas-plane")
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 20, y: 500, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 20, y: 500, id: 1 },
      { x: 80, y: 500, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 20, y: 450, id: 1 },
      { x: 160, y: 550, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(surface).toHaveCSS("pointer-events", "none");
  expect(
    await page
      .locator(".canvas-plane")
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a),
  ).toBeGreaterThan(before);
  await cdp.detach();
});
