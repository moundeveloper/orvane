// flow_tests: saved site flows (browser_memory) used as regression tests.
// A flow with expect steps is a test. run plays the site's tests one after
// another in a tab the AI controls, filming each with the page recorder
// (browser_record's engine); a failure keeps the step, the error, the page's
// address and text, a screenshot and the recorded frame at that moment.
// failure returns that bundle for one flow; rerun plays a run's flows again
// and says what was fixed, what still fails and what newly broke; history
// lists past runs. Runs are kept in <data>/flow-tests (the newest 30).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Flow, SiteMemoryStore } from "./site-memory.ts";
import { FlowTestStore } from "./flow-test-store.ts";
import {
  compareRuns, netSuiteProduction, newRunId, playFlows,
  type FlowContext, type FlowRun, type FlowResult, type LiveRun, type StepEvent, type TestRun,
} from "../src/flowRunner.ts";
export { compareRuns, netSuiteProduction };
export type { FlowResult, LiveRun, TestRun };

type Data = Record<string, unknown>;
type Request = (op: string, args: Data, sessionId?: string) => Promise<Data>;
type Image = { data: string; mimeType: string };


const PRODUCTION =
  "This tab is on a NetSuite production account. Exploring and generated tests only run on sandboxes and release previews: open the sandbox (browser_netsuite_environments) and work there.";

/** Same kind of page: the path and the names of its query parameters
 * (salesord.nl?id=1 and ?id=2 are one page to explore). */
export function pagePattern(url: string) {
  const u = new URL(url);
  const keys = [...new Set(u.searchParams.keys())].sort();
  return keys.length ? `${u.pathname}?${keys.join("&")}` : u.pathname;
}
const SKIP_LINK = /\b(log ?out|sign ?out|logoff|delete|remove|void|unsubscribe)\b|logout|signout/i;
const SKIP_FILE = /\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4|exe|msi)(\?|$)/i;

/** Page script: what a page offers, for the site map. */
const PAGE_SCRIPT = `
const strip = (s) => String(s || "").replace(/\\s+/g, " ").trim();
const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
const label = (el) => strip((el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("aria-label") || el.placeholder || el.name || el.id).slice(0, 60);
const links = [...document.querySelectorAll("a[href]")]
  .map((a) => ({ href: a.href.split("#")[0], text: strip(a.innerText || a.getAttribute("aria-label") || a.title).slice(0, 60) }))
  .filter((l) => l.href.startsWith(location.origin));
const fields = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(visible).slice(0, 40)
  .map((el) => ({ label: label(el), type: el.tagName === "INPUT" ? el.type : el.tagName.toLowerCase(), ...(el.required ? { required: true } : {}) }));
const buttons = [...new Set([...document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")].filter(visible)
  .map((el) => strip(el.innerText || el.value || el.getAttribute("aria-label")).slice(0, 40)).filter(Boolean))].slice(0, 25);
const headings = [...document.querySelectorAll("h1, h2")].map((h) => strip(h.innerText).slice(0, 80)).filter(Boolean).slice(0, 8);
return { url: location.href, title: document.title, headings, fields, buttons, links: links.slice(0, 300) };`;

/** Flows that count as tests: approved, on, with at least one expect step. */
export function testFlows(flows: Flow[]) {
  return flows.filter((f) => f.approved && !f.disabled && f.steps.some((s) => s.action === "expect"));
}

export function registerFlowTests(
  server: McpServer,
  deps: {
    dataDirectory: string;
    memory: SiteMemoryStore;
    request: Request;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the MCP tool result built by browser-tools' guarded()
    guarded: (run: () => Promise<Data>) => Promise<any>;
    siteOfTab: (id: string, sessionId?: string) => Promise<{ site: string; url: string }>;
    runnableFlow: (site: string, name: string, values: Record<string, string>) => Flow;
    runFlow: (tab: string, site: string, flow: Flow, values: Record<string, string>, sessionId?: string, onStep?: (event: StepEvent) => void) => Promise<FlowRun>;
    flowContext: (site: string, sessionId?: string) => FlowContext;
  },
) {
  const { dataDirectory, memory, request, guarded, siteOfTab, runnableFlow, runFlow, flowContext } = deps;
  const store = new FlowTestStore(dataDirectory);
  const root = store.root;
  const busy = new Set<string>();
  const loadRuns = () => store.runs();
  const findRun = (runId?: string) => store.find(runId);
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /** Plays flows as tests in the tab (src/flowRunner.ts playFlows), keeps the
  * run, and shows its progress in the window (Test runs app, Browser overlay). */
  async function play(tab: string, names: string[], params: Record<string, Record<string, string>>, record: boolean, previousRunId: string | undefined, sessionId?: string) {
    const { site, url } = await siteOfTab(tab, sessionId);
    // Generated tests were checked on a sandbox; never let them loose on production.
    const production = netSuiteProduction(url);
    if (busy.has(tab)) throw Error("Tests are already running in this tab.");
    busy.add(tab);
    try {
      const run = await playFlows(
        {
          ...flowContext(site, sessionId),
          flow: (name, values) => runnableFlow(site, name, values),
          skip: (name) =>
            production && memory.read(site).flows.find((f) => f.name.toLowerCase() === name.toLowerCase())?.plan
              ? "A generated test does not run on a NetSuite production account."
              : undefined,
          saveImage: async (runId, file, data) => store.saveImage(runId, file, data),
          live: (live) => {
            store.writeLive(live);
            void request("progress", { tabId: tab, live }, sessionId).catch(() => undefined);
          },
        },
        { tab, site, runId: newRunId(), names, params, record, previousRunId, by: "ai" },
      );
      store.saveRun(run);
      return run;
    } finally {
      busy.delete(tab);
    }
  }

  /** The short form of a run for the AI, with failure screenshots. */
  function summary(run: TestRun, previous?: TestRun): Data {
    const count = (status: string) => run.flows.filter((f) => f.status === status).length;
    const images: Image[] = [];
    for (const flow of run.flows)
      if (flow.files?.screenshot && images.length < 3 && existsSync(flow.files.screenshot))
        images.push({ data: readFileSync(flow.files.screenshot).toString("base64"), mimeType: "image/jpeg" });
    const compared = compareRuns(previous, run);
    const failed = run.flows.filter((f) => f.status === "failed");
    return {
      runId: run.runId,
      site: run.site,
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
      durationMs: run.durationMs,
      flows: run.flows.map((f) => ({
        name: f.name,
        status: f.status,
        durationMs: f.durationMs,
        ...(f.reason ? { reason: f.reason } : {}),
        ...(f.failed ? { failed: { step: f.failed.step, action: f.failed.action, error: f.failed.error } } : {}),
        ...(f.recording?.folder ? { recording: f.recording.folder } : {}),
        ...(f.recording?.warning ? { recordingWarning: f.recording.warning } : {}),
      })),
      ...(compared ? { previousRunId: previous!.runId, compared } : {}),
      ...(failed.length
        ? { next: `flow_tests failure {runId: "${run.runId}", flow: "${failed[0]!.name}"} returns the step, page, screenshot and recorded frame. Judge whether the app, the test, the environment or timing is wrong before changing anything.` }
        : {}),
      images,
    };
  }

  /** The recorded frame closest before a moment of a flow's recording. */
  function frameAt(folder: string | undefined, atMs: number) {
    if (!folder) return undefined;
    try {
      const meta = JSON.parse(readFileSync(join(folder, "recording.json"), "utf8")) as { frames: { file: string; ms: number }[] };
      let pick = meta.frames[0];
      for (const frame of meta.frames) if (frame.ms <= atMs) pick = frame;
      return pick ? { file: join(folder, pick.file), ms: pick.ms } : undefined;
    } catch {
      return undefined;
    }
  }

  type PageInfo = { url: string; title: string; headings: string[]; fields: Data[]; buttons: string[]; links: { href: string; text: string }[] };

  /** Walks the site by its same-site links (opens pages only, never clicks)
   * and returns one entry per kind of page. */
  async function explore(tab: string, site: string, start: string, maxPages: number, sessionId?: string) {
    const origin = new URL(start).origin;
    const queue: { url: string; from?: string; via?: string }[] = [{ url: start }];
    const seen = new Set<string>();
    const pages: Data[] = [];
    const skipped: string[] = [];
    const startedAt = Date.now();
    while (queue.length && pages.length < maxPages && Date.now() - startedAt < 150_000) {
      const next = queue.shift()!;
      let pattern: string;
      try {
        pattern = pagePattern(next.url);
      } catch {
        continue;
      }
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      try {
        if (pages.length) await request("act", { tabId: tab, action: "navigate", url: next.url }, sessionId);
        const { value } = await request("act", { tabId: tab, action: "eval", expression: PAGE_SCRIPT }, sessionId);
        const info = value as PageInfo;
        // A redirect (sign-in, error) to another site or kind of page.
        if (!info?.url?.startsWith(origin)) {
          skipped.push(`${next.url}: left the site`);
          continue;
        }
        const here = pagePattern(info.url);
        if (here !== pattern) seen.add(here);
        const linksTo = new Set<string>();
        for (const link of info.links) {
          if (SKIP_LINK.test(`${link.href} ${link.text}`) || SKIP_FILE.test(link.href)) continue;
          let target: string;
          try {
            target = pagePattern(link.href);
          } catch {
            continue;
          }
          if (target === here) continue;
          linksTo.add(target);
          if (!seen.has(target) && !queue.some((q) => q.url === link.href)) queue.push({ url: link.href, from: here, via: link.text });
        }
        const u = new URL(info.url);
        pages.push({
          page: here,
          example: u.pathname + u.search,
          title: info.title,
          ...(next.via ? { reachedBy: `"${next.via}" on ${next.from}` } : {}),
          headings: info.headings,
          ...(info.fields.length ? { fields: info.fields } : {}),
          ...(info.buttons.length ? { buttons: info.buttons } : {}),
          linksTo: [...linksTo].slice(0, 25),
        });
      } catch (error) {
        skipped.push(`${next.url}: ${message(error)}`);
      }
    }
    // Back where the user started.
    await request("act", { tabId: tab, action: "navigate", url: start }, sessionId).catch(() => undefined);
    const explorationId = `x${Date.now().toString(36)}`;
    const result = {
      explorationId,
      site,
      start,
      pages,
      notVisited: queue.filter((q) => !seen.has((() => { try { return pagePattern(q.url); } catch { return q.url; } })())).length,
      ...(skipped.length ? { skipped: skipped.slice(0, 20) } : {}),
      next: "Write the test plan from this map and the user's goal (flow_tests plan). Open pages yourself with browser_snapshot when a page needs a closer look.",
    };
    mkdirSync(join(root, "explorations"), { recursive: true });
    writeFileSync(join(root, "explorations", `${explorationId}.json`), JSON.stringify(result, null, 2));
    return result;
  }

  /** Checks one case's steps by running them, and saves the test. */
  async function generate(
    tab: string,
    site: string,
    input: { planId?: string; case?: string; steps?: Data[]; paramNames?: string[]; values?: Record<string, string> },
    sessionId?: string,
  ) {
    if (!input.planId || !input.case || !input.steps?.length) throw Error("generate needs planId, case and steps.");
    const values = input.values ?? {};
    const checked = memory.planFlow(site, input.planId, input.case, { params: input.paramNames, steps: input.steps });
    for (const param of checked.flow.params)
      if (!values[param]) throw Error(`The steps use {${param}}: give its value in values to check them.`);
    const candidate = { ...checked.flow, source: "ai" as const, approved: true, plan: input.planId, updatedAt: Date.now() };
    const done = await runFlow(tab, site, candidate, values, sessionId);
    const shot = async () => {
      try {
        const picture = await request("screenshot", { tabId: tab }, sessionId);
        return typeof picture.image === "string" ? [{ data: picture.image, mimeType: "image/jpeg" }] : [];
      } catch {
        return [];
      }
    };
    if (done.ok) {
      const saved = memory.savePlanFlow(site, input.planId, input.case, { params: input.paramNames, steps: input.steps }, {});
      return { saved: true, test: saved.flow.name, case: saved.case, steps: done.steps.length, outputs: done.outputs };
    }
    const failed = done.failed!;
    let page: Data | undefined;
    try {
      const look = await request("snapshot", { tabId: tab, maxElements: 40, textLength: 1200 }, sessionId);
      page = { url: look.url, title: look.title, text: look.text, elements: look.elements };
    } catch {}
    if (failed.action === "expect") {
      const saved = memory.savePlanFlow(site, input.planId, input.case, { params: input.paramNames, steps: input.steps }, { failsNow: failed.error });
      return {
        saved: true,
        test: saved.flow.name,
        case: saved.case,
        failsNow: { step: failed.step, error: failed.error },
        page,
        next: "The steps work but a check fails. If the app is wrong, this test now catches the bug; if your expectation is wrong, generate again with the right check.",
        images: await shot(),
      };
    }
    return {
      saved: false,
      failed: { step: failed.step, action: failed.action, definition: failed.definition, error: failed.error },
      page,
      next: "Nothing was saved: fix the steps (selectors or text from the page above) and generate again.",
      images: await shot(),
    };
  }

  server.registerTool(
    "flow_tests",
    {
      description: [
        "Test a website from one sentence, like an AI QA engineer: explore → plan → (the user approves the plan once) → generate → run → failure → fix → rerun.",
        "explore {tabId, maxPages?}: walks the site from the tab's page by its same-site links (it only opens links, never clicks or submits; log-out and delete links are skipped) and returns the site map: each kind of page with its title, headings, fields, buttons and the pages it links to.",
        "plan {tabId, title, goal, cases: [{name, useCase, description}]}: proposes test cases in plain words, grouped by use case; each description says what the user does and what must be true. The user approves or rejects the whole plan once in Orvane (Browser → Memory → Test plans). Say exactly which data a case changes (\"saves the order\", \"approves the bill\"): generated tests may only save, submit, approve, delete... when their case says so.",
        "plans {tabId}: the site's plans and each case's status (planned, generated, fails now).",
        "generate {tabId, planId, case, steps, params?, values?}: after approval, turns one case into a test. Work out the steps first with browser_snapshot / browser_act, then send them as flow steps (selector or text, never ref; no eval) with expect steps that check what the case promises. Orvane runs them at once: if they pass, or fail only at an expect (likely a real bug), the test is saved and runs with the others; if another step fails, nothing is saved and you get the error to fix the steps. values: parameter values for this check.",
        "NetSuite production accounts are refused for explore and generate, and generated tests are skipped there; use a sandbox.",
        "Saved site flows are tests too: a flow with expect steps (browser_memory save_flow; the user approves it).",
        "run: plays the tab's site's tests (or the flows named) one after another in a tab you control, each filmed with the page recorder; returns passed/failed per flow with the failing step and error, and a screenshot of each failure. Give flows that take parameters their values in params {flowName: {param: value}}.",
        "failure {runId?, flow?}: the evidence for one failed flow (default: the latest run's first failure): the step and its definition, the error, the steps with their times in the recording, the page's address and text when it failed, the failure screenshot, the recorded frame at that moment and the keyframe contact sheet. Decide whether the app, the test, the environment or timing is wrong before fixing.",
        "rerun {runId?, only?}: plays that run's flows again with the same parameters (only: \"failed\" for just the failures) and compares: fixed, still failing, new failure, passing.",
        "history: the latest runs.",
      ].join(" "),
      inputSchema: {
        action: z.enum(["explore", "plan", "plans", "generate", "run", "failure", "rerun", "history"]),
        tabId: z.string().optional().describe("A tab you control on the site (browser_open)."),
        maxPages: z.number().int().min(1).max(30).optional().describe("explore: kinds of pages to visit at most (default 12)."),
        title: z.string().max(80).optional().describe("plan: short title."),
        goal: z.string().max(400).optional().describe("plan: what the user asked to test, in their words."),
        cases: z
          .array(z.object({ name: z.string().max(60), useCase: z.string().max(60), description: z.string().max(200) }))
          .max(30)
          .optional()
          .describe("plan: the test cases."),
        planId: z.string().max(40).optional().describe("generate / run: the plan."),
        case: z.string().max(60).optional().describe("generate: the case's name."),
        steps: z.array(z.record(z.string(), z.unknown())).max(30).optional().describe("generate: the test's flow steps."),
        paramNames: z.array(z.string().max(30)).max(10).optional().describe("generate: names of {param} placeholders the steps use."),
        values: z.record(z.string(), z.string()).optional().describe("generate: parameter values for the check run."),
        flows: z.array(z.string().max(60)).max(30).optional().describe("run: flow names; default every approved flow of the site with expect steps (or of planId)."),
        params: z.record(z.string(), z.record(z.string(), z.string())).optional().describe("run: parameter values per flow name."),
        record: z.boolean().optional().describe("run / rerun: film each flow (default true)."),
        runId: z.string().optional().describe("failure / rerun: a run from run or history; default the latest."),
        flow: z.string().optional().describe("failure: the flow; default the run's first failure."),
        only: z.enum(["all", "failed"]).optional().describe("rerun: all flows (default) or only those that failed."),
        limit: z.number().int().min(1).max(30).optional().describe("history: how many runs (default 10)."),
        sessionId: z.string().optional().describe("Browser session ID from workspace_status; required when more than one workspace is connected."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ action, tabId, flows, params = {}, record = true, runId, flow, only = "all", limit = 10, sessionId, ...rest }) =>
      guarded(async () => {
        if (action === "explore" || action === "plan" || action === "plans" || action === "generate") {
          if (!tabId) throw Error(`${action} needs tabId: a tab you control on the site.`);
          const { site, url } = await siteOfTab(tabId, sessionId);
          if (action === "plans") return { site, plans: memory.read(site).plans ?? [] };
          if (action === "plan") {
            if (!rest.title || !rest.goal || !rest.cases?.length) throw Error("plan needs title, goal and cases.");
            const plan = memory.savePlan(site, { title: rest.title, goal: rest.goal, cases: rest.cases });
            return {
              plan,
              next: "Tell the user the plan is waiting for their approval in Orvane (header Site memory button → Test plans) and summarise the cases. When flow_tests plans shows it approved, generate each case.",
            };
          }
          if (netSuiteProduction(url)) throw Error(PRODUCTION);
          if (action === "explore") return explore(tabId, site, url, rest.maxPages ?? 12, sessionId);
          return generate(tabId, site, rest, sessionId);
        }
        if (action === "history")
          return {
            runs: loadRuns().slice(0, limit).map((r) => ({
              runId: r.runId,
              site: r.site,
              startedAt: r.startedAt,
              durationMs: r.durationMs,
              passed: r.flows.filter((f) => f.status === "passed").length,
              failed: r.flows.filter((f) => f.status === "failed").map((f) => f.name),
              skipped: r.flows.filter((f) => f.status === "skipped").length,
              ...(r.previousRunId ? { rerunOf: r.previousRunId } : {}),
            })),
          };
        if (action === "failure") {
          const run = findRun(runId);
          const target = flow ? run.flows.find((f) => f.name === flow) : run.flows.find((f) => f.status === "failed");
          if (!target) throw Error(flow ? `Flow "${flow}" is not in run ${run.runId}.` : `Run ${run.runId} has no failures.`);
          if (target.status !== "failed") return { runId: run.runId, flow: target.name, status: target.status, ...(target.reason ? { reason: target.reason } : {}) };
          const images: Image[] = [];
          if (target.files?.screenshot && existsSync(target.files.screenshot))
            images.push({ data: readFileSync(target.files.screenshot).toString("base64"), mimeType: "image/jpeg" });
          const frame = frameAt(target.recording?.folder, target.failed!.atMs);
          if (frame && existsSync(frame.file)) images.push({ data: readFileSync(frame.file).toString("base64"), mimeType: "image/jpeg" });
          if (target.files?.sheet && existsSync(target.files.sheet))
            images.push({ data: readFileSync(target.files.sheet).toString("base64"), mimeType: "image/jpeg" });
          return {
            runId: run.runId,
            site: run.site,
            flow: target.name,
            ...(target.params ? { params: target.params } : {}),
            failed: target.failed,
            steps: target.steps,
            page: target.page,
            recording: target.recording,
            ...(frame ? { frameAtFailure: frame } : {}),
            pictures: ["failure screenshot", ...(frame ? [`recorded frame at ${(frame.ms / 1000).toFixed(2)} s`] : []), ...(target.files?.sheet ? ["keyframe contact sheet"] : [])].slice(0, images.length),
            images,
          };
        }
        if (!tabId) throw Error(`${action} needs tabId: a tab you control on the site.`);
        if (action === "rerun") {
          const previous = findRun(runId);
          const { site } = await siteOfTab(tabId, sessionId);
          if (site !== previous.site) throw Error(`Run ${previous.runId} tested ${previous.site}; this tab is on ${site}.`);
          const chosen = previous.flows.filter((f) => (only === "failed" ? f.status === "failed" : true));
          if (!chosen.length) throw Error(`Run ${previous.runId} has no ${only === "failed" ? "failed " : ""}flows to run again.`);
          const values = Object.fromEntries(chosen.map((f) => [f.name, f.params ?? {}]));
          const run = await play(tabId, chosen.map((f) => f.name), values, record, previous.runId, sessionId);
          return summary(run, previous);
        }
        const { site } = await siteOfTab(tabId, sessionId);
        const names = flows?.length
          ? flows
          : testFlows(memory.read(site).flows).filter((f) => !rest.planId || f.plan === rest.planId).map((f) => f.name);
        if (!names.length)
          throw Error(`${site} has no tests yet: save a flow with expect steps (browser_memory save_flow) and ask the user to approve it.`);
        return summary(await play(tabId, names, params, record, undefined, sessionId));
      }),
  );
}
