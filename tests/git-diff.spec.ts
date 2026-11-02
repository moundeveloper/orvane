import { test, expect } from "./fixtures";
async function mount(page: import("@playwright/test").Page, wide = false) {
  await page.goto("/");
  const text = await page.evaluate(async (wide) => {
    const module = "/tests/git-diff-harness.ts";
    const fixture = (await import(module)).mountGitDiffFixture(wide);
    (window as any).diffFixture = fixture;
    return fixture.text;
  }, wide);
  const root = page.locator("#git-diff-fixture");
  await expect(root.locator(".cm-line").first()).toBeVisible();
  return { root, text };
}

test("large diffs keep colors, full-document selection and copy while remaining read-only", async ({
  page,
}) => {
  const { root, text } = await mount(page);
  await expect(root.locator(".cm-line.added").first()).toHaveCSS(
    "background-color",
    "rgb(230, 240, 233)",
  );
  await expect(root.locator(".cm-line.removed").first()).toHaveCSS(
    "background-color",
    "rgb(245, 232, 229)",
  );
  await expect(root.locator(".cm-line.hunk").first()).toHaveCSS(
    "background-color",
    "rgb(233, 240, 245)",
  );
  expect(await root.locator(".cm-line").count()).toBeLessThan(200);
  const content = root.getByRole("textbox", {
    name: "Git diff text",
    exact: true,
  });
  await expect(content).toHaveAttribute("aria-readonly", "true");
  await content.focus();
  await page.keyboard.press("Control+a");
  expect(
    await page.evaluate(() => (window as any).diffFixture.selection),
  ).toEqual({ from: 0, to: text.length });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  await page.keyboard.type("must not edit");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+v");
  expect(await page.evaluate(() => (window as any).diffFixture.displayed)).toBe(
    text,
  );
  await page.evaluate(() => (window as any).diffFixture.unmount());
});

test("diff search and keyboard navigation reach unmounted lines and keep rendering bounded", async ({
  page,
}) => {
  const { root } = await mount(page);
  const content = root.getByRole("textbox", {
    name: "Git diff text",
    exact: true,
  });
  expect(
    await root.locator(".cm-line").filter({ hasText: "FINAL_MATCH" }).count(),
  ).toBe(0);
  await content.focus();
  await page.keyboard.press("Control+f");
  const find = root.getByRole("textbox", { name: "Find", exact: true });
  await expect(find).toBeVisible();
  expect(
    await root.getByRole("textbox", { name: "Replace", exact: true }).count(),
  ).toBe(0);
  await find.pressSequentially("FINAL_MATCH");
  await find.press("Enter");
  await expect(
    root.locator(".cm-line").filter({ hasText: "FINAL_MATCH" }),
  ).toBeInViewport();
  expect(await root.locator(".cm-line").count()).toBeLessThan(200);
  await find.press("Escape");
  await content.focus();
  await page.keyboard.press("Control+Home");
  await expect(root.locator(".cm-line").first()).toHaveText(
    "diff --git a/fixture.txt b/fixture.txt",
  );
  await expect(root.locator(".cm-line.hunk").first()).toHaveCSS(
    "color",
    "rgb(77, 112, 138)",
  );
  await page.keyboard.press("Control+End");
  await expect(
    root.locator(".cm-line").filter({ hasText: "FINAL_MATCH" }),
  ).toBeInViewport();
  await page.evaluate(() => (window as any).diffFixture.unmount());
});

test("wide patches scroll inside the diff and survive zoom, hidden views and replacement", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { root } = await mount(page, true);
  const viewport = root.getByLabel("Git diff", { exact: true });
  expect(
    await viewport.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeGreaterThan(1000);
  expect(
    await root.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await viewport.evaluate(
    (element) => (element.scrollLeft = element.scrollWidth),
  );
  await expect(
    root.locator(".cm-line").filter({ hasText: "WIDE_END" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).diffFixture.resize());
  await page.evaluate(() => (window as any).diffFixture.hide(true));
  await expect(root).toBeHidden();
  await page.evaluate(() => (window as any).diffFixture.hide(false));
  await expect(root).toBeVisible();
  await page.evaluate(async () => {
    await (window as any).diffFixture.replace(
      "diff --git a/new b/new\n+REPLACED",
    );
  });
  await expect(root.locator(".cm-line.added")).toHaveText("+REPLACED");
  expect(
    await viewport.evaluate((element) => ({
      top: element.scrollTop,
      left: element.scrollLeft,
    })),
  ).toEqual({ top: 0, left: 0 });
  await page.evaluate(async () => {
    const fixture = (window as any).diffFixture;
    const changing = fixture.replace("+LAST");
    fixture.unmount();
    await changing;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(errors).toEqual([]);
});

test("small Git patches retain the native preformatted renderer", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/large-lists-harness.ts";
    (window as any).largeList = (await import(module)).mountLargeListFixture(
      "git",
      100,
    );
  });
  const root = page.locator("#large-list-fixture");
  await root.locator(".git-commit-row").click();
  await expect(root.locator("pre.git-patch > span")).toHaveCount(104);
  await expect(root.locator(".cm-editor")).toHaveCount(0);
  await page.evaluate(() => (window as any).largeList.unmount());
});

test("the Git viewer switches renderers at 500 lines and handles a very large single line", async ({
  page,
}) => {
  await page.goto("/");
  for (const count of [496, 497]) {
    await page.evaluate(async (count) => {
      const module = "/tests/large-lists-harness.ts";
      (window as any).largeList = (await import(module)).mountLargeListFixture(
        "git",
        count,
      );
    }, count);
    const root = page.locator("#large-list-fixture");
    await root.locator(".git-commit-row").click();
    if (count === 496)
      await expect(root.locator("pre.git-patch > span")).toHaveCount(500);
    else {
      await expect(root.locator(".cm-line").first()).toBeVisible();
      expect(await root.locator(".cm-line").count()).toBeLessThan(200);
    }
    await page.evaluate(() => (window as any).largeList.unmount());
  }
  await page.evaluate(async () => {
    const module = "/tests/large-lists-harness.ts";
    (window as any).largeList = (await import(module)).mountLargeListFixture(
      "git",
      1,
      "+" + "x".repeat(310000),
    );
  });
  const root = page.locator("#large-list-fixture");
  await root.locator(".git-commit-row").click();
  await expect(root.locator(".cm-line").first()).toBeVisible();
  await expect(root.locator("pre.git-patch")).toHaveCount(0);
  await page.evaluate(() => (window as any).largeList.unmount());
});
