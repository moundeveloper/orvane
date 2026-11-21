export type AgentProvider = "claude" | "codex";

export const agentNames = { claude: "Claude Code", codex: "Codex" };
export const agentPermissions = {
  claude:
    "Claude Code prompts in Orvane when its permission rules require approval.",
  codex: "Codex can write in the workspace. Shell network access is disabled.",
};

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

export interface AgentRun {
  id: string;
  provider: AgentProvider;
  folder: string;
  model?: string;
  key?: string;
  sessionId?: string;
  message: string;
  text: string;
  activity: string;
  activities?: AgentActivity[];
  status: "running" | "stopping" | "completed" | "failed" | "stopped";
  error?: string;
  permissions: { id: string; tool: string; input: string }[];
}

export const agentBusy = (run?: AgentRun | null) =>
  run?.status === "running" || run?.status === "stopping";

export type AgentRunSummary = Pick<
  AgentRun,
  "id" | "provider" | "folder" | "status" | "sessionId"
> & {
  title: string;
  awaitingApproval: boolean;
};
export function summarizeAgentRun(run: AgentRun): AgentRunSummary {
  return {
    id: run.id,
    provider: run.provider,
    folder: run.folder,
    status: run.status,
    sessionId: run.sessionId,
    title: run.message.trim().split("\n", 1)[0]!.slice(0, 90),
    awaitingApproval: run.permissions.length > 0,
  };
}
