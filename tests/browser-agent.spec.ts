import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The AI works in a Browser tab through the browser_* MCP tools with real
// input. While it controls a tab the page shows the AI border and takes no
// user input; Take control hands it back and withdraws access; the tab menu
// shares a tab again.
test("the AI opens, drives and hands back a Browser tab", async ({}, info) => {
  test.setTimeout(240_000);
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/two") return response.end("<!doctype html><title>Second</title><h1>Second page</h1>");
    response.end(`<!doctype html><title>Form fixture</title>
<h1>Form</h1>
<label>Name <input id="name"></label>
<select id="size"><option value="s">Small</option><option value="l">Large</option></select>
<button id="save" onclick="out.textContent = 'Saved ' + document.querySelector('#name').value + ' ' + size.value + ' ' + event.isTrusted">Save</button>
<p id="out"></p>
<a href="/two">Next</a>
<nav style="display:none"><a href="/two?from=menu">Hidden page</a></nav>
<div id="menu" onmouseenter="setTimeout(() => { const a = document.createElement('a'); a.href = '/two'; a.textContent = 'Late item'; this.append(a); }, 350)">Menu</div>
<script>window.clicks = 0; addEventListener('pointerdown', () => window.clicks++);</script>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const data = info.outputPath("data");
  const env = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...env, ORVANE_PORT: "5232", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5232" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-browser-agent-test", version: "1.0.0" });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    await expect(browser).toBeVisible();
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await expect.poll(async () => (await call("workspace_status")).sessions.length, { timeout: 30_000 }).toBe(1);

    const { browsers } = await call("browser_tabs");
    expect(browsers).toHaveLength(1);
    const opened = await call("browser_open", { url: `${origin}/` });
    const tabId = opened.tabId as string;
    expect(opened.page.title).toBe("Form fixture");

    // Locked: the border and bar show, and the overlay takes the pointer.
    const lock = browser.locator(".browser-ai-lock");
    await expect(lock).toBeVisible();
    await expect(lock).toContainText("AI is using this tab");
    await expect(browser.locator(".browser-tab.ai-controlled")).toHaveCount(1);
    const box = (await lock.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 40);
    const guestClicks = () =>
      app.evaluate(async ({ webContents }, first) => {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.getURL().startsWith(first))!;
        return guest.executeJavaScript("window.clicks");
      }, origin);
    expect(await guestClicks()).toBe(0);

    // Snapshot refs, then real input.
    const snapshot = await call("browser_snapshot", { tabId });
    const name = snapshot.elements.find((e: any) => e.role === "textbox" && e.name === "Name");
    expect(name.ref).toMatch(/^e\d+$/);
    await call("browser_act", { tabId, action: "fill", ref: name.ref, value: "Ada" });
    await call("browser_act", { tabId, action: "select", selector: "#size", label: "Large" });
    await call("browser_act", { tabId, action: "click", text: "Save" });
    const read = await call("browser_act", { tabId, action: "read", selector: "#out" });
    expect(read.text).toBe("Saved Ada l true");
    expect(await guestClicks()).toBeGreaterThan(0);
    // Refilling replaces the text.
    await call("browser_act", { tabId, action: "fill", ref: name.ref, value: "Grace", submit: false });
    expect((await call("browser_act", { tabId, action: "eval", expression: "document.querySelector('#name').value" })).value).toBe("Grace");
    // A body with return also works.
    expect((await call("browser_act", { tabId, action: "eval", expression: "const a = 2; return a * 21;" })).value).toBe(42);

    // Hover waits until a menu that opens late is in place.
    await call("browser_act", { tabId, action: "hover", text: "Menu" });
    expect((await call("browser_act", { tabId, action: "read", selector: "#menu" })).text).toContain("Late item");

    // Hidden menu links and same-origin fetches skip the clicking.
    const deep = await call("browser_snapshot", { tabId, includeHidden: true, textLength: 0 });
    expect(deep.hiddenLinks).toContainEqual({ name: "Hidden page", href: `${origin}/two?from=menu` });
    expect((await call("browser_snapshot", { tabId })).hiddenLinks).toBeUndefined();
    const fetched = await call("browser_act", { tabId, action: "eval", expression: "fetch('/two').then((r) => r.text())" });
    expect(fetched.value).toContain("Second page");

    const readShot = await raw("browser_act", { tabId, action: "read", selector: "h1", screenshot: true });
    expect((readShot.content as any[]).some((part) => part.type === "image")).toBe(true);
    // A page script that never answers fails on its own and doesn't block
    // the requests after it.
    const stuck = await raw("browser_act", { tabId, action: "eval", expression: "new Promise(() => {})" });
    expect(stuck.isError).toBe(true);
    expect(JSON.stringify(stuck.content)).toContain("did not answer");
    expect((await call("browser_tabs")).browsers).toHaveLength(1);

    const shot = await raw("browser_screenshot", { tabId });
    expect((shot.content as any[]).some((part) => part.type === "image" && part.data.length > 1000)).toBe(true);

    const moved = await call("browser_act", { tabId, action: "click", text: "Next" });
    expect(moved.page.title).toBe("Second");
    await call("browser_act", { tabId, action: "navigate", url: "back" });
    await expect.poll(async () => (await call("browser_snapshot", { tabId })).title).toBe("Form fixture");

    // The user takes control: the lock goes and the AI loses access.
    await lock.getByRole("button", { name: "Take control" }).click();
    await expect(lock).toHaveCount(0);
    const refused = await raw("browser_act", { tabId, action: "read" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("no access");
    expect((await raw("browser_control", { tabId, action: "take" })).isError).toBe(true);

    // Sharing it again from the tab menu lets the AI take it back.
    await browser.locator(".browser-tab.active").click({ button: "right" });
    await browser.getByRole("menu").getByText("Let AI use this tab", { exact: true }).click();
    expect((await call("browser_tabs")).browsers[0].tabs.find((t: any) => t.tabId === tabId).access).toBe("granted");
    await call("browser_control", { tabId, action: "take" });
    await expect(lock).toBeVisible();
    expect((await call("browser_act", { tabId, action: "read", selector: "h1" })).text).toBe("Form");
    await call("browser_control", { tabId, action: "release" });
    await expect(lock).toHaveCount(0);
    expect((await raw("browser_act", { tabId, action: "read" })).isError).toBe(true);

    // Ctrl+K withdraws (and gives) access to the open tab.
    await browser.locator(".browser-tab.active").click();
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Search and commands" }).getByRole("combobox", { name: "Search" }).fill("AI access");
    await page.getByText("Stop AI access to this tab", { exact: true }).click();
    const access = async () =>
      Object.fromEntries((await call("browser_tabs")).browsers[0].tabs.map((t: any) => [t.tabId, t.access ?? "none"]));
    expect((await access())[tabId]).toBe("none");

    // Several selected tabs are shared at once.
    const second = (await call("browser_open", { url: `${origin}/two` })).tabId as string;
    await call("browser_control", { tabId: second, action: "release" });
    const rows = browser.locator(".browser-tab");
    await rows.filter({ hasText: "Form fixture" }).click();
    await rows.filter({ hasText: "Second" }).click({ modifiers: ["Control"] });
    await rows.filter({ hasText: "Form fixture" }).click({ modifiers: ["Control"] });
    await rows.filter({ hasText: "Second" }).click({ button: "right" });
    await browser.getByRole("menu").getByText("Let AI use 2 tabs", { exact: true }).click();
    const shared = await access();
    expect([shared[tabId], shared[second]]).toEqual(["granted", "granted"]);

    // Task tabs are the AI's to close; tabs opened for the user are not.
    const scratch = (await call("browser_open", { url: `${origin}/two` })).tabId as string;
    expect((await call("browser_tabs")).browsers[0].tabs.find((t: any) => t.tabId === scratch).opened).toBe("task");
    expect(await call("browser_control", { tabId: scratch, action: "close" })).toMatchObject({ closed: true });
    expect((await call("browser_tabs")).browsers[0].tabs.some((t: any) => t.tabId === scratch)).toBe(false);
    const shown = (await call("browser_open", { url: `${origin}/two`, purpose: "user" })).tabId as string;
    const refusedClose = await raw("browser_control", { tabId: shown, action: "close" });
    expect(refusedClose.isError).toBe(true);
    await call("browser_control", { tabId: shown, action: "release" });
    await expect(browser.locator(".browser-tab.active")).toContainText("Second");
    // A task tab the user took over is theirs.
    const taken = (await call("browser_open", { url: `${origin}/two` })).tabId as string;
    await lock.getByRole("button", { name: "Take control" }).click();
    expect((await raw("browser_control", { tabId: taken, action: "close" })).isError).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
    site.close();
  }
});
