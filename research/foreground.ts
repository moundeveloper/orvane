import { build, preview, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { launchElectronFixture } from "./electron-foreground.ts";
import {
  measureElectronFirstUse,
  captureElectronPanAppearance,
  captureOverviewAppearance,
} from "./electron-first-use.ts";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { localStorageApi } from "../server/storage-api.ts";
import { notesApi } from "../server/notes-api.ts";
import {
  seedForegroundFixture,
  assertForegroundDocuments,
  externalRead,
  workload,
  contentWorkload,
  type ContentProfile,
} from "./foreground-fixture.ts";

// Production foreground comparison in Chromium or the actual Electron shell.
// External reads use fixed responses and terminal output is simulated.
const runtime = process.env.ORVANE_FOREGROUND_RUNTIME || "browser";
if (!["browser", "electron"].includes(runtime))
  throw Error("Unknown foreground runtime.");
const cameraModes = (
  process.env.ORVANE_FOREGROUND_MODES ||
  (runtime === "electron" && process.env.ORVANE_FOREGROUND_MATRIX !== "0"
    ? "normal,overview"
    : "normal")
).split(",");
const visualOnly = process.env.ORVANE_FOREGROUND_VISUAL_ONLY === "1";
const diagnosticOnly = process.env.ORVANE_FOREGROUND_DIAGNOSTIC_ONLY === "1";
if (visualOnly && diagnosticOnly)
  throw Error("Choose visual-only or diagnostic-only, not both.");
if (cameraModes.some((mode) => !["normal", "overview"].includes(mode)))
  throw Error("Unknown camera mode.");
const experiment = process.env.ORVANE_FOREGROUND_EXPERIMENT || "pan";
const contentProfile = (process.env.ORVANE_FOREGROUND_CONTENT_PROFILE ||
  "mixed") as ContentProfile;
if (!["mixed", "notes", "scripts", "git", "projects"].includes(contentProfile))
  throw Error("Unknown content profile.");
if (contentProfile !== "mixed") {
  if (
    runtime !== "electron" ||
    experiment !== "overview" ||
    cameraModes.some((mode) => mode !== "overview") ||
    visualOnly ||
    diagnosticOnly ||
    (process.env.ORVANE_FOREGROUND_ABLATION || "none") !== "none"
  )
    throw Error(
      "Content profiles require native overview comparisons without ablations.",
    );
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", "src"]);
  } catch {
    throw Error(
      "Content-density comparisons require clean production sources under src.",
    );
  }
}
const primaryAppCount = contentProfile === "mixed" ? 50 : 20;
// Counterfactual diagnostics only: these deliberately change appearance and
// must never be interpreted as production optimization candidates.
const ablation = process.env.ORVANE_FOREGROUND_ABLATION || "none";
if (!["none", "backdrop", "dots"].includes(ablation))
  throw Error("Unknown foreground ablation.");
if (
  ablation !== "none" &&
  (experiment !== "overview" ||
    cameraModes.some((mode) => mode !== "overview") ||
    visualOnly)
)
  throw Error("Ablations require the overview experiment and overview mode.");
const candidateStyleAppend =
  ablation === "backdrop"
    ? "\n.topbar-frost { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }\n"
    : ablation === "dots"
      ? "\n.canvas-dots { visibility: hidden !important; }\n"
      : "";
const traceCategories =
  "devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline" +
  (process.env.ORVANE_FOREGROUND_RASTER_TRACE === "1"
    ? ",cc,disabled-by-default-cc.debug"
    : "");
if (!["pan", "notes", "overview"].includes(experiment))
  throw Error("Unknown foreground experiment.");
const baselineCommit =
  contentProfile !== "mixed"
    ? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    : experiment === "overview"
      ? "18a3261"
      : experiment === "pan"
        ? "c5d47d0"
        : "805bbc8";
const root = resolve(".");
const destination = resolve(
  "artifacts/performance/foreground",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
await mkdir(destination, { recursive: true });
const repetitions = Number(process.env.ORVANE_FOREGROUND_REPETITIONS || 5);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
  throw Error("Repetitions must be 1–10.");
const cachedBrowser = `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe`;
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync(cachedBrowser) ? cachedBrowser : undefined);
const baselineSource = execFileSync(
  "git",
  ["show", `${baselineCommit}:src/components/notes/stores/workspace.ts`],
  { encoding: "utf8" },
);
// Apply the navigation correctness fix to both builds; only child lookup
// implementation differs. Never benchmark the known destructive loading race.
const currentSource = readFileSync(
  "src/components/notes/stores/workspace.ts",
  "utf8",
);
const commonFixedBaseline =
  experiment !== "notes"
    ? currentSource
    : currentSource.slice(
        0,
        currentSource.indexOf("      childrenByParent()"),
      ) +
      baselineSource.slice(
        baselineSource.indexOf("      childrenOf()"),
        baselineSource.indexOf("      breadcrumb(state)"),
      ) +
      currentSource.slice(currentSource.indexOf("      breadcrumb(state)"));
const baselinePanSources = new Map(
  ["src/App.vue", "src/style.css"].map((path) => [
    path,
    contentProfile !== "mixed"
      ? readFileSync(path, "utf8")
      : execFileSync(
          "git",
          [
            "show",
            `${experiment === "overview" ? baselineCommit : "c5d47d0"}:${path}`,
          ],
          { encoding: "utf8" },
        ),
  ]),
);
for (const variant of ["baseline", "candidate"]) {
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    plugins: [
      vue({
        template: {
          compilerOptions: { isCustomElement: (tag) => tag === "webview" },
        },
      }),
      {
        name: "foreground-baseline",
        enforce: "pre",
        transform(_code, id) {
          if (
            variant === "candidate" &&
            candidateStyleAppend &&
            id.replaceAll("\\", "/").endsWith("/src/style.css")
          )
            return _code + candidateStyleAppend;
          if (variant === "baseline" && experiment !== "notes") {
            for (const [path, source] of baselinePanSources)
              if (id.replaceAll("\\", "/").endsWith(`/${path}`)) return source;
          }
          if (
            experiment === "notes" &&
            variant === "baseline" &&
            id
              .replaceAll("\\", "/")
              .endsWith("/src/components/notes/stores/workspace.ts")
          )
            return commonFixedBaseline;
        },
      },
    ],
    resolve: { alias: { "@": join(root, "src") } },
    build: { outDir: join(destination, variant), cssMinify: "esbuild" },
  });
}

const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ] ?? null;
async function afterPaint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
const results: any[] = [];
const rejectedAttempts: any[] = [];
let failure: string | undefined;
async function finishTrace(cdp: any, path: string) {
  const completed = new Promise<any>((resolve) =>
    cdp.once("Tracing.tracingComplete", resolve),
  );
  await cdp.send("Tracing.end");
  const { stream } = await completed;
  let trace = "";
  while (true) {
    const chunk = await cdp.send("IO.read", { handle: stream });
    trace += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  await writeFile(path, trace);
}
async function run(
  variant: string,
  index: number,
  diagnostic = false,
  appCount = 50,
  cameraMode = "normal",
  attempt = 0,
) {
  const density =
    contentProfile === "mixed"
      ? "standard"
      : variant === "baseline"
        ? "low"
        : "high";
  const settings = contentWorkload(density);
  const directory = join(
    destination,
    `data-${variant}-${index}-${appCount}-${cameraMode}${diagnostic ? "-trace" : ""}-attempt-${attempt}`,
  );
  const expected = seedForegroundFixture(directory, {
    appCount,
    innerTabs: runtime === "electron",
    profile: contentProfile,
    density,
  });
  const requests: Record<string, number> = {};
  const fixtureErrors: string[] = [];
  const mocks: Plugin = {
    name: "foreground-fixtures",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] || "";
        if (path.startsWith("/__orvane/"))
          requests[path] = (requests[path] || 0) + 1;
        if (
          !path.startsWith("/__orvane/git/") &&
          !path.startsWith("/__orvane/projects/")
        )
          return next();
        try {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(externalRead(path, settings)));
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
    build: { outDir: join(destination, variant) },
    preview: {
      host: runtime === "electron" ? "localhost" : "127.0.0.1",
      port: 5186,
      strictPort: true,
    },
  });
  const desktop =
    runtime === "electron"
      ? await launchElectronFixture(root, directory, 5186, {
          scripts: settings.scripts,
        })
      : undefined;
  const browser = desktop
    ? undefined
    : await chromium.launch({
        headless: false,
        executablePath,
        args: ["--window-position=0,0", "--window-size=1460,1080"],
      });
  try {
    const context =
      desktop?.context ??
      (await browser!.newContext({
        viewport: { width: 1440, height: 1000 },
      }));
    const page = desktop?.page ?? (await context.newPage());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const initialize = () => {
      localStorage.setItem("orvane.examples.v1", "installed");
      const w = window as any;
      w.foreground = {
        focusLosses: 0,
        hidden: 0,
        samples: 0,
        longTasks: [] as number[],
        frames: [] as number[],
      };
      addEventListener("blur", () => w.foreground.focusLosses++);
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) w.foreground.hidden++;
      });
      new PerformanceObserver((list) => {
        w.foreground.longTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        );
      }).observe({ type: "longtask", buffered: true });
      if (!w.orvaneDesktop)
        w.orvaneDesktop = {
          netsuite: {
            tabs: async () => [
              { id: "fixture", label: "Fixture", status: "ready", count: 1 },
            ],
            run: async (_environment: string, op: string) => {
              if (op === "scripts")
                return {
                  rows: Array.from(
                    { length: (window as any).foregroundScripts },
                    (_, i) => ({
                      id: i + 1,
                      name: `Script ${i}`,
                      scriptfile: `script-${i}.js`,
                      fileid: i + 1,
                      owner: "Fixture",
                      scriptid: `customscript_${i}`,
                      scripttype: "UserEvent",
                    }),
                  ),
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
    };
    // tsx preserves function names with a helper in serialized callbacks.
    // Supply it before invoking the initialization in the browser realm.
    await page.addInitScript({
      content: `globalThis.__name = function (target) { return target; };globalThis.foregroundScripts = ${settings.scripts};(${initialize.toString()})();`,
    });
    const cdp = await context.newCDPSession(page);
    if (diagnostic)
      await cdp.send("Tracing.start", {
        categories: traceCategories,
        transferMode: "ReturnAsStream",
      });
    await page.goto(
      runtime === "electron"
        ? "http://localhost:5186/"
        : "http://127.0.0.1:5186/",
      { waitUntil: "load" },
    );
    await page.bringToFront();
    await desktop?.focus();
    await page.locator('main[data-ready="true"]').waitFor();
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll(".notes-workspace .page-title").length ===
          expected.notes &&
        document.querySelectorAll(".canvas-app").length === expected.apps,
      expected,
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    if (contentProfile === "notes")
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll(".notes-workspace [data-block-id]")
            .length === n,
        appCount * settings.blocksPerDocument,
      );
    if (contentProfile === "git")
      await page.waitForFunction(
        (n) => document.querySelectorAll(".git-commit-row").length === n,
        appCount * settings.commits,
      );
    if (contentProfile === "scripts")
      await page.waitForFunction(
        (n) =>
          [...document.querySelectorAll(".canvas-app")].filter((app) =>
            app.querySelector(".script-row"),
          ).length === n,
        appCount,
      );
    await desktop?.renderedMetadata();
    const app = page.locator('[data-app-id="app-0"]');
    const counts = await page.evaluate(() => ({
      apps: document.querySelectorAll(".canvas-app").length,
      notes: document.querySelectorAll(".notes-workspace:not(.loading)").length,
      projects: document.querySelectorAll(".projects-hub").length,
      git: document.querySelectorAll(".git-toolbar").length,
      scripts: document.querySelectorAll(".scripts-table").length,
      cabinets: document.querySelectorAll(".fc-workspace").length,
      queryViews: document.querySelectorAll(".ns-query-view").length,
      terminals: document.querySelectorAll(".xterm").length,
      elements: document.querySelectorAll("*").length,
      notesBlocks: document.querySelectorAll(".notes-workspace [data-block-id]")
        .length,
      gitCommits: document.querySelectorAll(".git-commit-row").length,
      scriptRows: document.querySelectorAll(".script-row").length,
      blur: getComputedStyle(document.querySelector(".topbar-frost")!)
        .backdropFilter,
      dotsVisibility: getComputedStyle(document.querySelector(".canvas-dots")!)
        .visibility,
    }));
    for (const key of [
      "apps",
      "notes",
      "projects",
      "git",
      "scripts",
      "cabinets",
      "queryViews",
      "terminals",
    ] as const)
      if (counts[key] !== expected[key])
        throw Error(
          `Fixture incomplete: ${JSON.stringify({ counts, expected, errors })}`,
        );
    if (variant === "candidate" && ablation === "backdrop") {
      if (counts.blur !== "none")
        throw Error("Backdrop ablation did not apply.");
    } else if (!counts.blur.includes("blur"))
      throw Error("Header blur is missing.");
    if (
      variant === "candidate" &&
      ablation === "dots" &&
      (await page
        .locator(".canvas-dots")
        .evaluate((el) => getComputedStyle(el).visibility)) !== "hidden"
    )
      throw Error("Dots ablation did not apply.");
    if (cameraMode === "overview") {
      await page.mouse.move(400, 300);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, 2500);
      await page.keyboard.up("Control");
      await page.waitForFunction(
        () =>
          Math.abs(
            document
              .querySelector<HTMLElement>(".canvas-app")!
              .getBoundingClientRect().width /
              document.querySelector<HTMLElement>(".canvas-app")!.offsetWidth -
              0.2,
          ) < 0.001,
      );
      await page
        .getByRole("button", { name: "Center canvas", exact: true })
        .click();
      await page
        .locator(".canvas-plane.camera-moving")
        .waitFor({ state: "detached" });
      await afterPaint(page);
    }
    if (contentProfile === "projects") {
      for (let i = 0; i < appCount; i++) {
        const hub = page.locator(`[data-app-id="app-${i}"]`);
        await hub
          .locator(".terminal-host:visible textarea")
          .evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
        await page.keyboard.type("fixture-output");
        await page.keyboard.press("Enter");
        await hub
          .locator(".terminal-host")
          .filter({
            hasText: `Controlled fixture output ${settings.terminalLines - 1}`,
          })
          .first()
          .waitFor();
      }
      if (requests["/__orvane/projects/terminal/run"] !== appCount)
        throw Error(
          "Terminal fixture did not execute exactly one mock command per app.",
        );
    }
    if (contentProfile === "projects")
      counts.elements = await page.locator("*").count();
    // Identical quiet period for both variants. Native process snapshots and
    // diagnostic DOM mapping stay outside the comparative timing window.
    await page.waitForTimeout(250);
    const resourcesBefore = await desktop?.resources();
    let paintNodes: any[] | undefined;
    if (diagnostic) {
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      paintNodes = [];
      const visit = (node: any) => {
        const attrs = node.attributes ?? [];
        const appIndex = attrs.indexOf("data-app-id");
        if (appIndex >= 0)
          paintNodes!.push({
            backendNodeId: node.backendNodeId,
            app: attrs[appIndex + 1],
          });
        for (const child of node.children ?? []) visit(child);
      };
      visit(root);
    }
    const view = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      scale:
        document
          .querySelector<HTMLElement>(".canvas-app")!
          .getBoundingClientRect().width /
        document.querySelector<HTMLElement>(".canvas-app")!.offsetWidth,
      transform: getComputedStyle(document.querySelector(".canvas-plane")!)
        .transform,
      appRects: [...document.querySelectorAll(".canvas-app")].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
      visibleApps: [...document.querySelectorAll(".canvas-app")].filter(
        (el) => {
          const r = el.getBoundingClientRect();
          return (
            r.right > 0 &&
            r.bottom > 0 &&
            r.left < innerWidth &&
            r.top < innerHeight
          );
        },
      ).length,
    }));
    if (
      contentProfile !== "mixed" &&
      (view.visibleApps !== appCount || Math.abs(view.scale - 0.2) > 0.001)
    )
      throw Error(
        "Content profile did not reach its equal-area overview geometry.",
      );
    const nativeAnchor =
      runtime === "electron"
        ? await page.evaluate(() => {
            for (let y = 100; y < innerHeight - 110; y += 12)
              for (let x = 18; x < innerWidth - 180; x += 12) {
                const el = document.elementFromPoint(x, y);
                if (
                  el?.closest("main") &&
                  !el.closest(
                    ".canvas-app,.spatial-group,.topbar,.dock,.floating-panel",
                  )
                )
                  return { x, y };
              }
            throw Error("No visible empty canvas point for the pan fixture.");
          })
        : undefined;
    await desktop?.focus();
    // Start the validity window after navigation/setup. A focused/visible
    // document is required throughout every measured operation.
    await page.evaluate(() => {
      const w = window as any,
        f = w.foreground;
      Object.assign(f, {
        focusLosses: 0,
        hidden: 0,
        samples: 0,
        invalid: false,
        longTasks: [],
        frames: [],
        phaseFrames: { start: [], continuous: [], stop: [] },
        phase: "selection",
      });
      performance.mark("foreground:start");
      let previous: number | undefined;
      w.foregroundFrame = (time: number) => {
        f.samples++;
        if (!document.hasFocus() || document.hidden) f.invalid = true;
        if (previous !== undefined) f.frames.push(time - previous);
        if (previous !== undefined && f.phaseFrames[f.phase])
          f.phaseFrames[f.phase].push(time - previous);
        previous = time;
        if (!f.stop) requestAnimationFrame(w.foregroundFrame);
      };
      requestAnimationFrame(w.foregroundFrame);
    });
    const select = async (pageNumber: number) => {
      await page.evaluate((pageNumber) => {
        const app = document.querySelector('[data-app-id="app-0"]')!;
        const f = (window as any).foreground;
        f.selectionMs = null;
        let start: number;
        const clicked = () => {
          start = performance.now();
          performance.mark(`foreground:select-${pageNumber}:start`);
          app.removeEventListener("click", clicked, true);
        };
        app.addEventListener("click", clicked, true);
        const observer = new MutationObserver(() => {
          if (
            start !== undefined &&
            app
              .querySelector(".block-content")
              ?.textContent?.startsWith(`Document ${pageNumber} paragraph 0`)
          ) {
            observer.disconnect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                f.selectionMs = performance.now() - start;
                performance.mark(`foreground:select-${pageNumber}:ready`);
              }),
            );
          }
        });
        observer.observe(app, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }, pageNumber);
      await app
        .locator(
          `.sb-scroll .pt-title[aria-label="Page ${String(pageNumber).padStart(4, "0")}"]`,
        )
        .click();
      try {
        await page.waitForFunction(
          () => (window as any).foreground.selectionMs !== null,
          undefined,
          { timeout: 5000 },
        );
      } catch {
        throw Error(
          `Selection ${pageNumber} did not complete: ${JSON.stringify(await app.evaluate((app) => ({ title: app.querySelector(".page-title")?.textContent, body: app.querySelector(".block-content")?.textContent?.slice(0, 100), errors: Array.from(app.querySelectorAll('[role="alert"]')).map((el) => el.textContent) })))}, page errors: ${errors.join("; ")}`,
        );
      }
      return page.evaluate(
        () => (window as any).foreground.selectionMs as number,
      );
    };
    const firstSelectionMs = cameraMode === "normal" ? await select(1) : null;
    const warmSelectionMs = cameraMode === "normal" ? await select(0) : null;
    await page.evaluate(() => {
      (window as any).foreground.phase = "start";
      performance.mark("foreground:pan:start");
    });
    // Exercise real canvas middle-drag events. Frame callback intervals are
    // cadence diagnostics, never proof that every frame was presented.
    const anchor = runtime === "electron" ? nativeAnchor! : { x: 1260, y: 870 };
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.down({ button: "middle" });
    await afterPaint(page);
    await page.evaluate(() => {
      (window as any).foreground.phase = "continuous";
      performance.mark("foreground:pan:continuous");
    });
    for (let i = 0; i < 60; i++)
      await page.mouse.move(
        runtime === "electron"
          ? anchor.x + 80 * (1 - Math.cos((i / 59) * Math.PI * 2))
          : anchor.x - 160 * Math.sin((i / 59) * Math.PI * 2),
        anchor.y,
      );
    await afterPaint(page);
    await page.evaluate(() => {
      (window as any).foreground.phase = "stop";
      performance.mark("foreground:pan:stop");
    });
    await page.mouse.up({ button: "middle" });
    await afterPaint(page);
    await page.evaluate(() => performance.mark("foreground:pan:end"));
    const sample = await page.evaluate(() => {
      const f = (window as any).foreground;
      f.stop = true;
      return { ...f, focused: document.hasFocus(), visible: !document.hidden };
    });
    if (
      sample.invalid ||
      sample.focusLosses ||
      sample.hidden ||
      !sample.focused ||
      !sample.visible ||
      errors.length ||
      fixtureErrors.length
    )
      throw Error(
        `Invalid foreground run: ${JSON.stringify({ ...sample, frames: undefined, longTasks: undefined, errors, fixtureErrors })}`,
      );
    if (index === 0 || diagnostic)
      await page.screenshot({
        path: join(
          destination,
          `${variant}-${index}-${appCount}-${cameraMode}${diagnostic ? "-trace" : ""}.png`,
        ),
      });
    const result = {
      overviewAppearance: undefined as
        Awaited<ReturnType<typeof captureOverviewAppearance>> | undefined,
      appearance: undefined as
        Awaited<ReturnType<typeof captureElectronPanAppearance>> | undefined,
      firstUse: undefined as
        Awaited<ReturnType<typeof measureElectronFirstUse>> | undefined,
      runtime,
      appCount,
      cameraMode,
      contentProfile,
      density,
      fixtureSettings: settings,
      resourcesBefore,
      resourcesAfter: await desktop?.resources(),
      paintNodes,
      view,
      electron: desktop?.metadata,
      nativeIPC: desktop ? await desktop.validate() : undefined,
      variant,
      index,
      diagnostic,
      counts,
      firstSelectionMs,
      warmSelectionMs,
      frameIntervalP50: percentile(sample.frames, 0.5),
      frameIntervalP95: percentile(sample.frames, 0.95),
      maxFrameInterval: Math.max(...sample.frames),
      frameSamples: sample.frames.length,
      panPhases: Object.fromEntries(
        Object.entries(sample.phaseFrames as Record<string, number[]>).map(
          ([phase, intervals]) => [
            phase,
            {
              samples: intervals.length,
              maxInterval: Math.max(...intervals),
              medianInterval: percentile(intervals, 0.5),
            },
          ],
        ),
      ),
      longTasks: sample.longTasks,
      requests,
      validity: {
        focused: sample.focused,
        visible: sample.visible,
        focusLosses: sample.focusLosses,
        hidden: sample.hidden,
        samples: sample.samples,
      },
      browserVersion: browser?.version() ?? desktop!.metadata.versions.chrome,
    };
    // Outside the timing window: verify the persisted document, not just DOM.
    assertForegroundDocuments(directory, settings.blocksPerDocument);
    results.push(result);
    if (diagnostic)
      await finishTrace(
        cdp,
        join(destination, `${variant}-${appCount}-${cameraMode}-trace.json`),
      );
    if (
      desktop &&
      diagnostic &&
      cameraMode === "overview" &&
      contentProfile === "mixed" &&
      ablation === "none"
    ) {
      result.overviewAppearance = await captureOverviewAppearance(
        page,
        destination,
        variant,
      );
      await desktop.validate();
      assertForegroundDocuments(directory, settings.blocksPerDocument);
    }
    if (desktop && appCount === 50 && cameraMode === "normal") {
      if (diagnostic)
        await cdp.send("Tracing.start", {
          categories:
            "devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline",
          transferMode: "ReturnAsStream",
        });
      result.firstUse = await measureElectronFirstUse(
        page,
        join(destination, `first-use-${variant}-${index}.png`),
      );
      if (diagnostic)
        await finishTrace(
          cdp,
          join(destination, `${variant}-first-use-trace.json`),
        );
      result.nativeIPC = await desktop.validate();
      if (
        result.nativeIPC.calls.filter((op: string) => op === "query").length !==
          1 ||
        result.nativeIPC.calls.filter((op: string) => op === "file").length !==
          1
      )
        throw Error("Cold/warm panes repeated execution or file loading.");
      if (requests["/__orvane/projects/terminal/run"] !== 1)
        throw Error("Controlled command count changed.");
      assertForegroundDocuments(directory, settings.blocksPerDocument);
      if (errors.length) throw Error(`First-use errors: ${errors.join("; ")}`);
      if (visualOnly) {
        result.appearance = await captureElectronPanAppearance(
          page,
          destination,
        );
        await desktop.validate();
      }
    }
    console.log(
      JSON.stringify({
        variant,
        ablation,
        contentProfile,
        density,
        index,
        appCount,
        cameraMode,
        diagnostic,
        firstSelectionMs,
        warmSelectionMs,
        panPhases: result.panPhases,
        firstUse: result.firstUse,
      }),
    );
  } finally {
    if (desktop) await desktop.close();
    else await browser!.close();
    await new Promise<void>((resolve) =>
      server.httpServer.close(() => resolve()),
    );
  }
}
async function acceptedRun(
  variant: string,
  index: number,
  diagnostic = false,
  appCount = 50,
  cameraMode = "normal",
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = results.length;
    try {
      await run(variant, index, diagnostic, appCount, cameraMode, attempt);
      return;
    } catch (error) {
      results.splice(before);
      const reason = String(error);
      if (
        !/Electron window is not foreground|Invalid foreground run|Interrupted first-use run/.test(
          reason,
        )
      )
        throw error;
      const rejected = {
        variant,
        index,
        diagnostic,
        appCount,
        cameraMode,
        attempt,
        reason,
      };
      rejectedAttempts.push(rejected);
      console.log(JSON.stringify({ rejected: true, ...rejected }));
      if (attempt === 2) throw error;
    }
  }
}
try {
  if (visualOnly) {
    if (runtime !== "electron") throw Error("Visual probe requires Electron.");
    await acceptedRun("candidate", 0, true, 50, "normal");
  } else {
    const modes = cameraModes;
    if (
      !diagnosticOnly &&
      contentProfile === "mixed" &&
      runtime === "electron" &&
      process.env.ORVANE_FOREGROUND_MATRIX !== "0"
    )
      for (const count of [5, 10, 20, 35])
        for (const mode of modes)
          for (const variant of ["baseline", "candidate"])
            await acceptedRun(variant, 0, false, count, mode);
    for (const mode of modes) {
      for (let index = 0; !diagnosticOnly && index < repetitions; index++)
        for (const variant of index % 2
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"])
          await acceptedRun(variant, index, false, primaryAppCount, mode);
      await acceptedRun("candidate", repetitions, true, primaryAppCount, mode);
      if (experiment !== "notes")
        await acceptedRun("baseline", repetitions, true, primaryAppCount, mode);
    }
  }
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  await writeFile(
    join(destination, "results.json"),
    JSON.stringify(
      {
        runtime,
        failure,
        visualOnly,
        diagnosticOnly,
        experiment,
        contentProfile,
        comparisonKind:
          contentProfile === "mixed" ? "implementation" : "content-density",
        ablation,
        candidateStyleAppend,
        traceCategories,
        baselineCommit,
        candidateBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        workload:
          contentProfile === "mixed"
            ? workload
            : {
                apps: primaryAppCount,
                columns: 5,
                width: 1200,
                height: 760,
                low: contentWorkload("low"),
                high: contentWorkload("high"),
              },
        sources: {
          baselineAppSha256: createHash("sha256")
            .update(
              experiment !== "notes"
                ? baselinePanSources.get("src/App.vue")!
                : readFileSync("src/App.vue"),
            )
            .digest("hex"),
          candidateAppSha256: createHash("sha256")
            .update(readFileSync("src/App.vue"))
            .digest("hex"),
          baselineStyleSha256: createHash("sha256")
            .update(
              experiment !== "notes"
                ? baselinePanSources.get("src/style.css")!
                : readFileSync("src/style.css"),
            )
            .digest("hex"),
          candidateStyleSha256: createHash("sha256")
            .update(readFileSync("src/style.css"))
            .update(candidateStyleAppend)
            .digest("hex"),
          commonFixedBaselineStoreSha256: createHash("sha256")
            .update(commonFixedBaseline)
            .digest("hex"),
          candidateStoreSha256: createHash("sha256")
            .update(currentSource)
            .digest("hex"),
          commonPageViewSha256: createHash("sha256")
            .update(
              readFileSync("src/components/notes/components/PageView.vue"),
            )
            .digest("hex"),
        },
        comparisonsCompleted:
          results.filter(
            (result) =>
              !result.diagnostic && result.appCount === primaryAppCount,
          ).length ===
          repetitions * 2 * cameraModes.length,
        repetitions,
        results,
        rejectedAttempts,
        limits: [
          ablation !== "none"
            ? "Counterfactual ablation deliberately changes appearance; not a production optimization candidate."
            : "Production appearance is an acceptance requirement.",
          runtime === "electron"
            ? "Actual Electron shell and preload with isolated userData; native NetSuite IPC is mocked."
            : "Production Chromium browser, not Electron.",
          contentProfile === "mixed"
            ? "App counts below 50 are single screening pairs, not repeated timing evidence."
            : "Content-density comparison uses identical production code, twenty equal app rectangles and low/high payloads; not an implementation speedup.",
          "Overview uses the actual UI minimum zoom of 0.2; large fixtures may not all fit on screen.",
          "Focused/visible document checks; screenshots support visual review but do not establish presented frame rate.",
          experiment !== "notes"
            ? "Only App.vue and style.css differ from the selected baseline; Notes loading fix and child index are common."
            : "Only child lookup implementation differs; the document-loading correctness fix and pan implementation are common.",
          "Mock external reads; real isolated SQLite workspace and Notes storage.",
          contentProfile !== "mixed"
            ? "Projects preloads one mock command per app before pan; output stays static during timing. No live backend or sustained terminal updates."
            : runtime === "electron"
              ? "Pan samples use the restored initial workload; the separate first-use phase adds a retained query result, expanded deployments and controlled terminal output. Large Git diffs are not included."
              : "No query outputs, expanded deployment panels, Git diff or active terminal commands in this initial fixture.",
          "Frame intervals cover selection and scripted pan together; first/warm readiness ends after two animation callbacks, not a measured physical display presentation.",
          "No heap snapshots, 30-minute soak or 50-app capacity guarantee.",
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Artifacts: ${destination}`);
}
