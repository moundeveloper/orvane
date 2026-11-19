import { test, expect } from "./fixtures";
import { deflateSync } from "node:zlib";

// A tiny valid PNG for a reference image.
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(4 * (1 + 12), 0x80);
  for (let y = 0; y < 4; y++) raw[y * 13] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("UI Maker reference captions: inline edit and the caption field support Enter and Escape", async ({ page }) => {
  await page.goto("/");
  page.setDefaultTimeout(8000);
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create UI Maker" }).click();
  const app = page.locator(".canvas-app").last();
  const help = page.locator(".help");
  await help.waitFor();
  await help.dispatchEvent("pointerdown");
  await expect(help).toHaveCount(0);
  await app.getByTitle("New component").click();
  await app.getByLabel("New component name").fill("Card");
  await app.getByLabel("New component name").press("Enter");
  const chooser = page.waitForEvent("filechooser");
  await app.locator('[data-el="fileBtn"]').click();
  await (await chooser).setFiles({ name: "ref.png", mimeType: "image/png", buffer: png() });
  const field = app.locator(".refbar").getByLabel("Reference caption");
  await field.waitFor();
  await page.screenshot({ path: "artifacts/uimaker-caption.png" });

  // Clicking the caption strip under the image edits it in place.
  const card = app.locator("[data-rid]").first();
  const box = (await card.boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height - 6);
  const inline = app.locator('[data-el="bedit"]');
  await expect(inline).toBeVisible();
  await expect(inline).toBeFocused();
  await page.keyboard.type("Use the header spacing");
  await page.keyboard.press("Enter");
  await expect(inline).toBeHidden();
  await expect(field).toHaveValue("Use the header spacing");
  await expect(card).toContainText("Use the header");
  await page.screenshot({ path: "artifacts/uimaker-caption-inline.png" });

  // Escape cancels an inline edit.
  await page.mouse.click(box.x + 30, box.y + box.height - 6);
  await expect(inline).toBeFocused();
  // The field covers the caption strip exactly: same left, width and bottom.
  const strip = (await inline.boundingBox())!;
  expect(Math.abs(strip.x - box.x)).toBeLessThan(2);
  expect(Math.abs(strip.width - box.width)).toBeLessThan(2);
  expect(Math.abs(strip.y + strip.height - (box.y + box.height))).toBeLessThan(2);
  await page.screenshot({ path: "artifacts/uimaker-caption-editing.png" });
  await page.keyboard.type(" and more");
  await page.keyboard.press("Escape");
  await expect(inline).toBeHidden();
  await expect(field).toHaveValue("Use the header spacing");

  // The caption field accepts typing; Escape restores, Enter keeps.
  await field.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" now");
  await expect(field).toHaveValue("Use the header spacing now");
  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("Use the header spacing");
  await expect(field).not.toBeFocused();
  await field.click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.keyboard.press("Enter");
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue("Use the header spacing!");

  // Pins still use the same inline field.
  await app.locator(".board .rail.mini").getByTitle(/pin/i).click();
  await page.mouse.click(box.x + 60, box.y + 60);
  await expect(inline).toBeFocused();
  await expect(inline).toHaveAttribute("aria-label", "Pin text");
  await page.keyboard.type("Header");
  await page.keyboard.press("Enter");
  await expect(inline).toBeHidden();
  await expect(card).toContainText("Use the header");
});
