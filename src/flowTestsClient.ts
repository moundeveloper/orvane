// The Test runs app's data and its own runner. Reads runs, live progress
// and tests from /__orvane/flow-tests; plays tests itself in a Browser task
// tab (src/flowRunner.ts), with no AI connected, and saves the run like
// flow_tests does.
import { getDomain } from "tldts";
import { browserRequest } from "./browserAgent";
import { setLiveRun } from "./flowTestsLive";
import {
  fillPath, netSuiteProduction, newRunId, playFlows, routeProblem,
  type FlowDef, type FlowResult, type LiveRun, type TestRun,
} from "./flowRunner";

export type { FlowResult, LiveRun, TestRun };
export interface RunSummary {
  runId: string; site: string; startedAt: string; durationMs: number; previousRunId?: string;
  passed: number; failed: number; skipped: number; flows: { name: string; status: string }[];
}
export interface RunDetail extends TestRun {
  flows: (FlowResult & { index: number; frames: number[]; hasScreenshot: boolean; hasSheet: boolean })[];
}
export interface SavedTest {
  name: string; description: string; approved: boolean; disabled: boolean; plan?: string; steps: number;
  history: { runId: string; at: string; status: string; durationMs: number; steps: number; failed?: FlowResult["failed"] }[];
}
export interface SiteTests {
  site: string;
  plans: { id: string; title: string; status: string; cases: { name: string; status: string }[] }[];
  tests: SavedTest[];
}

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: "Not available." }));
  if (!response.ok) throw Error(data.error || "That did not work.");
  return data as T;
}
const api = <T>(body: Record<string, unknown>) => post<T>("/__orvane/flow-tests", body);
const memory = <T>(body: Record<string, unknown>) => post<T>("/__orvane/site-memory", body);

export const listRuns = () => api<RunSummary[]>({ action: "runs" });
export const readRun = (runId: string) => api<RunDetail>({ action: "run", runId });
export const readLive = () => api<(LiveRun & { updatedAt?: number }) | null>({ action: "live" });
export const listTests = () => api<SiteTests[]>({ action: "tests" });
/** A picture of a saved run: a recorded frame at a moment, the failure screenshot or the keyframe sheet. */
export const pictureUrl = (runId: string, flow: number, kind: "frame" | "screenshot" | "sheet", ms = 0) =>
  `/__orvane/flow-tests/picture?run=${encodeURIComponent(runId)}&flow=${flow}&kind=${kind}${kind === "frame" ? `&ms=${Math.round(ms)}` : ""}`;

const siteOfUrl = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? getDomain(u.hostname) || u.host : "";
  } catch {
    return "";
  }
};

interface Memory {
  site: string;
  routes: { name: string; path: string; disabled?: boolean }[];
  flows: (FlowDef & { approved: boolean; disabled?: boolean; plan?: string })[];
}

/** Where to run a site's tests: an open Browser tab on the site (its account,
 * for NetSuite), else the address of the site's last run. */
async function startAddress(site: string) {
  const { browsers } = (await browserRequest("tabs", {})) as { browsers: { tabs: { url: string; active: boolean }[] }[] };
  const tabs = browsers.flatMap((b) => b.tabs).filter((t) => siteOfUrl(t.url) === site);
  const open = tabs.find((t) => t.active) ?? tabs[0];
  if (open) return new URL(open.url).origin + "/";
  for (const run of await listRuns().catch(() => [] as RunSummary[]))
    if (run.site === site) {
      const detail = await readRun(run.runId).catch(() => undefined);
      const url = detail?.flows.flatMap((f) => [f.page?.url, ...f.steps.map((s) => s.url)]).find((u) => u && siteOfUrl(u) === site);
      if (url) return new URL(url).origin + "/";
    }
  throw Error(`Open ${site} in a Browser first (signed in), then run the tests.`);
}

let running = false;
export const isRunning = () => running;

/** Plays a site's tests (or the flows named) in a new Browser task tab and saves the run. */
export async function runTests(input: { site: string; names?: string[]; planId?: string; params?: Record<string, Record<string, string>>; record?: boolean; previousRunId?: string }) {
  if (running) throw Error("Tests are already running.");
  running = true;
  let tab: string | undefined;
  try {
    const read = () => memory<Memory>({ action: "read", site: input.site });
    const saved = await read();
    const names = input.names?.length
      ? input.names
      : saved.flows
          .filter((f) => f.approved && !f.disabled && f.steps.some((s) => s.action === "expect") && (!input.planId || f.plan === input.planId))
          .map((f) => f.name);
    if (!names.length) throw Error(`${input.site} has no approved tests yet.`);
    const address = await startAddress(input.site);
    const production = netSuiteProduction(address);
    const opened = await browserRequest("open", { url: address, purpose: "task" });
    tab = String(opened.tabId);
    const request = (op: string, args: Record<string, unknown>) => browserRequest(op as Parameters<typeof browserRequest>[0], args);
    let current = saved;
    const run = await playFlows(
      {
        request,
        async navigateRoute(tabId, name, values) {
          const route = current.routes.find((r) => r.name.toLowerCase() === name.toLowerCase() && !r.disabled);
          if (!route) throw Error(`${input.site} has no route "${name}".`);
          const path = fillPath(route.path, values);
          const data = await request("act", { tabId, action: "navigate", url: path });
          const problem = routeProblem(path, data.page as { url?: string; title?: string } | undefined);
          return { ...data, routeCheck: problem ? `Route "${route.name}" may be broken: ${problem}.` : "ok" };
        },
        record: (name, error) => void memory({ action: "record", site: input.site, name, ...(error ? { error: error.slice(0, 400) } : {}) }).catch(() => undefined),
        flow(name, values) {
          const flow = current.flows.find((f) => f.name.toLowerCase() === name.toLowerCase());
          if (!flow || flow.disabled) throw Error(`${input.site} has no test "${name}".`);
          if (!flow.approved) throw Error(`"${flow.name}" waits for your approval (Site memory).`);
          for (const p of flow.params) if (!values[p]) throw Error(`"${flow.name}" needs the parameter "${p}".`);
          return flow;
        },
        skip: (name) =>
          production && current.flows.find((f) => f.name.toLowerCase() === name.toLowerCase())?.plan
            ? "A generated test does not run on a NetSuite production account."
            : undefined,
        saveImage: async (runId, file, data) => (await api<{ path: string }>({ action: "save-image", runId, file, data })).path,
        live: (live) => setLiveRun(live),
      },
      { tab, site: input.site, runId: newRunId(), names, params: input.params, record: input.record ?? true, previousRunId: input.previousRunId, by: "app" },
    );
    current = await read().catch(() => current);
    await api({ action: "save-run", run });
    return run;
  } finally {
    running = false;
    if (tab) await browserRequest("close", { tabId: tab }).catch(() => undefined);
  }
}
