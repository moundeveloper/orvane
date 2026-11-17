import { test, expect } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("**/__orvane/terminal/profiles", (route) =>
    route.fulfill({
      json: { profiles: [{ id: "fixture", name: "Fixture shell", kind: "other", source: "detected" }] },
    }),
  );
});

test("50 restored terminal tabs initialize only the selected terminal", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/terminal-performance-harness.ts";
    (window as any).terminalFixture = (
      await import(module)
    ).mountTerminalFixture();
  });
  const root = page.locator("#terminal-fixture");
  await expect(root.getByRole("tab")).toHaveCount(50);
  await expect(root.locator(".xterm")).toHaveCount(1);
  const baseline = await page.evaluate(() => ({
    initialized: document.querySelectorAll("#terminal-fixture .xterm").length,
    fits: (window as any).terminalFixture.fits,
    changes: (window as any).terminalFixture.changes,
  }));
  await info.attach("terminal-startup-candidate.json", {
    body: JSON.stringify(baseline),
    contentType: "application/json",
  });
  console.log("Terminal startup candidate:", baseline);
  await page.evaluate(() => (window as any).terminalFixture.unmount());
});

async function mount(
  page: import("@playwright/test").Page,
  count = 50,
  open = true,
) {
  await page.goto("/");
  await page.evaluate(
    async ({ count, open }) => {
      const module = "/tests/terminal-performance-harness.ts";
      (window as any).terminalFixture = (
        await import(module)
      ).mountTerminalFixture(count, open);
    },
    { count, open },
  );
  return page.locator("#terminal-fixture");
}

async function mountIsolated(page: import("@playwright/test").Page) {
  await page.route("**/terminal-rendering-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/terminal-rendering-fixture");
  await page.evaluate(async () => {
    const fixture = "/tests/terminal-performance-harness.ts";
    (window as any).terminalFixture = (await import(fixture)).mountTerminalFixture(1);
  });
  return page.locator("#terminal-fixture");
}

async function settleFrames(page: import("@playwright/test").Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
const cwd = (index: number) => `C:\\fixture\\project-${index}`;

test("closed restored panels defer every terminal; selecting and closing tabs initializes only the next visible tab", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const root = await mount(page, 50, false);
  await expect(root.locator(".terminal-tab")).toHaveCount(50);
  await expect(root.locator(".terminal-panel")).toBeHidden();
  await settleFrames(page);
  expect(await root.locator(".xterm").count()).toBe(0);
  expect(await page.evaluate(() => (window as any).terminalFixture.fits)).toBe(
    0,
  );
  expect(
    await page.evaluate(() => (window as any).terminalFixture.state.isOpen),
  ).toBe(false);
  await root
    .getByRole("button", { name: "Show terminal", exact: true })
    .click();
  await expect(root.locator(".xterm")).toHaveCount(1);
  await root.getByRole("tab", { name: "project-49", exact: true }).click();
  await expect(root.locator(".xterm")).toHaveCount(2);
  await root
    .getByRole("tab", { name: "project-20", exact: true })
    .getByRole("button", { name: /^Close project-/ })
    .click();
  await expect(root.locator(".xterm")).toHaveCount(2);
  await root
    .getByRole("tab", { name: "project-49", exact: true })
    .getByRole("button", { name: /^Close project-/ })
    .click();
  await expect(root.locator(".terminal-tab.active")).toHaveAttribute(
    "aria-label",
    "project-48",
  );
  await expect(root.locator(".xterm")).toHaveCount(2);
  await page.evaluate(() => (window as any).terminalFixture.unmount());
  expect(errors).toEqual([]);
});

test("initialized terminal buffers, pending output, input and history survive tab switches and hide/show", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const root = await mount(page, 2);
  await expect(root.locator(".xterm")).toHaveCount(1);
  await page.evaluate(() => (window as any).terminalFixture.focus());
  await page.keyboard.type("echo controlled");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalFixture.calls))
    .toEqual([{ cwd: cwd(0), command: "echo controlled" }]);
  await root.getByRole("tab", { name: "project-1", exact: true }).click();
  await expect(root.locator(".xterm")).toHaveCount(2);
  await root
    .getByRole("button", { name: "Hide terminal", exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).terminalFixture.resetFits();
    (window as any).terminalFixture.complete(0);
  });
  await page.setViewportSize({ width: 1200, height: 850 });
  await settleFrames(page);
  expect(await page.evaluate(() => (window as any).terminalFixture.fits)).toBe(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (path) => (window as any).terminalFixture.text(path),
        cwd(0),
      ),
    )
    .toContain("Controlled output");
  await root
    .getByRole("button", { name: "Show terminal", exact: true })
    .click();
  await root.getByRole("tab", { name: "project-0", exact: true }).click();
  await page.evaluate(() => (window as any).terminalFixture.focus());
  await page.keyboard.type("draft-value");
  await root.getByRole("tab", { name: "project-1", exact: true }).click();
  await root.getByRole("tab", { name: "project-0", exact: true }).click();
  await page.evaluate(() => (window as any).terminalFixture.focus());
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).terminalFixture.calls[1]?.command),
    )
    .toBe("draft-value");
  await page.evaluate(() => (window as any).terminalFixture.complete(1));
  await expect
    .poll(() =>
      page.evaluate(
        (path) => (window as any).terminalFixture.text(path),
        cwd(0),
      ),
    )
    .toContain("draft-value");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).terminalFixture.calls[2]?.command),
    )
    .toBe("draft-value");
  await page.evaluate(() => (window as any).terminalFixture.complete(2));
  await expect(root.locator(".xterm")).toHaveCount(2);
  await page.evaluate(() => (window as any).terminalFixture.unmount());
  expect(errors).toEqual([]);
});

test("a burst of new terminal tabs fits the final selection once and teardown cancels queued work", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const root = await mount(page, 2);
  await expect(root.locator(".xterm")).toHaveCount(1);
  await settleFrames(page);
  await page.evaluate(async () => {
    (window as any).terminalFixture.resetFits();
    await (window as any).terminalFixture.addTabs();
  });
  await expect(root.locator(".xterm")).toHaveCount(2);
  await settleFrames(page);
  expect(await page.evaluate(() => (window as any).terminalFixture.fits)).toBe(
    1,
  );
  expect(
    await page.evaluate(() => {
      const layout = JSON.parse((window as any).terminalFixture.state.layout);
      return layout.tabs.find((tab: any) => tab.id === layout.active).root.cwd;
    }),
  ).toBe("C:\\fixture\\new-4");
  await page.evaluate(async () => {
    const fixture = (window as any).terminalFixture;
    const adding = fixture.addTabs();
    fixture.unmount();
    await adding;
  });
  await settleFrames(page);
  expect(await page.locator("#terminal-fixture").count()).toBe(0);
  expect(errors).toEqual([]);
});

test("Projects Hub uses live terminal tabs that reorder and dock without restarting their shells", async ({ page }) => {
  const root = await mount(page, 3);
  const first = root.getByRole("tab", { name: "project-0", exact: true });
  const second = root.getByRole("tab", { name: "project-1", exact: true });
  const third = root.getByRole("tab", { name: "project-2", exact: true });
  await second.click();
  const opened = await page.evaluate(() => (window as any).terminalFixture.opened.slice());
  const thirdBounds = (await third.boundingBox())!;
  await first.dragTo(third, { targetPosition: { x: thirdBounds.width - 27, y: 10 } });
  await expect(root.getByRole("tab").last()).toHaveAccessibleName("project-0");

  const pane = root.locator(".terminal-pane:visible");
  const paneBounds = (await pane.boundingBox())!;
  await first.dragTo(pane, { targetPosition: { x: paneBounds.width - 15, y: paneBounds.height / 2 } });
  await expect(root.getByRole("tab")).toHaveCount(2);
  await expect(root.locator(".terminal-split.row .terminal-pane")).toHaveCount(2);
  await expect(root.locator(".terminal-split.row .terminal-pane").last())
    .toHaveAttribute("data-terminal-pane", opened[0]);

  const moving = root.locator(`[data-drag-terminal-pane="${opened[0]}"]`);
  await moving.click();
  await expect(root.locator(".terminal-split.row .terminal-pane")).toHaveCount(2);
  const otherPane = root.locator(`[data-terminal-pane="${opened[1]}"]`);
  const otherBounds = (await otherPane.boundingBox())!;
  await moving.dragTo(otherPane, { targetPosition: { x: otherBounds.width / 2, y: 12 } });
  await expect(root.locator(".terminal-split.column .terminal-pane").first())
    .toHaveAttribute("data-terminal-pane", opened[0]);
  await page.keyboard.down("Shift");
  try {
    const source = root.locator(`[data-terminal-pane="${opened[0]}"]`);
    await source.hover();
    const bounds = (await otherPane.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 20, bounds.y + bounds.height / 2, { steps: 10 });
    await expect(otherPane.locator(".terminal-pane-drop.right")).toBeVisible();
    await page.mouse.up();
  } finally {
    await page.keyboard.up("Shift");
  }
  await expect(root.locator(".terminal-split.row .terminal-pane").last())
    .toHaveAttribute("data-terminal-pane", opened[0]);
  await root.locator(`[data-untile-terminal-pane="${opened[0]}"]`).click();
  await expect(root.getByRole("tab")).toHaveCount(3);
  await expect(root.locator(".terminal-pane:visible")).toHaveAttribute("data-terminal-pane", opened[0]);
  expect(await page.evaluate(() => (window as any).terminalFixture.opened)).toEqual(opened);
  expect(await page.evaluate(() => (window as any).terminalFixture.killed)).toEqual([]);
});

test("moving a split pane keeps its live terminal instead of replaying the shell", async ({ page }) => {
  const root = await mount(page, 1);
  const fixture = () => page.evaluate(() => {
    const f = (window as any).terminalFixture;
    return { xterms: f.xterms, attached: f.attached.slice(), opened: f.opened.slice() };
  });
  await root.getByRole("button", { name: "Split right", exact: true }).click();
  await root.locator(".terminal-pane:visible").last().click();
  await root.getByRole("button", { name: "Split down", exact: true }).click();
  const panes = root.locator(".terminal-pane:visible");
  await expect(panes).toHaveCount(3);
  const opened = (await fixture()).opened;
  expect(opened).toHaveLength(3);

  const [moved] = opened;
  const source = root.locator(`[data-terminal-pane="${moved}"]`);
  const target = root.locator(`[data-terminal-pane="${opened[2]}"]`);
  await page.keyboard.down("Shift");
  try {
    await source.hover();
    const bounds = (await target.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 20, bounds.y + bounds.height / 2, { steps: 10 });
    await page.mouse.up();
  } finally {
    await page.keyboard.up("Shift");
  }
  await expect.poll(async () => (await source.boundingBox())!.x - (await target.boundingBox())!.x).toBeGreaterThan(0);
  const after = await fixture();
  expect(after.attached).toEqual([]);
  expect(after.xterms).toBe(3);

  // Output still reaches the moved pane.
  await source.locator("textarea.xterm-helper-textarea").focus();
  await page.keyboard.insertText("after move");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).terminalFixture.calls.length)).toBe(1);
  await page.evaluate(() => (window as any).terminalFixture.complete(0, "moved output"));
  await expect(source.locator(".xterm-rows")).toContainText("moved output");
});

test("a shell exiting successfully keeps its split and can restart in place", async ({ page }) => {
  const root = await mountIsolated(page);
  await root.getByRole("button", { name: "Split right", exact: true }).click();
  const panes = root.locator(".terminal-pane:visible");
  await expect(panes).toHaveCount(2);
  const id = (await panes.last().getAttribute("data-terminal-pane"))!;
  await page.evaluate((paneId) => (window as any).terminalFixture.exit(paneId, 0), id);
  await expect(panes).toHaveCount(2);
  await expect(panes.last().locator(".xterm-rows")).toContainText("Press Enter to restart");
  await panes.last().locator(".xterm-helper-textarea").press("Enter");
  await expect.poll(() => page.evaluate((paneId) =>
    (window as any).terminalFixture.opened.filter((opened: string) => opened === paneId).length, id,
  )).toBe(2);
  await expect(panes).toHaveCount(2);
});

test("split panes only show a scrollbar when they have scrollback", async ({ page }) => {
  const root = await mount(page, 1);
  await root.getByRole("button", { name: "Split right", exact: true }).click();
  const panes = root.locator(".terminal-pane:visible");
  await expect(panes).toHaveCount(2);
  const left = panes.first();
  const right = panes.last();
  const scrollbar = (pane: typeof left) => pane.locator(".xterm-scrollable-element > .scrollbar.vertical");
  await expect(scrollbar(left)).toHaveCSS("display", "none");
  await right.hover();
  await page.mouse.wheel(0, -400);
  await expect(scrollbar(right)).toHaveCSS("display", "none");

  await right.locator("textarea.xterm-helper-textarea").focus();
  await page.keyboard.insertText("fixture command");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).terminalFixture.calls.length)).toBe(1);
  await page.evaluate(() => (window as any).terminalFixture.complete(
    0, Array.from({ length: 40 }, (_, i) => `history line ${i + 1}`).join("\r\n"),
  ));
  await expect(right.locator(".xterm-rows")).toContainText("history line 40");
  await expect(scrollbar(right)).not.toHaveCSS("display", "none");
  const paneId = await right.getAttribute("data-terminal-pane");
  const viewportY = () => page.evaluate((id) => (window as any).terminalFixture.viewportY(id), paneId);
  const bottom = await viewportY();
  expect(bottom).toBeGreaterThan(0);
  await right.locator(".xterm-screen").hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(viewportY).toBeLessThan(bottom);
  await expect(scrollbar(left)).toHaveCSS("display", "none");
});

test("terminal panes stay see-through so Orvane's frosted glass shows behind them", async ({ page }) => {
  const root = await mount(page, 1);
  const pane = root.locator(".terminal-pane:visible").first();
  await expect(pane.locator(".xterm-scrollable-element")).toHaveCount(1);
  for (const layer of [pane, pane.locator(".xterm-scrollable-element"), pane.locator(".xterm-viewport")])
    await expect(layer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

for (const direction of ["right", "down"] as const) {
  test(`terminal content stays inside its pane when a split shrinks ${direction === "right" ? "horizontally" : "vertically"}`, async ({ page }) => {
    test.setTimeout(90_000);
    const root = await mount(page, 1);
    await root.getByRole("button", { name: `Split ${direction}`, exact: true }).click();
    const firstPart = root.locator(".terminal-split-part").first();
    await expect(firstPart.locator(".xterm-screen")).toBeVisible();
    const result = await firstPart.evaluate((part, direction) => {
      const host = part.querySelector(".terminal-host")!;
      const screen = host.querySelector(".xterm-screen")!;
      const sibling = part.nextElementSibling!.nextElementSibling as HTMLElement;
      const basis = part.style.flexBasis;
      const siblingBasis = sibling.style.flexBasis;
      try {
        // Model one divider update and inspect it before the deferred xterm fit.
        part.style.flexBasis = "20%";
        sibling.style.flexBasis = "80%";
        const bounds = host.getBoundingClientRect();
        const grid = screen.getBoundingClientRect();
        const horizontal = direction === "right";
        const x = horizontal ? bounds.right + 2 : grid.left + 5;
        const y = horizontal ? grid.top + 5 : bounds.bottom + 2;
        return {
          gridExtendsPastPane: x < grid.right && y < grid.bottom,
          gridVisibleOutsidePane: document.elementsFromPoint(x, y).some(
            (element) => host.contains(element),
          ),
        };
      } finally {
        part.style.flexBasis = basis;
        sibling.style.flexBasis = siblingBasis;
      }
    }, direction);
    expect(result).toEqual({ gridExtendsPastPane: true, gridVisibleOutsidePane: false });
  });
}

test("shrinking and expanding a split preserves output on the cursor line", async ({ page }) => {
  test.setTimeout(120_000);
  const root = await mount(page, 1);
  await root.getByRole("button", { name: "Split right", exact: true }).click();
  const pane = root.locator(".terminal-pane").first();
  const screen = pane.locator(".xterm-screen");
  const width = () => screen.evaluate((element) => element.getBoundingClientRect().width);
  await expect(screen).toBeVisible();
  const divider = root.locator(".terminal-divider");
  async function moveDivider(delta: number) {
    const rect = (await divider.boundingBox())!;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y);
    await page.mouse.up();
  }
  const output = "begin-" + "1234567890".repeat(5) + "-end";
  await pane.locator(".terminal-host").evaluate(
    (host, text) => (window as any).terminalFixture.write(host, text),
    output,
  );
  await expect(pane.locator(".xterm-rows")).toContainText(output);
  const initialWidth = await width();
  await moveDivider(-450);
  await expect.poll(width).toBeLessThan(initialWidth / 2);
  await moveDivider(450);
  await expect.poll(width).toBeGreaterThan(initialWidth - 20);
  await expect(pane.locator(".xterm-rows > div").filter({ hasText: output })).toHaveCount(1);
});

test("horizontal PowerShell scroll moves output and keeps the input line in place", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/__orvane/terminal/profiles", (route) =>
    route.fulfill({
      json: { profiles: [{ id: "fixture", name: "PowerShell", kind: "powershell", source: "detected" }] },
    }),
  );
  const root = await mount(page, 1);
  await root.evaluate((element) => { element.style.width = "330px"; });
  const scroller = root.locator(".terminal-scroll.powershell");
  await expect(scroller).toBeVisible();
  const write = (text: string) => scroller.locator(".terminal-host").evaluate(
    (host, data) => (window as any).terminalFixture.write(host, data),
    text,
  );
  await write("Directory output".padEnd(55) + "file.txt\r\nPS C:\\fixture> ");
  const output = scroller.locator(".xterm-rows > div").filter({ hasText: "file.txt" });
  const prompt = scroller.locator(".xterm-rows > div").filter({ hasText: "PS C:" });
  await expect(output).toHaveCount(1);
  await expect(prompt.locator(".xterm-cursor")).toHaveCount(1);
  const left = (row: typeof prompt) => row.evaluate((element) => element.getBoundingClientRect().left);
  const outputLeft = await left(output);
  const promptLeft = await left(prompt);
  await scroller.evaluate((element) => { element.scrollLeft = 70; });
  await expect.poll(() => left(output)).toBeCloseTo(outputLeft - 70, 0);
  await expect.poll(() => left(prompt)).toBeCloseTo(promptLeft, 0);

  const draft = "x".repeat(45);
  await write(draft);
  await expect(prompt).toContainText(draft);
  await expect.poll(() => scroller.evaluate((element) => {
    const caret = element.querySelector(".xterm-cursor")!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return caret.left >= bounds.left && caret.right <= bounds.right + 1;
  })).toBe(true);
  await expect.poll(() => left(output)).toBeCloseTo(outputLeft - 70, 0);
});

test("releasing a split divider immediately fits both shells to the final size", async ({ page }) => {
  test.setTimeout(120_000);
  const root = await mount(page, 1);
  await root.getByRole("button", { name: "Split down", exact: true }).click();
  await expect(root.locator(".terminal-pane:visible")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => (window as any).terminalFixture.resizes.length)).toBeGreaterThanOrEqual(2);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const count = () => page.evaluate(() => (window as any).terminalFixture.resizes.length);
  const before = await count();
  const box = (await root.locator(".terminal-divider").boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 8 });
  expect(await count()).toBe(before);
  await page.mouse.up();
  expect(await count() - before).toBe(2);
});

test("terminal preserves ANSI colors and continuous backgrounds at fractional zoom", async ({ page }) => {
  const root = await mountIsolated(page);
  const host = root.locator(".terminal-host");
  await expect(host.locator(".xterm-rows")).toBeVisible();
  await host.evaluate(async (element) => {
    const fixture = (window as any).terminalFixture;
    const row = "\x1b[38;2;65;65;65;48;2;23;23;33mA" + " ".repeat(35) +
      "\x1b[48;2;42;42;54m" + " ".repeat(10) + "\x1b[0m";
    await fixture.write(element, Array.from({ length: 6 }, () => row).join("\r\n"));
    const fixtureRoot = element.closest<HTMLElement>("#terminal-fixture")!;
    fixtureRoot.style.transformOrigin = "top left";
  });
  const rows = host.locator(".xterm-rows > div");
  const output = rows.first().locator("span").filter({ hasText: "A" });
  await expect.soft(output).toHaveCSS("color", "rgb(65, 65, 65)");
  await expect.soft(output).toHaveCSS("background-color", "rgb(23, 23, 33)");
  for (const zoom of [0.83, 1.25]) {
    await page.locator("#terminal-fixture").evaluate((element, scale) => {
      element.style.transform = `translate(0.3px, 0.4px) scale(${scale})`;
    }, zoom);
    const first = (await rows.nth(1).boundingBox())!;
    const last = (await rows.nth(4).boundingBox())!;
    const top = Math.ceil(first.y + first.height / 2);
    const screenshot = await page.screenshot({
      clip: { x: Math.ceil(first.x + 25), y: top, width: 1, height: Math.floor(last.y + last.height / 2) - top },
    });
    const maxColorDelta = await page.evaluate(async (encoded) => {
      const img = new Image();
      img.src = "data:image/png;base64," + encoded;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      let maxDelta = 0;
      for (let i = 0; i < data.length; i += 4) {
        maxDelta = Math.max(maxDelta, Math.abs(data[i]! - 23), Math.abs(data[i + 1]! - 23), Math.abs(data[i + 2]! - 33));
      }
      return maxDelta;
    }, screenshot.toString("base64"));
    expect.soft(maxColorDelta, `row seams at ${zoom * 100}% zoom`).toBeLessThanOrEqual(2);
  }
});
