// MCP tools that let the AI work in Orvane's Browser app the way Playwright
// drives a page: open its own tab (or take one the user shared), act with
// real input, read the page, and release it. The live window does the work
// (src/browserAgent.ts); while the AI controls a tab, the page wears the AI
// border and the user can only press Take control.
//
// Site memory (site-memory.ts): routes, notes and flows the AI saved for a
// site come back with browser_open, take and browser_snapshot, labelled as
// reference data; flows run only once the user approved them.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fillPath, FLOW_ACTIONS, siteOf, SiteMemoryStore } from "./site-memory.ts";
import { registerFlowTests } from "./flow-tests.ts";

type LiveRun = (run: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
type Data = Record<string, unknown>;
export interface FlowRun {
  ok: boolean;
  steps: { step: number; action: string; startedAt: number; ms: number; ok: boolean }[];
  outputs: Data[];
  page?: unknown;
  failed?: { step: number; action: string; definition: Record<string, unknown>; error: string; at: number };
}

const session = z
  .string()
  .optional()
  .describe("Browser session ID from workspace_status; required when more than one workspace is connected.");
const tabId = z.string().min(1).describe("Tab ID from browser_open or browser_tabs.");
const params = z.record(z.string(), z.string()).optional();

/** The page is not where the route meant to go (a redirect to sign-in or
 * home), or it shows an error page. */
function routeProblem(expected: string, page: { url?: string; title?: string } | undefined) {
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

export function registerBrowserTools(server: McpServer, liveRun: LiveRun, dataDirectory: string) {
  const memory = new SiteMemoryStore(dataDirectory);
  const live = { openWorldHint: true, destructiveHint: false } as const;
  const request = async (op: string, args: Data, sessionId?: string) => {
    const { revision: _revision, ...data } = ((await liveRun({ kind: "browser", op, args }, sessionId)) ?? {}) as Data;
    return data;
  };
  const respond = (data: Data) => {
    const { image, mimeType, images, ...rest } = data;
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text: JSON.stringify(rest, null, 2) },
    ];
    if (typeof image === "string" && image)
      content.push({ type: "image", data: image, mimeType: String(mimeType || "image/jpeg") });
    // Several pictures (browser_record's contact sheets), in order.
    if (Array.isArray(images))
      for (const item of images as { data?: unknown; mimeType?: unknown }[])
        if (typeof item?.data === "string" && item.data)
          content.push({ type: "image", data: item.data, mimeType: String(item.mimeType || "image/jpeg") });
    return { content, structuredContent: { result: rest } };
  };
  const guarded = async (run: () => Promise<Data>) => {
    try {
      return respond(await run());
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
  const tabUrl = async (id: string, sessionId?: string) => {
    const { browsers } = (await request("tabs", {}, sessionId)) as { browsers: { tabs: { tabId: string; url: string }[] }[] };
    const tab = browsers.flatMap((b) => b.tabs).find((t) => t.tabId === id);
    if (!tab) throw Error(`Tab ${id} does not exist. Call browser_tabs.`);
    return tab.url;
  };
  const siteOfTab = async (id: string, sessionId?: string) => {
    const url = await tabUrl(id, sessionId);
    if (!/^https?:/i.test(url)) throw Error("The tab is not on a web page yet; navigate first.");
    return { site: siteOf(url), url };
  };
  /** Adds the site's saved memory, if it has any. */
  const withMemory = (data: Data, url: unknown) => {
    if (typeof url !== "string" || !/^https?:/i.test(url)) return data;
    try {
      const saved = memory.forAgent(siteOf(url));
      return saved ? { ...data, siteMemory: saved } : data;
    } catch {
      return data;
    }
  };

  /** A short look at a page right after it opened: enough to tell it loaded
   * the right thing, or that it shows an error, a notice or a sign-in page. */
  const pageCheck = async (id: string, sessionId?: string) => {
    try {
      type Page = { url?: string; title?: string; text?: string; loading?: boolean };
      const look = async () =>
        (await request("snapshot", { tabId: id, maxElements: 10, textLength: 300 }, sessionId)) as Page;
      let page = await look();
      // Give a loading page up to about 5 seconds.
      for (let tries = 0; page.loading && tries < 10; tries++) {
        await new Promise((done) => setTimeout(done, 500));
        page = await look();
      }
      const text = String(page.text ?? "");
      const problem = /\b(record does not exist|page not found|404|access denied|you do not have permission|sign in|log ?in to|session (has )?expired|an unexpected error)\b/i.exec(
        `${page.title ?? ""} ${text.slice(0, 300)}`,
      );
      return {
        title: page.title,
        url: page.url,
        loading: page.loading,
        text: text.slice(0, 200),
        ...(problem ? { pageProblem: `The page says "${problem[0]}". Check the address.` } : {}),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  server.registerTool(
    "browser_tabs",
    {
      description:
        "List the Browser apps on the Orvane canvas and their tabs, with each tab's AI access: none, \"granted\" (the user shared it; take it with browser_control) or \"controlled\" (you are working in it), and the tab group it is in. Each Browser also lists its tab groups (current space) with their tabs.",
      inputSchema: { sessionId: session },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sessionId }) => guarded(() => request("tabs", {}, sessionId)),
  );

  server.registerTool(
    "browser_group",
    {
      description:
        "Put Browser tabs in a tab group by name (created in the current space if it does not exist), or take them out of their group with group: null. Only tabs you opened or the user shared with you. browser_tabs lists tabs and groups; browser_open can open a tab straight into a group.",
      inputSchema: {
        tabIds: z.array(z.string()).min(1).max(50).describe("Tabs to move, from browser_tabs or browser_open."),
        group: z.string().min(1).max(60).nullable().describe("Group name, or null to ungroup."),
        sessionId: session,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ sessionId, ...args }) => guarded(() => request("group", args, sessionId)),
  );

  server.registerTool(
    "browser_open",
    {
      description:
        "Open a new tab in an Orvane Browser app and take control of it, like a Playwright page. The tab shows the AI border and the user can't use it until you call browser_control release (or they press Take control). Sign-ins and cookies are the user's Browser profile. Returns tabId, and siteMemory when routes, notes or flows were saved for the site; then use browser_snapshot to see the page and browser_act to work in it. To open several pages at once pass urls (one tab each, returns { tabs }); add check: true to get each page's title, address and first text, with pageProblem when it shows an error or sign-in page. Choose purpose: \"task\" (default) for a scratch tab you use for quick work and then close with browser_control close; \"user\" when the page is meant for the user (to show a result or leave them somewhere): you never close it, and release leaves it in front.",
      inputSchema: {
        url: z.string().optional().describe("Address to open (http, https or file). Omit for an empty tab."),
        urls: z.array(z.string().min(1)).min(1).max(10).optional().describe("Several addresses to open in one call, one tab each (same purpose and group). Use instead of url, not with it."),
        check: z.boolean().optional().describe("Return a short look at each opened page (title, address, first text, pageProblem when it looks like an error or sign-in page), so no browser_snapshot is needed to confirm it loaded."),
        purpose: z.enum(["task", "user"]).optional().describe("task (default): your scratch tab, close it when done. user: opened for the user, stays open."),
        group: z.string().max(60).optional().describe("Open the tab in this tab group (by name); the group is created if it does not exist. Use it to keep related tabs together, e.g. one group per task."),
        appId: z.string().optional().describe("Browser app to open in (browser_tabs). Default: the focused app if it is a Browser, else the first Browser app."),
        blockId: z.string().optional().describe("Browser component inside that app, when it has several."),
        sessionId: session,
      },
      annotations: { readOnlyHint: false, ...live },
    },
    async ({ sessionId, urls, check, ...args }) =>
      guarded(async () => {
        if (urls && args.url !== undefined) throw Error("Give url or urls, not both.");
        const openOne = async (url: string | undefined) => {
          const data = await request("open", { ...args, url }, sessionId);
          const opened = withMemory(data, (data.page as Data | undefined)?.url ?? url);
          return check && typeof data.tabId === "string"
            ? { ...opened, check: await pageCheck(data.tabId, sessionId) }
            : opened;
        };
        if (!urls) return openOne(args.url);
        // One at a time: each open takes control of a new tab in order.
        const tabs: Data[] = [];
        for (const url of urls) {
          try {
            tabs.push({ url, ...(await openOne(url)) });
          } catch (error) {
            tabs.push({ url, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return { tabs };
      }),
  );

  server.registerTool(
    "browser_control",
    {
      description:
        "Take, release or close a Browser tab. \"take\" works on tabs you opened and released, or tabs the user shared (tab menu → Let AI use this tab), and returns the site's saved memory; \"release\" hands the tab back to the user (you can take it again later); \"close\" closes a task tab you opened (never the user's tabs or ones opened for the user). When you finish: close your task tabs, release the rest. If the user pressed Take control, your access is gone and the tab is theirs: ask them before trying again.",
      inputSchema: {
        tabId,
        action: z.enum(["take", "release", "close"]),
        select: z.boolean().optional().describe("take: show the tab in its Browser app (default true)."),
        sessionId: session,
      },
      annotations: { readOnlyHint: false, ...live },
    },
    async ({ sessionId, action, ...args }) =>
      guarded(async () => {
        const data = await request(action, args, sessionId);
        return action === "take" ? withMemory(data, await tabUrl(args.tabId, sessionId).catch(() => "")) : data;
      }),
  );

  server.registerTool(
    "browser_snapshot",
    {
      description:
        "Read a tab you control: address, title, loading state, scroll position, visible interactive elements and headings with refs (\"e12\") for browser_act, the start of the page text, and the site's saved memory (siteMemory). Refs stay the same for the same element while the page lives. Only the main frame is read (not iframes).",
      inputSchema: {
        tabId: tabId.optional(),
        tabIds: z.array(z.string().min(1)).min(1).max(10).optional().describe("Read several tabs in one call instead of tabId; returns { tabs: [...] } in the same order."),
        maxElements: z.number().int().min(10).max(500).optional().describe("Default 150."),
        textLength: z.number().int().min(0).max(20000).optional().describe("Characters of page text. Default 1500."),
        includeHidden: z.boolean().optional().describe("Also list links hidden in the page (collapsed menus, closed panels) as hiddenLinks {name, href}: navigate to one directly instead of opening the menus."),
        sessionId: session,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId, tabIds, ...args }) =>
      guarded(async () => {
        if (!tabIds) {
          if (!args.tabId) throw Error("Give tabId or tabIds.");
          const data = await request("snapshot", args, sessionId);
          return withMemory(data, data.url);
        }
        if (args.tabId) throw Error("Give tabId or tabIds, not both.");
        const tabs = await Promise.all(
          tabIds.map(async (id) => {
            try {
              const data = await request("snapshot", { ...args, tabId: id }, sessionId);
              return { tabId: id, ...withMemory(data, data.url) };
            } catch (error) {
              return { tabId: id, error: error instanceof Error ? error.message : String(error) };
            }
          }),
        );
        return { tabs };
      }),
  );

  server.registerTool(
    "browser_screenshot",
    {
      description: "A JPEG of what a tab you control shows now (viewport only).",
      inputSchema: { tabId, sessionId: session },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId, ...args }) => guarded(() => request("screenshot", args, sessionId)),
  );

  const region = z
    .object({
      name: z.string().max(60).optional().describe("Label for this region in the results."),
      selector: z.string().max(500).optional().describe("CSS selector of the element to record; its text changes are logged too."),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    })
    .describe("An element (selector) or a viewport rectangle in CSS pixels (x, y, width, height).");
  server.registerTool(
    "browser_record",
    {
      description:
        "Record a tab you control in real time and read it frame by frame: animations, typing demos, carousels, loaders, transitions, anything screenshots seconds apart would miss. Frames come from what the page paints (up to 15 per second); frames that look like the one before are dropped, and each region comes back as a contact sheet image of its keyframes labelled #n, time and how long it held, plus a list with the region's text at each keyframe (element regions) and every text change with its time. All frames are saved to disk (folder) for deeper analysis. action \"capture\" (default) records for durationMs and returns; \"start\" then \"stop\" (with recordingId) records while you act in between (browser_act click on a demo tab, scroll, hover); \"status\" tells if it is still recording. Regions must be visible in the viewport when the recording starts; scroll first. Up to 4 regions; omit for the whole viewport.",
      inputSchema: {
        tabId,
        action: z.enum(["capture", "start", "stop", "status"]).optional(),
        recordingId: z.string().optional().describe("stop / status: the id start returned."),
        regions: z.array(region).max(4).optional(),
        durationMs: z.number().int().min(500).max(30_000).optional().describe("capture: how long to record. Default 5000."),
        stopWhenStillMs: z.number().int().min(300).max(10_000).optional().describe("capture: end early once nothing has painted for this long (after the first second)."),
        fps: z.number().min(1).max(15).optional().describe("Frames per second at most. Default 8; 12-15 for fast motion."),
        maxKeyframes: z.number().int().min(1).max(40).optional().describe("Keyframes per region at most (thinned evenly over time). Default 16."),
        threshold: z.number().min(0.001).max(0.5).optional().describe("How different a frame must be from the last kept one to count, 0-1 mean colour change. Default 0.012; lower catches small movements."),
        sessionId: session,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId, action = "capture", durationMs = 5000, stopWhenStillMs, ...args }) =>
      guarded(async () => {
        if (action === "status" || action === "stop") {
          if (!args.recordingId) throw Error("recordingId is required: the id action \"start\" returned.");
          return request(action === "stop" ? "record-stop" : "record-status", args, sessionId);
        }
        const maxMs = action === "capture" ? durationMs + 1000 : 30_000;
        const started = await request("record-start", { ...args, maxMs }, sessionId);
        if (action === "start") return { ...started, note: "Recording (30 s at most). Act now, then call browser_record action \"stop\" with this recordingId." };
        const recordingId = String(started.recordingId);
        const until = Date.now() + durationMs;
        while (Date.now() < until) {
          await new Promise((done) => setTimeout(done, Math.min(400, Math.max(0, until - Date.now()))));
          if (!stopWhenStillMs) continue;
          const state = (await request("record-status", { tabId: args.tabId, recordingId }, sessionId)) as {
            recording?: boolean; elapsedMs?: number; lastFrameMs?: number;
          };
          if (!state.recording) break;
          const still = (state.elapsedMs ?? 0) - (state.lastFrameMs ?? 0);
          if ((state.elapsedMs ?? 0) > 1000 && still >= stopWhenStillMs) break;
        }
        const stopped = await request("record-stop", { ...args, recordingId }, sessionId);
        return started.warning ? { warning: started.warning, ...stopped } : stopped;
      }),
  );

  /** Navigates to a saved route on the tab's own site and checks it. */
  const goToRoute = async (args: Data, sessionId?: string) => {
    const { site } = await siteOfTab(String(args.tabId), sessionId);
    const route = memory.route(site, String(args.route));
    const path = fillPath(route.path, (args.params as Record<string, string> | undefined) ?? {});
    const { route: _route, params: _params, ...rest } = args;
    let data: Data;
    try {
      data = await request("act", { ...rest, action: "navigate", url: path }, sessionId);
    } catch (error) {
      memory.record(site, "route", route.name, error instanceof Error ? error.message : String(error));
      throw error;
    }
    const problem = routeProblem(path, data.page as { url?: string; title?: string } | undefined);
    memory.record(site, "route", route.name, problem || undefined);
    return {
      ...data,
      route: route.name,
      ...(problem
        ? { routeCheck: `Route "${route.name}" may be broken: ${problem}. Check the page; fix the route (browser_memory save_route) or delete it.` }
        : { routeCheck: "ok" }),
    };
  };

  server.registerTool(
    "browser_act",
    {
      description: [
        "Act in a Browser tab you control with real mouse and keyboard input. Element actions wait (timeoutMs, default 5000) until the element exists, is visible, enabled and not covered, scroll it into view, then act; hover and click also wait until menus or popups they open stop changing.",
        "Target an element with ref (from browser_snapshot, preferred), selector (CSS) or text (accessible name, exact then partial).",
        "Actions: navigate {url | path on the same site (\"/app/...\") | \"back\" | \"forward\" | \"reload\" | route + params (a saved route)}; click {target, button?, double?}; hover {target}; fill {target, value, submit?} (replaces a field's text; on a <select> picks the option); select {target, value | label}; type {value} (types at the focus); press {key: \"Enter\", \"Tab\", \"Escape\", \"Control+a\"…}; scroll {target?, dy?, dx?, to?: top|bottom}; wait {target, gone?} or {timeoutMs} alone to pause; read {target?, maxLength?} (text of an element or the page); eval {expression} (JavaScript in the page; an expression or a body with return).",
        "Add snapshot: true or screenshot: true to see the page after the action. If the screenshot is unavailable, the result includes screenshotWarning.",
        "Fastest path first: use a saved route (siteMemory), or go straight to a known or discovered address (browser_snapshot includeHidden for menu links) instead of clicking through menus; read data with read or eval (DOM queries, or fetch() of same-origin pages, which carries the user's sign-in) instead of opening pages one by one. Click, hover and fill only when the page needs a real interaction (forms, buttons that run code).",
      ].join(" "),
      inputSchema: {
        tabId,
        action: z.enum(["navigate", "click", "hover", "fill", "select", "type", "press", "scroll", "wait", "read", "eval"]),
        ref: z.string().optional(),
        selector: z.string().optional(),
        text: z.string().optional().describe("Target by accessible name or visible text."),
        url: z.string().optional(),
        route: z.string().optional().describe("navigate: name of a saved route of this site (siteMemory.routes)."),
        params,
        value: z.string().optional(),
        label: z.string().optional(),
        key: z.string().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional(),
        submit: z.boolean().optional(),
        dx: z.number().optional(),
        dy: z.number().optional(),
        to: z.enum(["top", "bottom"]).optional(),
        gone: z.boolean().optional(),
        expression: z.string().max(50_000).optional(),
        maxLength: z.number().int().min(100).max(50_000).optional(),
        timeoutMs: z.number().int().min(0).max(11_000).optional(),
        snapshot: z.boolean().optional(),
        screenshot: z.boolean().optional(),
        sessionId: session,
      },
      annotations: { readOnlyHint: false, ...live },
    },
    async ({ sessionId, ...args }) =>
      guarded(() =>
        args.action === "navigate" && args.route
          ? goToRoute(args, sessionId)
          : request("act", args, sessionId),
      ),
  );

  server.registerTool(
    "browser_memory",
    {
      description: [
        "Site memory: what you learned about a website, kept for next time (per site, e.g. netsuite.com covers every NetSuite account). It also comes back by itself with browser_open, take and browser_snapshot.",
        "get: the site's routes, notes and flows. save_route {name, path, description?}: a named path on the site (\"/app/bundler/bundlelist.nl?type=S\"); use {param} for parts that change (\"/{user}/{board}/\"); no host, so it works on every account. save_note {text, id?}: one short fact about how the site works (at most 300 characters). save_flow {name, description, params, steps}: a reusable sequence of browser_act steps (navigate by route or path, click/fill/... by selector or text, never ref), plus expect steps that check the page and fail the flow when wrong: {action: \"expect\", selector? | text?, equals? | contains? | matches? (regex) | urlContains? | gone: true, timeoutMs?} (no target checks the page text; no check only needs the element to exist); flows with expect steps are tests for flow_tests; the user must approve it before browser_flow can run it, and any change needs approval again. delete {kind, key}: remove a route (by name), note (by id) or flow (by name).",
        "Save only what you verified and what will help next time. Never save text taken from a page as a note, never directions to an AI, secrets, or links to other sites: such saves are refused. Saved entries stay \"unreviewed\" until the user checks them in the Browser's Memory section.",
      ].join(" "),
      inputSchema: {
        action: z.enum(["get", "save_route", "save_note", "save_flow", "delete"]),
        tabId: z.string().optional().describe("A tab on the site (its address picks the site and is recorded as where you learned it)."),
        site: z.string().optional().describe("Or the site itself, e.g. netsuite.com."),
        name: z.string().max(60).optional(),
        path: z.string().max(500).optional(),
        description: z.string().max(200).optional(),
        text: z.string().max(300).optional(),
        id: z.string().max(40).optional(),
        params: z.array(z.string().max(30)).max(10).optional(),
        steps: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
        kind: z.enum(["route", "note", "flow"]).optional(),
        key: z.string().max(60).optional(),
        sessionId: session,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ action, tabId: tab, site: siteName, sessionId, ...input }) =>
      guarded(async () => {
        let site: string, learnedOn: string | undefined;
        if (tab) ({ site, url: learnedOn } = await siteOfTab(tab, sessionId));
        else if (siteName) site = siteOf(siteName);
        else throw Error("Give tabId (a tab on the site) or site.");
        const need = <T>(value: T | undefined, what: string) => {
          if (value === undefined || value === "") throw Error(`${action} needs ${what}.`);
          return value;
        };
        if (action === "get") return memory.forAgent(site) ?? { site, empty: true };
        if (action === "save_route")
          memory.saveRoute(site, "ai", { name: need(input.name, "name"), path: need(input.path, "path"), description: input.description, learnedOn });
        else if (action === "save_note")
          memory.saveNote(site, "ai", { text: need(input.text, "text"), id: input.id, learnedOn });
        else if (action === "save_flow")
          memory.saveFlow(site, "ai", {
            name: need(input.name, "name"),
            description: need(input.description, "description"),
            params: input.params,
            steps: need(input.steps, "steps"),
          });
        else memory.remove(site, need(input.kind, "kind"), need(input.key, "key"));
        return { saved: action !== "delete", deleted: action === "delete", memory: memory.forAgent(site) ?? { site, empty: true } };
      }),
  );

  server.registerTool(
    "browser_netsuite_environments",
    {
      description:
        "NetSuite environments, like the Browser header's environment picker. list: the accounts and environments the signed-in user can open (production, sandboxes, release previews), read through a NetSuite tab shared with you (tabId, or the first shared one). open {environment}: goes to the tab already on that account, else opens a new tab on its home page for the user (granted to you: take it with browser_control to work there). environment is the account ID, or words that all appear in its label and type, e.g. \"sandbox consitech\"; an unclear name returns the candidates.",
      inputSchema: {
        action: z.enum(["list", "open"]),
        environment: z.string().max(120).optional().describe("open: account ID or words from the environment's label"),
        tabId: z.string().optional().describe("A signed-in NetSuite tab shared with you; default: the first one."),
        sessionId: session,
      },
      annotations: { readOnlyHint: false, ...live },
    },
    async ({ action, environment, tabId: tab, sessionId }) =>
      guarded(() =>
        request(
          action === "list" ? "netsuite-environments" : "netsuite-open",
          { ...(tab ? { tabId: tab } : {}), ...(environment ? { environment } : {}) },
          sessionId,
        ),
      ),
  );

  /** A saved flow that may run: approved, with every parameter given. */
  const runnableFlow = (site: string, name: string, values: Record<string, string>) => {
    const flow = memory.flow(site, name);
    if (!flow.approved)
      throw Error(`Flow "${flow.name}" is waiting for the user's approval (Browser → Memory). Ask the user to review it; until then do the steps yourself.`);
    for (const param of flow.params)
      if (!values[param]) throw Error(`Flow "${flow.name}" needs the parameter "${param}".`);
    return flow;
  };
  /** Runs a flow's steps in order, stopping at the first failure, and records
   * the flow's health. Each step's start time is kept for recordings. */
  const runFlow = async (
    tab: string,
    site: string,
    flow: ReturnType<typeof memory.flow>,
    values: Record<string, string>,
    sessionId?: string,
  ): Promise<FlowRun> => {
    const fill = (value: string) => value.replace(/\{(\w+)\}/g, (_, p: string) => values[p] ?? "");
    const outputs: Data[] = [];
    const steps: FlowRun["steps"] = [];
    let last: Data = {};
    for (const [index, step] of flow.steps.entries()) {
      const startedAt = Date.now();
      try {
        if (!FLOW_ACTIONS.has(step.action)) throw Error("unknown action");
        const args: Data = { tabId: tab };
        for (const [key, value] of Object.entries(step)) args[key] = typeof value === "string" && key !== "path" && key !== "route" ? fill(value) : value;
        if (step.action === "navigate" && typeof step.route === "string") {
          last = await goToRoute({ tabId: tab, route: step.route, params: values }, sessionId);
          if (last.routeCheck !== "ok") throw Error(String(last.routeCheck));
        } else if (step.action === "expect") {
          const checked = await expectStep(request, args, sessionId);
          if (checked.actual !== undefined) outputs.push({ step: index + 1, expect: true, actual: checked.actual });
        } else {
          if (step.action === "navigate") {
            args.url = fillPath(String(step.path), values);
            delete args.path;
          }
          last = await request("act", args, sessionId);
          if (step.action === "read" || step.action === "eval") outputs.push({ step: index + 1, ...last });
        }
        steps.push({ step: index + 1, action: step.action, startedAt, ms: Date.now() - startedAt, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ step: index + 1, action: step.action, startedAt, ms: Date.now() - startedAt, ok: false });
        memory.record(site, "flow", flow.name, `step ${index + 1} (${step.action}): ${message}`);
        return { ok: false, steps, outputs, page: last.page, failed: { step: index + 1, action: step.action, definition: step, error: message, at: startedAt } };
      }
    }
    memory.record(site, "flow", flow.name);
    return { ok: true, steps, outputs, page: last.page };
  };

  server.registerTool(
    "browser_flow",
    {
      description:
        "Run a saved flow of this tab's site (siteMemory.flows) in a tab you control, with its params. Only flows the user approved run. Steps run in order and stop at the first failure (the flow is then marked broken); read and eval steps return their results in outputs.",
      inputSchema: { tabId, name: z.string().max(60), params, sessionId: session },
      annotations: { readOnlyHint: false, ...live },
    },
    async ({ tabId: tab, name, params: values = {}, sessionId }) =>
      guarded(async () => {
        const { site } = await siteOfTab(tab, sessionId);
        const flow = runnableFlow(site, name, values);
        const done = await runFlow(tab, site, flow, values, sessionId);
        if (!done.ok) {
          const at = `step ${done.failed!.step} (${done.failed!.action})`;
          throw Error(`Flow "${flow.name}" stopped at ${at}: ${done.failed!.error}${done.outputs.length ? `\nOutputs so far: ${JSON.stringify(done.outputs).slice(0, 4000)}` : ""}`);
        }
        return { flow: flow.name, ok: true, outputs: done.outputs, page: done.page };
      }),
  );

  registerFlowTests(server, {
    dataDirectory,
    memory,
    request,
    guarded,
    siteOfTab,
    runnableFlow,
    runFlow,
  });

  return () => memory.close();
}

/** One expect step: polls the page until the check holds or time runs out. */
async function expectStep(
  request: (op: string, args: Data, sessionId?: string) => Promise<Data>,
  args: Data,
  sessionId?: string,
) {
  const timeout = Math.min(11_000, Math.max(0, Number(args.timeoutMs ?? 5000)));
  const until = Date.now() + timeout;
  const target = { ...(args.selector ? { selector: args.selector } : {}), ...(args.text ? { text: args.text } : {}) };
  const what = args.selector ? `${args.selector}` : args.text ? `"${args.text}"` : "the page";
  const clip = (value: string) => (value.length > 200 ? `${value.slice(0, 200)}…` : value);
  let problem = "";
  for (;;) {
    try {
      if (args.gone === true) {
        await request("act", { tabId: args.tabId, action: "wait", ...target, gone: true, timeoutMs: Math.max(200, until - Date.now()) }, sessionId);
        return { ok: true };
      }
      if (typeof args.urlContains === "string") {
        const { value } = await request("act", { tabId: args.tabId, action: "eval", expression: "location.href" }, sessionId);
        if (String(value).includes(args.urlContains)) return { ok: true, actual: value };
        problem = `expected the address to contain "${args.urlContains}", got ${String(value)}`;
      } else {
        const read = await request("act", { tabId: args.tabId, action: "read", ...target, maxLength: 5000, timeoutMs: 600 }, sessionId);
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
      const message = error instanceof Error ? error.message : String(error);
      problem = args.gone === true ? `expected ${what} to disappear: ${message}` : `${what} was not found: ${message}`;
    }
    if (Date.now() >= until) throw Error(problem);
    await new Promise((done) => setTimeout(done, 250));
  }
}
