import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

test("laptop Browser controls a shared desktop guest and hosting off revokes access", async ({ browser }, info) => {
  test.setTimeout(150_000);
  const site = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Desktop Browser fixture</title>
<input id="name" style="position:absolute;top:20px;left:20px;width:180px;height:30px" aria-label="Name">
<button style="position:absolute;top:64px;left:20px;width:140px;height:38px"
onclick="document.title='Saved '+document.querySelector('#name').value+' · '+event.isTrusted">Save on the host</button>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const binding = site.address();
  if (!binding || typeof binding === "string") throw Error("No test site address.");
  const siteUrl = `http://127.0.0.1:${binding.port}/`;
  const data = info.outputPath("data");
  const project = join(data, "project");
  await mkdir(project, { recursive: true });
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...process.env, ORVANE_DATA_DIR: data, ORVANE_MCP_STATE_DIR: data,
      ORVANE_HOST_ENABLED: "0", ORVANE_PORT: "5254", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  const laptopContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 750 } });
  try {
    const desktop = await app.firstWindow();
    await desktop.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await desktop.getByRole("button", { name: "Workspace options" }).click();
    await desktop.getByRole("button", { name: "Create Browser", exact: true }).click();
    await expect(desktop.locator(".browser-view")).toBeVisible();
    const password = "browser fixture password";
    const settingsUrl = new URL("/__orvane/agents/host-settings", desktop.url()).href;
    const result = await desktop.request.post(settingsUrl, { data: {
      action: "start", address: "127.0.0.1", port: 0, projects: [project], password,
      approvals: false, uiMaker: false, terminal: false, browser: true,
    } });
    expect(result.ok()).toBe(true);
    const awake = () => app.evaluate(({ powerSaveBlocker }) =>
      Array.from({ length: 64 }, (_, i) => i).some((id) => powerSaveBlocker.isStarted(id)));
    await expect.poll(awake, { timeout: 7000 }).toBe(true);
    const { url: host } = await result.json();
    const laptop = await laptopContext.newPage();
    await laptop.goto(host);
    await laptop.getByLabel("Access password").fill(password);
    await laptop.getByRole("button", { name: "Connect", exact: true }).click();
    await laptop.getByRole("link", { name: "Browser", exact: true }).click();
    await expect(laptop.getByText("No shared tabs")).toBeVisible({ timeout: 20_000 });
    await laptop.getByRole("textbox", { name: "Address", exact: true }).fill(siteUrl);
    await laptop.getByRole("button", { name: "New tab", exact: true }).click();
    const image = laptop.getByRole("img", { name: "Live view of the desktop tab" });
    await expect(image).toBeVisible({ timeout: 20_000 });
    const { view } = await (await laptop.request.get(host + "/api/browser")).json();
    const tab = view.tabs.find((value: { url: string }) => value.url === siteUrl);
    expect(tab).toBeTruthy();
    const focusPoint = async (x: number, y: number) => {
      const { view: frame } = await (await laptop.request.get(host + "/api/browser/view?tab=" + tab.tabId)).json();
      const bounds = (await image.boundingBox())!;
      await image.click({ position: { x: bounds.width * x / frame.width, y: bounds.height * y / frame.height } });
    };
    await focusPoint(60, 32);
    await laptop.getByRole("textbox", { name: "Text to type in the desktop page" }).fill("Orvane laptop");
    await laptop.getByRole("button", { name: "Send text" }).click();
    await focusPoint(70, 82);
    await expect.poll(() => app.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().find((guest) => guest.getType() === "webview" && guest.getURL() === url)?.getTitle(), siteUrl),
      { timeout: 15_000 }).toBe("Saved Orvane laptop · true");
    await expect(laptop.getByRole("status").first()).toHaveText("Saved Orvane laptop · true", { timeout: 10_000 });
    await laptop.screenshot({ path: info.outputPath("laptop-browser.png") });
    expect((await desktop.request.post(settingsUrl, { data: { action: "stop" } })).ok()).toBe(true);
    await expect.poll(awake, { timeout: 7000 }).toBe(false);
    await expect(laptop.request.get(host + "/api/browser", { timeout: 3000 })).rejects.toThrow();
  } finally {
    await laptopContext.close();
    await app.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});
