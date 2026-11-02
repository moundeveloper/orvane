import { test, expect } from "./fixtures";

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
  await root.getByRole("tab", { name: cwd(49), exact: true }).click();
  await expect(root.locator(".xterm")).toHaveCount(2);
  await root
    .getByRole("tab", { name: cwd(20), exact: true })
    .getByRole("button", { name: "Close terminal", exact: true })
    .click();
  await expect(root.locator(".xterm")).toHaveCount(2);
  await root
    .getByRole("tab", { name: cwd(49), exact: true })
    .getByRole("button", { name: "Close terminal", exact: true })
    .click();
  await expect(root.locator(".terminal-tab.active")).toHaveAttribute(
    "aria-label",
    cwd(48),
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
  await root.getByRole("tab", { name: cwd(1), exact: true }).click();
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
  await root.getByRole("tab", { name: cwd(0), exact: true }).click();
  await page.evaluate(() => (window as any).terminalFixture.focus());
  await page.keyboard.type("draft-value");
  await root.getByRole("tab", { name: cwd(1), exact: true }).click();
  await root.getByRole("tab", { name: cwd(0), exact: true }).click();
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
    await page.evaluate(() => (window as any).terminalFixture.state.activeCwd),
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
