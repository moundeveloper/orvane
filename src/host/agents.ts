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

// The host checks this per-sign-in token on every request that changes state.
const csrf = document.querySelector<HTMLMetaElement>('meta[name="orvane-csrf"]')?.content ?? "";
const send = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin) return send(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-orvane-csrf", csrf);
  return send(input, { ...init, headers });
};

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
