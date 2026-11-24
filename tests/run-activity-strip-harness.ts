import { createApp, h } from "vue";
import RunActivity from "../src/components/AgentRunActivity.vue";
import type { AgentActivity } from "../src/agentSessions";

/** A finished reply's tool calls folded into the time strip, plus a key log
 * that records which keys reach the window (Orvane's own shortcuts). */
export function mountStripFixture() {
  const root = document.createElement("div");
  root.id = "strip-fixture";
  root.style.cssText = "position:fixed;inset:0;background:white;z-index:999999;padding:20px;";
  document.body.appendChild(root);
  const items: AgentActivity[] = ["workspace_status", "app_list", "app_get"].map((tool, index) => ({
    id: `call-${index}`,
    kind: "mcp",
    label: `orvane / ${tool}`,
    status: "completed",
    input: { id: String(index) },
    output: `result ${index}`,
    startedAt: 1000 * index,
    endedAt: 1000 * index + 500,
  }));
  const reached: string[] = [];
  root.addEventListener("keydown", (event) => {
    if (event.key.startsWith("Arrow") && !event.defaultPrevented) reached.push((event.ctrlKey ? "Control+" : "") + event.key);
  });
  createApp({ render: () => h(RunActivity, { items, strip: true, collapsed: false }) }).mount(root);
  return { reached };
}
