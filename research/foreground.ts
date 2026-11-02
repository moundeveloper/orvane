import { build, preview, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
} from "./foreground-fixture.ts";

// Production browser comparison of the Notes metadata pass only. No live
// NetSuite, filesystem, Git or command calls are permitted by this fixture.
const baselineCommit = "805bbc8";
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
  currentSource.slice(0, currentSource.indexOf("      childrenByParent()")) +
  baselineSource.slice(
    baselineSource.indexOf("      childrenOf()"),
    baselineSource.indexOf("      breadcrumb(state)"),
  ) +
  currentSource.slice(currentSource.indexOf("      breadcrumb(state)"));
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
async function run(variant: string, index: number, diagnostic = false) {
  const directory = join(
    destination,
    `data-${variant}-${index}${diagnostic ? "-trace" : ""}`,
  );
  seedForegroundFixture(directory);
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
    build: { outDir: join(destination, variant) },
    preview: { host: "127.0.0.1", port: 5186, strictPort: true },
  });
  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args: ["--window-position=0,0", "--window-size=1460,1080"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
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
    };
    // tsx preserves function names with a helper in serialized callbacks.
    // Supply it before invoking the initialization in the browser realm.
    await page.addInitScript({
      content: `globalThis.__name = function (target) { return target; };(${initialize.toString()})();`,
    });
    const cdp = await context.newCDPSession(page);
    if (diagnostic)
      await cdp.send("Tracing.start", {
        categories:
          "devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline",
        transferMode: "ReturnAsStream",
      });
    await page.goto("http://127.0.0.1:5186/", { waitUntil: "load" });
    await page.bringToFront();
    await page.locator('main[data-ready="true"]').waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".notes-workspace .page-title").length ===
          12 && document.querySelectorAll(".canvas-app").length === 50,
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
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
      blur: getComputedStyle(document.querySelector(".topbar-frost")!)
        .backdropFilter,
    }));
    if (
      counts.apps !== 50 ||
      counts.notes !== 12 ||
      counts.projects !== 8 ||
      counts.git !== 10 ||
      counts.scripts !== 7 ||
      counts.cabinets !== 7 ||
      counts.queryViews !== 6 ||
      counts.terminals !== 8 ||
      !counts.blur.includes("blur")
    )
      throw Error(
        `Fixture incomplete: ${JSON.stringify({ counts, errors, notices: await page.locator(".ns-notice,.ns-error").allTextContents(), tabs: await page.locator(".split-tab").allTextContents() })}`,
      );
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
      });
      performance.mark("foreground:start");
      let previous: number | undefined;
      w.foregroundFrame = (time: number) => {
        f.samples++;
        if (!document.hasFocus() || document.hidden) f.invalid = true;
        if (previous !== undefined) f.frames.push(time - previous);
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
    const firstSelectionMs = await select(1);
    const warmSelectionMs = await select(0);
    await page.evaluate(() => performance.mark("foreground:pan:start"));
    // Exercise real canvas middle-drag events. Frame callback intervals are
    // cadence diagnostics, never proof that every frame was presented.
    await page.mouse.move(1260, 870);
    await page.mouse.down({ button: "middle" });
    for (let i = 0; i < 60; i++)
      await page.mouse.move(1260 - 160 * Math.sin((i / 59) * Math.PI * 2), 870);
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
          `${variant}-${index}${diagnostic ? "-trace" : ""}.png`,
        ),
      });
    const result = {
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
      longTasks: sample.longTasks,
      requests,
      validity: {
        focused: sample.focused,
        visible: sample.visible,
        focusLosses: sample.focusLosses,
        hidden: sample.hidden,
        samples: sample.samples,
      },
      browserVersion: browser.version(),
    };
    // Outside the timing window: verify the persisted document, not just DOM.
    assertForegroundDocuments(directory);
    results.push(result);
    if (diagnostic) {
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
      await writeFile(join(destination, "candidate-trace.json"), trace);
    }
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
    await new Promise<void>((resolve) =>
      server.httpServer.close(() => resolve()),
    );
  }
}
try {
  for (let index = 0; index < repetitions; index++) {
    for (const variant of index % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"])
      await run(variant, index);
  }
  await run("candidate", repetitions, true);
} finally {
  await writeFile(
    join(destination, "results.json"),
    JSON.stringify(
      {
        baselineCommit,
        candidateCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        workload,
        sources: {
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
          results.filter((result) => !result.diagnostic).length ===
          repetitions * 2,
        repetitions,
        results,
        limits: [
          "Production Chromium browser, not Electron.",
          "Focused/visible document checks; screenshots support visual review but do not establish presented frame rate.",
          "Only child lookup implementation differs; both variants include the common document-loading correctness fix discovered during setup.",
          "Mock external reads; real isolated SQLite workspace and Notes storage.",
          "No query outputs, expanded deployment panels, Git diff or active terminal commands in this initial fixture.",
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
