// Sums renderer and GPU work between the benchmark's user-timing marks.
// Nested events are reported under their own name, so rows overlap (script
// inside an event dispatch inside a task); compare a row with itself across
// builds rather than adding rows together.
interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  cat?: string;
  args?: any;
}
const MAIN = [
  "RunTask",
  "EventDispatch",
  "FunctionCall",
  "FireAnimationFrame",
  "UpdateLayoutTree",
  "Layout",
  "PrePaint",
  "Paint",
  "Layerize",
  "Commit",
  "MinorGC",
  "MajorGC",
];
const OTHER = ["RasterTask", "GPUTask", "ImageDecodeTask"];

export function summarizeTrace(trace: { traceEvents: TraceEvent[] } | TraceEvent[]) {
  const events = Array.isArray(trace) ? trace : trace.traceEvents;
  const marks = new Map<string, TraceEvent>();
  for (const event of events)
    if (event.name.startsWith("bench:") && !marks.has(event.name))
      marks.set(event.name, event);
  const scenarios = [...marks.keys()]
    .filter((name) => name.endsWith(":start"))
    .map((name) => name.slice(6, -6));
  const first = marks.values().next().value;
  if (!first) return {};
  const summary: Record<string, Record<string, number>> = {};
  for (const scenario of scenarios) {
    const start = marks.get(`bench:${scenario}:start`),
      end = marks.get(`bench:${scenario}:end`);
    if (!start || !end) continue;
    const totals: Record<string, number> = {};
    let longestStyle = 0,
      longestTask = 0;
    for (const event of events) {
      if (event.ph !== "X" || !event.dur) continue;
      if (event.ts < start.ts || event.ts > end.ts) continue;
      const main = event.pid === start.pid && event.tid === start.tid;
      if (main ? !MAIN.includes(event.name) : !OTHER.includes(event.name))
        continue;
      totals[event.name] = (totals[event.name] || 0) + event.dur / 1000;
      if (event.name === "UpdateLayoutTree")
        longestStyle = Math.max(longestStyle, event.dur / 1000);
      if (event.name === "RunTask")
        longestTask = Math.max(longestTask, event.dur / 1000);
    }
    summary[scenario] = Object.fromEntries(
      Object.entries({
        ...totals,
        longestStyleRecalc: longestStyle,
        longestTask,
        wall: (end.ts - start.ts) / 1000,
      }).map(([name, value]) => [name, Math.round(value * 10) / 10]),
    );
  }
  return summary;
}
