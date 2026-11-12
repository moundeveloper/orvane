// Repeatable interaction benchmark for the Orvane canvas.
//
//   pnpm bench                       current working tree only
//   pnpm bench -- --baseline HEAD    alternate against a build of a git ref
//   pnpm bench -- --runs 5 --trace   more repetitions plus one traced run
//
// Each run serves a production build against a disposable 50-app fixture
// (real SQLite workspace and Notes storage, fixed mock reads for Git,
// Projects and NetSuite) in a headed, focused Chromium window. Nothing here
// touches the user's workspace, repositories or a live account.
//
// Reported per scenario: animation-frame cadence, the renderer's own
// style/layout/script/task time (Chromium's cumulative counters), and
// latency from input to the first frame that reflects it. Frame callbacks
// are cadence evidence, not proof of presented frames.
import { build, preview, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import {
  chromium,
  _electron as electron,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { localStorageApi } from "../server/storage-api.ts";
import { notesApi } from "../server/notes-api.ts";
import {
  seedForegroundFixture,
  externalRead,
  workload,
} from "../research/foreground-fixture.ts";
import { summarizeTrace } from "./trace.ts";
import { exceeded } from "./budgets.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const runs = Number(option("runs") || 3);
const baselineRef = option("baseline");
const traced = args.includes("--trace");
const check = args.includes("--check");
const port = Number(option("port") || 5187);
const root = resolve(".");
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const destination = resolve("artifacts/bench", stamp);
await mkdir(destination, { recursive: true });

const git = (...command: string[]) =>
  execFileSync("git", command, { encoding: "utf8", cwd: root }).trim();

async function buildVariant(name: string, source: string) {
  await build({
    configFile: false,
    root: source,
    logLevel: "error",
    plugins: [
      vue({
        template: {
          compilerOptions: { isCustomElement: (tag) => tag === "webview" },
        },
      }),
    ],
    resolve: { alias: { "@": join(source, "src") } },
    build: {
      outDir: join(destination, "build", name),
      cssMinify: "esbuild",
      emptyOutDir: true,
    },
  });
}

const variants: { name: string; commit: string }[] = [];
if (baselineRef) {
  // Export the ref inside the repository so its bare imports resolve to the
  // installed node_modules; only tracked source is read.
  const commit = git("rev-parse", "--short", baselineRef);
  const source = join(destination, "source-baseline");
  await mkdir(source, { recursive: true });
  execFileSync(
    "git",
    ["--work-tree", source, "checkout", commit, "--", "src", "public", "index.html", "env.d.ts"],
    { cwd: root, env: { ...process.env, GIT_INDEX_FILE: join(destination, "baseline.index") } },
  );
  await buildVariant("baseline", source);
  await rm(source, { recursive: true, force: true });
  variants.push({ name: "baseline", commit });
}
await buildVariant("candidate", root);
variants.push({
  name: "candidate",
  commit: `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain", "--", "src") ? "+changes" : ""}`,
});

const percentile = (values: number[], fraction: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
      ]!
    : null;
const round = (value: number | null) =>
  value === null ? null : Math.round(value * 100) / 100;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Runs in the page before any application script.
function instrument() {
  localStorage.setItem("orvane.examples.v1", "installed");
  const w = window as any;
  const bench = (w.bench = {
    focusLosses: 0,
    hidden: 0,
    readyAt: 0,
    firstAppAt: 0,
    allAppsAt: 0,
    loadTasks: [] as number[],
    frames: [] as number[],
    longTasks: [] as number[],
    recording: false,
    sampling: false,
    inputAt: 0,
    firstFrameMs: null as number | null,
    cameraFirstMs: null as number | null,
    cameraLastMs: null as number | null,
  });
  addEventListener("blur", () => bench.focusLosses++);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) bench.hidden++;
  });
  new PerformanceObserver((list) => {
    const durations = list.getEntries().map((entry) => entry.duration);
    if (bench.recording) bench.longTasks.push(...durations);
    // Until every app exists, long tasks are the startup's blocking time.
    if (!bench.allAppsAt) bench.loadTasks.push(...durations);
  }).observe({ type: "longtask" });
  // When the app in view is usable, and when the last app has mounted.
  const mounting = () => {
    if (
      !bench.firstAppAt &&
      document.querySelector('[data-app-id="app-0"] .notes-workspace .page-title')
    )
      bench.firstAppAt = performance.now();
    const shells = document.querySelectorAll(".canvas-app").length;
    if (
      bench.firstAppAt &&
      shells &&
      shells === document.querySelectorAll(".canvas-app > .app-surface .block").length
    )
      bench.allAppsAt = performance.now();
    else requestAnimationFrame(mounting);
  };
  requestAnimationFrame(mounting);
  const ready = new MutationObserver(() => {
    if (document.querySelector('main[data-ready="true"]')) {
      bench.readyAt = performance.now();
      ready.disconnect();
    }
  });
  ready.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-ready"],
  });
  let previous: number | undefined,
    transform = "";
  // The sampler itself requests frames, so it only runs while a scenario
  // wants cadence; the idle scenario leaves it off.
  let loop = 0;
  const frame = (time: number) => {
    loop = 0;
    if (!bench.sampling) {
      previous = undefined;
      return;
    }
    if (previous !== undefined) bench.frames.push(time - previous);
    previous = time;
    // The first animation callback after an input, and the one after it,
    // bracket the frame in which that input was rendered.
    if (bench.inputAt && bench.firstFrameMs === null)
      requestAnimationFrame(() => {
        if (bench.firstFrameMs === null)
          bench.firstFrameMs = performance.now() - bench.inputAt;
      });
    const current =
      document.querySelector<HTMLElement>(".canvas-plane")?.style.transform ||
      "";
    if (current !== transform) {
      transform = current;
      if (bench.inputAt) {
        const elapsed = performance.now() - bench.inputAt;
        bench.cameraFirstMs ??= elapsed;
        bench.cameraLastMs = elapsed;
      }
    }
    loop = requestAnimationFrame(frame);
  };
  w.benchSample = (on: boolean) => {
    if (on) {
      bench.sampling = true;
      previous = undefined;
      transform =
        document.querySelector<HTMLElement>(".canvas-plane")?.style.transform ||
        "";
      loop ||= requestAnimationFrame(frame);
    } else bench.sampling = false;
  };
  const input = () => {
    if (bench.recording && !bench.inputAt) bench.inputAt = performance.now();
  };
  for (const type of ["pointerdown", "keydown", "wheel"])
    addEventListener(type, input, { capture: true, passive: true });
  w.orvaneDesktop = {
    netsuite: {
      tabs: async () => [
        { id: "fixture", label: "Fixture", status: "ready", count: 1 },
      ],
      run: async (_environment: string, op: string) => {
        if (op === "scripts")
          return {
            rows: Array.from({ length: 1000 }, (_, i) => ({
              id: i + 1,
              name: `Script ${i}`,
              scriptfile: `script-${i}.js`,
              fileid: i + 1,
              owner: "Fixture",
              scriptid: `customscript_${i}`,
              scripttype: "UserEvent",
            })),
          };
        if (op === "folders")
          return {
            rows: Array.from({ length: 1000 }, (_, i) => ({
              id: i + 1,
              name: `Folder ${i}`,
              parent: null,
            })),
          };
        if (op === "folder") return { folders: [], files: [] };
        throw Error(`Unsupported NetSuite fixture operation: ${op}`);
      },
      openRecord: async () => {
        throw Error("Record writes/navigation are outside this fixture.");
      },
    },
  };
}

type Counters = Record<string, number>;
async function counters(cdp: CDPSession): Promise<Counters> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

interface Scenario {
  frames: number;
  frameP50: number | null;
  frameP95: number | null;
  frameMax: number | null;
  over20ms: number;
  over34ms: number;
  longTasks: number;
  longestTask: number | null;
  firstFrameMs: number | null;
  cameraFirstMs: number | null;
  cameraSettledMs: number | null;
  styleMs: number;
  layoutMs: number;
  scriptMs: number;
  taskMs: number;
  styleRecalcs: number;
  layouts: number;
  wallMs: number;
}

async function measure(
  page: Page,
  cdp: CDPSession,
  name: string,
  action: () => Promise<void>,
  settle = 250,
  sample = true,
): Promise<Scenario> {
  await page.evaluate(([name, sample]) => {
    const bench = (window as any).bench;
    Object.assign(bench, {
      frames: [],
      longTasks: [],
      inputAt: 0,
      firstFrameMs: null,
      cameraFirstMs: null,
      cameraLastMs: null,
      recording: true,
    });
    (window as any).benchSample(sample);
    performance.mark(`bench:${name}:start`);
  }, [name, sample] as const);
  const before = await counters(cdp);
  const started = performance.now();
  await action();
  await sleep(settle);
  const wallMs = performance.now() - started;
  const after = await counters(cdp);
  const taken = await page.evaluate((name) => {
    const bench = (window as any).bench;
    bench.recording = false;
    (window as any).benchSample(false);
    performance.mark(`bench:${name}:end`);
    return {
      frames: bench.frames as number[],
      longTasks: bench.longTasks as number[],
      firstFrameMs: bench.firstFrameMs as number | null,
      cameraFirstMs: bench.cameraFirstMs as number | null,
      cameraLastMs: bench.cameraLastMs as number | null,
    };
  }, name);
  const delta = (key: string) => (after[key]! - before[key]!) * 1000;
  return {
    frames: taken.frames.length,
    frameP50: round(percentile(taken.frames, 0.5)),
    frameP95: round(percentile(taken.frames, 0.95)),
    frameMax: round(taken.frames.length ? Math.max(...taken.frames) : null),
    over20ms: taken.frames.filter((ms) => ms > 20).length,
    over34ms: taken.frames.filter((ms) => ms > 34).length,
    longTasks: taken.longTasks.length,
    longestTask: round(
      taken.longTasks.length ? Math.max(...taken.longTasks) : null,
    ),
    firstFrameMs: round(taken.firstFrameMs),
    cameraFirstMs: round(taken.cameraFirstMs),
    cameraSettledMs: round(taken.cameraLastMs),
    styleMs: round(delta("RecalcStyleDuration"))!,
    layoutMs: round(delta("LayoutDuration"))!,
    scriptMs: round(delta("ScriptDuration"))!,
    taskMs: round(delta("TaskDuration"))!,
    styleRecalcs: after.RecalcStyleCount! - before.RecalcStyleCount!,
    layouts: after.LayoutCount! - before.LayoutCount!,
    wallMs: round(wallMs)!,
  };
}

// Electron's own Chromium by default: it is the runtime Orvane ships on.
// "--browser chrome" uses PLAYWRIGHT_CHROMIUM_EXECUTABLE or Playwright's build.
const browserKind = option("browser") || "electron";
async function open(profile: string): Promise<{
  context: BrowserContext;
  page: Page;
  version: string;
  close: () => Promise<void>;
}> {
  if (browserKind === "electron") {
    const app = await electron.launch({
      args: ["bench/electron-main.mjs"],
      cwd: root,
      env: {
        ...(Object.fromEntries(
          Object.entries(process.env).filter(([, value]) => value !== undefined),
        ) as Record<string, string>),
        ORVANE_USER_DATA: profile,
      },
    });
    const page = await app.firstWindow();
    const version = await app.evaluate(
      () => `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    );
    return { context: app.context(), page, version, close: () => app.close() };
  }
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--window-position=0,0", "--window-size=1460,1080"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  return {
    context,
    page: await context.newPage(),
    version: `Chromium ${browser.version()}`,
    close: () => browser.close(),
  };
}

const results: any[] = [];
async function run(variant: (typeof variants)[number], index: number, trace = false) {
  const directory = join(destination, `data-${variant.name}-${index}${trace ? "-trace" : ""}`);
  seedForegroundFixture(directory);
  const fixtureErrors: string[] = [];
  let apiRequests = 0;
  const mocks: Plugin = {
    name: "bench-fixtures",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] || "";
        if (path.startsWith("/__orvane/")) apiRequests++;
        if (
          !path.startsWith("/__orvane/git/") &&
          !path.startsWith("/__orvane/projects/")
        )
          return next();
        try {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(externalRead(path)));
        } catch (error) {
          fixtureErrors.push(String(error));
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
  const server = await preview({
    configFile: false,
    root,
    logLevel: "error",
    plugins: [mocks, localStorageApi(directory), notesApi(directory)],
    build: { outDir: join(destination, "build", variant.name) },
    preview: { host: "127.0.0.1", port, strictPort: true },
  });
  const shell = await open(join(directory, "profile"));
  try {
    const { context, page } = shell;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript({
      content: `globalThis.__name = function (target) { return target; };(${instrument.toString()})();`,
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    if (trace)
      await cdp.send("Tracing.start", {
        categories:
          "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,cc,gpu,viz",
        transferMode: "ReturnAsStream",
      });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    await page.bringToFront();
    await page.locator('main[data-ready="true"]').waitFor();
    await page.waitForFunction(
      (count) => document.querySelectorAll(".canvas-app").length === count,
      workload.notes + workload.netsuite + workload.git + workload.projects,
    );
    const interactiveAt = await page.evaluate(() => performance.now());
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".notes-workspace .page-title").length === 12,
    );
    await page.evaluate(() => document.fonts.ready);
    await sleep(1500);
    // Off-screen apps are laid out during idle time after load; the
    // scenarios start once that has finished.
    const warmStarted = performance.now();
    for (let quiet = 0; quiet < 8 && performance.now() - warmStarted < 60000; ) {
      quiet = (await page.locator(".app-surface.is-warming").count())
        ? 0
        : quiet + 1;
      await sleep(100);
    }
    const settledMs = await page.evaluate(() => performance.now());
    const loaded = await counters(cdp);
    const load = await page.evaluate(() => ({
      readyMs: (window as any).bench.readyAt as number,
      firstAppMs: (window as any).bench.firstAppAt as number,
      allAppsMs: (window as any).bench.allAppsAt as number,
      loadTasks: (window as any).bench.loadTasks as number[],
      elements: document.querySelectorAll("*").length,
      blur: getComputedStyle(document.querySelector(".topbar-frost")!)
        .backdropFilter,
      refreshProbe: 0,
    }));
    await page.evaluate(() => {
      const bench = (window as any).bench;
      bench.focusLosses = 0;
      bench.hidden = 0;
    });

    const scenarios: Record<string, Scenario> = {};
    // Nothing happening: the cost of an open workspace at rest, and the
    // display's own callback cadence for interpreting the rows below.
    scenarios.idle = await measure(page, cdp, "idle", () => sleep(3000), 0, false);

    // The window may be smaller than requested on a small display, so every
    // gesture is placed from the real viewport and a free patch of canvas.
    const view = await page.evaluate(() => {
      const dock = document.querySelector(".dock")!.getBoundingClientRect();
      let free: { x: number; y: number } | undefined;
      for (let y = dock.top - 30; y > 90 && !free; y -= 20)
        for (let x = innerWidth - 40; x > innerWidth / 2 && !free; x -= 20)
          if (
            document
              .elementFromPoint(x, y)
              ?.classList.contains("canvas-background")
          )
            free = { x, y };
      return {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        free,
      };
    });
    if (!view.free) throw Error("No empty canvas to start a pan from.");
    const origin = view.free;
    const drag = async (button: "middle" | "left", steps: number) => {
      await page.mouse.move(origin.x, origin.y);
      await page.mouse.down({ button });
      for (let i = 0; i < steps; i++) {
        await page.mouse.move(
          origin.x - view.width * 0.3 * Math.sin((i / (steps - 1)) * Math.PI * 2),
          origin.y - view.height * 0.15 * Math.sin((i / (steps - 1)) * Math.PI * 4),
        );
        await sleep(4);
      }
      await page.mouse.up({ button });
    };
    scenarios.panNormal = await measure(page, cdp, "pan-normal", () =>
      drag("middle", 180),
    );
    // Space only arms panning; it must not cost a whole-document restyle.
    scenarios.spaceArm = await measure(page, cdp, "space-arm", async () => {
      await page.keyboard.down("Space");
      await sleep(300);
      await page.keyboard.up("Space");
    });
    const zoom = async (direction: number, ticks: number) => {
      await page.mouse.move(view.width / 2, view.height / 2);
      await page.keyboard.down("Control");
      for (let i = 0; i < ticks; i++) {
        await page.mouse.wheel(0, direction * 100);
        await sleep(16);
      }
      await page.keyboard.up("Control");
    };
    scenarios.zoomOut = await measure(page, cdp, "zoom-out", () => zoom(1, 16), 500);
    // Every app in view at once: the heaviest paint the canvas can ask for.
    scenarios.panOverview = await measure(page, cdp, "pan-overview", () =>
      drag("middle", 180),
    );
    scenarios.zoomIn = await measure(page, cdp, "zoom-in", () => zoom(-1, 16), 500);
    // A plain click: empty canvas, then a control inside an app.
    scenarios.clickCanvas = await measure(page, cdp, "click-canvas", () =>
      page.mouse.click(origin.x, origin.y),
    );
    scenarios.clickInApp = await measure(page, cdp, "click-in-app", () =>
      page.locator('[data-app-id="app-0"] .page-title').first().click(),
    );
    const dock = (name: string) =>
      page.locator(".dock-tab", { hasText: new RegExp(`^${name}$`) });
    scenarios.switchFar = await measure(
      page,
      cdp,
      "switch-far",
      () => dock("git 40").click(),
      700,
    );
    scenarios.switchBack = await measure(
      page,
      cdp,
      "switch-back",
      () => dock("notes 0").click(),
      700,
    );
    let rapid = 0;
    scenarios.switchRapid = await measure(
      page,
      cdp,
      "switch-rapid",
      async () => {
        for (const name of ["netsuite 14", "projects 44", "notes 5", "git 33", "netsuite 20", "notes 0"]) {
          await dock(name).click();
          await sleep(350);
          rapid++;
        }
      },
      400,
    );
    const move = async () => {
      const header = page.locator('[data-app-id="app-0"] .app-topline');
      const box = (await header.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 8);
      await page.mouse.down();
      for (let i = 0; i < 90; i++) {
        await page.mouse.move(
          box.x + box.width / 2 + 120 * Math.sin((i / 89) * Math.PI * 2),
          box.y + 8 + 60 * Math.sin((i / 89) * Math.PI * 4),
        );
        await sleep(4);
      }
      await page.mouse.up();
    };
    scenarios.dragApp = await measure(page, cdp, "drag-app", move);

    await cdp.send("HeapProfiler.collectGarbage");
    const memory = await counters(cdp);
    const validity = await page.evaluate(() => {
      const bench = (window as any).bench;
      return {
        focused: document.hasFocus(),
        visible: !document.hidden,
        focusLosses: bench.focusLosses as number,
        hidden: bench.hidden as number,
      };
    });
    const valid =
      validity.focused &&
      validity.visible &&
      !validity.focusLosses &&
      !validity.hidden &&
      !errors.length &&
      !fixtureErrors.length &&
      load.blur.includes("blur");
    if (index === 0 && !trace)
      await page.screenshot({ path: join(destination, `${variant.name}.png`) });
    let traceSummary: unknown;
    if (trace) {
      const completed = new Promise<any>((done) =>
        cdp.once("Tracing.tracingComplete", done),
      );
      await cdp.send("Tracing.end");
      const { stream } = await completed;
      const chunks: string[] = [];
      while (true) {
        const chunk = await cdp.send("IO.read", { handle: stream });
        chunks.push(chunk.data);
        if (chunk.eof) break;
      }
      await cdp.send("IO.close", { handle: stream });
      const file = join(destination, `${variant.name}-trace.json`);
      await writeFile(file, chunks.join(""));
      traceSummary = summarizeTrace(JSON.parse(await readFile(file, "utf8")));
    }
    const result = {
      variant: variant.name,
      commit: variant.commit,
      index,
      trace,
      valid,
      validity,
      errors: [...errors, ...fixtureErrors],
      view,
      load: {
        readyMs: round(load.readyMs),
        appsMountedMs: round(interactiveAt),
        // The app in view is usable / the last app has mounted.
        firstAppMs: round(load.firstAppMs),
        allAppsMs: round(load.allAppsMs),
        // Startup's main-thread stalls: the worst one, and the time beyond
        // 50 ms summed over all of them (total blocking time).
        longestLoadTaskMs: round(Math.max(0, ...load.loadTasks)),
        loadBlockingMs: round(
          load.loadTasks.reduce((sum, ms) => sum + Math.max(0, ms - 50), 0),
        ),
        settledMs: round(settledMs),
        elements: load.elements,
        // Renderer totals from navigation until the workspace has settled.
        scriptMs: round(loaded.ScriptDuration! * 1000),
        styleMs: round(loaded.RecalcStyleDuration! * 1000),
        layoutMs: round(loaded.LayoutDuration! * 1000),
        taskMs: round(loaded.TaskDuration! * 1000),
      },
      memory: {
        jsHeapUsedMb: round(memory.JSHeapUsedSize! / 2 ** 20),
        nodes: memory.Nodes,
        listeners: memory.JSEventListeners,
      },
      apiRequests,
      rapidSwitches: rapid,
      scenarios,
      traceSummary,
      browser: shell.version,
    };
    results.push(result);
    console.log(
      `${variant.name} #${index}${trace ? " (trace)" : ""} ${valid ? "" : "INVALID "}` +
        Object.entries(scenarios)
          .map(([name, s]) => `${name} p95=${s.frameP95} max=${s.frameMax} style=${s.styleMs} task=${s.taskMs}`)
          .join(" | "),
    );
  } finally {
    await shell.close();
    await new Promise<void>((done) => server.httpServer.close(() => done()));
  }
}

try {
  for (let index = 0; index < runs; index++)
    for (const variant of index % 2 ? [...variants].reverse() : variants)
      await run(variant, index);
  if (traced) for (const variant of variants) await run(variant, runs, true);
} finally {
  const median = (values: number[]) => percentile(values, 0.5);
  const summary: Record<string, any> = {};
  for (const variant of variants) {
    const accepted = results.filter(
      (result) => result.variant === variant.name && !result.trace && result.valid,
    );
    if (!accepted.length) continue;
    const scenarios: Record<string, any> = {};
    for (const name of Object.keys(accepted[0].scenarios)) {
      scenarios[name] = {};
      for (const key of Object.keys(accepted[0].scenarios[name])) {
        const values = accepted
          .map((result) => result.scenarios[name][key])
          .filter((value) => typeof value === "number");
        scenarios[name][key] = values.length ? round(median(values)) : null;
      }
    }
    summary[variant.name] = {
      commit: variant.commit,
      acceptedRuns: accepted.length,
      readyMs: round(median(accepted.map((r) => r.load.readyMs))),
      appsMountedMs: round(median(accepted.map((r) => r.load.appsMountedMs))),
      firstAppMs: round(median(accepted.map((r) => r.load.firstAppMs))),
      allAppsMs: round(median(accepted.map((r) => r.load.allAppsMs))),
      settledMs: round(median(accepted.map((r) => r.load.settledMs))),
      longestLoadTaskMs: round(median(accepted.map((r) => r.load.longestLoadTaskMs))),
      loadBlockingMs: round(median(accepted.map((r) => r.load.loadBlockingMs))),
      loadScriptMs: round(median(accepted.map((r) => r.load.scriptMs))),
      loadStyleMs: round(median(accepted.map((r) => r.load.styleMs))),
      loadLayoutMs: round(median(accepted.map((r) => r.load.layoutMs))),
      loadTaskMs: round(median(accepted.map((r) => r.load.taskMs))),
      jsHeapUsedMb: round(median(accepted.map((r) => r.memory.jsHeapUsedMb))),
      nodes: median(accepted.map((r) => r.memory.nodes)),
      scenarios,
    };
  }
  await writeFile(
    join(destination, "results.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        workload,
        runs,
        summary,
        results,
        limits: [
          "Production build in a bare Electron window (or Chromium with --browser chrome): the desktop bridge, webview guests and processing pages are not exercised.",
          "Medians of a few runs; do not read tails (p99) from them.",
          "Animation-callback intervals are cadence diagnostics, not presented frames.",
          "Input is paced from another process, so intervals include its jitter.",
          "Mock Git/Projects/NetSuite reads; real disposable SQLite workspace and Notes.",
        ],
      },
      null,
      2,
    ),
  );
  const names = Object.keys(summary);
  if (names.length) {
    const rows = Object.keys(summary[names[0]!].scenarios);
    const cell = (value: unknown) => String(value ?? "–").padStart(9);
    for (const key of ["frameP95", "frameMax", "over34ms", "firstFrameMs", "cameraFirstMs", "styleMs", "layoutMs", "scriptMs", "taskMs"]) {
      console.log(`\n${key}${" ".repeat(Math.max(1, 16 - key.length))}${names.map(cell).join("")}`);
      for (const row of rows)
        console.log(
          `  ${row.padEnd(14)}${names.map((name) => cell(summary[name].scenarios[row][key])).join("")}`,
        );
    }
    console.log(
      `\nready ms        ${names.map((name) => cell(summary[name].readyMs)).join("")}` +
        `\napps mounted ms ${names.map((name) => cell(summary[name].appsMountedMs)).join("")}` +
        `\nfirst app ms    ${names.map((name) => cell(summary[name].firstAppMs)).join("")}` +
        `\nall apps ms     ${names.map((name) => cell(summary[name].allAppsMs)).join("")}` +
        `\nsettled ms      ${names.map((name) => cell(summary[name].settledMs)).join("")}` +
        `\nlongest task ms ${names.map((name) => cell(summary[name].longestLoadTaskMs)).join("")}` +
        `\nblocking ms     ${names.map((name) => cell(summary[name].loadBlockingMs)).join("")}` +
        `\nload script ms  ${names.map((name) => cell(summary[name].loadScriptMs)).join("")}` +
        `\nload style ms   ${names.map((name) => cell(summary[name].loadStyleMs)).join("")}` +
        `\nload layout ms  ${names.map((name) => cell(summary[name].loadLayoutMs)).join("")}` +
        `\nload task ms    ${names.map((name) => cell(summary[name].loadTaskMs)).join("")}` +
        `\nJS heap MB      ${names.map((name) => cell(summary[name].jsHeapUsedMb)).join("")}` +
        `\nDOM nodes       ${names.map((name) => cell(summary[name].nodes)).join("")}`,
    );
  }
  console.log(`\nArtifacts: ${destination}`);
  if (!existsSync(join(destination, "results.json"))) process.exitCode = 1;
  if (check) {
    const failures = summary.candidate
      ? exceeded(summary.candidate.scenarios)
      : ["no accepted candidate run"];
    if (failures.length) {
      console.error(`\nOver budget:\n  ${failures.join("\n  ")}`);
      process.exitCode = 1;
    } else console.log("\nWithin budgets (bench/budgets.ts).");
  }
}
