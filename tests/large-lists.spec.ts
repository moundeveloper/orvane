import { test, expect } from "./fixtures";

for (const kind of ["git", "cabinet", "cabinet-files"] as const) {
  test(`${kind} large-list DOM comparison`, async ({ page }, info) => {
    await page.goto("/");
    await page.evaluate(async (kind) => {
      const module = "/tests/large-lists-harness.ts";
      (window as any).largeList = (await import(module)).mountLargeListFixture(
        kind,
      );
    }, kind);
    const root = page.locator("#large-list-fixture");
    if (kind === "git") {
      await root.locator(".git-commit-row").click();
      await expect
        .poll(() => root.locator(".git-patch .cm-line").count())
        .toBeGreaterThan(0);
      await expect
        .poll(() => root.locator(".git-patch .cm-line").count())
        .toBeLessThan(200);
    } else
      await expect
        .poll(() => root.locator(".fc-item").count())
        .toBeLessThan(80);
    const metrics = await root.evaluate((root) => ({
      elements: root.querySelectorAll("*").length,
      rows: root.querySelectorAll(
        ".git-patch > span,.git-patch .cm-line,.fc-item",
      ).length,
      firstRowHeight: (
        root.querySelector(
          ".git-patch > span,.git-patch .cm-line,.fc-item",
        ) as HTMLElement
      )?.offsetHeight,
      treeElements: root.querySelector(".folder-tree")?.querySelectorAll("*")
        .length,
      treeRows: root.querySelectorAll("[data-folder-key]").length,
      treeHeight: root.querySelector<HTMLElement>(".folder-tree")?.offsetHeight,
      sidebarScrollHeight:
        root.querySelector<HTMLElement>(".fc-sidebar")?.scrollHeight,
      tableElements: root.querySelector(".fc-content")?.querySelectorAll("*")
        .length,
      height: root.querySelector<HTMLElement>(".fc-content")?.clientHeight,
      scrollHeight:
        root.querySelector<HTMLElement>(".fc-content")?.scrollHeight,
      columns: Array.from(root.querySelectorAll("th")).map(
        (th) => th.getBoundingClientRect().width,
      ),
    }));
    console.log("Large-list candidate:", kind, metrics);
    await info.attach(`${kind}-candidate.json`, {
      body: JSON.stringify(metrics),
      contentType: "application/json",
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.screenshot({
      path: `artifacts/performance/${kind}-candidate.png`,
    });
    await page.evaluate(() => (window as any).largeList.unmount());
  });
}
