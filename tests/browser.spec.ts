import { test, expect } from "./fixtures";
import { createServer, type Server } from "node:http";

async function site() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><title>Fixture</title><h1>Page ${request.url}</h1>`,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("Browser app loads pages in tabs, keeps history and still pans the canvas", async ({
  page,
}) => {
  const { server, origin } = await site();
  try {
    await page.addInitScript(() =>
      localStorage.setItem("orvane.examples.v1", "installed"),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page
      .getByRole("button", { name: "Create Browser", exact: true })
      .click();
    const browser = page.locator(".browser-view");
    await expect(browser).toBeVisible();
    await expect(browser.locator(".browser-start")).toBeVisible();

    const address = browser.getByRole("textbox", { name: "Address" });
    await address.fill(`${origin}/one`);
    await address.press("Enter");
    const frame = page.frameLocator(".browser-view iframe");
    await expect(frame.locator("h1")).toHaveText("Page /one");

    await address.fill(`${origin}/two`);
    await address.press("Enter");
    await expect(frame.locator("h1")).toHaveText("Page /two");
    await page.screenshot({ path: "artifacts/browser.png" });
    await browser.getByRole("button", { name: "Back", exact: true }).click();
    await expect(frame.locator("h1")).toHaveText("Page /one");
    await expect(address).toHaveValue(`${origin}/one`);
    await browser.getByRole("button", { name: "Forward" }).click();
    await expect(frame.locator("h1")).toHaveText("Page /two");

    // Bookmarks: star the page, reopen it from the bar, middle-click for a
    // new tab, and remove it.
    const star = browser.getByRole("button", { name: "Bookmark this page" });
    await star.click();
    const bookmarks = browser.getByRole("navigation", { name: "Bookmarks" });
    await expect(bookmarks.getByRole("button", { name: "127.0.0.1", exact: true })).toBeVisible();
    await expect(
      browser.getByRole("button", { name: "Remove bookmark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await browser.getByRole("button", { name: "Back", exact: true }).click();
    await expect(frame.locator("h1")).toHaveText("Page /one");
    await bookmarks.getByRole("button", { name: "127.0.0.1", exact: true }).click();
    await expect(frame.locator("h1")).toHaveText("Page /two");
    await bookmarks
      .getByRole("button", { name: "127.0.0.1", exact: true })
      .click({ button: "middle" });
    await expect(browser.locator(".browser-tab")).toHaveCount(2);
    await browser.locator(".browser-tab").nth(1).click({ button: "middle" });
    await expect(browser.locator(".browser-tab")).toHaveCount(1);

    // Orvane's own origin and non-web schemes never load in the frame.
    await address.fill(new URL(page.url()).origin);
    await address.press("Enter");
    await expect(browser.locator(".browser-error")).toBeVisible();
    await address.fill("javascript:alert(1)");
    await address.press("Enter");
    await expect(browser.locator(".browser-error")).toBeVisible();
    await expect(frame.locator("h1")).toHaveText("Page /two");

    await browser.getByRole("button", { name: "New tab" }).click();
    await expect(browser.locator(".browser-tab")).toHaveCount(2);
    await expect(browser.locator(".browser-start")).toBeVisible();
    await browser.locator(".browser-tab").first().click();
    await expect(frame.locator("h1")).toHaveText("Page /two");

    // Outside the page, a middle-drag over the frame pans the canvas.
    await page.locator(".canvas-background").click({ position: { x: 5, y: 5 } });
    await expect(browser.locator(".browser-shield")).toBeVisible();
    const box = (await browser.locator(".browser-page").boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(x - 120, y - 40, { steps: 5 });
    await page.mouse.up({ button: "middle" });
    await expect
      .poll(async () => (await browser.locator(".browser-page").boundingBox())!.x)
      .toBeLessThan(box.x - 100);

    // Clicking the shield hands the pointer to the page.
    await browser.locator(".browser-shield").click();
    await expect(browser.locator(".browser-shield")).toHaveCount(0);

    await page.reload();
    await expect(page.locator(".browser-tab")).toHaveCount(2);
    await page
      .getByRole("button", { name: "Remove bookmark 127.0.0.1" })
      .click();
    await expect(
      page.getByRole("navigation", { name: "Bookmarks" }),
    ).toHaveCount(0);
    await expect(
      page.frameLocator(".browser-view iframe").locator("h1"),
    ).toHaveText("Page /two");
    await expect(page.locator(".browser-view select")).toHaveCount(0);
  } finally {
    await new Promise((done) => (server as Server).close(done));
  }
});

test("panning over an app behind does not bring it to the front; clicking does", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  const create = async (name: string) => {
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name, exact: true }).click();
  };
  await create("Create Browser");
  await create("Create Notes");
  const back = page.locator(".canvas-app").filter({ has: page.locator(".browser-view") });
  const front = page.locator(".canvas-app").filter({ has: page.locator(".notes-workspace") });
  await expect(front.locator(".notes-workspace")).toBeVisible({ timeout: 20000 });
  const z = (app: typeof back) =>
    app.evaluate((el) => Number(getComputedStyle(el).zIndex));
  // Uncover part of the browser by moving the Notes app to the right.
  const header = (await front.locator(".app-topline").boundingBox())!;
  await page.mouse.move(header.x + 40, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 340, header.y + header.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await z(front)).toBeGreaterThan(await z(back));
  const visible = (await back.boundingBox())!;
  const x = visible.x + 120,
    y = visible.y + visible.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + 80, y + 40, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  expect(await z(front)).toBeGreaterThan(await z(back));
  await page.mouse.click(x + 80, y + 40);
  await expect.poll(async () => (await z(back)) > (await z(front))).toBe(true);
});
