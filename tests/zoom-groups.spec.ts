import { readStored } from "./storage-helper";
import { test, expect } from "./fixtures";

test("rendered apps, text and iframes keep one scale throughout zoom and after settling", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page.locator(".canvas-app").first()).toBeVisible();
  await expect(page.locator("iframe").first()).toBeVisible();
  async function trace(delta: number) {
    const recording = page.evaluate(
      () =>
        new Promise<
          {
            scale: number;
            width: number;
            textScale: number;
            frameScale: number;
            frameWidth: number;
            zoom: string;
            anchor: number;
          }[]
        >((resolve) => {
          const plane = document.querySelector<HTMLElement>(".canvas-plane")!,
            app = document.querySelector<HTMLElement>(".canvas-app")!,
            text = app.querySelector<HTMLElement>(".app-text")!,
            frame = document.querySelector<HTMLIFrameElement>("iframe")!,
            start = performance.now(),
            logicalTextHeight =
              text.getBoundingClientRect().height /
              new DOMMatrix(getComputedStyle(plane).transform).a,
            samples: {
              scale: number;
              width: number;
              textScale: number;
              frameScale: number;
              frameWidth: number;
              zoom: string;
              anchor: number;
            }[] = [];
          const sample = () => {
            const m = new DOMMatrix(getComputedStyle(plane).transform);
            samples.push({
              scale: m.a,
              width: app.getBoundingClientRect().width,
              textScale:
                text.getBoundingClientRect().height / logicalTextHeight,
              frameScale:
                frame.getBoundingClientRect().width / frame.offsetWidth,
              frameWidth: frame.clientWidth,
              zoom: plane.style.zoom,
              anchor: (200 - m.e) / m.a,
            });
            if (performance.now() - start < 850) requestAnimationFrame(sample);
            else resolve(samples);
          };
          sample();
        }),
    );
    await page.mouse.move(200, 180);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, delta);
    await page.keyboard.up("Control");
    return recording;
  }
  const inward = await trace(-180);
  expect(inward.length).toBeGreaterThan(8);
  for (let i = 1; i < inward.length; i++) {
    expect(inward[i]!.width, JSON.stringify(inward)).toBeGreaterThanOrEqual(
      inward[i - 1]!.width - 0.1,
    );
    expect(inward[i]!.scale).toBeLessThanOrEqual(Math.exp(0.45) + 0.0001);
  }
  expect(inward.at(-1)!.scale).toBeCloseTo(Math.exp(0.45), 3);
  const outward = await trace(180);
  for (let i = 1; i < outward.length; i++)
    expect(outward[i]!.width).toBeLessThanOrEqual(outward[i - 1]!.width + 0.1);
  expect(outward.at(-1)!.scale).toBeCloseTo(1, 3);
  for (const sample of [...inward, ...outward]) {
    expect(sample.zoom).toBe("");
    expect(sample.textScale).toBeCloseTo(sample.scale, 2);
    expect(sample.frameScale).toBeCloseTo(sample.scale, 2);
    expect(sample.anchor).toBeCloseTo(200, 2);
  }
  expect(new Set([...inward, ...outward].map((s) => s.frameWidth)).size).toBe(
    1,
  );
  await page.screenshot({ path: "artifacts/grouped-canvas.png" });
});

test("groups are visible, editable, persistent and do not bind app movement", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".spatial-group")).toHaveCount(1);
  await expect(page.locator(".spatial-group-label")).toContainText("Examples");
  await page.getByRole("button", { name: "App groups", exact: true }).click();
  await page.getByRole("button", { name: "New group", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Group name", exact: true })
    .fill("A little focus");
  await page
    .getByRole("checkbox", { name: "Include Daily list in group", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Include Notes in group", exact: true })
    .check();
  await expect(page.locator(".spatial-group")).toHaveCount(2);
  const stored = (await readStored(page)).apps.map((a) => ({
    name: a.name,
    id: a.id,
  }));
  await page.getByRole("button", { name: "Close groups", exact: true }).click();
  const first = page.locator(".canvas-app").filter({
      has: page.getByRole("region", { name: "Daily list", exact: true }),
    }),
    second = page.locator(".canvas-app").filter({
      has: page.getByRole("region", { name: "Notes", exact: true }),
    });
  const before = (await first.boundingBox())!,
    peer = (await second.boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(before.x + 60, before.y + 65);
  await page.mouse.down();
  await page.mouse.move(before.x + 100, before.y + 115, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect((await first.boundingBox())!.x).toBeCloseTo(before.x + 40, 0);
  expect((await second.boundingBox())!.x).toBeCloseTo(peer.x, 0);
  await page
    .getByRole("button", { name: "Edit group A little focus", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Group name", exact: true })
    .fill("Room for ideas");
  await page.mouse.click(20, 60);
  await expect(page.locator(".groups-panel")).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.reload();
  await expect(
    page.locator(".spatial-group-label").filter({ hasText: "Room for ideas" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit group Room for ideas", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", {
      name: "Include Daily list in group",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Include Notes in group", exact: true }),
  ).toBeChecked();
  await page.screenshot({ path: "artifacts/group-editor.png" });
  await page.getByRole("button", { name: "Ungroup apps", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Include Daily list in group",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(page.locator(".spatial-group")).toHaveCount(1);
  expect(stored.length).toBe(4);
  await expect(page.locator(".canvas-app")).toHaveCount(4);
});
