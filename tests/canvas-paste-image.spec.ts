import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createServer } from "node:http";

async function launch(info: { outputPath(name: string): string }, port: string) {
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: port,
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  const page = await app.firstWindow();
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
  return { app, page };
}
async function pastedPicture(page: Page) {
  const before = await page.locator(".image-widget").count();
  await page.mouse.move(700, 500);
  await page.keyboard.press("Control+v");
  const widget = page.locator(".image-widget").nth(before);
  await expect(widget).toBeVisible({ timeout: 15_000 });
  const picture = widget.locator("img.image-main");
  await expect(picture).toBeVisible({ timeout: 15_000 });
  return picture;
}

// Ctrl+V on the canvas with a picture on the clipboard (a screenshot) places
// an image widget that shows the picture.
test("a pasted clipboard image shows in its canvas widget", async ({}, info) => {
  test.setTimeout(120_000);
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(info, "5233");
    app = launched.app;
    const { page } = launched;
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#2878c8";
      context.fillRect(0, 0, 64, 64);
      const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    });
    const picture = await pastedPicture(page);
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(64);
  } finally {
    await app?.close();
  }
});

// A web image copied as part of a page (only its address is on the
// clipboard) that needs the user's sign-in: the server's download is
// refused, so the picture is fetched again with the Browser's cookies.
test("a pasted web image behind a sign-in uses the Browser's cookies", async ({}, info) => {
  test.setTimeout(120_000);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxXQAAAAASUVORK5CYII=",
    "base64",
  );
  const site = createServer((request, response) => {
    if (/(^|;\s*)auth=1/.test(request.headers.cookie ?? "")) {
      response.setHeader("content-type", "image/png");
      return response.end(png);
    }
    response.statusCode = 401;
    response.setHeader("content-type", "text/html");
    response.end("<h1>Sign in</h1>");
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(info, "5235");
    app = launched.app;
    const { page } = launched;
    await app.evaluate(({ session }, url) =>
      session.fromPartition("persist:orvane-browser").cookies.set({ url, name: "auth", value: "1" }), origin);
    const url = `${origin}/media/27ad51bc-c684-4db2-8c36-9077036d94d2`;
    await page.evaluate(async (url) => {
      const html = new Blob([`<p>Look</p><img src="${url}">`], { type: "text/html" });
      await navigator.clipboard.write([new ClipboardItem({ "text/html": html })]);
    }, url);
    const picture = await pastedPicture(page);
    await expect(picture).toHaveAttribute("src", /^\/__orvane\/files\/image\/[a-f\d]{40}\.png$/);
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(1);
  } finally {
    await app?.close();
    site.close();
  }
});
