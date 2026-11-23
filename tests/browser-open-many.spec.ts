import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// One call opens several tabs and says what each page shows, so an agent
// notices an error page ("Record does not exist") without a snapshot per tab;
// browser_snapshot reads several tabs at once.
test("browser_open opens several pages with a page check and browser_snapshot reads them together", async ({}, info) => {
  test.setTimeout(180_000);
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      request.url === "/missing"
        ? "<!doctype html><title>Notice</title><p>Record does not exist</p><button>Go Back</button>"
        : `<!doctype html><title>Page ${request.url}</title><h1>Script ${request.url}</h1>`,
    );
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
    env: { ...env, ORVANE_PORT: "5234", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5234" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-open-many-test", version: "1.0.0" });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    await expect(page.locator(".browser-view")).toBeVisible();
    await client.connect(transport);
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await raw(name, args);
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    await expect.poll(async () => (await call("workspace_status")).sessions.length, { timeout: 30_000 }).toBe(1);

    const opened = await call("browser_open", {
      urls: [`${origin}/script`, `${origin}/missing`],
      purpose: "user",
      check: true,
    });
    expect(opened.tabs).toHaveLength(2);
    const [good, missing] = opened.tabs;
    expect(good.tabId).toBeTruthy();
    expect(good.check.title).toBe("Page /script");
    expect(good.check.pageProblem).toBeUndefined();
    expect(missing.check.title).toBe("Notice");
    expect(missing.check.pageProblem).toContain("Record does not exist");

    const read = await call("browser_snapshot", { tabIds: [good.tabId, missing.tabId], textLength: 200 });
    expect(read.tabs.map((t: any) => [t.tabId, t.title])).toEqual([
      [good.tabId, "Page /script"],
      [missing.tabId, "Notice"],
    ]);

    const both = await raw("browser_open", { url: `${origin}/a`, urls: [`${origin}/b`] });
    expect(both.isError).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
    site.closeAllConnections();
    site.close();
  }
});
