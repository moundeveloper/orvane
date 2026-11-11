import { test, expect, type Locator, type Page } from "./fixtures";
import { createServer } from "node:http";

// The Browser app's sidebar, layouts, pinned tabs, groups, spaces, Peek,
// Split View and tab search, in the iframe build (desktop-only parts such as
// link Shift-click inside a page are covered in desktop.spec.ts).
async function open(page: Page) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><title>Fixture ${request.url}</title><h1>Page ${request.url}</h1>`,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create Browser", exact: true }).click();
  const browser = page.locator(".browser-view");
  await expect(browser).toBeVisible();
  const go = async (path: string) => {
    const bar = browser.getByRole("textbox", { name: "Address" });
    await bar.fill(`${origin}${path}`);
    await bar.press("Enter");
    await expect(browser.locator(".browser-tab.active")).toContainText("127.0.0.1");
  };
  const tab = async (path: string) => {
    await browser.getByRole("button", { name: "New tab" }).click();
    await go(path);
  };
  const menu = async (target: Locator, item: string) => {
    await target.click({ button: "right" });
    await browser.getByRole("menu").getByText(item, { exact: true }).click();
  };
  const more = async (item: string) => {
    await browser.getByRole("button", { name: "Browser menu" }).click();
    const menu = browser.getByRole("menu");
    const action = menu.getByText(item, { exact: true });
    if (!(await action.count()))
      await menu.getByText("Browser tools", { exact: true }).click();
    await action.click();
  };
  const saved = () =>
    page.evaluate(async () => {
      const response = await fetch("/__orvane/storage/workspace");
      return response.ok ? response.text() : "";
    });
  return { server, origin, browser, go, tab, menu, more, saved };
}

test("sidebar layouts keep every control and remember the choice", async ({
  page,
}) => {
  const { server, browser, go, tab, more } = await open(page);
  try {
    await go("/one");
    await tab("/two");
    // Default: a vertical sidebar beside the page, with the address bar.
    await expect(browser).toHaveClass(/layout-balanced/);
    const side = await browser.locator(".browser-side").boundingBox();
    const pageBox = await browser.locator(".browser-page").boundingBox();
    expect(side!.x + side!.width).toBeLessThanOrEqual(pageBox!.x + 1);
    const tabs = browser.locator(".browser-tab");
    const [first, second] = [await tabs.nth(0).boundingBox(), await tabs.nth(1).boundingBox()];
    expect(second!.y).toBeGreaterThan(first!.y);
    await page.screenshot({ path: "artifacts/browser-balanced.png" });

    // Sidebar only: the bar is hidden until asked for, then floats.
    await more("Layout: sidebar only");
    const bar = browser.getByRole("textbox", { name: "Address" });
    await expect(bar).toBeHidden();
    await browser.getByRole("button", { name: "Edit address" }).click();
    await expect(bar).toBeFocused();
    await page.screenshot({ path: "artifacts/browser-performance.png" });
    await page.keyboard.press("Escape");

    // Tabs on top: the strip is horizontal again.
    await more("Layout: tabs on top");
    await expect(bar).toBeVisible();
    const [left, right] = [await tabs.nth(0).boundingBox(), await tabs.nth(1).boundingBox()];
    expect(Math.abs(right!.y - left!.y)).toBeLessThan(2);
    expect(right!.x).toBeGreaterThan(left!.x);
    await page.screenshot({ path: "artifacts/browser-comfortable.png" });

    await page.reload();
    await expect(page.locator(".browser-view")).toHaveClass(/layout-comfortable/);
    await expect(page.locator(".browser-tab")).toHaveCount(2);
  } finally {
    server.close();
  }
});

test("pinned tabs, groups, multi-select and spaces organise tabs", async ({
  page,
}) => {
  const { server, origin, browser, go, tab, menu, more } = await open(page);
  try {
    await go("/a");
    await tab("/b");
    await tab("/c");
    const tabs = browser.locator(".browser-tab");
    await expect(tabs).toHaveCount(3);

    // Pin the first tab: it moves to the top, and a double-click returns it
    // to the address it was pinned at.
    await menu(tabs.nth(0), "Pin tab");
    await expect(tabs.nth(0)).toHaveClass(/pinned/);
    await tabs.nth(0).click();
    await go("/elsewhere");
    await tabs.nth(0).dblclick();
    await expect(browser.getByRole("textbox", { name: "Address" })).toHaveValue(
      `${origin}/a`,
    );

    // Ctrl-click two tabs and group them; the group collapses and renames.
    await tabs.nth(1).click({ modifiers: ["Control"] });
    await tabs.nth(2).click({ modifiers: ["Control"] });
    await expect(browser.locator(".browser-tab.selected")).toHaveCount(2);
    await menu(tabs.nth(2), "Group 2 tabs");
    const name = browser.getByRole("textbox", { name: "Group name" });
    await name.fill("Research");
    await name.press("Enter");
    const group = browser.getByRole("button", { name: "Tab group Research" });
    await expect(group).toContainText("2");
    await expect(browser.locator(".browser-tab.grouped")).toHaveCount(2);
    await group.click();
    await expect(tabs).toHaveCount(1);
    await group.click();
    await expect(tabs).toHaveCount(3);

    // A group becomes a bookmark folder and its tabs are ungrouped.
    await menu(group, "Save as bookmark folder");
    await expect(group).toHaveCount(0);
    const folder = browser.locator(".browser-folder");
    await expect(folder).toContainText("Research");
    await expect(browser.locator(".browser-bookmark.in-folder")).toHaveCount(2);

    // Group by site sweeps the loose tabs together.
    await more("Group tabs by site");
    await expect(browser.getByRole("button", { name: /Tab group 127/ })).toBeVisible();

    // A new space starts with its own blank tab; the first space keeps its
    // tabs, and a tab can be sent across.
    await browser.getByRole("button", { name: "New space" }).click();
    const spaceName = browser.getByRole("textbox", { name: "Space name" });
    await spaceName.fill("Work");
    await spaceName.press("Enter");
    await expect(tabs).toHaveCount(1);
    await expect(browser.locator(".browser-start")).toBeVisible();
    await browser.getByRole("tab", { name: "Space Main" }).click();
    await expect(tabs).toHaveCount(3);
    await menu(tabs.nth(2), "Move to Work");
    await expect(tabs).toHaveCount(2);
    await browser.getByRole("tab", { name: "Space Work" }).click();
    await expect(tabs).toHaveCount(2);
    await page.screenshot({ path: "artifacts/browser-spaces.png" });

    // All of it survives a reload.
    await page.reload();
    const again = page.locator(".browser-view");
    await expect(again.getByRole("tab", { name: "Space Work" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await again.getByRole("tab", { name: "Space Main" }).click();
    await expect(again.locator(".browser-tab.pinned")).toHaveCount(1);
  } finally {
    server.close();
  }
});

test("Peek, Split View and tab search open pages without losing the current one", async ({
  page,
}) => {
  const { server, origin, browser, go, tab, menu, more } = await open(page);
  try {
    await go("/main");
    await browser.getByRole("button", { name: "Bookmark this page" }).click();
    await tab("/other");
    const tabs = browser.locator(".browser-tab");
    const bookmark = browser
      .getByRole("navigation", { name: "Bookmarks" })
      .getByRole("button", { name: "127.0.0.1", exact: true });

    // Peek: a panel over the page, which stays underneath.
    const library = browser.getByRole("button", { name: "Library", exact: true });
    await library.click();
    await menu(bookmark, "Open Link in Peek View");
    const peekBar = browser.getByRole("toolbar", { name: "Peek View" });
    await expect(peekBar).toBeVisible();
    await expect(
      page.frameLocator(".browser-view iframe.browser-peeking").locator("h1"),
    ).toHaveText("Page /main");
    await expect(
      page.frameLocator(".browser-view iframe:not(.browser-peeking)").locator("h1"),
    ).toHaveText("Page /other");
    await expect(tabs).toHaveCount(2);
    await page.screenshot({ path: "artifacts/browser-peek.png" });
    // Shift-click a bookmark is the same; Escape closes it.
    await browser.getByRole("button", { name: "Close Peek" }).click();
    await expect(peekBar).toBeHidden();
    await library.click();
    await bookmark.click({ modifiers: ["Shift"] });
    await expect(peekBar).toBeVisible();
    await peekBar.getByRole("button", { name: "Open as tab" }).click();
    await expect(peekBar).toBeHidden();
    await expect(tabs).toHaveCount(3);
    await expect(browser.getByRole("textbox", { name: "Address" })).toHaveValue(
      `${origin}/main`,
    );

    // Split View: two pages side by side, with controls in both captions.
    await menu(tabs.nth(1), "Open in Split View");
    const split = browser.getByRole("toolbar", { name: "Split View" });
    await expect(split).toBeVisible();
    const frames = browser.locator(".browser-page iframe:not(.browser-peeking)");
    const primary = frames.and(browser.locator(".pane-first"));
    const secondary = frames.and(browser.locator(".pane-second"));
    await expect(frames).toHaveCount(2);
    const [a, b] = [await primary.boundingBox(), await secondary.boundingBox()];
    expect(Math.abs(a!.width - b!.width)).toBeLessThan(3);
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 3);
    await page.screenshot({ path: "artifacts/browser-split.png" });
    await more("Split top and bottom");
    const [top, bottom] = [await primary.boundingBox(), await secondary.boundingBox()];
    expect(bottom!.y).toBeGreaterThan(top!.y + top!.height - 3);
    // The sidebar shows the two tabs together; swapping moves the pages,
    // and choosing the other row moves the selection without moving pages.
    const choices = browser.locator(".inline-split .browser-tab");
    await expect(choices).toHaveCount(2);
    await expect(choices.nth(1)).toHaveClass(/active/);
    await more("Swap panes");
    await expect(choices.nth(0)).toHaveClass(/active/);
    await split.getByRole("button", { name: "Focus pane" }).last().click();
    await expect(choices.nth(1)).toHaveClass(/active/);
    await choices.nth(1).press("ArrowUp");
    await expect(choices.nth(0)).toHaveClass(/active/);
    await expect(frames).toHaveCount(2);
    await page.screenshot({ path: "artifacts/browser-split-stacked.png" });
    await split.getByRole("button", { name: "Close Split View", exact: true }).first().click();
    await expect(frames).toHaveCount(1);
    // Alt-click a tab opens it beside the current one.
    await tabs.nth(0).click({ modifiers: ["Alt"] });
    await expect(frames).toHaveCount(2);
    await choices.last().click({ modifiers: ["Alt"] });
    await expect(frames).toHaveCount(1);

    // Search finds a tab by its address and switches to it.
    await more("Search tabs");
    const search = browser.getByRole("textbox", {
      name: "Search open tabs and bookmarks",
    });
    await search.fill("other");
    // One matching tab, plus the offer to open the text in a new tab.
    const results = browser.getByRole("dialog", { name: "Search tabs" }).locator("button");
    await expect(results).toHaveCount(2);
    await page.screenshot({ path: "artifacts/browser-command.png" });
    await search.press("Enter");
    await expect(browser.getByRole("textbox", { name: "Address" })).toHaveValue(
      `${origin}/other`,
    );

    // In the Chrome-like layout a peek opens as an ordinary tab.
    await more("Layout: tabs on top");
    await bookmark.click({ modifiers: ["Shift"] });
    await expect(peekBar).toBeHidden();
    await expect(tabs).toHaveCount(4);
  } finally {
    server.close();
  }
});

test("Split View keeps its anchor and replaces only the focused pane", async ({ page }) => {
  const { server, origin, browser, go, tab } = await open(page);
  try {
    await go("/before");
    await tab("/source");
    await tab("/after");
    const address = browser.getByRole("textbox", { name: "Address" });
    const pair = browser.getByRole("group", { name: "Split View panes" });
    const choices = pair.getByRole("tab");
    const tabs = browser.locator(".browser-tab");
    const primary = browser.locator("iframe.pane-first");
    const secondary = browser.locator("iframe.pane-second");
    await tabs.nth(1).click();
    await browser.getByRole("button", { name: "Toggle Split View" }).click();
    await expect(tabs).toHaveCount(4);
    await expect(primary).toHaveAttribute("src", `${origin}/source`);
    await expect(browser.locator(".browser-start.pane-second")).toBeVisible();
    await expect(choices.last()).toHaveAttribute("aria-selected", "true");
    await expect(address).toHaveValue("");
    expect((await pair.boundingBox())!.y).toBeLessThan((await tabs.last().boundingBox())!.y);

    // Selecting an ordinary tab replaces the focused right pane and retains
    // the primary document.
    const primaryContent = primary.contentFrame().locator("h1");
    await primaryContent.evaluate((heading) => (heading.dataset.retained = "true"));
    await tabs.last().click();
    await expect(secondary).toHaveAttribute("src", `${origin}/after`);
    await expect(primaryContent).toHaveAttribute("data-retained", "true");
    await choices.last().press("ArrowUp");
    await expect(address).toHaveValue(`${origin}/source`);
    await expect(primaryContent).toHaveAttribute("data-retained", "true");
    await browser.locator(".browser-shield.pane-second").click();
    await expect(address).toHaveValue(`${origin}/after`);

    // The pair stays at the source even when the source becomes an ordinary
    // tab again. Keep the active pane and the new divider position on reload.
    await choices.first().click();
    await tabs.first().click();
    await expect(primary).toHaveAttribute("src", `${origin}/before`);
    await expect(secondary).toHaveAttribute("src", `${origin}/after`);
    expect((await tabs.first().boundingBox())!.y).toBeLessThan((await pair.boundingBox())!.y);
    const divider = browser.getByRole("separator", { name: "Split View divider" });
    await divider.press("Home");
    await expect(divider).toHaveAttribute("aria-valuenow", "25");
    await divider.press("End");
    await expect(divider).toHaveAttribute("aria-valuenow", "75");
    await page.reload();
    await expect(divider).toHaveAttribute("aria-valuenow", "75");
    await expect(choices.first()).toHaveAttribute("aria-selected", "true");
    await expect(primary).toHaveAttribute("src", `${origin}/before`);
    await expect(secondary).toHaveAttribute("src", `${origin}/after`);
  } finally {
    server.close();
  }
});
