import { readStored } from "./storage-helper";
import { test, expect } from "./fixtures";
import {
  exampleApps,
  LEGACY_CALCULATOR_CODE,
  CALCULATOR_CODE,
} from "../src/examples";
import { emptyWorkspace, uid } from "../src/model";

test("calculator fills its app at different sizes without inner or outer scrolling", async ({
  page,
}) => {
  const w = emptyWorkspace(),
    app = exampleApps(100, 80).find((a) => a.name === "Calculator")!;
  app.x = 100;
  app.y = 80;
  app.blocks[0]!.code = LEGACY_CALCULATOR_CODE;
  app.blocks[0]!.height = 210;
  delete app.blocks[0]!.sizing;
  w.apps = [app];
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    if (!localStorage.getItem("orvane.workspace.v1"))
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, w);
  await page.goto("/");
  const frame = page.frameLocator('iframe[title="Calculator"]');
  for (const [width, height] of [
    [350, 390],
    [460, 600],
    [240, 260],
  ]) {
    await page
      .getByRole("button", { name: "Options for Calculator", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Position & size", exact: true })
      .click();
    await page
      .getByRole("spinbutton", { name: "Width", exact: true })
      .fill(String(width));
    await page
      .getByRole("spinbutton", { name: "Height", exact: true })
      .fill(String(height));
    await page.getByRole("button", { name: "Close position controls" }).click();
    await expect
      .poll(() =>
        frame.locator("html").evaluate((el) => ({
          overflow: el.scrollHeight - el.clientHeight,
          body: document.body.scrollHeight - innerHeight,
        })),
      )
      .toEqual({ overflow: 0, body: 0 });
    const content = await page.locator(".app-content").evaluate((el) => ({
      height: el.clientHeight,
      scroll: el.scrollHeight,
      bottom: el.getBoundingClientRect().bottom,
      padding: parseFloat(getComputedStyle(el).paddingBottom),
    }));
    expect(content.scroll - content.height).toBeLessThanOrEqual(1);
    const box = (await page.locator("iframe").boundingBox())!;
    await expect
      .poll(async () => (await page.locator("iframe").boundingBox())!.height)
      .toBeGreaterThan(height! - 110);
    expect(
      Math.abs(box.y + box.height - (content.bottom - content.padding)),
    ).toBeLessThan(2);
    expect(
      await frame
        .getByRole("button", { name: "=", exact: true })
        .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight + 1),
    ).toBe(true);
    if (height === 600)
      await page.screenshot({ path: "artifacts/calculator-fill.png" });
  }
  await frame.getByRole("button", { name: "7", exact: true }).click();
  await frame.getByRole("button", { name: "+", exact: true }).click();
  await frame.getByRole("button", { name: "3", exact: true }).click();
  await frame.getByRole("button", { name: "=", exact: true }).click();
  await expect(frame.locator("output")).toHaveText("10");
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator("iframe")).toHaveCSS("height", /px$/);
  await expect
    .poll(() =>
      frame.locator("html").evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBe(0);
});

test("only the exact legacy calculator is upgraded; custom code stays intact", async ({
  page,
}) => {
  const w = emptyWorkspace(),
    legacy = exampleApps(100, 80).find((a) => a.name === "Calculator")!,
    custom = structuredClone(legacy);
  legacy.blocks[0]!.code = LEGACY_CALCULATOR_CODE;
  custom.id = uid();
  custom.blocks[0]!.id = uid();
  custom.name = "My edited calculator";
  custom.x += 400;
  custom.blocks[0]!.code = LEGACY_CALCULATOR_CODE + "<!-- my change -->";
  w.apps = [legacy, custom];
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, w);
  await page.goto("/");
  await page.getByRole("button", { name: "Canvas guide", exact: true }).click();
  await page.waitForTimeout(250);
  const stored = await readStored(page);
  expect(stored.apps[0].blocks[0].code).toBe(CALCULATOR_CODE);
  expect(stored.apps[1].blocks[0].code).toBe(custom.blocks[0]!.code);
  expect(stored.apps[0].height).toBe(legacy.height);
});

test("scrolling embedded content has breathing room beside the scrollbar", async ({
  page,
}) => {
  const w = emptyWorkspace(),
    app = exampleApps(100, 80).find((a) => a.name === "Calculator")!;
  app.x = 100;
  app.y = 80;
  app.name = "Scrollable code";
  app.blocks[0]!.label = "Scrollable content";
  app.blocks[0]!.code =
    "<style>body{margin:0}main{height:900px}</style><button onclick=\"document.querySelector('main').style.height='20px'\">Shorten content</button><main>Some content</main>";
  w.apps = [app];
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, w);
  await page.goto("/");
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("html")).toHaveClass("orvane-scroll-y");
  const gap = await frame
    .locator("body")
    .evaluate(
      (el) =>
        document.documentElement.clientWidth - el.getBoundingClientRect().right,
    );
  expect(gap).toBeGreaterThanOrEqual(9);
  await frame.getByRole("button", { name: "Shorten content" }).click();
  await expect(frame.locator("html")).not.toHaveClass("orvane-scroll-y");
});
