import { test, expect } from "./fixtures";

test("new components and nodes reveal once; restoring an app has a brief arrival", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  const app = page.locator(".canvas-app").last();
  await app.getByRole("button", { name: "Build app", exact: true }).click();
  await app
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("Motion workbench");
  await app.getByRole("button", { name: "Add your first component" }).click();
  await app.getByRole("button", { name: "Button", exact: true }).click();
  const calls = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            motionCalls: {
              target: string;
              duration: number;
              frames: Keyframe[];
            }[];
          }
        ).motionCalls,
    );
  expect(
    (await calls()).some(
      (c) =>
        c.target.includes("block-button") &&
        c.duration === 130 &&
        c.frames[0]?.transform === "none",
    ),
  ).toBe(true);
  await app
    .getByRole("button", { name: "Expand to graph", exact: true })
    .click();
  await app.getByRole("button", { name: "Add node", exact: true }).click();
  await app
    .getByRole("button", { name: "Increase counter", exact: true })
    .click();
  await expect(app.locator(".action-node")).toHaveCount(1);
  const nodeCalls = (await calls()).filter(
    (c) => c.target === "flow-node action-node",
  );
  expect(nodeCalls).toHaveLength(1);
  expect(nodeCalls[0]?.frames[0]?.transform).toBe("none");
  await app.getByRole("button", { name: "Layout", exact: true }).click();
  await app.getByRole("button", { name: "Done", exact: true }).click();
  await app
    .getByRole("button", { name: "Options for Motion workbench" })
    .click();
  await app.getByRole("button", { name: "Archive app", exact: true }).click();
  await page.getByRole("button", { name: "Archive app", exact: true }).click();
  const arrivalsBefore = (await calls()).filter(
    (c) => c.target === "app-surface",
  ).length;
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Motion workbench", exact: true }),
  ).toBeVisible();
  expect(
    (await calls()).filter((c) => c.target === "app-surface"),
  ).toHaveLength(arrivalsBefore + 1);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { target: string; frames: Keyframe[]; duration: number }[] =
      [];
    (window as unknown as { motionCalls: typeof calls }).motionCalls = calls;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (
      frames: Keyframe[] | PropertyIndexedKeyframes | null,
      options?: number | KeyframeAnimationOptions,
    ) {
      calls.push({
        target: (this as HTMLElement).className || this.tagName,
        frames: frames as Keyframe[],
        duration:
          typeof options === "object"
            ? Number(options.duration)
            : Number(options),
      });
      return animate.call(this, frames, options);
    };
  });
});

test("rows and values animate while checkbox changes have no background flash", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "New task", exact: true })
    .fill("A small, visible change");
  await page
    .getByRole("button", { name: "Add to the list", exact: true })
    .click();
  await expect(
    page.locator(".list-item").filter({ hasText: "A small, visible change" }),
  ).toBeVisible();
  let calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          motionCalls: {
            target: string;
            frames: Keyframe[];
            duration: number;
          }[];
        }
      ).motionCalls,
  );
  expect(
    calls.some(
      (c) =>
        c.target === "list-item" &&
        c.frames[0]?.transform === "translateY(3px)" &&
        c.duration === 160,
    ),
  ).toBe(true);
  expect(calls.some((c) => c.target === "OUTPUT" && c.duration === 130)).toBe(
    true,
  );
  await expect(
    page.locator(".runtime-counter").first().locator("output"),
  ).toHaveText("1");
  await page
    .locator(".list-item")
    .filter({ hasText: "A small, visible change" })
    .getByRole("checkbox")
    .check();
  calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          motionCalls: {
            target: string;
            frames: Keyframe[];
            duration: number;
          }[];
        }
      ).motionCalls,
  );
  expect(
    calls.some(
      (c) => c.frames[0]?.backgroundColor === "#e0ebf2" && c.duration === 180,
    ),
  ).toBe(false);
  await page
    .locator(".list-item")
    .filter({ hasText: "A small, visible change" })
    .getByRole("button", { name: "Remove item" })
    .click();
  await expect(
    page.locator(".list-item").filter({ hasText: "A small, visible change" }),
  ).toHaveCount(0);
});

test("builder and popovers animate in the live interface; exits do not linger", async ({
  page,
}) => {
  await page.goto("/");
  const app = page.getByRole("region", { name: "Daily list", exact: true });
  await app.getByRole("button", { name: "Build app", exact: true }).click();
  let calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          motionCalls: { target: string; duration: number }[];
        }
      ).motionCalls,
  );
  expect(calls.some((c) => c.target === "editor" && c.duration === 180)).toBe(
    true,
  );
  await app.getByRole("button", { name: "Style", exact: true }).click();
  await app
    .getByRole("combobox", { name: "Dock icon", exact: false })
    .click()
    .catch(async () => {
      await app.locator(".select-trigger").first().click();
    });
  await expect(page.getByRole("listbox")).toBeVisible();
  calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          motionCalls: { target: string; duration: number }[];
        }
      ).motionCalls,
  );
  expect(
    calls.some((c) => c.target === "select-popover" && c.duration === 160),
  ).toBe(true);
  await page.mouse.click(20, 60);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("button", { name: "App groups", exact: true }).click();
  calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          motionCalls: { target: string; duration: number }[];
        }
      ).motionCalls,
  );
  expect(
    calls.some(
      (c) => c.target === "groups-panel floating-panel" && c.duration === 160,
    ),
  ).toBe(true);
  await page.mouse.click(20, 60);
  await expect(page.locator(".groups-panel")).toHaveCount(0);
});

test("rapid counter changes retarget the running fade without stacking or resetting its opacity", async ({
  page,
}) => {
  await page.goto("/");
  const counter = page.locator(".runtime-counter").first();
  const state = await counter.evaluate(async (el) => {
    const button = el.querySelectorAll("button")[1]!,
      output = el.querySelector("output")!;
    button.click();
    await new Promise(requestAnimationFrame);
    await new Promise((resolve) => setTimeout(resolve, 35));
    const before = Number(getComputedStyle(output).opacity);
    button.click();
    await new Promise(requestAnimationFrame);
    const animations = output.getAnimations();
    return {
      before,
      start: Number(
        animations[0]?.effect instanceof KeyframeEffect
          ? animations[0].effect.getKeyframes()[0]?.opacity
          : 1,
      ),
      running: animations.filter((a) => a.playState === "running").length,
      value: output.textContent,
      width: output.offsetWidth,
    };
  });
  expect(state.value).toBe("2");
  expect(state.running).toBe(1);
  expect(state.start).toBeGreaterThanOrEqual(state.before - 0.01);
  await expect(counter.locator("output")).toHaveCSS("opacity", "1");
  expect(
    await counter
      .locator("output")
      .evaluate((el) => (el as HTMLElement).offsetWidth),
  ).toBe(state.width);
});

test("reduced motion keeps updates instant and skips decorative animations", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "New task", exact: true })
    .fill("No movement needed");
  await page
    .getByRole("button", { name: "Add to the list", exact: true })
    .click();
  await page.getByRole("button", { name: "App groups", exact: true }).click();
  await expect(page.locator(".groups-panel")).toBeVisible();
  const calls = await page.evaluate(
    () => (window as unknown as { motionCalls: unknown[] }).motionCalls,
  );
  expect(calls).toHaveLength(0);
  await expect(
    page.locator(".list-item").filter({ hasText: "No movement needed" }),
  ).toBeVisible();
});

test("newly created apps have an arrival animation without changing their dimensions", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  const app = page.locator(".canvas-app").last().locator(".app-surface");
  await expect(app).toBeVisible();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          motionCalls: { target: string; duration: number }[];
        }
      ).motionCalls,
  );
  expect(
    calls.some((c) => c.target === "app-surface" && c.duration === 170),
  ).toBe(true);
  const before = await app.evaluate((el) => ({
    w: (el as HTMLElement).offsetWidth,
    h: (el as HTMLElement).offsetHeight,
  }));
  await expect(app).toHaveCSS("transform", "none");
  expect(
    await app.evaluate((el) => ({
      w: (el as HTMLElement).offsetWidth,
      h: (el as HTMLElement).offsetHeight,
    })),
  ).toEqual(before);
});
