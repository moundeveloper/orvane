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
      await expect(root.locator(".git-patch > span")).toHaveCount(10004);
    } else
      await expect
        .poll(() => root.locator(".fc-item").count())
        .toBeLessThan(80);
    const metrics = await root.evaluate((root) => ({
      elements: root.querySelectorAll("*").length,
      rows: root.querySelectorAll(".git-patch > span,.fc-item").length,
      firstRowHeight: (
        root.querySelector(".git-patch > span,.fc-item") as HTMLElement
      )?.offsetHeight,
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
    await root.screenshot({
      path: `artifacts/performance/${kind}-candidate.png`,
    });
    await page.evaluate(() => (window as any).largeList.unmount());
  });
}
