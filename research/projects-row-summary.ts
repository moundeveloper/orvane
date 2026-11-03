import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const directories = process.argv.slice(2);
if (!directories.length) throw Error("Pass completed projects-rows artifact directories.");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const ensure = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const distribution = (values: number[]) => {
  ensure(values.length && values.every(Number.isFinite), "Missing timing samples.");
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted.at(-1)! };
};
let sources: any;
const cohorts: any[] = [];
for (const directory of directories) {
  const data = read(join(directory, "results.json"));
  ensure(data.runtime === "electron" && data.experiment === "projects-rows" && data.comparisonKind === "implementation" && data.comparisonsCompleted && !data.failure, "Incomplete or wrong experiment.");
  sources ??= data.sources;
  ensure(JSON.stringify(sources) === JSON.stringify(data.sources), "Candidate sources differ between cohorts.");
  for (const [path, hashes] of Object.entries(data.sources.baselineOverrides) as [string, any][])
    ensure(sha(path) === hashes.candidateSha256, `Candidate source changed after timing: ${path}`);
  for (const [path, hash] of Object.entries(data.sources.candidateNewModules))
    ensure(sha(path) === hash, `New candidate module changed after timing: ${path}`);
  for (const mode of [...new Set<string>(data.results.map((r: any) => r.cameraMode))]) {
    const runs = data.results.filter((r: any) => r.cameraMode === mode);
    ensure(runs.length === data.repetitions * 2 + 2, "Missing primary/diagnostic pair.");
    const payload = JSON.stringify(runs[0].fixtureSettings), geometry = JSON.stringify(runs[0].view);
    for (const run of runs) {
      const v = run.validity;
      ensure(v.focused && v.visible && !v.focusLosses && !v.hidden, "Interrupted sample.");
      ensure(run.density === "high" && JSON.stringify(run.fixtureSettings) === payload, "Payload differs between variants.");
      ensure(JSON.stringify(run.view) === geometry, "Camera/app geometry differs between variants.");
      ensure(run.requests["/__orvane/projects/terminal/run"] === run.counts.projects, "Mock terminal population differs.");
      ensure(run.variant === "baseline" ? run.counts.projectRows === 100 * run.counts.projects : run.counts.windowedProjectLists === run.counts.projects, "Unexpected row rendering mode.");
    }
    const variants = Object.fromEntries(["baseline", "candidate"].map((variant) => {
      const primary = runs.filter((r: any) => r.variant === variant && !r.diagnostic);
      const diagnostic = runs.find((r: any) => r.variant === variant && r.diagnostic)!;
      ensure(primary.length === data.repetitions && diagnostic, "Missing variant samples.");
      const events = read(join(directory, `${variant}-${diagnostic.appCount}-${mode}-trace.json`)).traceEvents;
      const mark = (name: string) => {
        const matches = events.filter((e: any) => e.name === name);
        ensure(matches.length === 1, `Missing/duplicate ${name} mark.`);
        return matches[0].ts;
      };
      const start = mark("foreground:pan:continuous"), end = mark("foreground:pan:stop");
      const phase = events.filter((e: any) => e.ts >= start && e.ts < end && e.ph === "X");
      const traceWork = Object.fromEntries(["Layerize", "Paint", "RasterTask", "Layout", "UpdateLayoutTree", "FunctionCall"].map((name) => {
        const rows = phase.filter((e: any) => e.name === name);
        return [name, { count: rows.length, aggregateMs: rows.reduce((n: number, e: any) => n + (e.dur ?? 0), 0) / 1000, maxMs: rows.reduce((n: number, e: any) => Math.max(n, e.dur ?? 0), 0) / 1000 }];
      }));
      return [variant, {
        continuousMedianMs: distribution(primary.map((r: any) => r.panPhases.continuous.medianInterval)),
        continuousWorstMs: distribution(primary.map((r: any) => r.panPhases.continuous.maxInterval)),
        startWorstMs: distribution(primary.map((r: any) => r.panPhases.start.maxInterval)),
        stopWorstMs: distribution(primary.map((r: any) => r.panPhases.stop.maxInterval)),
        primary: primary.map((r: any) => ({ index: r.index, counts: r.counts, panPhases: r.panPhases, validity: r.validity, processMemoryAfterKB: r.resourcesAfter })),
        diagnostic: { counts: diagnostic.counts, traceWork, validity: diagnostic.validity, appearance: diagnostic.overviewAppearance },
      }];
    }));
    cohorts.push({ artifacts: directory, contentProfile: data.contentProfile, cameraMode: mode, appCount: runs[0].appCount, view: runs[0].view, heldPayload: runs[0].fixtureSettings, environment: { electron: runs[0].electron, browserVersion: runs[0].browserVersion }, repetitions: data.repetitions, baselineCommit: data.baselineCommit, candidateBaseCommit: data.candidateBaseCommit, rejectedAttempts: data.rejectedAttempts, variants });
  }
}
process.stdout.write(JSON.stringify({
  sources, cohorts,
  limits: [
    "Alternating baseline/candidate production builds with identical populated payloads. External operations are mocked; SQLite and the native Electron shell are real and isolated.",
    "Median/min/max summarize per-run callback statistics, not physical presented FPS, input latency or stable tail percentiles.",
    "Separate traces add overhead; nested paint and parallel raster event sums are not exclusive CPU or wall time.",
    "Overview app intersections and geometry are reported explicitly; the mixed fixture does not fit all fifty large apps onscreen.",
    "No forced GC, heap stabilization, 100-cycle or thirty-minute soak claim. Process memory is separate working/private/peak values in Electron kilobytes.",
    "Terminal output is prepopulated before pan and stays static during timing. Query outputs, expanded deployments and large diffs are not included.",
    "Potentially wrapping names and horizontally overflowing lists use the original full-list rendering path; native Find sees only mounted text in windowed lists.",
  ],
}, null, 2) + "\n");
