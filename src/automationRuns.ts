// Run history for Action-library workflows, shown on the automation
// timeline: one entry per top-level workflow run with when it started and
// ended, who started it and the error if it failed. Kept in the workspace,
// trimmed to the last week and a few hundred runs.
import { nextOccurrence, type Trigger } from "./triggers";

export type RunSource = "trigger" | "manual" | "button" | "ai";
export interface AutomationRun {
  id: string;
  workflowId: string;
  source: RunSource;
  triggerId?: string;
  start: number;
  end: number;
  error?: string;
}

export const RUN_LIMIT = 400;
export const RUN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Adds a finished run, newest last, dropping old and excess runs. */
export function addRun(runs: AutomationRun[] | undefined, run: AutomationRun, now = Date.now()) {
  const kept = (runs ?? []).filter((r) => now - r.end < RUN_KEEP_MS);
  kept.push(run);
  return kept.slice(-RUN_LIMIT);
}

export const SOURCE_LABEL: Record<RunSource, string> = {
  trigger: "Trigger",
  manual: "Run now",
  button: "App button",
  ai: "AI",
};

/** Runs of one lane that overlap a run of another lane, as [start, end] spans. */
export function overlaps(runs: { lane: string; start: number; end: number }[]) {
  const spans: [number, number][] = [];
  const sorted = [...runs].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length && sorted[j]!.start < sorted[i]!.end; j++) {
      if (sorted[j]!.lane === sorted[i]!.lane) continue;
      spans.push([sorted[j]!.start, Math.min(sorted[i]!.end, sorted[j]!.end)]);
    }
  // Merge touching spans so a busy stretch reads as one band.
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/** Planned runs of a trigger between from and to (at most 96). */
export function plannedRuns(trigger: Trigger, from: number, to: number) {
  const out: number[] = [];
  let cursor = from;
  // Walk forward one occurrence at a time, as if each planned run had run.
  while (out.length < 96) {
    const next = nextOccurrence({ ...trigger, lastRun: out.at(-1) ?? trigger.lastRun }, cursor);
    if (next === null || next > to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
