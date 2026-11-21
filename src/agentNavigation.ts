import { shallowReactive } from "vue";
import type { AgentRun, AgentRunSummary } from "./agentSessions";

export const agentOpenRequests = shallowReactive(
  new Map<string, { key: string } | { run: AgentRun }>(),
);
export const agentRunIndicators = shallowReactive(
  new Map<string, AgentRunSummary>(),
);
