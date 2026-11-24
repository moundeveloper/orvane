// Shared pieces of the Agent sessions harness that reach beyond one app:
// the composer that receives selections and snapshots, the activity list
// (waiting, running, done), desktop alerts and keeping Windows awake.
import { computed, reactive, watch } from "vue";
import { agentRequest } from "./exposition";
import { agentRunIndicators } from "./agentNavigation";
import { agentNames, type AgentEditMode, type AgentProvider, type AgentRunSummary } from "./agentSessions";
import { appTextAt, appTextIn } from "./appText";

/** Context added to the composer: a selection, an app snapshot or another session. */
export interface AgentQuote {
  id: string;
  kind: "selection" | "snapshot" | "session";
  /** App name, or the mentioned session's title. */
  source: string;
  detail: string;
  text: string;
  /** Saved picture of a snapshot. */
  image?: string;
  /** "Continue with another model": the session this draft continues. */
  origin?: ContinueSource;
}
/** The source of a continued session: where its full transcript is and what
 * the reference card shows. Built from the transcript, not written by a model. */
export interface ContinueSource {
  key: string;
  provider: AgentProvider;
  transcript: string;
  model?: string;
  updatedAt?: number;
  calls: number;
  asked: string;
  reply: string;
  changed: string[];
  open: string;
  turns: { id: string; at: string; role: "user" | "assistant"; line: string; tools: number }[];
}

const quoteLimit = 4000;
export function quoteText(quote: AgentQuote) {
  const text = quote.text.length > quoteLimit ? quote.text.slice(0, quoteLimit) + "\n…" : quote.text;
  const where = quote.detail ? ` (${quote.detail})` : "";
  if (quote.origin)
    return [
      `Continue from the earlier session "${quote.source}"${where}.`,
      `Its full transcript (JSONL) is at: ${JSON.stringify(quote.origin.transcript)}`,
      "Read it when you need earlier turns, decisions or tool output. Where it stopped:",
      "```",
      text,
      "```",
    ].join("\n");
  const head =
    quote.kind === "session"
      ? `Context from the earlier session "${quote.source}"${where}, its latest reply:`
      : quote.kind === "snapshot"
        ? `Snapshot of the ${quote.source} app in Orvane${where}${quote.image ? ", picture attached" : ""}:`
        : `Selected in ${quote.source}${where}:`;
  return text ? `${head}\n\`\`\`\n${text}\n\`\`\`` : head;
}

// ---- The composer that receives context ----

export interface ComposerHandle {
  element: () => HTMLElement | undefined;
  addQuote: (quote: AgentQuote) => void;
}
const composers = new Set<ComposerHandle>();
let lastComposer: ComposerHandle | null = null;
/** Context captured while no composer was open; the next one takes it. */
const waiting: AgentQuote[] = [];

export function registerComposer(handle: ComposerHandle) {
  composers.add(handle);
  if (!lastComposer) lastComposer = handle;
  if (waiting.length) for (const quote of waiting.splice(0)) handle.addQuote(quote);
  return () => {
    composers.delete(handle);
    if (lastComposer === handle) lastComposer = [...composers].at(-1) ?? null;
  };
}
/** The composer used last receives the next selection. */
export function touchComposer(handle: ComposerHandle) {
  lastComposer = handle;
}

interface HarnessHost {
  appName(appId: string): string;
  apps(): { id: string; name: string; icon: string }[];
  focusApp(appId: string): void;
  /** Open (or create) an Agent sessions app. */
  openSessions(): void;
  openRun(runId: string): void;
}
let host: HarnessHost | null = null;
export function configureHarness(value: HarnessHost) {
  host = value;
}

const quoteId = () => Math.random().toString(36).slice(2, 10);

function deliver(quote: AgentQuote) {
  const target = lastComposer && composers.has(lastComposer) ? lastComposer : null;
  if (target) {
    target.addQuote(quote);
    const app = target.element()?.closest<HTMLElement>(".canvas-app")?.dataset.appId;
    if (app) host?.focusApp(app);
    return;
  }
  waiting.push(quote);
  host?.openSessions();
}

/**
 * Ctrl+Shift+L: the text selected in the focused app goes to the agent
 * composer used last. `from` is the app element when a Browser page asked.
 */
export async function sendSelection(from?: Element | null) {
  const focus = from ?? document.activeElement;
  const app = focus?.closest<HTMLElement>(".canvas-app") ?? null;
  const source = appTextAt(focus ?? null) ?? (app ? appTextIn(app) : undefined);
  let text = source?.selection ? (await source.selection()).trim() : "";
  let appElement = app;
  if (!text) {
    const selection = window.getSelection();
    text = selection?.toString().trim() ?? "";
    const anchor = selection?.anchorNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    appElement = element?.closest<HTMLElement>(".canvas-app") ?? appElement;
  }
  if (!text) return "Select some text in an app first.";
  // The composer itself is not a source.
  if (appElement?.querySelector(".agent-sessions-app") && !source) return "Select text in another app.";
  const appId = appElement?.dataset.appId ?? "";
  deliver({
    id: quoteId(),
    kind: "selection",
    source: (appId && host?.appName(appId)) || "Orvane",
    detail: source?.detail?.() ?? "",
    text: text.slice(0, 20000),
  });
  return "";
}

/** The apps an agent snapshot can show, newest first, without the sessions app itself. */
export function snapshotApps() {
  return (host?.apps() ?? []).filter(
    (app) => !document.querySelector(`.canvas-app[data-app-id="${CSS.escape(app.id)}"] .agent-sessions-app`),
  );
}

type Desktop = { captureWindow?(rect: { x: number; y: number; width: number; height: number }): Promise<string> };
const desktop = () => (window as unknown as { orvaneDesktop?: Desktop }).orvaneDesktop;

/** Picture and text of one canvas app, saved for an agent. */
export async function snapshotApp(appId: string, picture: boolean): Promise<AgentQuote> {
  const app = document.querySelector<HTMLElement>(`.canvas-app[data-app-id="${CSS.escape(appId)}"]`);
  const name = host?.appName(appId) || "app";
  if (!app) throw Error(`${name} is not on the canvas.`);
  const source = appTextIn(app);
  const surface = app.querySelector<HTMLElement>(".app-surface") ?? app;
  const text = ((source?.text ? await source.text() : surface.innerText) || "").trim().slice(0, 20000);
  let image: string | undefined;
  if (picture) {
    let data = source?.picture ? await source.picture().catch(() => "") : "";
    if (!data) {
      const rect = surface.getBoundingClientRect();
      const inView =
        rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
        rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
      if (inView) data = (await desktop()?.captureWindow?.({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }).catch(() => "")) || "";
    }
    if (data) image = (await agentRequest<{ path: string }>("attachment-save", { data })).path;
  }
  return { id: quoteId(), kind: "snapshot", source: name, detail: source?.detail?.() ?? "", text, ...(image ? { image } : {}) };
}

// ---- Activity: waiting, running and finished runs ----

const seenKey = "orvane-agent-seen-runs";
const settingsKey = "orvane-agent-harness";
function load<T>(key: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") };
  } catch {
    return fallback;
  }
}
export const harness = reactive({
  runs: [] as AgentRunSummary[],
  seen: new Set<string>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(seenKey) || "[]") as string[];
      } catch {
        return [];
      }
    })(),
  ),
  settings: load(settingsKey, {
    alerts: true,
    keepAwake: true,
    suggest: true,
    /** Edit mode every new chat starts in, per CLI (Settings → Sessions).
     * Replace the object to change it, so the setting is saved. */
    defaultModes: {} as Partial<Record<AgentProvider, AgentEditMode>>,
  }),
  awake: false,
  /** Ctrl+Alt+U asked the Agent sessions app to show its activity list. */
  activityOpen: false,
});
watch(
  () => ({ ...harness.settings }),
  (value) => {
    try {
      localStorage.setItem(settingsKey, JSON.stringify(value));
    } catch {}
  },
);
// The server keeps a copy so Host access sends from a laptop start in the
// same edit mode as a new desktop chat.
watch(
  () => harness.settings.defaultModes,
  (modes) => void agentRequest("default-modes", { ...modes }).catch(() => undefined),
  { immediate: true },
);

export function markSeen(...ids: string[]) {
  let changed = false;
  for (const id of ids)
    if (id && !harness.seen.has(id)) {
      harness.seen.add(id);
      changed = true;
    }
  if (!changed) return;
  try {
    localStorage.setItem(seenKey, JSON.stringify([...harness.seen].slice(-300)));
  } catch {}
}

const busy = (run: AgentRunSummary) => run.status === "running" || run.status === "stopping";
export const activityGroups = computed(() => {
  const waiting = harness.runs.filter((run) => busy(run) && run.awaitingApproval);
  const running = harness.runs.filter((run) => busy(run) && !run.awaitingApproval);
  const day = Date.now() - 24 * 3600_000;
  const done = harness.runs.filter(
    (run) => !busy(run) && !harness.seen.has(run.id) && (run.endedAt ?? Date.now()) > day,
  );
  return { waiting, running, done };
});
export const activityCount = computed(
  () => activityGroups.value.waiting.length + activityGroups.value.done.length,
);
/** Runs holding the PC awake: working, not waiting for the user. */
export const awakeRuns = computed(() =>
  harness.settings.keepAwake ? harness.runs.filter((run) => busy(run) && !run.awaitingApproval) : [],
);

type Notify = { notify?(data: { title: string; body: string; appId: string }): Promise<void>; keepAwake?(on: boolean): Promise<boolean> };
const bridge = () => (window as unknown as { orvaneDesktop?: Notify }).orvaneDesktop;

function alert(run: AgentRunSummary, title: string, body: string) {
  if (!harness.settings.alerts || (document.hasFocus() && !document.hidden)) return;
  const notify = bridge()?.notify;
  if (notify) void notify({ title, body, appId: `agent-run:${run.id}` }).catch(() => undefined);
  else if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
}

let previous = new Map<string, AgentRunSummary>();
function compare(runs: AgentRunSummary[]) {
  for (const run of runs) {
    const before = previous.get(run.id);
    const name = agentNames[run.provider];
    if (run.awaitingApproval && run.approval && before?.approval?.id !== run.approval.id && busy(run))
      alert(
        run,
        run.approval.questions ? `${name} has a question` : `${name} needs your approval`,
        run.approval.questions ? `${run.title} · ${run.approval.detail}` : `${run.title} · ${run.approval.tool}: ${run.approval.detail}`,
      );
    if (before && busy(before) && !busy(run)) {
      if (run.status === "completed") alert(run, `${name} finished`, run.title);
      else if (run.status === "failed") alert(run, `${name} stopped with an error`, run.title);
    }
  }
  previous = new Map(runs.map((run) => [run.id, run]));
}

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
export function startActivity() {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      const { runs } = await agentRequest<{ runs: AgentRunSummary[] }>("runs");
      // First read: earlier runs count as seen, so old work is not "new".
      if (!previous.size && !harness.runs.length)
        markSeen(...runs.filter((run) => !busy(run) && !harness.seen.has(run.id) && (run.endedAt ?? 0) < Date.now() - 60_000).map((run) => run.id));
      compare(runs);
      harness.runs = runs;
      for (const run of [...runs].reverse()) agentRunIndicators.set(run.id, run);
      while (agentRunIndicators.size > 20) {
        const oldest = agentRunIndicators.keys().next().value;
        if (!oldest) break;
        agentRunIndicators.delete(oldest);
      }
    } catch {}
    timer = setTimeout(tick, harness.runs.some(busy) ? 2000 : 4000);
  };
  void tick();
  watch(
    () => awakeRuns.value.length > 0,
    async (on) => {
      const keep = bridge()?.keepAwake;
      harness.awake = keep ? await keep(on).catch(() => false) : false;
    },
    { immediate: true },
  );
}
export function stopActivity() {
  clearTimeout(timer);
  started = false;
}
export function openRunFromAlert(appId: string) {
  if (!appId.startsWith("agent-run:")) return false;
  host?.openRun(appId.slice("agent-run:".length));
  return true;
}
