import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { WebSocket } from "ws";
import { UiMakerService } from "../server/uimaker.ts";
import { test, expect } from "./fixtures";

function trustedStatus(url: string, ca: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const request = get(url, { ca, timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("timeout", () => request.destroy(Error("Host connection timed out.")));
    request.on("error", reject);
  });
}

test("desktop settings start and revoke Host, which can approve a turn and pick a live Lab variant", async ({ page, context, browser }, info) => {
  test.setTimeout(100_000);
  const ns = (await context.cookies()).find((cookie) => cookie.name === "orvane-test-workspace")!.value;
  const directory = join(process.cwd(), ".orvane");
  const data = join(directory, "tests", ns);
  const project = join(data, "project");
  const transcripts = join(data, "claude-projects", "test-project");
  const privateProject = join(data, "private");
  await Promise.all([project, privateProject, transcripts].map((folder) => mkdir(folder, { recursive: true })));
  await copyFile("tests/helpers/agent-cli.cjs", join(data, "agent-cli.cjs"));
  const claudeId = "11111111-1111-4111-8111-111111111111";
  await writeFile(join(transcripts, claudeId + ".jsonl"), JSON.stringify({
    type: "user", sessionId: claudeId, cwd: project,
    message: { content: "Laptop host approval" }, timestamp: new Date().toISOString(),
  }) + "\n");

  await writeFile(join(transcripts, "22222222-2222-4222-8222-222222222222.jsonl"), JSON.stringify({
    type: "user", sessionId: "22222222-2222-4222-8222-222222222222", cwd: privateProject,
    message: { content: "Private host transcript" }, timestamp: new Date().toISOString(),
  }) + "\n");

  const maker = new UiMakerService(directory, `tests/${ns}.sqlite`);
  const component = await maker.create({ name: "Laptop review" });
  const round = await maker.labStart(component.id, "Review", "new");
  await maker.labWrite(component.id, {
    variant: "tested", round: round.id, label: "Tested variant",
    html: `<!doctype html><h1>Laptop mock</h1><p id="isolation"></p><script>
      try { parent.document.title; } catch { document.querySelector('#isolation').textContent='Preview is isolated'; }
    </script>`,
  });

  const remoteContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 950, height: 710 } });
  let desktopTerminal: WebSocket | undefined;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Workspace options", exact: true }).click();
    await page.getByRole("button", { name: "Create Agent sessions", exact: true }).click();
    const sessions = page.locator(".agent-sessions-app");
    await sessions.getByText("Laptop host approval", { exact: true }).click();
    await expect(sessions.locator(".cs-thread").getByText("Laptop host approval", { exact: true })).toBeVisible();
    await expect(sessions.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    const hint = page.getByRole("button", { name: "Got it", exact: true });
    if (await hint.isVisible()) await hint.click();
    await page.screenshot({ path: info.outputPath("desktop-agent-sessions.png") });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const access = page.getByRole("region", { name: "Host access" });
    const toggle = access.getByRole("switch", { name: "Host on local network" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await access.getByRole("combobox", { name: "Network interface" }).click();
    await page.getByRole("option", { name: /This computer only/ }).click();
    await access.getByLabel("HTTPS port").fill("0");
    const password = "desk42";
    await access.getByLabel(/Shared project folders/).fill(project);
    await access.getByRole("switch", { name: "Approval from the laptop" }).click();
    await access.getByRole("switch", { name: "Share UI Maker" }).click();
    await access.getByRole("switch", { name: "Share open terminals" }).click();
    await access.getByLabel("Access password").fill("desk4");
    await toggle.click();
    await expect(access.getByRole("alert")).toHaveText("Use an access password of at least 6 characters.");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await access.getByLabel("Access password").fill(password);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    const url = await access.locator("code").textContent();
    expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const response = await page.request.post("/__orvane/agents/host-settings", { data: { action: "certificate" } });
    expect(response.ok()).toBe(true);
    const { certificate } = await response.json();
    expect(certificate).toContain("BEGIN CERTIFICATE");
    expect(certificate).not.toContain("PRIVATE KEY");
    expect(await trustedStatus(url!, certificate)).toBe(200);
    await page.screenshot({ path: info.outputPath("desktop-host-settings.png") });

    const laptop = await remoteContext.newPage();
    await laptop.goto(url!);
    await laptop.getByLabel("Access password").fill(password);
    await laptop.getByRole("button", { name: "Connect", exact: true }).click();
    // The laptop runs the desktop's own Agent Sessions component.
    const app = laptop.locator(".agent-sessions-app");
    await expect(app.getByRole("navigation", { name: "Agent sessions" })).toBeVisible();
    await expect(app.getByText("Laptop host approval", { exact: true })).toBeVisible();
    await expect(app.getByText("Private host transcript")).toHaveCount(0);
    for (const desktopOnly of ["Settings", "Scheduled"])
      await expect(app.getByRole("button", { name: new RegExp("^" + desktopOnly) })).toHaveCount(0);
    await app.getByText("Laptop host approval", { exact: true }).click();
    await expect(app.locator(".cs-thread").getByText("Laptop host approval", { exact: true })).toBeVisible();
    await expect(app.getByRole("button", { name: "Open folder" })).toHaveCount(0);
    await expect(app.getByRole("button", { name: /^Snapshot/ })).toHaveCount(0);
    const chat = app.getByRole("textbox", { name: "Message", exact: true });
    await chat.fill("Review the laptop mock");
    await chat.press("Enter");
    const request = app.getByRole("group", { name: /Permission request for Write/ });
    await expect(request).toBeVisible();
    await expect(request.getByText(/fixture\.txt/)).toBeVisible();
    await laptop.screenshot({ path: info.outputPath("laptop-approval.png") });
    await request.getByRole("button", { name: "Allow once" }).click();
    await expect(app.locator(".cs-thread").getByText("Write approved", { exact: true })).toBeVisible();

    const send = app.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeVisible();
    await chat.fill("Ask me questions");
    await chat.press("Enter");
    const card = app.getByRole("group", { name: "Questions from Claude Code" });
    await card.getByRole("radio", { name: /UI 1x, page keeps zoom/ }).click();
    await card.getByRole("button", { name: /^Next/ }).click();
    await card.getByRole("checkbox", { name: /Canvas/ }).click();
    await card.getByRole("button", { name: /Send answers/ }).click();
    await expect(app.locator(".cs-thread")).toContainText("Answers");

    await expect(send).toBeVisible();
    await app.getByRole("button", { name: "Codex", exact: true }).click();
    await expect(app.getByLabel("Project folder")).toHaveValue(project);
    await chat.fill("Start a Codex session from the laptop");
    await chat.press("Enter");
    await expect(app.locator(".cs-thread")).toContainText("Codex started");
    await laptop.screenshot({ path: info.outputPath("laptop-agent-sessions.png") });
    // Popovers keep the desktop's surface on the laptop page (selectPopover.css).
    await app.locator(".au-pill").click();
    const usage = laptop.getByRole("dialog", { name: "Usage" });
    await expect(usage).toHaveCSS("background-color", "rgb(244, 248, 250)");
    // It opens above the pill, by its real height.
    await expect.poll(async () => (await usage.boundingBox())!.y + (await usage.boundingBox())!.height)
      .toBeLessThanOrEqual((await app.locator(".au-pill").boundingBox())!.y);
    await laptop.screenshot({ path: info.outputPath("laptop-usage.png") });
    await laptop.keyboard.press("Escape");
    await expect(usage).toHaveCount(0);
    await app.getByRole("button", { name: /Laptop host approval/ }).click({ button: "right" });
    const rowMenu = laptop.getByRole("menu", { name: "Open session in a tile" });
    await expect(rowMenu).toHaveCSS("background-color", "rgb(244, 248, 250)");
    await laptop.screenshot({ path: info.outputPath("laptop-session-menu.png"), animations: "disabled" });
    await laptop.keyboard.press("Escape");
    await expect(rowMenu).toHaveCount(0);
    await laptop.locator(".host-top .wordmark").click();
    await laptop.keyboard.press("Control+ArrowRight");
    await expect(laptop).toHaveURL(url! + "/maker");
    await laptop.getByRole("button", { name: "Lab", exact: true }).click();
    const preview = laptop.frameLocator("#maker-frame");
    await expect(preview.getByRole("heading", { name: "Laptop mock" })).toBeVisible();
    await expect(preview.getByText("Preview is isolated")).toBeVisible();
    await laptop.getByRole("button", { name: "Pick this variant" }).click();
    await laptop.getByRole("button", { name: "Confirm pick" }).click();
    await expect(laptop.getByRole("status")).toHaveText("Saved as v2 on the host.");
    expect((await maker.labRound(component.id, round.id)).picked).toBe("tested");
    await laptop.screenshot({ path: info.outputPath("laptop-ui-maker.png") });
    const desktopUrl = new URL(page.url());
    const terminalUrl = new URL("/__orvane/terminal", desktopUrl);
    terminalUrl.protocol = "ws:";
    const socket = desktopTerminal = new WebSocket(terminalUrl, { origin: desktopUrl.origin });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    let output = "";
    let shellStarted = false;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.t === "started") shellStarted = true;
      if (message.t === "o") output += message.d;
    });
    socket.send(JSON.stringify({ t: "open", id: "host-test-" + ns, profile: process.platform === "win32" ? "powershell" : "/bin/bash", cwd: project, cols: 74, rows: 18 }));
    await expect.poll(() => shellStarted, { timeout: 12_000 }).toBe(true);
    await laptop.getByRole("link", { name: "Terminal" }).click();
    await expect(laptop.getByText("Connected to desktop shell")).toBeVisible();
    await laptop.locator(".xterm").click();
    await laptop.keyboard.insertText(process.platform === "win32"
      ? "Write-Output ('ORVANE_HOST_' + 'TERMINAL_OK')"
      : "printf '%s%s\\n' ORVANE_HOST_ TERMINAL_OK");
    await laptop.keyboard.press("Enter");
    await expect.poll(() => output, { timeout: 12_000 }).toContain("ORVANE_HOST_TERMINAL_OK");
    await expect(laptop.locator(".xterm-rows")).toContainText("ORVANE_HOST_TERMINAL_OK");
    await expect(laptop.locator(".xterm-viewport")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await laptop.screenshot({ path: info.outputPath("laptop-terminal.png") });
    await laptop.getByRole("link", { name: "Agent Sessions" }).click();
    await expect(app.getByRole("navigation", { name: "Agent sessions" })).toBeVisible();
    // Restart asks first, then reaches the desktop window. This test page isn't
    // the Electron app, so the window answers that it can't restart.
    await laptop.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(laptop.getByRole("heading", { name: "Restart Orvane?" })).toBeVisible();
    await laptop.screenshot({ path: info.outputPath("laptop-restart-confirm.png") });
    await laptop.getByRole("button", { name: "Restart Orvane" }).click();
    await expect(laptop.getByRole("alert")).toContainText("Open the updated Orvane desktop app to schedule a restart.");
    await laptop.getByRole("link", { name: "Back" }).click();
    await expect(app.getByRole("navigation", { name: "Agent sessions" })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(trustedStatus(url!, certificate)).rejects.toThrow();
  } finally {
    if (desktopTerminal?.readyState === WebSocket.OPEN) desktopTerminal.send(JSON.stringify({ t: "kill", id: "host-test-" + ns }));
    desktopTerminal?.close();
    // The test verifies shutdown above. A lost server during cleanup should
    // preserve the original failure and still release the other fixtures.
    await page.request.post("/__orvane/agents/host-settings", { data: { action: "stop" } }).catch(() => undefined);
    await remoteContext.close();
    await maker.close();
  }
});
