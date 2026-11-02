import { test, expect } from "./fixtures";

test("restored File Cabinet loads both visible splits and defers hidden files; pointer resize commits once", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/tests/performance-harness.ts";
    const { mountPerformanceFixture } = await import(path);
    (window as any).performanceFixture = mountPerformanceFixture("cabinet");
  });
  const root = page.locator("#performance-fixture");
  await expect(root.locator(".fc-pane")).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).performanceFixture.calls
          .filter((x: any) => x.op === "file")
          .map((x: any) => x.args.id)
          .sort(),
      ),
    )
    .toEqual([10, 11]);
  await page.evaluate(() => (window as any).performanceFixture.resetWrites());
  const handle = root.getByRole("separator", { name: "Resize split" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 50, { steps: 20 });
  expect(
    await page.evaluate(() => (window as any).performanceFixture.writes),
  ).toBe(0);
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => (window as any).performanceFixture.writes))
    .toBe(1);
  for (const end of ["pointercancel", "blur"]) {
    await page.evaluate(() => (window as any).performanceFixture.resetWrites());
    const bounds = (await handle.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 50);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 20, bounds.y + 50, { steps: 5 });
    expect(await page.evaluate(() => (window as any).performanceFixture.writes)).toBe(0);
    await page.evaluate(event => window.dispatchEvent(new Event(event)), end);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).performanceFixture.writes)).toBe(1);
  }
  await root.getByRole("tab", { name: "c.js" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).performanceFixture.calls
          .filter((x: any) => x.op === "file")
          .map((x: any) => x.args.id)
          .sort(),
      ),
    )
    .toEqual([10, 11, 12]);
  await page.evaluate(() => (window as any).performanceFixture.unmount());
});

test("NetSuite restores visible views first and retains an initialized editor when switching tabs", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/tests/performance-harness.ts";
    const { mountPerformanceFixture } = await import(path);
    (window as any).performanceFixture = mountPerformanceFixture("netsuite");
  });
  const root = page.locator("#performance-fixture");
  await expect(root.locator(".fc-workspace")).toHaveCount(1);
  await expect(root.locator(".ns-query-view")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).performanceFixture.calls.some(
          (x: any) => x.op === "scripts",
        ),
      ),
    )
    .toBe(true);
  await root.getByRole("tab", { name: "SuiteQL", exact: true }).click();
  await expect(root.locator(".cm-editor")).not.toHaveCount(0);
  const editorCount = await root.locator(".cm-editor").count();
  await root.getByRole("tab", { name: "Scripts", exact: true }).click();
  await expect(root.locator(".cm-editor")).toHaveCount(editorCount);
  await page.evaluate(() => (window as any).performanceFixture.unmount());
});

test("Notes shares committed edits while preserving per-view undo and durable close/reopen state", async ({
  page,
}) => {
  const timestamp = new Date().toISOString();
  let metadata = [
    {
      id: "shared",
      parentId: null,
      type: "page",
      title: "Shared",
      icon: null,
      isFavorite: false,
      trashedAt: null,
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  let blocks = [
    {
      id: "body",
      pageId: "shared",
      type: "paragraph",
      html: "Initial",
      indent: 0,
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "tail",
      pageId: "shared",
      type: "paragraph",
      html: "",
      indent: 0,
      position: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  await page.route("**/__orvane/notes/data", async (route) => {
    const p = route.request().postDataJSON();
    let result: unknown = {};
    if (p.action === "list")
      result = p.collection === "pages" ? metadata : blocks;
    if (p.action === "get") result = null;
    if (p.collection === "pages" && p.action === "delete") metadata = metadata.filter(page => page.id !== p.key);
    if (p.collection === "blocks" && p.action === "deletePage") blocks = blocks.filter(block => block.pageId !== p.pageId);
    if (p.collection === "blocks" && p.action === "replaceBlocks")
      blocks = p.rows;
    if (p.collection === "blocks" && p.action === "put")
      blocks = blocks.map((b) => (b.id === p.rows[0].id ? p.rows[0] : b));
    await route.fulfill({ json: result });
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/tests/performance-harness.ts";
    return (await import(path)).exerciseNotesViews();
  });
  expect(result).toEqual({
    synchronized: "Edited",
    historiesIndependent: true,
    undone: "Initial",
    redone: "Edited",
    reopened: "Edited",
    otherViewStillOpen: "shared",
    deletedInOtherView: true,
  });
});
