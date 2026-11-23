// Plays saved site flows (site memory) as tests, step by step, in a Browser
// tab: shared by the MCP tools (server/browser-tools.ts browser_flow,
// server/flow-tests.ts flow_tests) and the Test runs app, which runs tests
// itself without an AI connected. Everything that touches the page goes
// through `request`, the browser agent operations (act, snapshot,
// screenshot, record-start, record-stop); storage is up to the host.

export type Data = Record<string, unknown>;
/** A browser agent operation (src/browserAgent.ts runBrowserAgent). */
export type Request = (op: string, args: Data) => Promise<Data>;

export const FLOW_ACTIONS = new Set([
  "navigate", "click", "hover", "fill", "select", "type", "press", "scroll", "wait", "read", "eval", "expect",
]);
export type FlowStep = Record<string, string | number | boolean> & { action: string };
export interface FlowDef {
  name: string;
  description?: string;
  params: string[];
  steps: FlowStep[];
  plan?: string;
}

export type StepEvent = { step: number; label: string; done?: boolean; ok?: boolean; url?: string };
export interface FlowRun {
  ok: boolean;
  steps: { step: number; action: string; label: string; startedAt: number; ms: number; ok: boolean; url?: string }[];
  outputs: Data[];
  page?: unknown;
  failed?: { step: number; action: string; definition: Record<string, unknown>; error: string; at: number };
}
export interface FlowResult {
  name: string;
  params?: Record<string, string>;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  durationMs: number;
  steps: { step: number; action: string; label: string; atMs: number; ms: number; ok: boolean; url?: string }[];
  failed?: { step: number; action: string; definition: Data; error: string; atMs: number };
  page?: { url?: string; title?: string; text?: string };
  recording?: { folder?: string; frames: number; durationMs: number; warning?: string };
  files?: { screenshot?: string; sheet?: string };
}
export interface TestRun {
  runId: string;
  site: string;
  startedAt: string;
  durationMs: number;
  flows: FlowResult[];
  previousRunId?: string;
  /** Who started it: an AI through flow_tests, or the owner in the Test runs app. */
  by?: "ai" | "app";
}
/** The run in progress, for the Test runs app and the Browser overlay. */
export interface LiveRun {
  runId: string;
  site: string;
  tabId: string;
  startedAt: string;
  status: "running" | "done";
  recording?: boolean;
  flows: { name: string; status: "queued" | "running" | "passed" | "failed" | "skipped"; steps: { step: number; label: string; ok?: boolean; url?: string }[] }[];
}

const RECORD_MS = 120_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Fills {param} placeholders (URL-encoded); every one must be given. */
export function fillPath(path: string, params: Record<string, string> = {}) {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") throw Error(`The route needs the parameter "${name}".`);
    return encodeURIComponent(value);
  });
}

/** The page is not where the route meant to go (a redirect to sign-in or
 * home), or it shows an error page. */
export function routeProblem(expected: string, page: { url?: string; title?: string } | undefined) {
  if (!page?.url) return "the page did not load";
  let landed: URL, wanted: URL;
  try {
    landed = new URL(page.url);
    wanted = new URL(expected, landed.origin);
  } catch {
    return "the address is not valid";
  }
  if (landed.pathname.replace(/\/$/, "") !== wanted.pathname.replace(/\/$/, ""))
    return `it landed on ${landed.pathname} instead of ${wanted.pathname}`;
  if (/\b(404|not found|error|page (is )?not available|access denied|sign in|log ?in)\b/i.test(page.title ?? ""))
    return `the page title is "${String(page.title).slice(0, 80)}"`;
  return "";
}

/** A NetSuite production account (sandboxes are 123-sb1, release previews 123-rp). */
export function netSuiteProduction(url: string) {
  try {
    return /^\d+\.app\.netsuite\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A step in a few words, for run views: "click Add line", "expect #tax = IT 22%". */
export function stepLabel(step: Record<string, unknown>, fill: (value: string) => string = (v) => v) {
  const s = (key: string) => (typeof step[key] === "string" ? fill(step[key] as string) : undefined);
  const target = s("text") ?? s("selector");
  switch (step.action) {
    case "navigate":
      return `open ${s("route") ?? s("path") ?? ""}`.trim();
    case "fill":
    case "select":
      return `${step.action} ${target ?? ""} = ${s("value") ?? s("label") ?? ""}`.trim();
    case "type":
      return `type ${s("value") ?? ""}`.trim();
    case "press":
      return `press ${s("key") ?? ""}`.trim();
    case "expect": {
      const check =
        s("equals") !== undefined ? `= ${s("equals")}`
          : s("contains") !== undefined ? `contains ${s("contains")}`
            : s("matches") !== undefined ? `matches /${s("matches")}/`
              : s("urlContains") !== undefined ? `address has ${s("urlContains")}`
                : step.gone === true ? "is gone" : "exists";
      return `expect ${target ?? "page"} ${check}`;
    }
    default:
      return `${step.action} ${target ?? ""}`.trim();
  }
}

/** One expect step: polls the page until the check holds or time runs out. */
export async function expectStep(request: Request, args: Data) {
  const timeout = Math.min(11_000, Math.max(0, Number(args.timeoutMs ?? 5000)));
  const until = Date.now() + timeout;
  const target = { ...(args.selector ? { selector: args.selector } : {}), ...(args.text ? { text: args.text } : {}) };
  const what = args.selector ? `${args.selector}` : args.text ? `"${args.text}"` : "the page";
  const clip = (value: string) => (value.length > 200 ? `${value.slice(0, 200)}…` : value);
  let problem = "";
  for (;;) {
    try {
      if (args.gone === true) {
        await request("act", { tabId: args.tabId, action: "wait", ...target, gone: true, timeoutMs: Math.max(200, until - Date.now()) });
        return { ok: true };
      }
      if (typeof args.urlContains === "string") {
        const { value } = await request("act", { tabId: args.tabId, action: "eval", expression: "location.href" });
        if (String(value).includes(args.urlContains)) return { ok: true, actual: value };
        problem = `expected the address to contain "${args.urlContains}", got ${String(value)}`;
      } else {
        const read = await request("act", { tabId: args.tabId, action: "read", ...target, maxLength: 5000, timeoutMs: 600 });
        const actual = String(read.text ?? "").replace(/\s+/g, " ").trim();
        const pass =
          typeof args.equals === "string" ? actual === args.equals.trim()
            : typeof args.contains === "string" ? actual.includes(args.contains)
              : typeof args.matches === "string" ? new RegExp(args.matches).test(actual)
                : true;
        if (pass) return { ok: true, actual: clip(actual) };
        const wanted = typeof args.equals === "string" ? `to be "${args.equals}"`
          : typeof args.contains === "string" ? `to contain "${args.contains}"`
            : `to match /${args.matches}/`;
        problem = `expected ${what} ${wanted}, got ${actual ? `"${clip(actual)}"` : "empty"}`;
      }
    } catch (error) {
      problem = args.gone === true ? `expected ${what} to disappear: ${message(error)}` : `${what} was not found: ${message(error)}`;
    }
    if (Date.now() >= until) throw Error(problem);
    await new Promise((done) => setTimeout(done, 250));
  }
}

export interface FlowContext {
  request: Request;
  /** Opens a saved route of the site; returns the act result with routeCheck "ok" or the problem. */
  navigateRoute(tab: string, route: string, values: Record<string, string>): Promise<Data>;
  /** Records the flow's health (worked / failed with this note). */
  record?(name: string, error?: string): void;
}

/** Runs a flow's steps in order, stopping at the first failure. Each step's
 * start time and page address are kept for recordings and the run map. */
export async function runFlow(
  ctx: FlowContext,
  tab: string,
  flow: FlowDef,
  values: Record<string, string>,
  onStep?: (event: StepEvent) => void,
): Promise<FlowRun> {
  const fill = (value: string) => value.replace(/\{(\w+)\}/g, (_, p: string) => values[p] ?? "");
  const outputs: Data[] = [];
  const steps: FlowRun["steps"] = [];
  let last: Data = {};
  let url: string | undefined;
  const pageUrl = () => {
    const page = last.page as { url?: string } | undefined;
    if (typeof page?.url === "string") url = page.url;
    return url;
  };
  for (const [index, step] of flow.steps.entries()) {
    const startedAt = Date.now();
    const label = stepLabel(step, fill);
    onStep?.({ step: index + 1, label });
    try {
      if (!FLOW_ACTIONS.has(step.action)) throw Error("unknown action");
      const args: Data = { tabId: tab };
      for (const [key, value] of Object.entries(step)) args[key] = typeof value === "string" && key !== "path" && key !== "route" ? fill(value) : value;
      if (step.action === "navigate" && typeof step.route === "string") {
        last = await ctx.navigateRoute(tab, step.route, values);
        if (last.routeCheck !== "ok") throw Error(String(last.routeCheck));
      } else if (step.action === "expect") {
        const checked = await expectStep(ctx.request, args);
        if (checked.actual !== undefined) outputs.push({ step: index + 1, expect: true, actual: checked.actual });
      } else {
        if (step.action === "navigate") {
          args.url = fillPath(String(step.path), values);
          delete args.path;
        }
        last = await ctx.request("act", args);
        if (step.action === "read" || step.action === "eval") outputs.push({ step: index + 1, ...last });
      }
      steps.push({ step: index + 1, action: step.action, label, startedAt, ms: Date.now() - startedAt, ok: true, url: pageUrl() });
      onStep?.({ step: index + 1, label, done: true, ok: true, url });
    } catch (error) {
      steps.push({ step: index + 1, action: step.action, label, startedAt, ms: Date.now() - startedAt, ok: false, url: pageUrl() });
      onStep?.({ step: index + 1, label, done: true, ok: false, url });
      ctx.record?.(flow.name, `step ${index + 1} (${step.action}): ${message(error)}`);
      return { ok: false, steps, outputs, page: last.page, failed: { step: index + 1, action: step.action, definition: step, error: message(error), at: startedAt } };
    }
  }
  ctx.record?.(flow.name);
  return { ok: true, steps, outputs, page: last.page };
}

export interface PlayHost extends FlowContext {
  /** The flow to play, or throws why it can't run (not approved, missing params). */
  flow(name: string, values: Record<string, string>): FlowDef;
  /** A reason to skip this flow (a generated test on NetSuite production). */
  skip?(name: string): string | undefined;
  /** Keeps a picture of the run (base64 JPEG) and returns where it went. */
  saveImage(runId: string, file: string, data: string): Promise<string | undefined>;
  live(live: LiveRun): void;
}

/** Plays flows one after another in a tab, each filmed with the page
 * recorder; a failure keeps the step, the page, a screenshot and the
 * recording. The host stores the pictures and follows the progress. */
export async function playFlows(
  host: PlayHost,
  input: { tab: string; site: string; runId: string; names: string[]; params?: Record<string, Record<string, string>>; record: boolean; previousRunId?: string; by?: "ai" | "app" },
): Promise<TestRun> {
  const { tab, site, runId, names, record } = input;
  const startedAt = Date.now();
  const flows: FlowResult[] = [];
  const live: LiveRun = {
    runId, site, tabId: tab, startedAt: new Date(startedAt).toISOString(), status: "running", recording: record,
    flows: names.map((name) => ({ name, status: "queued", steps: [] })),
  };
  const tell = () => host.live(JSON.parse(JSON.stringify(live)) as LiveRun);
  tell();
  for (const [n, name] of names.entries()) {
    const entry = live.flows[n]!;
    const values = input.params?.[name] ?? {};
    const skip = host.skip?.(name);
    let flow: FlowDef | undefined;
    let reason = skip;
    if (!reason)
      try {
        flow = host.flow(name, values);
      } catch (error) {
        reason = message(error);
      }
    if (!flow) {
      flows.push({ name, ...(Object.keys(values).length ? { params: values } : {}), status: "skipped", reason, durationMs: 0, steps: [] });
      entry.status = "skipped";
      tell();
      continue;
    }
    entry.status = "running";
    tell();
    const result = await playFlow(host, tab, runId, n + 1, flow, values, record, (event) => {
      const at = entry.steps.findIndex((s) => s.step === event.step);
      const step = { step: event.step, label: event.label, ...(event.done ? { ok: event.ok } : {}), ...(event.url ? { url: event.url } : {}) };
      if (at < 0) entry.steps.push(step);
      else entry.steps[at] = step;
      tell();
    });
    entry.status = result.status;
    tell();
    flows.push(result);
  }
  live.status = "done";
  tell();
  return {
    runId, site, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, flows,
    ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}),
    ...(input.by ? { by: input.by } : {}),
  };
}

async function playFlow(host: PlayHost, tab: string, runId: string, n: number, flow: FlowDef, values: Record<string, string>, record: boolean, onStep: (event: StepEvent) => void): Promise<FlowResult> {
  let recording: { recordingId: string; startedAt: number } | undefined;
  let recordWarning: string | undefined;
  if (record)
    try {
      recording = (await host.request("record-start", { tabId: tab, fps: 6, maxMs: RECORD_MS, logText: false })) as typeof recording;
    } catch (error) {
      recordWarning = `Not recorded: ${message(error)}`;
    }
  const started = Date.now();
  const zero = recording?.startedAt ?? started;
  const done = await runFlow(host, tab, flow, values, onStep);
  const result: FlowResult = {
    name: flow.name,
    ...(Object.keys(values).length ? { params: values } : {}),
    status: done.ok ? "passed" : "failed",
    durationMs: Date.now() - started,
    steps: done.steps.map(({ startedAt, ...step }) => ({ ...step, atMs: Math.max(0, startedAt - zero) })),
  };
  const file = (suffix: string) => `${String(n).padStart(2, "0")}-${suffix}`;
  if (done.failed) {
    const failedStep = done.steps[done.steps.length - 1];
    result.failed = {
      step: done.failed.step,
      action: done.failed.action,
      definition: done.failed.definition,
      error: done.failed.error,
      atMs: Math.max(0, done.failed.at + (failedStep?.ms ?? 0) - zero),
    };
    // The page as the failure left it.
    try {
      const look = await host.request("snapshot", { tabId: tab, maxElements: 10, textLength: 1500 });
      result.page = { url: look.url as string, title: look.title as string, text: String(look.text ?? "").slice(0, 1500) };
    } catch {}
    try {
      const shot = await host.request("screenshot", { tabId: tab });
      if (typeof shot.image === "string") {
        const saved = await host.saveImage(runId, file("failure.jpg"), shot.image);
        if (saved) result.files = { ...result.files, screenshot: saved };
      }
    } catch {}
  }
  if (recording)
    try {
      const stopped = await host.request("record-stop", { tabId: tab, recordingId: recording.recordingId, maxKeyframes: 12 });
      result.recording = { folder: stopped.folder as string | undefined, frames: Number(stopped.frames ?? 0), durationMs: Number(stopped.durationMs ?? 0) };
      if (stopped.ended === "time limit") result.recording.warning = `The recording covers the first ${RECORD_MS / 1000} s.`;
      const sheet = (stopped.images as { data: string }[] | undefined)?.[0];
      if (sheet) {
        const saved = await host.saveImage(runId, file("keyframes.jpg"), sheet.data);
        if (saved) result.files = { ...result.files, sheet: saved };
      }
    } catch (error) {
      recordWarning = `Recording lost: ${message(error)}`;
    }
  if (recordWarning) result.recording = { frames: 0, durationMs: 0, ...result.recording, warning: recordWarning };
  return result;
}

/** What happened to each flow between two runs. */
export function compareRuns(before: TestRun | undefined, after: TestRun) {
  if (!before) return undefined;
  return after.flows.map((flow) => {
    const old = before.flows.find((f) => f.name === flow.name);
    const change =
      !old || old.status === "skipped" ? (flow.status === "passed" ? "passing" : flow.status === "failed" ? "failing" : "skipped")
        : old.status === "failed" && flow.status === "passed" ? "fixed"
          : old.status === "failed" && flow.status === "failed" ? "still failing"
            : old.status === "passed" && flow.status === "failed" ? "new failure"
              : flow.status === "passed" ? "passing" : "skipped";
    return { flow: flow.name, before: old?.status ?? "not run", after: flow.status, change };
  });
}

export const newRunId = () =>
  `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${Math.random().toString(36).slice(2, 6)}`;
