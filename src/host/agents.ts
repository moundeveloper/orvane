// Laptop entry served by Orvane Host: the desktop's own AgentSessions.vue,
// not a copy. Its requests go to the host's authenticated, project-scoped
// /__orvane/agents and /__orvane/files routes (server/orvane-host-agents.ts).
import { createApp, h, reactive, watch } from "vue";
import AgentSessions from "../components/AgentSessions.vue";
import { makeBlock } from "../model";
import { harness } from "../agentHarness";
import "../style.css";
import "../scrollbars.css";
import "../selectPopover.css";
// The shared dropdown trigger look (one line, ellipsis), as on the desktop.
import "../editor.css";
import "./csrf";

// New chats start in the desktop's default edit modes (Settings → Sessions).
try {
  const modes = JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="orvane-modes"]')?.content || "{}");
  if (modes && typeof modes === "object") harness.settings.defaultModes = { ...harness.settings.defaultModes, ...modes };
} catch {}

// The app's saved layout (split panes, open sessions) lives on this laptop.
const key = "orvane-host-agents-block";
const block = reactive(makeBlock("claude"));
block.id = "host-agents";
block.value = localStorage.getItem(key) ?? "";
watch(() => block.value, (value) => localStorage.setItem(key, value));

createApp({ render: () => h(AgentSessions, { block, focused: true }) }).mount("#host-agents");
