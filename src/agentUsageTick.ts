// Shared refresh signal for the subscription usage pills (AgentUsage.vue).
// Each pill used to refresh only on mount, on click and when its own chat's
// run ended, so the Agent sessions app and the pinned chat showed stale
// numbers until clicked. Runs that end anywhere dispatch USAGE_CHANGED; one
// timer for all mounted pills picks up limits reported elsewhere (another
// chat, a CLI in the Terminal). The request is local: nothing is fetched
// from Anthropic or OpenAI.

/** Dispatched on window when a run ends and limits may have changed. */
export const USAGE_CHANGED = "orvane:agent-usage-changed";
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

export function watchUsage(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    // Hidden windows do no work; the visibilitychange refresh catches up.
    if (document.hidden) return;
    for (const run of listeners) run();
  }, TICK_MS);
}

export function unwatchUsage(listener: () => void) {
  listeners.delete(listener);
  if (!listeners.size && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

export const announceUsageChanged = () => window.dispatchEvent(new Event(USAGE_CHANGED));
