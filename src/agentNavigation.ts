import { reactive, shallowReactive } from "vue";
import type { AgentProvider, AgentEffort, AgentEditMode, AgentRun, AgentRunSummary } from "./agentSessions";
import type { AgentQuote } from "./agentHarness";

export interface AgentDraft {
  provider: AgentProvider;
  folder: string;
  text: string;
  paths: string[];
  quotes?: AgentQuote[];
  model?: string;
  effort?: AgentEffort | "";
  mode?: AgentEditMode | "";
  runId?: string;
}

export const PIN_AGENT_DRAFT = "orvane:pin-agent-draft";

export const agentOpenRequests = shallowReactive(
  new Map<string, { key: string } | { run: AgentRun }>(),
);
export const agentRunIndicators = shallowReactive(
  new Map<string, AgentRunSummary>(),
);

/* ---------- Continue with another model ---------- */

/** The session a new one continues from. */
export interface AgentSource {
  key: string;
  title: string;
  provider: AgentProvider;
}

/** Which session each continued session came from (child key → source).
 * A convenience for the header links and the session list, kept per machine. */
const LINEAGE_KEY = "orvane-agent-lineage";
export const agentLineage = reactive(new Map<string, AgentSource>());
try {
  const saved = JSON.parse(localStorage.getItem(LINEAGE_KEY) || "{}") as Record<string, AgentSource>;
  for (const [key, source] of Object.entries(saved))
    if (source && typeof source.key === "string") agentLineage.set(key, source);
} catch {}
export function recordLineage(child: string, source: AgentSource) {
  if (child === source.key) return;
  agentLineage.set(child, source);
  try {
    localStorage.setItem(LINEAGE_KEY, JSON.stringify(Object.fromEntries([...agentLineage].slice(-200))));
  } catch {}
}

/** Drafts that continue a session and are not sent yet, so the source can
 * say where it continues. id: the draft's own instance. */
export interface ContinueDraft {
  id: string;
  blockId: string;
  paneId: string;
  from: AgentSource;
  provider: AgentProvider;
}
export const continueDrafts = shallowReactive(new Map<string, ContinueDraft>());

/** Show a session (and one of its messages) where it is open: the Agent
 * Sessions app focuses its pane, the pinned panel switches to it. */
export const AGENT_REVEAL = "orvane:agent-reveal";
export interface AgentReveal {
  /** The app (or `session-chat:side`) the request comes from. */
  blockId: string;
  key?: string;
  /** A draft pane to go back to. */
  paneId?: string;
  messageId?: string;
}
/** A message to scroll to once its session has been read. */
export const pendingReveals = new Map<string, string>();
export function revealSession(detail: AgentReveal) {
  if (detail.key && detail.messageId) pendingReveals.set(detail.key, detail.messageId);
  window.dispatchEvent(new CustomEvent<AgentReveal>(AGENT_REVEAL, { detail }));
}
