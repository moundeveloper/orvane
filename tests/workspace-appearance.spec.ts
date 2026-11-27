import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "./fixtures";

test.setTimeout(90_000);

async function openAppearance(page: Page) {
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: /^Palette and background/ }).click();
  return page.getByRole("region", { name: "Appearance settings" });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("header controls sit on the same frosted pill on every background", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // The top-left wordmark and the full-width header frost band are gone.
  await expect(page.locator(".topbar .wordmark, .topbar-frost")).toHaveCount(0);
  const actions = page.locator(".topbar .top-actions");
  const closeOptions = page.getByRole("button", { name: "Close workspace settings" });
  const backdrop = (cluster: typeof actions) =>
    cluster.evaluate((node) => getComputedStyle(node, "::before").backgroundColor);
  const opaqueFrost = /^rgba\(247, 250, 252, 0\.(?:898|9)\)$/;
  // Plain used to leave the cluster bare; it now matches Image, Video and Code.
  expect(await backdrop(actions)).toMatch(opaqueFrost);
  const panel = await openAppearance(page);
  await panel.getByRole("radio", { name: "Video", exact: true }).click();
  await expect.poll(() => backdrop(actions)).toMatch(opaqueFrost);
  await expect(page.getByRole("button", { name: "App groups" })).toHaveCSS("color", "rgb(69, 89, 104)");
  await panel.getByRole("radio", { name: "Code", exact: true }).click();
  await expect.poll(() => backdrop(actions)).toMatch(opaqueFrost);
  await panel.getByRole("radio", { name: "Plain", exact: true }).click();
  await expect.poll(() => backdrop(actions)).toMatch(opaqueFrost);
  await panel.getByRole("radio", { name: "Video", exact: true }).click();
  await page.getByRole("button", { name: "Workspace options" }).click();
  await expect(closeOptions).toBeVisible();
  await expect.poll(() => backdrop(actions)).toMatch(opaqueFrost);
});

test("the frosted Terminal uses Auto tint over a light wallpaper and keeps Plain unchanged", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // Same classes AppSurface gives the Terminal app.
  const glass = () => page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "app-surface app-frosted";
    probe.innerHTML = '<div class="xterm-screen"></div>';
    document.querySelector("main.workspace")!.append(probe);
    const { backgroundColor, backdropFilter } = getComputedStyle(probe);
    const halo = getComputedStyle(probe.firstElementChild!).filter;
    probe.remove();
    return { backgroundColor, backdropFilter, halo };
  });
  expect(await glass()).toEqual({ backgroundColor: "rgba(247, 250, 252, 0.08)", backdropFilter: "blur(8px) saturate(1.2)", halo: "none" });
  const panel = await openAppearance(page);
  for (const type of ["Image", "Video", "Code"]) {
    await panel.getByRole("radio", { name: type, exact: true }).click();
    await expect.poll(glass).toEqual({ backgroundColor: "rgba(247, 250, 252, 0.42)", backdropFilter: "blur(22px) saturate(1.4)", halo: "none" });
  }
  await panel.getByRole("radio", { name: "Plain", exact: true }).click();
  await expect.poll(glass).toEqual({ backgroundColor: "rgba(247, 250, 252, 0.08)", backdropFilter: "blur(8px) saturate(1.2)", halo: "none" });
});

test("the preview badge never covers header controls", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const panel = await openAppearance(page);
  await panel.getByRole("radio", { name: "Sage" }).click();
  const badge = page.locator(".appearance-preview-chip");
  for (const type of ["Plain", "Video"]) {
    await panel.getByRole("radio", { name: type, exact: true }).click();
    for (const width of [1600, 1280, 1000, 820, 700]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(badge).toBeVisible();
      const box = (await badge.boundingBox())!;
      const controls = await page.locator(".topbar .top-actions > *").evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect()).filter((rect) => rect.width && rect.height)
          .map(({ left, right, top, bottom }) => ({ left, right, top, bottom })));
      expect(controls.length).toBeGreaterThan(3);
      for (const control of controls) {
        const overlaps = box.x < control.right && box.x + box.width > control.left
          && box.y < control.bottom && box.y + box.height > control.top;
        expect(overlaps, `${type} at ${width}px`).toBe(false);
      }
    }
  }
});

test("Appearance opens from the settings area of Workspace options and returns there", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Workspace options" }).click();
  const options = page.getByRole("region", { name: "Workspace settings" });
  const entry = options.locator(".settings-section").getByRole("button", { name: /^Palette and background/ });
  await expect(entry).toContainText("Orvane · Plain");
  await entry.click();
  const panel = page.getByRole("region", { name: "Appearance settings" });
  await panel.getByRole("button", { name: /^Back/ }).click();
  await expect(options).toBeVisible();
  await expect(entry).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Workspace options" })).toBeFocused();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Appearance settings");
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
});

test("the dock's Center canvas button shows the Orvane mark and still centers the canvas", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const center = page.locator(".dock").getByRole("button", { name: "Center canvas", exact: true });
  await expect(center).toHaveAttribute("title", "Center canvas");
  await expect(center.locator("img.dock-logo")).toHaveAttribute("src", "/favicon.png");
  expect((await center.boundingBox())!.width).toBeGreaterThanOrEqual(29);
  const plane = page.locator(".canvas-plane").first();
  const transform = () => plane.evaluate((node) => getComputedStyle(node).transform);
  const before = await transform();
  await page.mouse.move(120, 650);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(60, 560, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  await expect.poll(transform).not.toBe(before);
  await center.click();
  await expect.poll(transform).toBe(before);
});

test("palettes theme the dock and Orvane's floating panels; the default palette keeps their look", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const groupsButton = page.getByRole("button", { name: "App groups" });
  const surfaces = async () => {
    await groupsButton.click();
    const groups = page.locator(".groups-panel");
    await expect(groups).toBeVisible();
    // Buttons fade their colours; read the settled values.
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished)));
    const style = (selector: string, property: "backgroundColor" | "color") =>
      page.locator(selector).first().evaluate((node, key) => getComputedStyle(node)[key], property);
    const result = {
      dock: await style(".dock", "backgroundColor"),
      groups: await style(".groups-panel", "backgroundColor"),
      text: await style(".groups-panel", "color"),
      create: await style(".dock .create-app", "backgroundColor"),
      topPill: await page.locator(".topbar .top-actions").evaluate((node) => getComputedStyle(node, "::before").backgroundColor),
      topText: await style(".top-actions [aria-label='Memory']", "color"),
    };
    await groupsButton.click();
    await expect(groups).toBeHidden();
    return result;
  };
  const defaults = await surfaces();
  expect(defaults).toMatchObject({
    dock: "rgb(245, 248, 250)", groups: "rgb(247, 249, 250)", text: "rgb(69, 89, 104)", create: "rgb(228, 237, 242)",
  });
  expect(defaults.topPill).toMatch(/^rgba\(247, 250, 252, 0\.(?:898|9)\)$/);
  const panel = await openAppearance(page);
  const apply = panel.getByRole("button", { name: /^Apply/ });
  await panel.getByRole("radio", { name: "Sage" }).click();
  // The open Appearance panel previews the palette on itself.
  await expect(apply).toHaveCSS("background-color", "rgb(61, 100, 77)");
  await apply.click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  const sage = await surfaces();
  expect(sage.text).toBe("rgb(70, 87, 74)");
  for (const key of ["dock", "groups", "create", "topPill", "topText"] as const) expect(sage[key]).not.toBe(defaults[key]);
  // The top bar pill uses the dock's shell surface, like the dock itself.
  expect(sage.topText).toBe(await page.locator(".dock .dock-tab, .dock .empty-dock-label").first()
    .evaluate((node) => getComputedStyle(node).color));
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await surfaces()).toEqual(sage);
  await (await openAppearance(page)).getByRole("radio", { name: "Orvane" }).click();
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("region", { name: "Appearance settings" }).getByText("No changes")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await surfaces()).toEqual(defaults);
});

test("previews live palette changes and saves only on Apply", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const workspace = page.locator("main.workspace");
  const panel = await openAppearance(page);
  await panel.getByRole("radio", { name: "Sage" }).click();
  await expect(workspace).toHaveCSS("background-color", "rgb(230, 235, 228)");
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveCSS("background-color", "rgb(233, 237, 240)");
  await expect(panel.getByRole("button", { name: /^Apply/ })).toBeDisabled();

  await panel.getByRole("button", { name: /^Edit Canvas colour/ }).click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("slider", { name: "Hue" })).toBeFocused();
  await page.keyboard.press("Tab");
  const hex = page.getByRole("textbox", { name: "Hex colour" });
  await expect(hex).toBeFocused();
  await hex.fill("#f1eadf");
  await hex.press("Enter");
  await expect(workspace).toHaveCSS("background-color", "rgb(241, 234, 223)");
  await page.keyboard.press("Control+Enter");
  await expect(panel.getByText("No changes")).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(workspace).toHaveCSS("background-color", "rgb(241, 234, 223)");
  await (await openAppearance(page)).getByRole("radio", { name: "Harbor" }).click();
  await page.locator(".canvas-background").click({ position: { x: 45, y: 200 } });
  await expect(panel).toBeHidden();
  await expect(workspace).toHaveCSS("background-color", "rgb(241, 234, 223)");
});

test("persists local media and previews code and reduced motion", async ({ page, browser }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const panel = await openAppearance(page);
  await panel.getByRole("radio", { name: "Image", exact: true }).click();
  await panel.locator('input[type="file"]').setInputFiles({
    name: "wallpaper.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kvWQAAAAASUVORK5CYII=", "base64"),
  });
  const image = page.locator(".wallpaper-image");
  await expect(image).toHaveCSS("background-image", /blob:/);
  await panel.getByRole("button", { name: /^Apply/ }).click();
  await expect(image).toHaveCSS("background-image", /storage\/theme-media\//);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(image).toHaveCSS("background-image", /storage\/theme-media\//);
  expect(await image.evaluate(async (node) => {
    const url = getComputedStyle(node).backgroundImage.slice(5, -2);
    return (await fetch(url)).headers.get("content-type");
  })).toBe("image/png");

  await openAppearance(page);
  await page.keyboard.press("Alt+3");
  const video = page.locator(".theme-wallpaper video");
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0);
  await expect(video).toHaveJSProperty("loop", true);
  await expect(video).toHaveJSProperty("muted", true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(video).toHaveJSProperty("paused", true);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(video).toHaveJSProperty("paused", false);
  await panel.getByRole("switch", { name: "Preview reduced motion" }).click();
  await expect(video).toHaveJSProperty("paused", true);
  await panel.getByRole("radio", { name: "Code", exact: true }).click();
  await expect(page.locator(".theme-wallpaper canvas")).toBeVisible();
  await expect(panel.getByLabel("Animation code")).toContainText("ctx.fillRect");
  await panel.getByRole("slider", { name: "Animation speed" }).press("ArrowRight");
  await panel.getByRole("button", { name: /^Discard/ }).click();
  await expect(image).toBeVisible();

  await panel.getByRole("radio", { name: "Video", exact: true }).click();
  await panel.locator('input[type="file"]').setInputFiles("public/themes/rain.webm");
  await expect(video).toHaveAttribute("src", /^blob:/);
  await panel.getByRole("button", { name: /^Apply/ }).click();
  await expect(video).toHaveAttribute("src", /storage\/theme-media\//);
  await page.reload({ waitUntil: "domcontentloaded" });
  const source = await video.getAttribute("src");
  expect(source).toMatch(/storage\/theme-media\//);
  const range = await page.request.get(source!, { headers: { Range: "bytes=0-15" } });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(16);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(video).toHaveJSProperty("paused", true);

  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search" }).fill(">Export backup");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByText("Export backup", { exact: true }).click(),
  ]);
  const backupFile = (await download.path())!;
  const backup = JSON.parse(await readFile(backupFile, "utf8"));
  expect(Object.values(backup.backgrounds)).toEqual(expect.arrayContaining([
    expect.objectContaining({ mime: "image/png", data: expect.any(String) }),
    expect.objectContaining({ mime: "video/webm", data: expect.any(String) }),
  ]));

  const restored = await browser.newContext();
  const namespace = randomUUID();
  const origin = new URL(page.url()).origin;
  await restored.setExtraHTTPHeaders({ "x-orvane-test-workspace": namespace });
  await restored.addCookies([{ name: "orvane-test-workspace", value: namespace, url: origin }]);
  try {
    const fresh = await restored.newPage();
    await fresh.addInitScript(() => localStorage.setItem("orvane.examples.v1", "installed"));
    await fresh.goto(origin, { waitUntil: "domcontentloaded" });
    await expect(fresh.locator('main[data-editable="true"]')).toBeVisible({ timeout: 30_000 });
    expect((await fresh.request.get(source!)).status()).toBe(404);
    await fresh.getByLabel("Import workspace file").setInputFiles({
      name: "backup.json", mimeType: "application/json", buffer: await readFile(backupFile),
    });
    await fresh.getByRole("dialog", { name: "Backup import preview" }).getByRole("button", { name: "Replace" }).click();
    await expect(fresh.locator(".theme-wallpaper video")).toHaveAttribute("src", source!);
    expect((await fresh.request.get(source!)).headers()["content-type"]).toBe("video/webm");
  } finally {
    await restored.close();
  }
});

test("Workspace settings and Appearance stay above the pinned side chat", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // Same classes and place App.vue gives the pinned chat (z-index 200, top right).
  await page.evaluate(() => {
    const side = document.createElement("aside");
    side.className = "side-chat workspace-frost";
    side.dataset.probe = "side";
    document.querySelector("main.workspace")!.append(side);
  });
  const onTop = (region: string) =>
    page.getByRole("region", { name: region }).evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(box.right - 40, box.top + box.height / 2);
      return !!hit && panel.contains(hit);
    });
  await page.getByRole("button", { name: "Workspace options" }).click();
  expect(await onTop("Workspace settings")).toBe(true);
  await page.getByRole("button", { name: /^Palette and background/ }).click();
  expect(await onTop("Appearance settings")).toBe(true);
});

test("palette arrow buttons and Left/Right keys step through palettes", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const panel = await openAppearance(page);
  const selected = () => panel.getByRole("radiogroup", { name: "Palette" }).locator('[aria-checked="true"]');
  await expect(selected()).toHaveText(/Orvane/);
  await panel.getByRole("button", { name: "Next palette" }).click();
  await expect(selected()).toHaveText(/Sage/);
  await panel.getByRole("button", { name: "Previous palette" }).click();
  await panel.getByRole("button", { name: "Previous palette" }).click();
  // Wraps from the first palette to the last.
  await expect(selected()).not.toHaveText(/Orvane|Sage/);
  // Arrows work with focus on the panel itself, not only on a swatch.
  await panel.focus();
  await page.keyboard.press("ArrowRight");
  await expect(selected()).toHaveText(/Orvane/);
  await page.keyboard.press("ArrowRight");
  await expect(selected()).toHaveText(/Sage/);
});

test("an image builds a matching palette, not a copy of its colours", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // A sunset: orange sky, yellow sun, violet hills, teal water.
  const sunset = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const context = canvas.getContext("2d")!;
    for (const [color, y, h] of [["#f98f3a", 0, 34], ["#f9d46b", 34, 10], ["#6a3f86", 44, 20], ["#1c7e92", 64, 16]] as const) {
      context.fillStyle = color;
      context.fillRect(0, y, 120, h);
    }
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), "base64");
  const panel = await openAppearance(page);
  const image = panel.getByRole("radio", { name: "Palette from image" });
  await expect(image).toHaveAttribute("aria-checked", "false");
  // Arrow keys pass over "Image" without opening a file picker.
  await panel.getByRole("radio", { name: "Heather" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(image).toBeFocused();
  await expect(panel.getByRole("radio", { name: "Heather" })).toHaveAttribute("aria-checked", "true");

  const chooser = page.waitForEvent("filechooser");
  await image.press("Enter");
  await (await chooser).setFiles({ name: "sunset-ridge.png", mimeType: "image/png", buffer: sunset });
  await expect(image).toHaveAttribute("aria-checked", "true");
  const source = panel.getByLabel("Palette image", { exact: true });
  await expect(source).toContainText("sunset-ridge.png");
  await expect(source).toContainText("120×80");
  await expect(panel.getByLabel("Image mood")).toContainText("Warm");
  await expect(panel.getByText("For the UI")).toBeVisible();
  const token = (label: string) => panel.getByRole("button", { name: new RegExp(`^Edit ${label} colour`) });
  await expect(token("Canvas")).toContainText("orange, almost grey");
  await expect(token("Text")).toContainText("violet, dark");
  const accent = async () => (await token("Accent").getAttribute("aria-label"))!.split(", ")[1];
  const balanced = await accent();
  // The palette goes with the image; it never copies the image's own colours.
  for (const hex of ["#f98f3a", "#f9d46b", "#6a3f86", "#1c7e92"]) expect(balanced).not.toBe(hex);

  const strength = panel.getByRole("radiogroup", { name: "Colour strength" });
  await strength.getByRole("radio", { name: "Vivid" }).click();
  const vivid = await accent();
  expect(vivid).not.toBe(balanced);
  await expect(panel.getByText(/Text on windows \d+\.\d:1$/)).toBeVisible();

  const asBackground = panel.getByRole("switch", { name: "Use the palette image as canvas background" });
  await asBackground.click();
  await expect(asBackground).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".wallpaper-image")).toHaveCSS("background-image", /blob:/);

  await panel.getByRole("button", { name: /^Apply/ }).click();
  await expect(panel.getByText("No changes")).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  const again = await openAppearance(page);
  await expect(again.getByRole("radio", { name: "Palette from image" })).toHaveAttribute("aria-checked", "true");
  await expect(again.getByLabel("Palette image", { exact: true })).toContainText("sunset-ridge.png");
  await expect(again.getByLabel("Palette image", { exact: true }).locator("img")).toHaveJSProperty("complete", true);
  expect(await again.getByRole("button", { name: /^Edit Accent colour/ }).getAttribute("aria-label")).toContain(vivid);
  await expect(again.getByRole("radiogroup", { name: "Colour strength" }).getByRole("radio", { name: "Vivid" }))
    .toHaveAttribute("aria-checked", "true");
  // Another palette and back: the image palette is kept.
  await page.keyboard.press("Escape");
  const third = await openAppearance(page);
  await third.getByRole("radio", { name: "Sage" }).click();
  await third.getByRole("radio", { name: "Palette from image" }).click();
  await expect(third.getByLabel("Palette image", { exact: true })).toContainText("sunset-ridge.png");
});

test("an image palette keeps only its colours unless the image is also the background", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 60;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#1c7e92";
    context.fillRect(0, 0, 60, 26);
    context.fillStyle = "#2e274e";
    context.fillRect(0, 26, 60, 14);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), "base64");
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/theme-media/")) uploads.push(request.url());
  });
  const panel = await openAppearance(page);
  const chooser = page.waitForEvent("filechooser");
  await panel.getByRole("radio", { name: "Palette from image" }).click();
  await (await chooser).setFiles({ name: "harbour.png", mimeType: "image/png", buffer: png });
  await expect(panel.getByLabel("Palette image", { exact: true })).toContainText("harbour.png");
  // Background on, then off again: the image is no longer needed.
  const asBackground = panel.getByRole("switch", { name: "Use the palette image as canvas background" });
  await asBackground.click();
  await asBackground.click();
  await expect(asBackground).toHaveAttribute("aria-checked", "false");
  const canvas = await panel.getByRole("button", { name: /^Edit Canvas colour/ }).getAttribute("aria-label");
  await panel.getByRole("button", { name: /^Apply/ }).click();
  await expect(panel.getByText("No changes")).toBeVisible();
  expect(uploads).toEqual([]);
  // The colours stay; the image and its card are gone.
  await expect(panel.getByLabel("Palette image", { exact: true })).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  const again = await openAppearance(page);
  await expect(again.getByRole("radio", { name: "Palette from image" })).toHaveAttribute("aria-checked", "true");
  expect(await again.getByRole("button", { name: /^Edit Canvas colour/ }).getAttribute("aria-label")).toBe(canvas);
  await expect(again.getByLabel("Palette image", { exact: true })).toHaveCount(0);
  await expect(again.getByRole("radio", { name: "Plain", exact: true })).toHaveAttribute("aria-checked", "true");
});
