import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The AI keeps related tabs together through the MCP: browser_open opens a
// tab straight into a named group, browser_group moves tabs in and out, and
// only tabs it opened or the user shared can be grouped.
test("the AI opens tabs into groups and moves them between groups", async ({}, info) => {
  test.setTimeout(180_000);
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>Page ${request.url}</title><h1>${request.url}</h1>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const data = info.outputPath("data");
  const env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...env, ORVANE_PORT: "5233", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5233" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-tab-groups-test", version: "1.0.0" });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    await expect(browser).toBeVisible();
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await expect.poll(async () => (await call("workspace_status")).sessions.length, { timeout: 30_000 }).toBe(1);

    // browser_open creates the group and opens the tab in it.
    const first = await call("browser_open", { url: `${origin}/one`, purpose: "user", group: "Release QR Code" });
    expect(first.group).toBe("Release QR Code");
    await expect(browser.getByText("Release QR Code", { exact: true })).toBeVisible();
    // The same name in other case joins the existing group.
    const second = await call("browser_open", { url: `${origin}/two`, purpose: "user", group: "release qr code" });
    expect(second.group).toBe("Release QR Code");
    const third = await call("browser_open", { url: `${origin}/three`, purpose: "user" });
    let listed = (await call("browser_tabs")).browsers[0];
    expect(listed.groups).toEqual([{ name: "Release QR Code", tabIds: [first.tabId, second.tabId] }]);
    expect(listed.tabs.find((t: any) => t.tabId === third.tabId).group).toBeUndefined();

    // browser_group moves tabs into another group and takes one out.
    expect(await call("browser_group", { tabIds: [second.tabId, third.tabId], group: "Research" })).toMatchObject({
      group: "Research",
    });
    await call("browser_group", { tabIds: [first.tabId], group: null });
    listed = (await call("browser_tabs")).browsers[0];
    const groupOf = (id: string) => listed.tabs.find((t: any) => t.tabId === id).group;
    expect([groupOf(first.tabId), groupOf(second.tabId), groupOf(third.tabId)]).toEqual([
      undefined,
      "Research",
      "Research",
    ]);
    await page.screenshot({ path: info.outputPath("tab-groups.png") });

    // A tab the user has not shared can't be grouped.
    await call("browser_control", { tabId: first.tabId, action: "release" });
    await browser.locator(".browser-tab", { hasText: "Page /one" }).click();
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Search and commands" }).getByRole("combobox", { name: "Search" }).fill("AI access");
    await page.getByText("Stop AI access to this tab", { exact: true }).click();
    const refused = await raw("browser_group", { tabIds: [first.tabId], group: "Research" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("not shared");
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});
