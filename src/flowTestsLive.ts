// Test runs in progress, by Browser tab: fed by runs the Test runs app starts
// itself (src/flowTestsClient.ts) and by flow_tests runs an AI starts (the
// MCP server sends a "progress" browser operation each step). The Test runs
// app shows them live; BrowserView shows the REC pill and step trail.
import { reactive } from "vue";
import type { LiveRun } from "./flowRunner";

export const liveRuns = reactive<Record<string, LiveRun & { updatedAt: number }>>({});

export function setLiveRun(live: LiveRun) {
  if (!live || typeof live.tabId !== "string" || !Array.isArray(live.flows)) return;
  liveRuns[live.tabId] = { ...live, updatedAt: Date.now() };
  // A finished run stays on screen briefly, then its overlay goes.
  if (live.status === "done") {
    const runId = live.runId;
    setTimeout(() => {
      if (liveRuns[live.tabId]?.runId === runId && liveRuns[live.tabId]?.status === "done") delete liveRuns[live.tabId];
    }, 6000);
  }
}

/** The newest run in progress (or just finished), across tabs. */
export function latestLiveRun() {
  return Object.values(liveRuns).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
