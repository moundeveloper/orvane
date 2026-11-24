import type { TriggerSchedule } from "./triggers.ts";

export type AgentProvider = "claude" | "codex";

export const agentNames = { claude: "Claude Code", codex: "Codex" };
export const agentPermissions = {
  claude:
    "Claude Code prompts in Orvane when its permission rules require approval.",
  codex: "Codex can write in the workspace. Shell network access is disabled.",
};

/** Reasoning effort; unset means the provider's own default. */
export const agentEfforts = ["low", "medium", "high", "max"] as const;
export type AgentEffort = (typeof agentEfforts)[number];
/** How edits are handled: ask before each, accept them, or only plan. */
// "full": no approvals and no sandbox (Claude bypassPermissions, Codex danger-full-access).
export type AgentEditMode = "ask" | "auto" | "plan" | "full";
export const agentEditModes: Record<AgentProvider, AgentEditMode[]> = {
  // Codex runs without approval prompts, so it can't ask first.
  claude: ["ask", "auto", "plan", "full"],
  codex: ["auto", "plan", "full"],
};
export const agentEditModeNames: Record<AgentEditMode, string> = {
  ask: "Ask first",
  auto: "Auto-accept",
  plan: "Plan only",
  full: "Full access",
};

export interface AgentSchedule {
  id: string;
  prompt: string;
  provider: AgentProvider;
  folder: string;
  model?: string;
  effort?: AgentEffort;
  mode?: AgentEditMode;
  schedule: TriggerSchedule;
  enabled: boolean;
  createdAt: number;
  lastOccurrence?: number;
  lastRun?: number;
  lastRunId?: string;
  lastStatus?: AgentRun["status"];
  lastSessionId?: string;
  lastSessionProvider?: AgentProvider;
  lastError?: string;
}

export interface AgentActivity {
  id: string;
  kind: "mcp" | "tool" | "command" | "reasoning" | "search" | "changes";
  label: string;
  status: "running" | "completed" | "failed" | "interrupted";
  summary?: string;
  /** Tool arguments by name, each shortened for display. */
  input?: Record<string, string>;
  /** Tool result or error text, shortened for display. */
  output?: string;
  startedAt?: number;
  endedAt?: number;
}

/** One subscription limit window: percent used and when it resets (ms). */
export interface AgentUsageWindow {
  used: number;
  resetsAt?: number;
}
/** The 5-hour and weekly limits a CLI last reported, and when (ms). */
export interface AgentUsage {
  at: number;
  fiveHour?: AgentUsageWindow;
  weekly?: AgentUsageWindow;
}

/** How full the session's context window was after the latest reply. */
export interface AgentContext {
  /** Tokens in the context: earlier turns, what this turn added, the reply. */
  used: number;
  window: number;
  estimatedWindow?: boolean;
  /** Earlier context read back from the cache. */
  cached: number;
  /** New input this turn (uncached and newly cached). */
  added: number;
  /** The latest reply. */
  output: number;
  model?: string;
}

const tokens = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** Claude's per-message usage. Result events can replace the estimated window. */
export function claudeContext(usage: unknown, model?: unknown, chosen?: string): AgentContext | undefined {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const cached = tokens(u.cache_read_input_tokens);
  const added = tokens(u.input_tokens) + tokens(u.cache_creation_input_tokens);
  const output = tokens(u.output_tokens);
  const used = cached + added + output;
  if (!used) return;
  const name = typeof model === "string" ? model.slice(0, 120) : undefined;
  const extended = /\[1m\]|claude-(?:fable\b|sonnet-5\b|haiku-5-5\b|opus-(?:4-[789]|5)\b)/i;
  const large = extended.test(chosen ?? "") || extended.test(name ?? "") || used > 200_000;
  return {
    used, window: large ? 1_000_000 : 200_000, estimatedWindow: true,
    cached, added, output, ...(name ? { model: name } : {}),
  };
}

/** Codex's token_count event: the last request's usage and the model's window. */
export function codexContext(info: unknown): AgentContext | undefined {
  if (!info || typeof info !== "object") return;
  const i = info as { last_token_usage?: Record<string, unknown>; model_context_window?: unknown };
  const last = i.last_token_usage;
  const window = tokens(i.model_context_window);
  if (!last || !window) return;
  const input = tokens(last.input_tokens);
  const cached = Math.min(tokens(last.cached_input_tokens), input);
  const output = tokens(last.output_tokens);
  const used = tokens(last.total_tokens) || input + output;
  if (!used) return;
  return { used, window, cached, added: input - cached, output };
}

/** A message waiting for the running turn to end. */
export interface AgentQueued {
  id: string;
  text: string;
}

/** The project's files saved just before a turn started (Orvane's own shadow Git). */
export interface AgentCheckpoint {
  commit: string;
  at: string;
}

export interface AgentRun {
  id: string;
  provider: AgentProvider;
  folder: string;
  model?: string;
  effort?: AgentEffort;
  mode?: AgentEditMode;
  fork?: boolean;
  key?: string;
  sessionId?: string;
  message: string;
  text: string;
  activity: string;
  activities?: AgentActivity[];
  status: "running" | "stopping" | "completed" | "failed" | "stopped";
  error?: string;
  permissions: { id: string; tool: string; input: string }[];
  /** Context use reported while the run works (Claude streams it). */
  context?: AgentContext;
  /** Messages sent in order once this run completes. */
  queued?: AgentQueued[];
  /** The run that took over the queue when this one ended. */
  next?: string;
  /** Messages that reached the agent mid-turn (Claude only). */
  steered?: { text: string; at: string }[];
  checkpoint?: AgentCheckpoint;
  /** Resume Claude at this transcript message (a rewound chat). */
  resumeAt?: string;
  startedAt?: number;
  endedAt?: number;
}

export const agentBusy = (run?: AgentRun | null) =>
  run?.status === "running" || run?.status === "stopping";

export type AgentRunSummary = Pick<
  AgentRun,
  "id" | "provider" | "folder" | "status" | "sessionId"
> & {
  title: string;
  awaitingApproval: boolean;
  /** The first approval the run waits for. */
  approval?: { id: string; tool: string; detail: string; questions?: boolean };
  startedAt?: number;
  endedAt?: number;
};
/** One line describing what an approval request would do. */
/** One question from Claude's AskUserQuestion tool. */
export interface AgentQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
}
/** Answers for AskUserQuestion, keyed by question text: an option label,
 * labels joined with ", " (multiSelect) or the owner's own text. */
export interface AgentAnswer {
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string; preview?: string }>;
}
/** The questions of an AskUserQuestion request, or null when the request is
 * something else (or its input is not the expected shape). */
export function askedQuestions(permission: { tool: string; input: string }): AgentQuestion[] | null {
  if (permission.tool !== "AskUserQuestion" || !permission.input) return null;
  try {
    const value = JSON.parse(permission.input) as { questions?: unknown };
    if (!Array.isArray(value.questions) || !value.questions.length) return null;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const questions = value.questions.map((raw: any): AgentQuestion | null => {
      const question = text(raw?.question);
      if (!question || !Array.isArray(raw.options)) return null;
      const options = raw.options
        .map((o: any) => ({ label: text(o?.label), description: text(o?.description), ...(text(o?.preview) ? { preview: text(o.preview) } : {}) }))
        .filter((o: { label: string }) => o.label);
      return { question, header: text(raw.header) || question.slice(0, 12), multiSelect: raw.multiSelect === true, options };
    });
    return questions.every(Boolean) ? (questions as AgentQuestion[]) : null;
  } catch {
    return null;
  }
}
/** "2 questions · Focus mode zoom: …" for an AskUserQuestion request. */
function questionDetail(permission: { tool: string; input: string }) {
  const questions = askedQuestions(permission);
  if (!questions) return null;
  const count = questions.length === 1 ? "1 question" : `${questions.length} questions`;
  return `${count} · ${questions[0]!.question}`.slice(0, 160);
}
export function approvalDetail(input: string) {
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    const first = value.command ?? value.file_path ?? value.path ?? value.url ?? value.pattern;
    if (typeof first === "string") return first.split("\n", 1)[0]!.slice(0, 160);
  } catch {}
  return input.replace(/\s+/g, " ").slice(0, 160);
}
export function summarizeAgentRun(run: AgentRun): AgentRunSummary {
  return {
    id: run.id,
    provider: run.provider,
    folder: run.folder,
    status: run.status,
    sessionId: run.sessionId,
    title: run.message.trim().split("\n", 1)[0]!.slice(0, 90),
    awaitingApproval: run.permissions.length > 0,
    ...(run.permissions[0]
      ? {
          approval: {
            id: run.permissions[0].id,
            tool: run.permissions[0].tool,
            detail: questionDetail(run.permissions[0]) ?? approvalDetail(run.permissions[0].input),
            // Questions need their own card: the bell opens the session.
            ...(askedQuestions(run.permissions[0]) ? { questions: true } : {}),
          },
        }
      : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  };
}
