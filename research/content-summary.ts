import { readFileSync } from "node:fs";
import { join } from "node:path";

const directories = process.argv.slice(2);
if (!directories.length)
  throw Error("Pass completed content-profile artifact directories.");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
let geometry: any[] | undefined;
let productionCommit: string | undefined;
let sourceHashes: any;
let environment: any;
const profiles = directories.map((directory) => {
  const data = read(join(directory, "results.json"));
  const diagnosticDensities = data.results
    .filter((r: any) => r.diagnostic)
    .map((r: any) => r.density)
    .sort();
  if (
    data.comparisonKind !== "content-density" ||
    !data.comparisonsCompleted ||
    data.failure ||
    JSON.stringify(diagnosticDensities) !== JSON.stringify(["high", "low"])
  )
    throw Error(`Not a completed content comparison: ${directory}`);
  if (
    data.baselineCommit !== data.candidateBaseCommit ||
    data.sources.baselineAppSha256 !== data.sources.candidateAppSha256 ||
    data.sources.baselineStyleSha256 !== data.sources.candidateStyleSha256
  )
    throw Error("Content comparisons must use identical production code.");
  productionCommit ??= data.baselineCommit;
  sourceHashes ??= data.sources;
  const metadata = data.results[0].electron;
  environment ??= {
    versions: metadata.versions,
    display: metadata.display,
    contentSize: metadata.contentSize,
    gpuComplete: metadata.gpuComplete,
    hardwareAccelerationEnabled: metadata.hardwareAccelerationEnabled,
  };
  if (
    productionCommit !== data.baselineCommit ||
    JSON.stringify(sourceHashes) !== JSON.stringify(data.sources)
  )
    throw Error("Production sources differ between content profiles.");
  const runs = data.results.map((run: any) => {
    if (
      data.contentProfile === "projects" &&
      run.requests["/__orvane/projects/terminal/run"] !== 20
    )
      throw Error("Expected exactly twenty mock terminal commands before pan.");
    const v = run.validity;
    if (!v.focused || !v.visible || v.focusLosses || v.hidden)
      throw Error("Interrupted content sample.");
    if (
      run.appCount !== 20 ||
      run.view.visibleApps !== 20 ||
      Math.abs(run.view.scale - 0.2) > 0.001
    )
      throw Error("Expected twenty visible overview apps.");
    geometry ??= run.view.appRects;
    if (
      geometry?.length !== 20 ||
      JSON.stringify(geometry) !== JSON.stringify(run.view.appRects)
    )
      throw Error("Content profile geometry differs.");
    let traceWork;
    if (run.diagnostic) {
      const events = read(
        join(directory, `${run.variant}-20-overview-trace.json`),
      ).traceEvents;
      const threadNames = new Map(
        events
          .filter((e: any) => e.name === "thread_name")
          .map((e: any) => [`${e.pid}:${e.tid}`, e.args.name]),
      );
      const mark = (name: string) => {
        const found = events.filter((e: any) => e.name === name);
        if (found.length !== 1) throw Error(`Missing/duplicate ${name} mark.`);
        return found[0].ts;
      };
      const start = mark("foreground:pan:continuous"),
        stop = mark("foreground:pan:stop");
      const phase = events.filter(
        (e: any) => e.ts >= start && e.ts < stop && e.ph === "X",
      );
      traceWork = Object.fromEntries(
        [
          "Paint",
          "RasterTask",
          "Layerize",
          "Commit",
          "Layout",
          "UpdateLayoutTree",
          "FunctionCall",
        ].map((name) => {
          const rows = phase.filter((e: any) => e.name === name);
          return [
            name,
            {
              threads: [
                ...new Set(
                  rows.map(
                    (e: any) =>
                      threadNames.get(`${e.pid}:${e.tid}`) ??
                      `${e.pid}:${e.tid}`,
                  ),
                ),
              ],
              count: rows.length,
              aggregateMs:
                rows.reduce((n: number, e: any) => n + (e.dur ?? 0), 0) / 1000,
              maxMs:
                rows.reduce((n: number, e: any) => Math.max(n, e.dur ?? 0), 0) /
                1000,
            },
          ];
        }),
      );
    }
    const settings = run.fixtureSettings;
    return {
      density: run.density,
      diagnostic: run.diagnostic,
      payload: Object.fromEntries(
        [
          "pages",
          "blocksPerDocument",
          "commits",
          "scripts",
          "projectsPerRoot",
          "savedTerminals",
          "terminalLines",
        ].map((k) => [k, settings[k]]),
      ),
      counts: run.counts,
      panPhases: run.panPhases,
      validity: v,
      terminalMockCalls: run.requests["/__orvane/projects/terminal/run"] ?? 0,
      processMemoryAfterKB: run.resourcesAfter,
      traceWork,
    };
  });
  return {
    profile: data.contentProfile,
    artifacts: directory,
    repetitions: data.repetitions,
    rejectedAttempts: data.rejectedAttempts,
    runs,
  };
});
process.stdout.write(
  JSON.stringify(
    {
      productionCommit,
      environment,
      sourceHashes,
      appGeometryCssPixels: geometry,
      limits: [
        "Controlled twenty-app homogeneous cohorts, not a mixed fifty-app capacity result.",
        "Low/high payload comparisons with separate diagnostics; see per-profile repetitions. Not stable tail estimates or implementation speedups.",
        "All app rectangles and production source hashes match. Payloads and component types differ intentionally.",
        "Sequential cohorts do not hold OS/thermal conditions fixed. Callback intervals are not physical FPS or input latency.",
        "Trace event durations overlap categories/threads; sums are not exclusive CPU or wall time.",
        "Process snapshots are kilobytes reported by Electron; no forced GC, retained heap or stabilization claim. Do not add working sets as physical RAM.",
        "Projects output is populated through mock commands before timing and remains static during pan; real commands are never executed.",
        "Projects also holds 100 project entries per view; these cohorts do not uniquely attribute its cost to terminal buffers.",
      ],
      profiles,
    },
    null,
    2,
  ) + "\n",
);
