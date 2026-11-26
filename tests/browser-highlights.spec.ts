import { test, expect } from "./fixtures";
import { sourceHighlightScript, readBrowserSources, type BrowserSources } from "../src/browserHighlights";
const sources = (): BrowserSources => ({ url: "https://fixture.test/article", title: "Source article", selected: "second",
  passages: [
    { id: "first", quote: "A verified source quote.", label: "Opening", text: "", found: false, matches: 0 },
    { id: "second", quote: "Keep the last 14 copies.", prefix: "Retention:", label: "Retention", text: "", found: false, matches: 0 },
    { id: "missing", quote: "A claim that is not on this page.", text: "", found: false, matches: 0 },
  ] });

test("source marks match exact inline text and context without changing page text, forms or selection", async ({ page }) => {
  await page.setContent('<p id="first">A <a href="#retention">verified</a> source quote.</p><input value="draft"><p>Keep the last 14 copies.</p><div style="height:1000px"></div><p id="retention">Retention: Keep the last <b>14</b> copies.</p>');
  await page.locator("input").fill("unsaved draft");
  await page.evaluate(() => { (document.activeElement as HTMLElement).blur(); const range = document.createRange(); range.selectNodeContents(document.querySelector("#first")!); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("A verified source quote.");
  const before = await page.locator("body").textContent();
  const result = await page.evaluate(sourceHighlightScript(sources(), true));
  expect(result.passages.map((p: any) => [p.id, p.found, p.matches])).toEqual([["first", true, 1], ["second", true, 1], ["missing", false, 0]]);
  expect(result.passages[1].text).toBe("Keep the last 14 copies.");
  expect(await page.locator("body").textContent()).toBe(before);
  await expect(page.locator("input")).toHaveValue("unsaved draft");
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("A verified source quote.");
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const target = await page.locator("#retention").boundingBox();
  expect(target!.y).toBeGreaterThanOrEqual(0);
  expect(target!.y).toBeLessThan(1000);
  expect(await page.evaluate(() => (CSS as any).highlights.get("orvane-source-active").size)).toBe(1);
  expect(await page.locator("#first a").getAttribute("href")).toBe("#retention");
  await page.evaluate(sourceHighlightScript());
  expect(await page.evaluate(() => (CSS as any).highlights.has("orvane-source"))).toBe(false);
  await expect(page.locator("[data-orvane-sources]")).toHaveCount(0);
});

test("changed passages report missing and reappear without polling or repeated observers", async ({ page }) => {
  await page.setContent('<p id="first">A verified source quote.</p><p>Retention: Keep the last 14 copies.</p>');
  const reports: any[] = [];
  page.on("console", (message) => { if (message.text().startsWith("__orvane_sources__")) reports.push(JSON.parse(message.text().slice("__orvane_sources__".length))); });
  await page.evaluate(sourceHighlightScript(sources()));
  await page.locator("#first").evaluate((element) => { element.textContent = "Changed text"; });
  await expect.poll(() => reports.at(-1)?.passages.find((p: any) => p.id === "first").found).toBe(false);
  await page.locator("#first").evaluate((element) => { element.textContent = "A verified source quote."; });
  await expect.poll(() => reports.at(-1)?.passages.find((p: any) => p.id === "first").found).toBe(true);
  await page.evaluate(sourceHighlightScript(sources()));
  await expect(page.locator("[data-orvane-sources]")).toHaveCount(1);
  const saved = readBrowserSources({ ...sources(), passages: sources().passages.map((p) => ({ ...p, found: true, matches: 3, text: p.quote })) })!;
  expect(saved.passages.every((p) => !p.found && p.matches === 0)).toBe(true);
  expect(saved.passages[0]!.text).toBe("A verified source quote.");
});

test("source widget keeps tab state, keyboard access, outside dismissal and a bounded popover", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.goto("/tests/browser-sources-harness.html", { timeout: 90_000 });
  const panel = page.getByRole("region", { name: "Source passages", exact: true });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole("option")).toHaveCount(3);
  await expect(panel.getByRole("option").filter({hasText:"No longer found"})).toBeDisabled();
  const selected = panel.getByRole("option", { selected: true });
  await selected.focus();
  await selected.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("option", { selected: true })).toContainText("Schedule");
  await page.getByRole("button", { name: "Next source passage", exact: true }).click();
  await expect(panel.getByRole("option", { selected: true })).toContainText("Retention");
  await page.getByRole("button", { name: "Outside", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Outside", exact: true })).toBeFocused();
  const trigger = page.getByRole("button", { name: "Source passages", exact: true });
  await trigger.click();
  await page.evaluate(() => window.dispatchEvent(new Event("orvane:guest-pointer-down")));
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => (window as any).setSourceTab("two"));
  await expect(trigger).toContainText("1 of 1");
  await trigger.click();
  await expect(panel).toContainText("Another tab's own passage.");
  await expect(panel).not.toContainText("Retention");
  await page.evaluate(() => (window as any).setSourceTab("one"));
  await trigger.click();
  await page.locator("#stage").evaluate((element) => { element.style.width="280px";element.style.height="320px"; });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeLessThanOrEqual(248);
  const box = (await panel.boundingBox())!, stage = (await page.locator("#stage").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(stage.y);
  await page.screenshot({path:info.outputPath("source-widget-compact.png")});
  await page.getByRole("button", {name:"Clear source highlights",exact:true}).click();
  await expect(page.locator(".browser-sources")).toHaveCount(0);
});
