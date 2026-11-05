import { test, expect } from "./fixtures";

test("arrow navigation keeps Notes blocks visible inside a scaled pane", async ({
  page,
}, info) => {
  const timestamp = "2026-11-05";
  await page.route("**/__orvane/notes/data", async (route) => {
    const p = route.request().postDataJSON();
    await route.fulfill({
      json:
        p.action !== "list"
          ? {}
          : p.collection === "pages"
            ? [
                {
                  id: "a",
                  title: "Keyboard navigation",
                  type: "page",
                  parentId: null,
                  position: 0,
                  trashedAt: null,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ]
            : Array.from({ length: 60 }, (_, position) => ({
                id: `line-${position}`,
                pageId: "a",
                type: "paragraph",
                html: position === 59 ? "" : `Line ${position}`,
                indent: 0,
                position,
                createdAt: timestamp,
                updatedAt: timestamp,
              })),
    });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/notes-loading-harness.ts";
    (window as any).notesLoadingFixture = (
      await import(module)
    ).mountNotesLoadingFixture();
    document.getElementById("notes-loading-fixture")!.style.cssText =
      "position:fixed;left:80px;top:80px;width:1000px;height:600px;transform:scale(.75);transform-origin:top left;z-index:99999;background:white";
  });
  const root = page.locator("#notes-loading-fixture");
  const blocks = root.locator(".block-content");
  await expect(blocks).toHaveCount(60);
  await blocks.first().click();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await expect(blocks.nth(i + 1)).toBeFocused();
  }
  const caretIsVisible = () =>
    root.locator(".notes-page-scroll").evaluate((viewport) => {
      const bounds = viewport.getBoundingClientRect();
      const top = viewport.querySelector(".crumbs")!.getBoundingClientRect().bottom;
      const caret = window
        .getSelection()
        ?.getRangeAt(0)
        .getBoundingClientRect();
      return (
        !!caret && caret.top >= top && caret.bottom <= bounds.bottom
      );
    });
  await expect.poll(caretIsVisible).toBe(true);
  expect(
    await root.locator(".notes-page-scroll").evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0);
  for (let i = 40; i > 0; i--) {
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect(blocks.nth(i - 1)).toBeFocused();
  }
  await expect.poll(caretIsVisible).toBe(true);
  await root.screenshot({ path: info.outputPath("notes-keyboard.png") });
  await page.evaluate(() => (window as any).notesLoadingFixture.unmount());
});

test("initial and switched Notes documents wait for their own data before creating editable blocks", async ({
  page,
}) => {
  const timestamp = "2026-11-02";
  const pages = ["a", "b", "empty"].map((id, position) => ({
    id,
    position,
    parentId: null,
    title: `Page ${id}`,
    type: "page",
    icon: null,
    isFavorite: false,
    trashedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const blocks = new Map(
    ["a", "b", "empty"].map((id) => [
      id,
      id === "empty"
        ? []
        : [
            {
              id: `body-${id}`,
              pageId: id,
              type: "paragraph",
              html: `Saved ${id}`,
              indent: 0,
              position: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              id: `tail-${id}`,
              pageId: id,
              type: "paragraph",
              html: "",
              indent: 0,
              position: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
    ]),
  );
  const held = new Map<string, () => void>();
  const writes: string[] = [];
  await page.route("**/__orvane/notes/data", async (route) => {
    const p = route.request().postDataJSON();
    if (p.action === "list" && p.collection === "blocks") {
      await new Promise<void>((resolve) => held.set(p.pageId, resolve));
      await route.fulfill({ json: blocks.get(p.pageId) || [] });
      return;
    }
    if (p.collection === "blocks") {
      writes.push(p.pageId || p.rows?.[0]?.pageId);
      if (p.action === "replaceBlocks") blocks.set(p.pageId, p.rows);
    }
    await route.fulfill({
      json: p.action === "list" ? pages : p.action === "get" ? null : {},
    });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/notes-loading-harness.ts";
    (window as any).notesLoadingFixture = (
      await import(module)
    ).mountNotesLoadingFixture();
  });
  const root = page.locator("#notes-loading-fixture");
  await expect(root.getByRole("status")).toHaveText("Loading page…");
  await expect(root.locator(".block-content")).toHaveCount(0);
  await expect.poll(() => held.has("a")).toBe(true);
  expect(writes).toEqual([]);
  held.get("a")!();
  await expect(root.locator(".block-content").first()).toHaveText("Saved a");
  await root.locator('.sb-scroll .pt-title[aria-label="Page b"]').click();
  await expect(root.getByRole("status")).toHaveText("Loading page…");
  await expect.poll(() => held.has("b")).toBe(true);
  expect(writes).toEqual([]);
  await root.locator('.sb-scroll .pt-title[aria-label="Page empty"]').click();
  await expect.poll(() => held.has("empty")).toBe(true);
  held.get("b")!(); // Superseded response must not mount or initialize B.
  await expect(root.getByRole("status")).toHaveText("Loading page…");
  await expect(root.locator(".block-content")).toHaveCount(0);
  expect(writes).toEqual([]);
  await root.screenshot({
    path: "artifacts/performance/notes-document-loading.png",
  });
  held.get("empty")!();
  await expect(root.locator(".block-content")).toHaveCount(1);
  await expect.poll(() => writes.includes("empty")).toBe(true);
  expect(writes.every((id) => id === "empty")).toBe(true);
  expect(blocks.get("a")![0]!.html).toBe("Saved a");
  expect(blocks.get("b")![0]!.html).toBe("Saved b");
  held.delete("b");
  await root.locator('.sb-scroll .pt-title[aria-label="Page b"]').click();
  await expect(root.getByRole("status")).toHaveText("Loading page…");
  await expect.poll(() => held.has("b")).toBe(true);
  held.get("b")!();
  await expect(root.locator(".block-content").first()).toHaveText("Saved b");
  await page.evaluate(() => (window as any).notesLoadingFixture.unmount());
});

test("failed Notes reads preserve saved content and can be retried", async ({
  page,
}) => {
  let failed = false,
    writes = 0;
  await page.route("**/__orvane/notes/data", async (route) => {
    const p = route.request().postDataJSON();
    if (p.collection === "blocks" && p.action === "list") {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 500,
          json: { error: "Fixture read failed" },
        });
        return;
      }
      await route.fulfill({
        json: [
          {
            id: "saved",
            pageId: "a",
            html: "Saved content",
            type: "paragraph",
            position: 0,
            indent: 0,
          },
          {
            id: "tail",
            pageId: "a",
            html: "",
            type: "paragraph",
            position: 1,
            indent: 0,
          },
        ],
      });
      return;
    }
    if (p.collection === "blocks") writes++;
    await route.fulfill({
      json:
        p.action === "list"
          ? [
              {
                id: "a",
                parentId: null,
                position: 0,
                title: "Page a",
                type: "page",
                trashedAt: null,
              },
            ]
          : p.action === "get"
            ? null
            : {},
    });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/tests/notes-loading-harness.ts";
    (window as any).notesLoadingFixture = (
      await import(module)
    ).mountNotesLoadingFixture();
  });
  const root = page.locator("#notes-loading-fixture");
  await expect(
    root.getByRole("button", { name: "Retry loading page", exact: true }),
  ).toBeVisible();
  await expect(root.locator(".block-content")).toHaveCount(0);
  expect(writes).toBe(0);
  await root
    .getByRole("button", { name: "Retry loading page", exact: true })
    .click();
  await expect(root.locator(".block-content").first()).toHaveText(
    "Saved content",
  );
  expect(writes).toBe(0);
  await page.evaluate(() => (window as any).notesLoadingFixture.unmount());
});
