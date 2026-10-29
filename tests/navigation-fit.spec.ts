import { test, expect, type Page } from "./fixtures";
import { emptyWorkspace, makeBlock, type CanvasApp } from "../src/model";

async function seed(page: Page) {
  const workspace = emptyWorkspace();
  workspace.apps = [
    { id: "small", name: "Small app", x: 200, y: 180, width: 300, height: 280 },
    {
      id: "large",
      name: "Large app",
      x: 2200,
      y: 1500,
      width: 2400,
      height: 1600,
    },
    { id: "wide", name: "Wide app", x: 6000, y: 0, width: 10000, height: 1200 },
    { id: "tall", name: "Tall app", x: 2000, y: 0, width: 300, height: 2200 },
  ].map((a): CanvasApp => ({
    ...a,
    blocks: [
      {
        ...makeBlock("input"),
        label: `${a.name} note`,
        value: "Keep this draft",
      },
    ],
    icon: "app",
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 24,
    gap: 12,
    radius: 8,
  }));
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
}
async function fits(page: Page, id: string) {
  await expect(page.locator(".canvas-plane")).not.toHaveClass(/camera-moving/);
  await expect
    .poll(() =>
      page.locator(`[data-app-id="${id}"]`).evaluate((el) => {
        const app = el.getBoundingClientRect(),
          top = document
            .querySelector(".topbar")!
            .getBoundingClientRect().bottom,
          dock = document.querySelector(".dock")!.getBoundingClientRect().top;
        return (
          app.left >= 15 &&
          app.right <= innerWidth - 15 &&
          app.top >= top + 15 &&
          app.bottom <= dock - 15
        );
      }),
    )
    .toBe(true);
}
const zoom = (page: Page) =>
  page
    .locator(".canvas-plane")
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
for (const reduced of [false, true])
  test(`dock and search fit app dimensions without resetting content, reduced motion ${reduced}`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    await seed(page);
    await page.getByRole("button", { name: "Small app", exact: true }).click();
    await fits(page, "small");
    const smallZoom = await zoom(page);
    expect(smallZoom).toBeGreaterThan(1);
    await page
      .getByRole("textbox", { name: "Small app note", exact: true })
      .fill("Unfinished input");
    await page.getByRole("button", { name: "Large app", exact: true }).click();
    await fits(page, "large");
    expect(await zoom(page)).toBeLessThan(smallZoom);
    await page
      .getByRole("button", { name: "Find an app", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Search apps", exact: true })
      .fill("Wide app");
    await page
      .getByRole("textbox", { name: "Search apps", exact: true })
      .press("Enter");
    await fits(page, "wide");
    expect(await zoom(page)).toBeLessThan(0.2);
    const width = await page
      .locator('[data-app-id="wide"]')
      .evaluate((el) => (el as HTMLElement).offsetWidth);
    expect(width).toBe(10000);
    const before = await zoom(page);
    await page.mouse.move(600, 400);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 30);
    await page.keyboard.up("Control");
    await expect.poll(() => zoom(page)).toBeLessThanOrEqual(before + 0.0001);
    await page.getByRole("button", { name: "Small app", exact: true }).click();
    await fits(page, "small");
    await expect(
      page.getByRole("textbox", { name: "Small app note", exact: true }),
    ).toHaveValue("Unfinished input");
  });
test("phone navigation fits a tall app between the actual chrome and dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await page.getByRole("button", { name: "Tall app", exact: true }).click();
  await fits(page, "tall");
  await page.screenshot({ path: "artifacts/app-navigation-fit-mobile.png" });
});
test("rapid app switching and wheel interruption use the displayed camera pose", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "Small app", exact: true }).click();
  await page.getByRole("button", { name: "Large app", exact: true }).click();
  await fits(page, "large");
  await page.getByRole("button", { name: "Small app", exact: true }).click();
  await page.mouse.move(720, 500);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -60);
  await page.keyboard.up("Control");
  await expect(page.locator(".canvas-plane")).not.toHaveClass(/camera-moving/);
  await page.getByRole("button", { name: "Large app", exact: true }).click();
  await fits(page, "large");
});
