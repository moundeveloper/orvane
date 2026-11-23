import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// browser_record films a Browser tab in real time: keyframes of what changed
// per region as contact sheets, the region's text at each keyframe, every
// text change with its time, and all frames saved to disk.
test("browser_record captures animation, text changes and acted-on pages", async ({}, info) => {
  test.setTimeout(240_000);
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/still")
      return response.end(`<!doctype html><title>Still</title><h1 id="still">Nothing moves here</h1>`);
    response.end(`<!doctype html><title>Demo</title>
<style>body{margin:0;font:16px sans-serif}#stage{position:relative;width:420px;height:160px;background:#eef3f6}
#box{position:absolute;top:50px;left:0;width:60px;height:60px;background:#365f78}#panel{margin-top:20px;padding:10px;width:400px}</style>
<div id="stage"><div id="box"></div><p id="counter" style="margin:0;padding:8px">Step 0</p></div>
<button id="open" onclick="panel.textContent = 'Opened the agent tab'">Agent</button>
<div id="panel">Live run</div>
<div style="height:3000px"></div><p id="far">Far below</p>
<script>
let n = 0;
setInterval(() => { n++; counter.textContent = 'Step ' + n; box.style.left = (n * 40 % 360) + 'px'; }, 300);
</script>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const data = info.outputPath("data");
  const profile = info.outputPath("profile");
  const env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...env, ORVANE_PORT: "5243", ORVANE_USER_DATA: profile },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5243" },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-browser-record-test", version: "1.0.0" });
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
      return result as { structuredContent: { result: any }; content: { type: string; data?: string }[] };
    };
    await expect.poll(async () => (await call("workspace_status")).structuredContent.result.sessions.length, { timeout: 30_000 }).toBe(1);

    const { tabId } = (await call("browser_open", { url: `${origin}/` })).structuredContent.result;

    // Capture: a moving element and its text, plus a fixed rectangle.
    const captured = await call("browser_record", {
      tabId,
      durationMs: 2500,
      fps: 10,
      regions: [{ selector: "#stage", name: "Stage" }, { x: 0, y: 0, width: 420, height: 50, name: "Top strip" }],
    });
    const result = captured.structuredContent.result;
    expect(result.frames).toBeGreaterThan(4);
    expect(result.durationMs).toBeGreaterThanOrEqual(2400);
    const [stage, strip] = result.regions;
    expect(stage.name).toBe("Stage");
    expect(stage.keyframes.length).toBeGreaterThanOrEqual(5);
    // Times go forward and the text log follows the counter.
    const times = stage.keyframes.map((k: any) => k.ms);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const counts = stage.textChanges.map((c: any) => Number(/Step (\d+)/.exec(c.text)?.[1]));
    expect(Math.max(...counts) - Math.min(...counts)).toBeGreaterThanOrEqual(5);
    expect(stage.keyframes.some((k: any) => /Step \d+/.test(k.text ?? ""))).toBe(true);
    // A rectangle region has no text log, and this strip sits above the
    // moving box, so it changes less than the stage.
    expect(strip.textChanges).toBeUndefined();
    expect(strip.keyframes.length).toBeLessThan(stage.keyframes.length);
    // One contact sheet per region.
    expect(captured.content.filter((c) => c.type === "image")).toHaveLength(2);
    // Every frame is saved with a description file.
    expect(result.folder.startsWith(join(profile, "recordings"))).toBe(true);
    expect(existsSync(join(result.folder, "recording.json"))).toBe(true);
    expect(readdirSync(join(result.folder, "frames"))).toHaveLength(result.frames);

    // Start, act, stop: the click's result is in the text log.
    const started = (await call("browser_record", { tabId, action: "start", regions: [{ selector: "#panel" }] })).structuredContent.result;
    expect(started.recordingId).toBeTruthy();
    const status = (await call("browser_record", { tabId, action: "status", recordingId: started.recordingId })).structuredContent.result;
    expect(status.recording).toBe(true);
    await call("browser_act", { tabId, action: "click", text: "Agent" });
    await new Promise((done) => setTimeout(done, 600));
    const stopped = (await call("browser_record", { tabId, action: "stop", recordingId: started.recordingId })).structuredContent.result;
    expect(stopped.regions[0].textChanges.map((c: any) => c.text)).toEqual(["Live run", "Opened the agent tab"]);
    // A stopped recording is gone.
    const again = await raw("browser_record", { tabId, action: "stop", recordingId: started.recordingId });
    expect(again.isError).toBe(true);

    // A region outside the viewport is refused with a hint.
    const far = await raw("browser_record", { tabId, regions: [{ selector: "#far" }], durationMs: 500 });
    expect(far.isError).toBe(true);
    expect(JSON.stringify(far.content)).toContain("Scroll it into view");

    // A still page ends early and has a single keyframe.
    await call("browser_act", { tabId, action: "navigate", url: `${origin}/still` });
    const before = Date.now();
    const still = (await call("browser_record", { tabId, durationMs: 8000, stopWhenStillMs: 800, regions: [{ selector: "#still" }] })).structuredContent.result;
    expect(Date.now() - before).toBeLessThan(6000);
    expect(still.regions[0].keyframes).toHaveLength(1);
    expect(still.regions[0].keyframes[0].text).toBe("Nothing moves here");
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    site.close();
  }
});
