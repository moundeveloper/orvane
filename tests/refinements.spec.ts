import { clickFrameButton } from "./frame-pointer";
import { test, expect } from "./fixtures";

for (const reducedMotion of [false, true]) {
  test(`search briefly outlines only its destination, reduced motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    await page.goto("/");
    for (const [name, keyboard] of [
      ["Tally", false],
      ["Daily list", true],
    ] as const) {
      const app = page
        .locator(".canvas-app")
        .filter({ has: page.getByRole("region", { name, exact: true }) });
      const dimensions = await app.evaluate((el) => [
        (el as HTMLElement).offsetWidth,
        (el as HTMLElement).offsetHeight,
      ]);
      await page
        .getByRole("button", { name: "Find an app", exact: true })
        .click();
      const input = page.getByRole("textbox", {
        name: "Search apps",
        exact: true,
      });
      await input.fill(name);
      if (keyboard) await input.press("Enter");
      else await page.locator(".search-results button").click();
      const outline = app.locator(".app-locator");
      await expect(outline).toBeVisible();
      await expect(page.locator(".app-locator")).toHaveCount(1);
      await expect(outline).toHaveCSS("opacity", "1");
      expect(
        await app.evaluate((el) => [
          (el as HTMLElement).offsetWidth,
          (el as HTMLElement).offsetHeight,
        ]),
      ).toEqual(dimensions);
      await expect(outline).toHaveCSS("pointer-events", "none");
      if (!reducedMotion && !keyboard)
        await page.screenshot({
          path: "artifacts/search-destination-outline.png",
        });
      if (keyboard) {
        const field = app.getByRole("textbox", {
          name: "New task",
          exact: true,
        });
        await field.fill("Still usable during the highlight");
        await expect(field).toBeFocused();
      }
    }
    await expect(page.locator(".app-locator")).toHaveCount(0);
  });
}

test("search arrow keys move the selection and enter opens the selected app", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Find an app", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Search apps", exact: true });
  const results = page.locator(".search-results button");
  const count = await results.count();
  expect(count).toBeGreaterThan(2);
  await expect(results.nth(0)).toHaveClass(/selected/);
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(results.nth(2)).toHaveClass(/selected/);
  await expect(page.locator(".search-results button.selected")).toHaveCount(1);
  await input.press("ArrowUp");
  await expect(results.nth(1)).toHaveClass(/selected/);
  await input.press("ArrowUp");
  await input.press("ArrowUp");
  await expect(results.nth(count - 1)).toHaveClass(/selected/);
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(input).toBeFocused();
  const name = (
    await results
      .nth(1)
      .locator("span")
      .evaluate((el) => el.firstChild?.textContent ?? "")
  ).trim();
  await input.press("Enter");
  const app = page
    .locator(".canvas-app")
    .filter({ has: page.getByRole("region", { name, exact: true }) });
  await expect(app.locator(".app-locator")).toBeVisible();
});

test("examples install once, calculator works, and the sample cross-app flow is live", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".canvas-app")).toHaveCount(4);
  await page
    .getByRole("textbox", { name: "New task", exact: true })
    .fill("One more idea");
  await page
    .getByRole("button", { name: "Add to the list", exact: true })
    .click();
  await expect(page.locator(".runtime-list").first()).toContainText(
    "One more idea",
  );
  await expect(
    page.locator(".runtime-counter").first().locator("output"),
  ).toHaveText("1");
  await page.getByRole("button", { name: "Calculator", exact: true }).click();
  await expect(page.locator(".canvas-plane")).not.toHaveClass(/camera-moving/);
  const calc = page.frameLocator('iframe[title="Calculator"]');
  await clickFrameButton(page, "Calculator", "7");
  await clickFrameButton(page, "Calculator", "+");
  await clickFrameButton(page, "Calculator", "3");
  await clickFrameButton(page, "Calculator", "=");
  await expect(calc.locator("output")).toHaveText("10");
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator(".canvas-app")).toHaveCount(4);
  await expect(page.locator(".runtime-list").first()).toContainText(
    "One more idea",
  );
  await page.screenshot({ path: "artifacts/examples-desktop.png" });
});

test("global popovers and each app menu close on outside pointerdown", async ({
  page,
}) => {
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "New task", exact: true });
  for (const name of ["Find an app", "Canvas guide", "Workspace options"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.locator(".search-panel,.guide-panel,.workspace-panel"),
    ).toHaveCount(1);
    await field.click();
    await expect(
      page.locator(".search-panel,.guide-panel,.workspace-panel"),
    ).toHaveCount(0);
  }
  await page
    .getByRole("button", { name: "Options for Daily list", exact: true })
    .click();
  await expect(page.locator(".app-menu")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "A thought to come back to", exact: true })
    .click();
  await expect(page.locator(".app-menu")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Options for Daily list", exact: true })
    .click();
  await page.mouse.click(12, 60);
  await expect(page.locator(".app-menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Calculator", exact: true }).click();
  // The iframe's own button is stationary in frame coordinates while its parent
  // app is still panning. Wait for that camera movement before targeting it.
  await expect(page.locator(".canvas-plane")).not.toHaveClass(/camera-moving/);
  await page.getByRole("button", { name: "Canvas guide", exact: true }).click();
  await clickFrameButton(page, "Calculator", "7");
  await expect(page.locator(".guide-panel")).toHaveCount(1);
  await expect(
    page.frameLocator('iframe[title="Calculator"]').locator("output"),
  ).toHaveText("7");
});

test("search animates from the dock icon for mouse and shortcut; fields have no rectangular focus outline", async ({
  page,
}) => {
  await page.goto("/");
  for (const shortcut of [false, true]) {
    if (shortcut) await page.keyboard.press("k");
    else
      await page
        .getByRole("button", { name: "Find an app", exact: true })
        .click();
    const search = page.locator(".search-panel");
    await expect(search).toBeVisible();
    await expect(search).not.toHaveClass(/search-reveal-enter-active/);
    const origin = await search.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        s = getComputedStyle(el),
        [x, y] = s.transformOrigin.split(" ").map(parseFloat);
      return { x: r.x + x!, y: r.y + y! };
    });
    const button = (await page
      .getByRole("button", { name: "Find an app", exact: true })
      .boundingBox())!;
    expect(Math.abs(origin.x - button.x - button.width / 2)).toBeLessThan(2);
    expect(Math.abs(origin.y - button.y - button.height / 2)).toBeLessThan(2);
    const input = page.getByRole("textbox", {
      name: "Search apps",
      exact: true,
    });
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe("none");
    await page.screenshot({
      path: shortcut
        ? "artifacts/search-focus.png"
        : "artifacts/search-mouse.png",
    });
    await input.press("Escape");
    await expect(search).toHaveCount(0);
  }
  const app = page.getByRole("region", { name: "Daily list", exact: true });
  await app.getByRole("button", { name: "Build app", exact: true }).click();
  await app.locator(".tree-select").filter({ hasText: "New task" }).click();
  for (const el of await app
    .locator("input:not([type=range]):not([type=checkbox]),textarea,select")
    .all()) {
    if (!(await el.isVisible())) continue;
    await el.focus();
    expect(
      await el.evaluate((node) => getComputedStyle(node).outlineStyle),
    ).toBe("none");
  }
});

test("wheel zoom interpolates continuously and repaints text without a scaled compositor layer", async ({
  page,
}) => {
  await page.goto("/");
  const app = page.locator(".canvas-app").first();
  const logicalWidth = await app.evaluate(
    (el) => (el as HTMLElement).offsetWidth,
  );
  await page.mouse.move(200, 180);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -180);
  await page.keyboard.up("Control");
  await page.waitForTimeout(35);
  const midway = await page
    .locator(".canvas-plane")
    .evaluate(
      (el) =>
        (Number((el as HTMLElement).style.zoom) || 1) *
        new DOMMatrix(getComputedStyle(el).transform).a,
    );
  await expect
    .poll(() =>
      page
        .locator(".canvas-plane")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a),
    )
    .toBeCloseTo(Math.exp(0.45), 3);
  expect(midway).toBeGreaterThan(1);
  expect(midway).toBeLessThan(Math.exp(0.45));
  await expect.poll(() => page.locator(".canvas-plane").evaluate(
    (el) => getComputedStyle(el).willChange,
  )).toBe("auto");
  const style = await page.locator(".canvas-plane").evaluate((el) => ({
    transform: getComputedStyle(el).transform,
    scale: new DOMMatrix(getComputedStyle(el).transform).a,
    willChange: getComputedStyle(el).willChange,
  }));
  expect(style.scale).toBeCloseTo(Math.exp(0.45), 3);
  expect(style.willChange).toBe("auto");
  expect(await app.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(
    logicalWidth,
  );
  await page.screenshot({ path: "artifacts/zoom-sharp.png" });
});
