import { expect, type Page } from "@playwright/test";

// Drive real screen-space input. The iframe's content rect is in frame-local
// CSS pixels; the outer canvas uniformly scales the frame without reflowing it.
export async function clickFrameButton(
  page: Page,
  title: string,
  name: string,
) {
  const frame = page.locator(`iframe[title="${title}"]`);
  const button = page
    .frameLocator(`iframe[title="${title}"]`)
    .getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  const local = await button.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  const box = await frame.evaluate((el: HTMLIFrameElement) => {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      scaleX: rect.width / el.offsetWidth,
      scaleY: rect.height / el.offsetHeight,
    };
  });
  await page.mouse.click(
    box.x + local.x * box.scaleX,
    box.y + local.y * box.scaleY,
  );
}
