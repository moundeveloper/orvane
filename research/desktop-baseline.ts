// Step 0 of PERFORMANCE-PLAN.md: a baseline of the full desktop shell.
//
//   node --import tsx research/desktop-baseline.ts [--idle 60] [--port 5201]
//
// Launches the real Electron shell (electron/main.mjs) against a disposable
// data folder and profile, builds a fixed workspace through the UI (one
// Browser app with 10 local pages, 3 terminals printing output, Notes, a Git
// viewer), then records:
//   - memory and CPU per process (main, workspace, each Browser page, GPU,
//     utility) plus the local Node server,
//   - local server requests and terminal socket messages per minute,
//   - bytes the workspace saves while typing in Notes,
//   - frame cadence while panning, with terminals printing and quiet.
// Nothing touches the owner's workspace, profile or a live account. NetSuite
// processing pages need a signed-in account and are not part of the fixture.
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(args[index + 1]);
};
const idleSeconds = option("idle", 60);
const port = option("port", 5201);
const root = resolve(".");
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const destination = resolve("artifacts/baseline", stamp);
await mkdir(destination, { recursive: true });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const percentile = (values: number[], fraction: number) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]! : 0;

// ---- Local pages: a few thousand elements, a CSS animation, a 1 s timer ----
const site = createServer((request, response) => {
  const name = (request.url || "/").slice(1) || "home";
  const rows = Array.from({ length: 400 }, (_, i) => `<tr><td>${i}</td><td>Row ${i} of ${name}</td><td><a href="#${i}">open</a></td><td>${(i * 37) % 997}</td></tr>`).join("");
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>Page ${name}</title>
<style>body{font:14px system-ui;margin:20px}.spin{width:24px;height:24px;border:3px solid #6f8998;border-top-color:transparent;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(1turn)}}</style>
<h1>${name}</h1><div class="spin"></div><p id="clock"></p><table>${rows}</table>
<script>setInterval(()=>{document.getElementById("clock").textContent=new Date().toISOString()},1000)</script>`);
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const address = site.address();
if (!address || typeof address === "string") throw Error("No site port");
const siteOrigin = `http://127.0.0.1:${address.port}`;

// ---- Launch the shell on isolated storage ----
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  ORVANE_PORT: String(port),
  ORVANE_DATA_DIR: join(destination, "data"),
  ORVANE_MCP_STATE_DIR: join(destination, "data"),
  ORVANE_USER_DATA: join(destination, "profile"),
});
const app: ElectronApplication = await electron.launch({ args: [join(root, "electron/main.mjs")], cwd: root, env });
const report: Record<string, unknown> = { stamp, commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() };

try {
  const page = await app.firstWindow();
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 90_000 });
  // tsx names functions with a __name helper that page scripts lack.
  await page.evaluate("window.__name = (target) => target");
  report.environment = await app.evaluate(async ({ app, screen, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const display = screen.getDisplayMatching(window.getBounds());
    return {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      refreshRate: display.displayFrequency,
      scaleFactor: display.scaleFactor,
      size: display.size,
      gpu: ((await app.getGPUInfo("basic")) as any).gpuDevice?.map((d: any) => d.vendorId + ":" + d.deviceId),
    };
  });

  // Count local server traffic for the whole run.
  const traffic = { requests: [] as { at: number; path: string; bytes: number }[], socketFrames: [] as number[] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.port === String(port) && url.pathname.startsWith("/__orvane"))
      traffic.requests.push({ at: Date.now(), path: url.pathname.replace(/\/[0-9a-f-]{8,}.*$/i, "/:id"), bytes: request.postDataBuffer()?.length ?? 0 });
  });
  page.on("websocket", (socket) => socket.on("framereceived", () => traffic.socketFrames.push(Date.now())));

  // ---- Build the workspace through the UI ----
  const create = async (label: string) => {
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: label, exact: true }).click();
    await sleep(800);
  };
  const existing = await page.locator(".canvas-app").count(); // first-run examples
  await create("Create Browser");
  const browser = page.locator(".browser-view").first();
  for (let i = 0; i < 10; i++) {
    if (i) await browser.getByRole("button", { name: "New tab", exact: true }).first().click();
    const bar = browser.getByRole("textbox", { name: "Address" });
    await bar.fill(`${siteOrigin}/tab-${i}`);
    await bar.focus();
    await page.keyboard.press("Enter");
    await browser.locator(".browser-tab", { hasText: `Page tab-${i}` }).waitFor({ timeout: 20_000 });
  }
  await create("Create Notes");
  await create("Create Git viewer");
  // A steady stream like a dev server or test run: 50 lines a second each.
  const stream = `node -e "let n=0;setInterval(()=>console.log(String(n++).padStart(6)+' '+'build output line '.repeat(5)),20)"`;
  for (let i = 0; i < 3; i++) {
    await create("Create Terminal");
    const terminal = page.locator(".terminal-pane .xterm").nth(i);
    await terminal.waitFor({ timeout: 30_000 });
    await sleep(2500); // shell prompt
    await terminal.click();
    await page.keyboard.type(stream);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
  await sleep(5000);
  await page.screenshot({ path: join(destination, "workspace.png") });
  report.canvasProbe = await page.evaluate(() =>
    [[innerWidth / 2, innerHeight / 2], [100, innerHeight - 200]].map(([x, y]) => {
      const el = document.elementFromPoint(x!, y!);
      return { x, y, tag: el?.tagName, cls: String(el?.className).slice(0, 80), parents: [...(function* (e) { while ((e = e?.parentElement ?? null)) yield `${e.tagName}.${String(e.className).split(" ")[0]}`; })(el)].slice(0, 6).join(" < ") };
    }),
  );

  // ---- Processes ----
  const sampleProcesses = async () =>
    app.evaluate(({ app, webContents }) => {
      const labels = new Map<number, string>();
      for (const contents of webContents.getAllWebContents()) {
        const pid = contents.getOSProcessId();
        const type = contents.getType();
        const url = contents.getURL();
        const label = type === "webview" ? `browser page ${new URL(url).pathname}` : type === "window" ? "workspace" : `${type} ${url.slice(0, 40)}`;
        labels.set(pid, labels.has(pid) ? `${labels.get(pid)} + ${label}` : label);
      }
      return app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        label: labels.get(m.pid) ?? m.type,
        privateMB: Math.round(((m.memory as any).privateBytes ?? m.memory.workingSetSize) / 1024),
        workingSetMB: Math.round(m.memory.workingSetSize / 1024),
        cpu: m.cpu.percentCPUUsage,
      }));
    });
  const serverProcess = () => {
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command", `$p = Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess; "$($p.CPU);$($p.PrivateMemorySize64)"`], { encoding: "utf8" }).trim();
      const [cpuSeconds, bytes] = out.split(";").map(Number);
      return { cpuSeconds: cpuSeconds!, privateMB: Math.round(bytes! / 2 ** 20) };
    } catch {
      return null;
    }
  };

  // Idle with terminals printing: CPU is the average over the window.
  await sampleProcesses(); // resets the CPU counters
  const serverBefore = serverProcess();
  const idleFrom = Date.now();
  await sleep(idleSeconds * 1000);
  const processes = await sampleProcesses();
  const serverAfter = serverProcess();
  const idleMinutes = (Date.now() - idleFrom) / 60_000;
  const groups: Record<string, { count: number; privateMB: number; cpu: number }> = {};
  for (const p of processes) {
    const key = p.label.startsWith("browser page") ? "browser pages" : p.label;
    const group = (groups[key] ??= { count: 0, privateMB: 0, cpu: 0 });
    group.count++;
    group.privateMB += p.privateMB;
    group.cpu = round(group.cpu + p.cpu);
  }
  if (serverAfter && serverBefore)
    groups["local server"] = { count: 1, privateMB: serverAfter.privateMB, cpu: round(((serverAfter.cpuSeconds - serverBefore.cpuSeconds) / (idleMinutes * 60)) * 100) };
  const idleRequests = traffic.requests.filter((r) => r.at >= idleFrom);
  const byPath: Record<string, number> = {};
  for (const r of idleRequests) byPath[r.path] = (byPath[r.path] ?? 0) + 1;
  report.idleWithTerminals = {
    seconds: idleSeconds,
    totalPrivateMB: Object.values(groups).reduce((sum, g) => sum + g.privateMB, 0),
    groups,
    processes,
    serverRequestsPerMinute: round(idleRequests.length / idleMinutes),
    requestsByPath: Object.fromEntries(Object.entries(byPath).map(([k, v]) => [k, round(v / idleMinutes)])),
    terminalSocketFramesPerMinute: round(traffic.socketFrames.filter((t) => t >= idleFrom).length / idleMinutes),
  };

  // ---- Terminals printing while panned off screen ----
  const canvasPan = (dx: number) =>
    page.evaluate((dx) => window.dispatchEvent(new CustomEvent("orvane-canvas-pan", { detail: { dx, dy: 0 } })), dx);
  await canvasPan(-20000);
  await sleep(2000);
  await sampleProcesses();
  const awayFrom = Date.now();
  await sleep(30_000);
  const away = await sampleProcesses();
  const sum = (list: typeof away, match: (p: (typeof away)[number]) => boolean) => round(list.filter(match).reduce((total, p) => total + p.cpu, 0));
  report.offScreenTerminals = {
    seconds: round((Date.now() - awayFrom) / 1000),
    workspaceCpu: sum(away, (p) => p.label === "workspace"),
    gpuCpu: sum(away, (p) => p.type === "GPU"),
    totalCpu: sum(away, () => true),
  };
  await canvasPan(20000);
  await sleep(2000);

  // ---- Saving while typing in Notes ----
  // The dock brings the Notes app made above into view. A new Notes app
  // starts empty: make a page, then type in it.
  await page.locator(".dock button", { hasText: "Notes" }).last().click();
  await sleep(1500);
  const notesApp = page.locator(".canvas-app").nth(existing + 1);
  report.notesButtons = await notesApp.getByRole("button").allInnerTexts();
  await page.screenshot({ path: join(destination, "notes.png") });
  const newPage = notesApp.getByRole("button", { name: /page/i }).first();
  if (await newPage.count()) await newPage.click();
  await sleep(1000);
  const title = await notesApp.evaluate((app) => {
    const el = [...app.querySelectorAll<HTMLElement>(".page-title, [contenteditable=true]")].find((e) => e.getBoundingClientRect().width);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
  });
  const typingFrom = Date.now();
  if (title) {
    await page.mouse.click(title.x, title.y);
    await page.keyboard.press("End");
    await page.keyboard.type(" The quick brown fox jumps over the lazy dog.".repeat(4), { delay: 40 });
    await sleep(3000);
  }
  const saves = traffic.requests.filter((r) => r.at >= typingFrom && r.bytes > 0);
  report.typingInNotes = {
    typed: Boolean(title),
    characters: 180,
    seconds: round((Date.now() - typingFrom) / 1000),
    saveRequests: saves.length,
    bytesSent: saves.reduce((sum, r) => sum + r.bytes, 0),
    byPath: saves.reduce<Record<string, number>>((acc, r) => ((acc[r.path] = (acc[r.path] ?? 0) + r.bytes), acc), {}),
  };

  // ---- Frame cadence while panning ----
  // A point on bare canvas, where a plain drag pans.
  const emptyPoint = () =>
    page.evaluate(() => {
      for (let y = innerHeight - 140; y > 120; y -= 20)
        for (let x = 70; x < innerWidth - 70; x += 20) {
          const el = document.elementFromPoint(x, y);
          if (el?.classList.contains("canvas-background") || (el?.closest(".canvas-plane") && !el.closest(".canvas-app, .board-note"))) return { x, y };
        }
      return null;
    });
  const pan = async (label: string) => {
    const start = await emptyPoint();
    if (!start) return { label, error: "no empty canvas point" };
    await page.evaluate(() => {
      const w = window as any;
      w.__frames = [];
      let last = performance.now();
      const tick = (now: number) => {
        w.__frames.push(now - last);
        last = now;
        if (w.__sampling) requestAnimationFrame(tick);
      };
      w.__sampling = true;
      requestAnimationFrame(tick);
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let round = 0; round < 4; round++)
      for (let step = 0; step < 60; step++) {
        const dx = (round % 2 ? 59 - step : step) * 6;
        await page.mouse.move(start.x + dx, start.y + Math.sin(step / 10) * 30);
        await sleep(8);
      }
    await page.mouse.up();
    const frames: number[] = await page.evaluate(() => {
      const w = window as any;
      w.__sampling = false;
      return w.__frames.slice(2);
    });
    return {
      label,
      frames: frames.length,
      p50: round(percentile(frames, 0.5), 2),
      p95: round(percentile(frames, 0.95), 2),
      over20ms: frames.filter((f) => f > 20).length,
      over10ms: frames.filter((f) => f > 10).length,
    };
  };
  // Zoomed out so every app is on screen, which is the heavy case.
  await page.keyboard.press("Escape");
  await page.mouse.move(150, 500);
  await page.keyboard.down("Control");
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 240);
    await sleep(60);
  }
  await page.keyboard.up("Control");
  await sleep(1500);
  // New apps open stacked on one spot. Drag each by its title bar into a
  // 3-column grid so the overview shows them side by side.
  const created = (await page.locator(".canvas-app").count()) - existing;
  for (let i = 0; i < created; i++) {
    const header = await page.evaluate((existing) => {
      const apps = [...document.querySelectorAll<HTMLElement>(".canvas-app")].slice(existing);
      const top = apps.filter((a) => !a.dataset.arranged).sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0];
      if (!top) return null;
      top.dataset.arranged = "1";
      const r = (top.querySelector(".app-topline") ?? top).getBoundingClientRect();
      return { x: r.left + r.width * 0.3, y: r.top + Math.min(6, r.height / 2) };
    }, existing);
    if (!header) break;
    const target = { x: 520 + (i % 3) * 300, y: 200 + Math.floor(i / 3) * 220 };
    await page.mouse.move(header.x, header.y);
    await page.mouse.down();
    await page.mouse.move((header.x + target.x) / 2, (header.y + target.y) / 2, { steps: 5 });
    await page.mouse.move(target.x, target.y, { steps: 5 });
    await page.mouse.up();
    await sleep(300);
  }
  await sleep(1000);
  await page.screenshot({ path: join(destination, "overview.png") });
  report.overviewApps = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".canvas-app")].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.querySelector(".app-name, h2, .app-title")?.textContent?.trim().slice(0, 20), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display, visibility: getComputedStyle(el).visibility, style: el.getAttribute("style")?.slice(0, 120) };
    }),
  );
  const panning = [await pan("terminals printing"), await pan("terminals printing (repeat)")];
  // Stop the streams (Ctrl+C in each terminal), then pan again.
  for (let i = 0; i < 3; i++) {
    await page.locator(".terminal-pane .xterm").nth(i).click({ force: true }).catch(() => {});
    await page.keyboard.press("Control+C");
  }
  await page.keyboard.press("Escape");
  await sleep(2000);
  panning.push(await pan("terminals quiet"), await pan("terminals quiet (repeat)"));
  report.panOverview = panning;

  // Idle with nothing printing: background request rate only.
  const quietFrom = Date.now();
  await sampleProcesses();
  await sleep(30_000);
  const quiet = await sampleProcesses();
  const quietMinutes = (Date.now() - quietFrom) / 60_000;
  const quietRequests = traffic.requests.filter((r) => r.at >= quietFrom);
  const quietByPath: Record<string, number> = {};
  for (const r of quietRequests) quietByPath[r.path] = (quietByPath[r.path] ?? 0) + 1;
  report.idleQuiet = {
    seconds: 30,
    totalCpu: round(quiet.reduce((sum, p) => sum + p.cpu, 0)),
    serverRequestsPerMinute: round(quietRequests.length / quietMinutes),
    requestsByPath: Object.fromEntries(Object.entries(quietByPath).map(([k, v]) => [k, round(v / quietMinutes)])),
  };

  await writeFile(join(destination, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, idleWithTerminals: { ...(report.idleWithTerminals as any), processes: undefined } }, null, 2));
  console.log(`\nFull result: ${join(destination, "result.json")}`);
} finally {
  await app.close().catch(() => {});
  site.close();
}
