// AI control of Browser tabs (MCP browser_* tools). Each Browser app
// registers a host; requests find the tab across all of them. A tab is
// "granted" when the user lets the AI use it (or the AI opened it and
// released it), and "controlled" while the AI works in it: the page then
// shows the AI border and takes no user input until the AI releases it or
// the user presses Take control, which also withdraws access.
import {
  evalScript,
  focusForFillScript,
  locateScript,
  presentScript,
  quietScript,
  readScript,
  scrollScript,
  selectScript,
  snapshotScript,
  type AgentTarget,
} from "./browserAgentPage";

export type AgentAccess = "granted" | "controlled";
/** Why the AI opened a tab: "task" is its own scratch tab (it closes it when
 * done); "user" is opened to show the user something and stays theirs. */
export type AgentPurpose = "task" | "user";
export interface AgentTabInfo {
  tabId: string;
  title: string;
  url: string;
  active: boolean;
  access?: AgentAccess;
  opened?: AgentPurpose;
}
export type PageOp =
  | { type: "mouse"; x: number; y: number; action: "click" | "double" | "move"; button?: "left" | "right" | "middle" }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "screenshot" }
  | { type: "navigate"; action: "back" | "forward" | "reload" };
export interface BrowserAgentHost {
  blockId: string;
  tabs(): AgentTabInfo[];
  /** Opens a tab (in front) and returns its id, or throws. */
  open(url: string): string;
  access(tabId: string): AgentAccess | undefined;
  setAccess(tabId: string, access: AgentAccess | undefined): void;
  /** The guest's webContents id once the page exists (it may be loading). */
  page(tabId: string): number | undefined;
  navigate(tabId: string, url: string): void;
  select(tabId: string): void;
  close(tabId: string): void;
}

const hosts = new Map<string, BrowserAgentHost>();
/** Tabs the AI opened, and why (in memory: forgotten on restart). */
const opened = new Map<string, AgentPurpose>();
export const openedBy = (tabId: string) => opened.get(tabId);
/** The user took the tab (Take control, Stop AI access) or closed it: it is
 * no longer the AI's to close. */
export function userOwns(tabId: string) {
  opened.delete(tabId);
}
export function registerBrowserAgentHost(host: BrowserAgentHost) {
  hosts.set(host.blockId, host);
  return () => {
    if (hosts.get(host.blockId) === host) hosts.delete(host.blockId);
  };
}
export function browserAgentHost(blockId: string) {
  return hosts.get(blockId);
}

interface Desktop {
  runInPage(id: number, code: string): Promise<unknown>;
  pageAgent?(id: number, op: PageOp): Promise<unknown>;
}
const desktop = () =>
  (window as unknown as { orvaneDesktop?: Desktop }).orvaneDesktop;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const LIMIT_MS = 11_000; // MCP bridge requests end after 15 s.

export type BrowserRequest = {
  kind: "browser";
  op: "tabs" | "open" | "take" | "release" | "close" | "act" | "snapshot" | "screenshot";
  args: Record<string, unknown>;
};

function hostOfTab(tabId: string) {
  for (const host of hosts.values())
    if (host.tabs().some((tab) => tab.tabId === tabId)) return host;
  throw Error(`Tab ${tabId} does not exist. Call browser_tabs.`);
}
function str(args: Record<string, unknown>, name: string) {
  const value = args[name];
  return typeof value === "string" && value ? value : undefined;
}
function num(args: Record<string, unknown>, name: string, fallback: number) {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function target(args: Record<string, unknown>): AgentTarget | undefined {
  const t = { ref: str(args, "ref"), selector: str(args, "selector"), text: str(args, "text") };
  return t.ref || t.selector || t.text ? t : undefined;
}
function needTarget(args: Record<string, unknown>) {
  const t = target(args);
  if (!t) throw Error("Give ref (from browser_snapshot), selector or text.");
  return t;
}

/** The page of a tab the AI controls, waiting a little for it to exist. */
async function controlled(tabId: string) {
  const host = hostOfTab(tabId);
  const access = host.access(tabId);
  if (access !== "controlled")
    throw Error(
      access === "granted"
        ? `Tab ${tabId} is not under your control. Call browser_control with action "take" first.`
        : `You have no access to tab ${tabId}: the user took control or never shared it. Open your own tab with browser_open, or ask the user to share this one (tab menu → Let AI use this tab).`,
    );
  const until = Date.now() + 8000;
  for (;;) {
    const id = host.page(tabId);
    if (id !== undefined) return { host, id };
    if (Date.now() > until) throw Error("The page did not start. Try again.");
    await sleep(100);
  }
}
/** A page script that never answers (a frozen page, a promise that never
 * settles) must not hold up every later request: the window answers one MCP
 * request at a time. */
const PAGE_LIMIT_MS = 12_000;
async function run<T>(id: number, code: string) {
  const d = desktop();
  if (!d) throw Error("Browser control needs the Orvane desktop app.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      d.runInPage(id, code),
      new Promise((_, fail) => {
        timer = setTimeout(
          () => fail(Error("The page did not answer within 12 seconds (it may be busy or frozen). Check it with browser_screenshot; reload it with browser_act navigate \"reload\" if needed.")),
          PAGE_LIMIT_MS,
        );
      }),
    ])) as T;
  } finally {
    clearTimeout(timer);
  }
}
async function op(id: number, operation: PageOp) {
  const d = desktop();
  if (!d?.pageAgent) throw Error("Browser control needs a newer Orvane desktop app. Restart Orvane.");
  return d.pageAgent(id, operation);
}
/** Retries a page script that answers { wait } until it succeeds. */
async function untilReady<T extends Record<string, unknown>>(
  id: number,
  code: () => string,
  timeout: number,
): Promise<T> {
  const until = Date.now() + Math.min(timeout, LIMIT_MS);
  let last = "";
  for (;;) {
    let result: T | undefined;
    try {
      result = await run<T>(id, code());
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (/gone from the page|Give a ref/.test(last)) throw Error(last);
    }
    if (result && typeof result.error === "string") throw Error(result.error);
    if (result && !result.wait) return result;
    if (result?.wait) last = String(result.wait);
    if (Date.now() > until) throw Error(`${last || "Timed out."} (waited ${Math.round(timeout / 1000)} s)`);
    await sleep(120);
  }
}
/** After an action: a short pause, then wait out a navigation it caused,
 * and (after a hover or click) until menus or popups stop changing. */
async function settle(id: number, quiet = 0) {
  await sleep(quiet ? 60 : 150);
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    try {
      const state = await run<string>(id, "document.readyState");
      if (state !== "loading") break;
    } catch {
      // Navigating: the old document is gone.
    }
    await sleep(120);
  }
  if (quiet)
    try {
      await run(id, quietScript(quiet));
    } catch {
      // Navigated meanwhile.
    }
}
async function page(id: number) {
  try {
    return await run<{ url: string; title: string }>(id, "({ url: location.href, title: document.title })");
  } catch {
    return undefined;
  }
}
async function screenshot(id: number) {
  const data = (await op(id, { type: "screenshot" })) as string;
  return data ? { image: data, mimeType: "image/jpeg" } : { image: "" };
}

async function act(args: Record<string, unknown>) {
  const tabId = str(args, "tabId");
  if (!tabId) throw Error("tabId is required.");
  const { host, id } = await controlled(tabId);
  const action = str(args, "action");
  const timeout = num(args, "timeoutMs", 5000);
  let result: Record<string, unknown> = {};
  switch (action) {
    case "navigate": {
      const url = str(args, "url");
      if (url === "back" || url === "forward" || url === "reload") await op(id, { type: "navigate", action: url });
      else if (url?.startsWith("/") && !url.startsWith("//")) {
        // A path on the tab's own site (saved routes): the same path works
        // on every account of a site (NetSuite dev, sandbox, production).
        const here = (await page(id))?.url;
        if (!here || !/^https?:/.test(here)) throw Error("The tab has no site yet to open that path on.");
        host.navigate(tabId, new URL(url, here).href);
      } else if (url) host.navigate(tabId, url);
      else throw Error('navigate needs url (an address, or "back", "forward", "reload").');
      await sleep(300);
      break;
    }
    case "click":
    case "hover": {
      const where = await untilReady<{ x: number; y: number; ref: string; name: string }>(
        id, () => locateScript(needTarget(args)), timeout,
      );
      const button = str(args, "button") as "left" | "right" | "middle" | undefined;
      await op(id, {
        type: "mouse", x: where.x, y: where.y,
        action: action === "hover" ? "move" : args.double ? "double" : "click",
        button,
      });
      result = { element: { ref: where.ref, name: where.name } };
      break;
    }
    case "fill": {
      const value = typeof args.value === "string" ? args.value : undefined;
      if (value === undefined) throw Error("fill needs value.");
      const t = needTarget(args);
      const field = await untilReady<{ ref: string; name: string; select?: boolean; focused?: boolean }>(
        id, () => focusForFillScript(t), timeout,
      );
      if (field.select) {
        result = await untilReady(id, () => selectScript(t, { label: value, value }), timeout);
        break;
      }
      if (!field.focused) {
        // Some fields only take focus from a real click.
        const where = await untilReady<{ x: number; y: number }>(id, () => locateScript(t), timeout);
        await op(id, { type: "mouse", x: where.x, y: where.y, action: "click" });
        await run(id, focusForFillScript(t));
      }
      if (value) await op(id, { type: "text", text: value });
      else await op(id, { type: "key", key: "Delete" });
      if (args.submit) await op(id, { type: "key", key: "Enter" });
      result = { element: { ref: field.ref, name: field.name } };
      break;
    }
    case "select": {
      const value = str(args, "value"), label = str(args, "label");
      if (!value && !label) throw Error("select needs value or label.");
      result = await untilReady(id, () => selectScript(needTarget(args), { value, label }), timeout);
      break;
    }
    case "type": {
      const text = typeof args.value === "string" ? args.value : str(args, "text");
      if (!text) throw Error("type needs value (the text to type at the focus).");
      await op(id, { type: "text", text });
      break;
    }
    case "press": {
      const key = str(args, "key");
      if (!key) throw Error('press needs key, for example "Enter", "Tab", "Control+a".');
      await op(id, { type: "key", key });
      break;
    }
    case "scroll": {
      const to = str(args, "to") as "top" | "bottom" | undefined;
      result = await untilReady(
        id, () => scrollScript(target(args), to, num(args, "dx", 0), num(args, "dy", to ? 0 : 600)), timeout,
      );
      break;
    }
    case "wait": {
      const t = target(args);
      const gone = args.gone === true;
      const until = Date.now() + Math.min(num(args, "timeoutMs", 8000), LIMIT_MS);
      if (!t) {
        await sleep(Math.min(num(args, "timeoutMs", 1000), LIMIT_MS));
        break;
      }
      for (;;) {
        let state: { present?: boolean } = {};
        try {
          state = await run<{ present: boolean }>(id, presentScript(t));
        } catch {
          // Navigating.
        }
        if (!!state.present !== gone) break;
        if (Date.now() > until) throw Error(gone ? "Still on the page." : "Did not appear.");
        await sleep(150);
      }
      result = { [gone ? "gone" : "present"]: true };
      break;
    }
    case "read": {
      result = await untilReady(id, () => readScript(target(args), num(args, "maxLength", 8000)), timeout);
      return args.screenshot ? { ...result, ...(await screenshot(id)) } : result;
    }
    case "eval": {
      const expression = str(args, "expression");
      if (!expression) throw Error("eval needs expression.");
      let value: unknown;
      try {
        value = await run(id, evalScript(expression));
      } catch (error) {
        if (!/SyntaxError|Unexpected/.test(String(error))) throw error;
        value = await run(id, evalScript(expression, true));
      }
      return args.screenshot ? { value, ...(await screenshot(id)) } : { value };
    }
    default:
      throw Error("Unknown action. Use navigate, click, hover, fill, select, type, press, scroll, wait, read or eval.");
  }
  // Menus often open after a hover delay of a few hundred milliseconds.
  await settle(id, action === "hover" ? 400 : action === "click" ? 250 : 0);
  const out: Record<string, unknown> = { ok: true, ...result, page: await page(id) };
  if (args.snapshot) out.snapshot = await run(id, snapshotScript(num(args, "maxElements", 150), 0));
  if (args.screenshot) Object.assign(out, await screenshot(id));
  return out;
}

export async function runBrowserAgent(
  request: BrowserRequest,
  context: {
    /** Browser blocks on the canvas, the focused app's first. */
    browserBlocks(appId?: string): { blockId: string; appId: string; app: string }[];
    /** Mounts an app's components if they are not yet. */
    mount(appId: string): void;
  },
) {
  const args = request.args ?? {};
  if (request.op === "tabs") {
    const blocks = context.browserBlocks();
    return {
      browsers: blocks.map((block) => ({
        ...block,
        mounted: hosts.has(block.blockId),
        tabs: (hosts.get(block.blockId)?.tabs() ?? []).map((tab) =>
          opened.has(tab.tabId) ? { ...tab, opened: opened.get(tab.tabId) } : tab,
        ),
      })),
    };
  }
  if (request.op === "open") {
    const blocks = context.browserBlocks(str(args, "appId"));
    const wanted = str(args, "blockId");
    const block = wanted ? blocks.find((b) => b.blockId === wanted) : blocks[0];
    if (!block)
      throw Error(
        "No Browser app on the canvas. Create one first (component_create kind=browser, or ask the user).",
      );
    let host = hosts.get(block.blockId);
    if (!host) {
      context.mount(block.appId);
      const until = Date.now() + 5000;
      while (!(host = hosts.get(block.blockId)) && Date.now() < until) await sleep(100);
      if (!host) throw Error("That Browser app did not start. Try again.");
    }
    const url = str(args, "url") ?? "";
    const purpose: AgentPurpose = args.purpose === "user" ? "user" : "task";
    const tabId = host.open(url);
    opened.set(tabId, purpose);
    host.setAccess(tabId, "controlled");
    const out: Record<string, unknown> = { tabId, appId: block.appId, blockId: block.blockId, purpose };
    if (url) {
      const { id } = await controlled(tabId);
      await settle(id);
      // Let the first document arrive (loading pages answer at once).
      const until = Date.now() + 6000;
      while (Date.now() < until && !(await page(id))?.url.startsWith("http")) await sleep(150);
      out.page = await page(id);
    }
    return out;
  }
  const tabId = str(args, "tabId");
  if (!tabId) throw Error("tabId is required.");
  if (request.op === "take" || request.op === "release" || request.op === "close") {
    const host = hostOfTab(tabId);
    const access = host.access(tabId);
    if (request.op === "release") {
      if (access === "controlled") host.setAccess(tabId, "granted");
      // A tab opened for the user is left in front, showing the result.
      if (opened.get(tabId) === "user") host.select(tabId);
      return { tabId, access: host.access(tabId) ?? "none" };
    }
    if (request.op === "close") {
      const purpose = opened.get(tabId);
      if (purpose !== "task")
        throw Error(
          purpose === "user"
            ? `Tab ${tabId} was opened for the user: leave it open (release it instead).`
            : `You can only close your own task tabs (browser_open purpose "task"); tab ${tabId} belongs to the user.`,
        );
      host.close(tabId);
      opened.delete(tabId);
      return { tabId, closed: true };
    }
    if (!access)
      throw Error(
        `The user has not shared tab ${tabId}. Ask them to choose "Let AI use this tab" in its tab menu, or open your own tab with browser_open.`,
      );
    host.setAccess(tabId, "controlled");
    if (args.select !== false) host.select(tabId);
    return { tabId, access: "controlled" };
  }
  if (request.op === "snapshot") {
    const { id } = await controlled(tabId);
    return untilReady(
      id,
      () => snapshotScript(num(args, "maxElements", 150), num(args, "textLength", 1500), args.includeHidden === true),
      3000,
    );
  }
  if (request.op === "screenshot") {
    const { id } = await controlled(tabId);
    return { ...(await screenshot(id)), page: await page(id) };
  }
  return act(args);
}
