// The Test runs app's view of flow_tests (server/flow-tests.ts): runs, the
// run in progress, test plans, and the recorded frames and failure pictures.
// Local, same-origin only, like the site memory API. Pictures are served only
// when a saved run points at them, so no other file can be read through it.
import type { Connect, Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SiteMemoryStore } from "./site-memory.ts";
import type { LiveRun, TestRun } from "../src/flowRunner.ts";
import { FlowTestStore } from "./flow-test-store.ts";

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("runs") }).strict(),
  z.object({ action: z.literal("run"), runId: z.string().max(60) }).strict(),
  z.object({ action: z.literal("live") }).strict(),
  z.object({ action: z.literal("tests") }).strict(),
  // Runs the Test runs app played itself.
  z.object({ action: z.literal("save-image"), runId: z.string().max(60), file: z.string().max(40), data: z.string().max(12_000_000) }).strict(),
  z.object({ action: z.literal("save-run"), run: z.record(z.string(), z.unknown()) }).strict(),
]);

type Frames = { file: string; ms: number }[];

export function flowTestsApi(directory: string): Plugin {
  const root = join(directory, "flow-tests");
  let store: SiteMemoryStore | undefined;
  const testStore = new FlowTestStore(directory);
  /** A run from the app may only point at its own pictures and at page recordings. */
  const checkRun = (run: TestRun) => {
    if (typeof run.runId !== "string" || typeof run.site !== "string" || !Array.isArray(run.flows)) throw Error("Not a test run.");
    const inRoot = (file?: string) => !file || resolve(file).startsWith(resolve(root));
    for (const flow of run.flows) {
      if (!inRoot(flow.files?.screenshot) || !inRoot(flow.files?.sheet)) throw Error("A run picture is outside the runs folder.");
      if (flow.recording?.folder && !/[\\/]recordings[\\/][\w.-]+$/.test(flow.recording.folder)) throw Error("A recording is outside the recordings folder.");
    }
    return run;
  };
  const runs = (): TestRun[] => {
    try {
      return JSON.parse(readFileSync(join(root, "runs.json"), "utf8")) as TestRun[];
    } catch {
      return [];
    }
  };
  const frames = (folder?: string): Frames => {
    if (!folder) return [];
    try {
      return (JSON.parse(readFileSync(join(folder, "recording.json"), "utf8")) as { frames: Frames }).frames;
    } catch {
      return [];
    }
  };
  /** The run as the app shows it: each flow with its recording's frame times. */
  const detail = (runId: string) => {
    const run = runs().find((r) => r.runId === runId);
    if (!run) throw Error(`No run ${runId}.`);
    return {
      ...run,
      flows: run.flows.map((flow, index) => ({
        ...flow,
        index,
        frames: frames(flow.recording?.folder).map((f) => f.ms),
        hasScreenshot: !!flow.files?.screenshot,
        hasSheet: !!flow.files?.sheet,
      })),
    };
  };
  /** Every site's saved tests (approved flows with expect steps) with their recent results. */
  const tests = () => {
    store ??= new SiteMemoryStore(directory);
    const all = runs();
    return store.sites().map(({ site }) => {
      const memory = store!.read(site);
      const flows = memory.flows.filter((f) => f.steps.some((s) => s.action === "expect"));
      return {
        site,
        plans: memory.plans ?? [],
        tests: flows.map((f) => {
          const history = all
            .filter((r) => r.site === site)
            .flatMap((r) => r.flows.filter((x) => x.name === f.name).map((x) => ({ runId: r.runId, at: r.startedAt, status: x.status, durationMs: x.durationMs, steps: x.steps.length, failed: x.failed })))
            .slice(0, 10);
          return {
            name: f.name,
            description: f.description,
            approved: f.approved,
            disabled: !!f.disabled,
            plan: f.plan,
            steps: f.steps.length,
            history,
          };
        }),
      };
    }).filter((s) => s.tests.length || s.plans.length);
  };
  /** A picture a saved run points at: a recorded frame, the failure screenshot or the keyframe sheet. */
  const picture = (url: URL) => {
    const run = runs().find((r) => r.runId === url.searchParams.get("run"));
    const flow = run?.flows[Number(url.searchParams.get("flow"))];
    if (!flow) return undefined;
    const kind = url.searchParams.get("kind");
    if (kind === "screenshot") return flow.files?.screenshot;
    if (kind === "sheet") return flow.files?.sheet;
    if (kind === "frame") {
      const folder = flow.recording?.folder;
      const list = frames(folder);
      const at = Number(url.searchParams.get("ms"));
      let pick = list[0];
      for (const f of list) if (f.ms <= at) pick = f;
      return folder && pick ? resolve(folder, pick.file) : undefined;
    }
    return undefined;
  };

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    const path = req.url?.split("?")[0];
    if (path !== "/__orvane/flow-tests" && path !== "/__orvane/flow-tests/picture") return next();
    res.removeHeader("Access-Control-Allow-Origin");
    res.setHeader("Cache-Control", "no-store");
    const reply = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    };
    const host = req.headers.host || "",
      protocol = "encrypted" in req.socket ? "https" : "http";
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `${protocol}://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      req.headers["sec-fetch-site"] === "same-site" ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")
    )
      return reply(403, { error: "Local, same-origin access is required." });
    try {
      if (path === "/__orvane/flow-tests/picture") {
        if (req.method !== "GET") return reply(405, { error: "GET is required." });
        const file = picture(new URL(req.url!, "http://local"));
        if (!file || !/\.jpe?g$/i.test(file) || !existsSync(file)) return reply(404, { error: "No such picture." });
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "private, max-age=3600");
        return res.end(readFileSync(file));
      }
      if (req.method !== "POST") return reply(405, { error: "POST is required." });
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") return reply(415, { error: "JSON is required." });
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 16_000_000) return reply(413, { error: "The request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      const r = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      if (r.action === "runs")
        return reply(200, runs().map((run) => ({
          runId: run.runId, site: run.site, startedAt: run.startedAt, durationMs: run.durationMs, previousRunId: run.previousRunId,
          passed: run.flows.filter((f) => f.status === "passed").length,
          failed: run.flows.filter((f) => f.status === "failed").length,
          skipped: run.flows.filter((f) => f.status === "skipped").length,
          flows: run.flows.map((f) => ({ name: f.name, status: f.status })),
        })));
      if (r.action === "run") return reply(200, detail(r.runId));
      if (r.action === "tests") return reply(200, tests());
      if (r.action === "save-image") return reply(200, { path: testStore.saveImage(r.runId, r.file, r.data) });
      if (r.action === "save-run") {
        testStore.saveRun(checkRun(r.run as unknown as TestRun));
        return reply(200, { saved: true });
      }
      let live: LiveRun | null = null;
      try {
        live = JSON.parse(readFileSync(join(root, "live.json"), "utf8")) as LiveRun;
      } catch {}
      return reply(200, live);
    } catch (error) {
      reply(400, { error: error instanceof z.ZodError ? "Invalid flow tests request." : error instanceof Error ? error.message : String(error) });
    }
  };
  return {
    name: "orvane-flow-tests-api",
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", () => store?.close());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer.once("close", () => store?.close());
    },
  };
}
