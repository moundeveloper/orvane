import { test, expect, type Page } from "./fixtures";
test.setTimeout(60000); // The isolated Hub import includes the SuiteCloud views.

async function mount(page: Page, count = 1000, terminal = false) {
  await page.routeWebSocket(/\/__orvane\/terminal$/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.t === "open") socket.send(JSON.stringify({ t: "started", id: message.id, name: "Fixture shell" }));
      if (message.t === "in" && message.d === "\r") {
        socket.send(JSON.stringify({ t: "o", id: message.id, d: "Controlled fixture output\r\n" }));
      }
    });
  });
  const state = {
    longNames: false,
    removed: new Set<string>(),
    calls: [] as { op: string; args: any }[],
  };
  const name = (i: number) => `P${String(i).padStart(4, "0")}`;
  const projects = () =>
    Array.from({ length: count }, (_, i) => ({
      name: state.longNames
        ? `${"A long project folder name ".repeat(12)}${name(i)}`
        : name(i),
      path: `C:\\fixture\\${name(i)}`,
      modifiedAt: "2026-11-02T12:00:00Z",
    })).filter((project) => !state.removed.has(project.path));
  await page.route("**/__orvane/projects/**", async (route) => {
    const op = new URL(route.request().url()).pathname.split(
      "/__orvane/projects/",
    )[1]!;
    const args = route.request().postDataJSON() ?? {};
    state.calls.push({ op, args });
    let data: unknown;
    if (op === "workspace") {
      const rows = projects(),
        grouped = rows.filter((_, i) => i % 50 === 0);
      data = {
        rootPath: "C:\\fixture",
        projects: rows,
        groups: [
          {
            id: "g",
            name: "Selected group",
            projectPaths: grouped.map((p) => p.path),
            projects: grouped,
          },
        ],
        terminalState: {
          isOpen: terminal,
          height: 230,
          tabs: [{ title: "Terminal", cwd: "C:\\fixture" }],
        },
      };
    } else if (op === "terminal/state") data = { saved: true };
    else if (op === "open-code") data = { opened: true };
    else if (op === "suitecloud/inspect")
      data = { isSuiteCloud: false, files: [], accounts: [] };
    else throw Error(`Unexpected Projects fixture operation: ${op}`);
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/projects-windowing-harness.ts";
    (window as any).projectWindowFixture = (
      await import(module)
    ).mountProjectsWindowFixture();
  });
  const root = page.locator("#projects-window-fixture"),
    body = root.locator(".project-rows");
  await expect(body.locator(".project-row").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return {
    root,
    body,
    state,
    row: (i: number) =>
      body.locator(".project-row").filter({ hasText: name(i) }),
  };
}
test("Projects window preserves full-data ranges, filtering, grouping and actions", async ({
  page,
}) => {
  const { root, body, row, state } = await mount(page);
  await expect(body).toHaveAttribute("data-windowed", "true");
  expect(await body.locator(".project-row").count()).toBeLessThan(50);
  expect(await body.evaluate((el) => el.scrollHeight)).toBe(40000);
  await row(0).locator("input").check();
  await body.evaluate((el) => (el.scrollTop = 4000));
  await row(100)
    .locator("input")
    .click({ modifiers: ["Shift"] });
  await expect(root.locator(".selection-count")).toHaveText("101 selected");
  await root.getByLabel("Select visible projects").locator("input").check();
  await expect(root.locator(".selection-count")).toHaveText("1000 selected");
  await root.getByPlaceholder("Filter projects...").fill("P0999");
  await expect(body.locator(".project-row")).toHaveCount(1);
  await expect(row(999).locator("input")).toBeChecked();
  await row(999).locator(".project-name").dblclick();
  await expect
    .poll(() =>
      state.calls.some(
        (c) => c.op === "open-code" && c.args.path.endsWith("P0999"),
      ),
    )
    .toBe(true);
  await row(999).click({ button: "right" });
  await expect(root.locator(".project-context-menu")).toBeVisible();
  await root.locator(".context-backdrop").click({ position: { x: 2, y: 2 } });
  await root.getByPlaceholder("Filter projects...").fill("");
  await root
    .locator(".group-item")
    .filter({ hasText: "Selected group" })
    .click();
  await expect(body.locator(".project-row")).toHaveCount(20);
  await root.getByRole("button", { name: "All projects", exact: true }).click();
  await expect(body).toHaveAttribute("data-windowed", "true");
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
});
test("Projects Tab traversal reaches unmounted rows and pins focused controls", async ({
  page,
}) => {
  const { root, body, row } = await mount(page, 100);
  await expect(body).toHaveAttribute("data-windowed", "true");
  await root.getByLabel("Select visible projects").locator("input").focus();
  await page.keyboard.press("Tab");
  await expect(row(0)).toBeFocused();
  for (let i = 0; i < 64; i++) await page.keyboard.press("Tab");
  await expect(row(16)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    row(15).getByRole("button", { name: "Delete project", exact: true }),
  ).toBeFocused();
  await row(16).focus();
  await body.evaluate((el) => (el.scrollTop = 3900));
  await expect(row(16)).toBeFocused();
  await expect(row(99)).toHaveCount(1);
  await root.getByLabel("Select visible projects").locator("input").focus();
  await page.keyboard.press("Tab");
  await expect(row(0)).toBeFocused();
  await body.evaluate((el) => {
    const after = document.createElement("button");
    after.id = "after-project-rows";
    after.textContent = "After rows";
    after.style.position = "absolute";
    el.after(after);
    after.focus({ preventScroll: true });
  });
  await page.keyboard.press("Shift+Tab");
  await expect(
    row(99).getByRole("button", { name: "Delete project", exact: true }),
  ).toBeFocused();
});
test("Projects uses logical row dimensions through zoom, resize, wrapped names and hidden panels", async ({
  page,
}) => {
  const { root, body, row, state } = await mount(page, 100, true);
  await expect(body).toHaveAttribute("data-windowed", "true");
  await body.evaluate((el) => (el.scrollTop = 2000));
  for (const scale of [0.2, 0.6, 1.4, 1]) {
    await page.evaluate(
      (s) => (window as any).projectWindowFixture.scale(s),
      scale,
    );
    expect(await body.evaluate((el) => el.scrollHeight)).toBe(4000);
  }
  await page.evaluate(() =>
    (window as any).projectWindowFixture.resize(900, 700),
  );
  await expect
    .poll(() => body.evaluate((el) => el.scrollTop))
    .toBeCloseTo(2000, 0);
  state.longNames = true;
  await root
    .getByRole("button", { name: "Refresh", exact: true })
    .last()
    .click();
  await expect(body).toHaveAttribute("data-windowed", "false");
  await expect(body.locator(".project-row")).toHaveCount(100);
  expect(await body.evaluate((el) => el.scrollHeight)).toBeGreaterThan(4000);
  await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(row(99)).toBeVisible();
  state.longNames = false;
  await root
    .getByRole("button", { name: "Refresh", exact: true })
    .last()
    .click();
  await expect(body).toHaveAttribute("data-windowed", "true");
  await expect(row(99)).toBeVisible();
  await root.locator(".terminal-host:visible textarea").focus();
  await page.keyboard.insertText("fixture-output");
  await page.keyboard.press("Enter");
  await expect(
    root
      .locator(".terminal-host")
      .filter({ hasText: "Controlled fixture output" })
      .first(),
  ).toBeVisible();
  await root
    .getByRole("button", { name: "Hide terminal", exact: true })
    .click();
  await expect(row(99)).toBeVisible();
  await root
    .getByRole("button", { name: "Show terminal", exact: true })
    .click();
  await expect(
    root
      .locator(".terminal-host")
      .filter({ hasText: "Controlled fixture output" })
      .first(),
  ).toBeVisible();
  await root.evaluate((el) => (el.style.display = "none"));
  await root.evaluate((el) => (el.style.display = "flex"));
  await expect(row(99)).toBeVisible();
  await root.getByPlaceholder("Filter projects...").fill("not-found-anywhere");
  await expect(body.locator(".empty-state")).toBeVisible();
});
for (const count of [50, 51])
  test(`Projects row window boundary ${count}`, async ({ page }) => {
    const { body } = await mount(page, count);
    await expect(body).toHaveAttribute("data-windowed", String(count > 50));
    if (count === 50)
      await expect(body.locator(".project-row")).toHaveCount(50);
    if (count > 50)
      expect(await body.locator(".project-row").count()).toBeLessThan(50);
    expect(await body.evaluate((el) => el.scrollHeight)).toBe(count * 40);
  });

test("Projects refresh keeps the next logical row when its scroll anchor is removed", async ({
  page,
}) => {
  const { root, body, state } = await mount(page, 100);
  await expect(body).toHaveAttribute("data-windowed", "true");
  await body.evaluate((el) => (el.scrollTop = 2000));
  state.removed.add("C:\\fixture\\P0050");
  await root
    .getByRole("button", { name: "Refresh", exact: true })
    .last()
    .click();
  await expect
    .poll(() =>
      body.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        return [...el.querySelectorAll<HTMLElement>(".project-row")]
          .find((row) => row.getBoundingClientRect().bottom > top + 1)
          ?.querySelector(".project-name")
          ?.textContent?.trim();
      }),
    )
    .toBe("P0051");
});

test("Projects row observers are disconnected when the view closes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Native = ResizeObserver;
    const active = new Set<ResizeObserver>();
    (window as any).projectRowObservers = active;
    window.ResizeObserver = class extends Native {
      observe(target: Element, options?: ResizeObserverOptions) {
        if (target.closest("#projects-window-fixture")) active.add(this);
        super.observe(target, options);
      }
      disconnect() {
        active.delete(this);
        super.disconnect();
      }
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { body } = await mount(page, 100);
  await expect(body).toHaveAttribute("data-windowed", "true");
  expect(
    await page.evaluate(() => (window as any).projectRowObservers.size),
  ).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).projectWindowFixture.unmount());
  expect(
    await page.evaluate(() => (window as any).projectRowObservers.size),
  ).toBe(0);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);
  expect(errors).toEqual([]);
});

test("Projects wrapped-list refresh preserves an anchor when an earlier row is removed", async ({
  page,
}) => {
  const { root, body, row, state } = await mount(page, 100);
  state.longNames = true;
  await root
    .getByRole("button", { name: "Refresh", exact: true })
    .last()
    .click();
  await expect(body).toHaveAttribute("data-windowed", "false");
  await expect(body.locator(".project-row")).toHaveCount(100);
  await row(50).evaluate((el) => {
    const parent = el.parentElement!;
    parent.scrollTop =
      (el as HTMLElement).offsetTop -
      (parent.querySelector(".project-row") as HTMLElement).offsetTop;
  });
  const first = () =>
    body.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      return [...el.querySelectorAll<HTMLElement>(".project-row")].find(
        (row) => row.getBoundingClientRect().bottom > top + 1,
      )?.dataset.projectKey;
    });
  await expect.poll(first).toBe("C:\\fixture\\P0050");
  state.removed.add("C:\\fixture\\P0010");
  await root
    .getByRole("button", { name: "Refresh", exact: true })
    .last()
    .click();
  await expect.poll(first).toBe("C:\\fixture\\P0050");
});

test("Projects preserves native horizontal keyboard scrolling in a narrow app", async ({
  page,
}) => {
  const { body, row } = await mount(page, 100);
  await expect(body).toHaveAttribute("data-windowed", "true");
  await page.evaluate(() => (window as any).projectWindowFixture.resize(500));
  await expect(body).toHaveAttribute("data-windowed", "false");
  await expect(body.locator(".project-row")).toHaveCount(100);
  expect(await body.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  await row(99)
    .getByRole("button", { name: "Delete project", exact: true })
    .focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    row(99).getByRole("button", { name: "Open in VS Code", exact: true }),
  ).toBeFocused();
  expect(
    await body.evaluate((el) => {
      const focus = document.activeElement!.getBoundingClientRect(),
        bounds = el.getBoundingClientRect();
      return (
        focus.left >= bounds.left - 1 &&
        focus.right <= bounds.left + el.clientWidth + 1
      );
    }),
  ).toBe(true);
  await page.evaluate(() => (window as any).projectWindowFixture.resize(1200));
  await expect(body).toHaveAttribute("data-windowed", "true");
  await expect(row(99)).toBeVisible();
});
