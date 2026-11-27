// "Mock ready" cards in Agent sessions (UI Maker "UI mock ready", picked
// variant Preview card). The agent calls the uimaker_present MCP tool when it
// judges a mock ready; its compact JSON result (server/uimaker-tools.ts) is
// read back from the transcript and drawn as a card that opens UI Maker.
import type { AgentMessage } from "./exposition";

export type MockReady = {
  /** Tool call ID, unique per card. */
  id: string;
  component: string;
  name: string;
  summary: string;
  mode: "lab" | "review";
  round?: string;
  title?: string;
  variants?: { id: string; label: string }[];
  version?: number;
  /** Render path under the UI Maker files route. */
  thumb?: string;
};

/** Dispatched on window by a card; App.vue opens UI Maker on it. */
export const MOCK_READY_OPEN = "orvane:mock-ready-open";
export type MockReadyOpen = {
  component: string;
  mode: "lab" | "review";
  version?: number;
  lab?: { round: string; variant?: string };
  /** Set by App.vue: resolves when UI Maker shows it, rejects with the reason. */
  opened?: Promise<unknown>;
};

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function parseMockReady(id: string, output: string | undefined): MockReady | undefined {
  if (!output || !output.includes('"orvaneMockReady"')) return;
  let data: any;
  try {
    data = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  } catch {
    return;
  }
  if (data?.orvaneMockReady !== 1 || typeof data.component !== "string" || !ID.test(data.component)) return;
  const lab = data.mode === "lab" && typeof data.round === "string" && /^r\d{1,4}$/.test(data.round);
  const version = Number.isInteger(data.version) && data.version > 0 ? (data.version as number) : undefined;
  if (!lab && !version) return;
  return {
    id,
    component: data.component,
    name: String(data.name ?? data.component).slice(0, 80),
    summary: String(data.summary ?? "").slice(0, 200),
    mode: lab ? "lab" : "review",
    ...(lab
      ? {
          round: data.round,
          title: String(data.title ?? "").slice(0, 60),
          variants: (Array.isArray(data.variants) ? data.variants : [])
            .filter((v: any) => typeof v?.id === "string" && ID.test(v.id))
            .slice(0, 9)
            .map((v: any) => ({ id: v.id, label: String(v.label ?? v.id).slice(0, 24) })),
        }
      : { version }),
    ...(typeof data.thumb === "string" && /^[a-z0-9-]+\/present\/[\w.-]+\.png$/.test(data.thumb) ? { thumb: data.thumb } : {}),
  };
}

/** The cards in one reply, in call order. */
export const mockReadyCards = (message: AgentMessage) =>
  message.tools
    .filter((tool) => tool.name.endsWith("uimaker_present") && tool.status !== "failed")
    .map((tool) => parseMockReady(tool.id, tool.output))
    .filter((card): card is MockReady => !!card);
