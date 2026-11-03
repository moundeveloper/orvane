import { readFileSync } from "node:fs";
import { join } from "node:path";

// Summarize only the marked continuous-pan phase, keeping diagnostic trace
// work separate from untraced callback samples. Raw artifacts stay untouched.
const directories = process.argv.slice(2);
if (!directories.length)
  throw Error("Pass one or more foreground artifact directories.");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const stats = (events: any[]) => ({
  count: events.length,
  aggregateMs: events.reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000,
  maxMs: Math.max(0, ...events.map((e) => (e.dur ?? 0) / 1000)),
});
const summaries = directories.map((directory) => {
  const result = read(join(directory, "results.json"));
  if (
    !result.comparisonsCompleted ||
    result.results.some(
      (r: any) =>
        !r.validity.focused ||
        !r.validity.visible ||
        r.validity.focusLosses ||
        r.validity.hidden,
    )
  )
    throw Error(`Incomplete or interrupted comparison: ${directory}`);
  const diagnostics = result.results.filter((r: any) => r.diagnostic);
  return {
    directory,
    ablation: result.ablation ?? "none",
    baselineCommit: result.baselineCommit,
    candidateBaseCommit: result.candidateBaseCommit,
    candidateStyleAppend: result.candidateStyleAppend,
    sources: result.sources,
    traceCategories: result.traceCategories,
    rejectedAttempts: result.rejectedAttempts,
    primary: result.results
      .filter((r: any) => !r.diagnostic)
      .map((r: any) => ({
        variant: r.variant,
        view: r.view,
        counts: r.counts,
        panPhases: r.panPhases,
        validity: r.validity,
      })),
    diagnostic: diagnostics.map((run: any) => {
      const trace = read(
        join(
          directory,
          `${run.variant}-${run.appCount}-${run.cameraMode}-trace.json`,
        ),
      );
      const events = trace.traceEvents;
      const mark = (name: string) => {
        const matches = events.filter((e: any) => e.name === name);
        if (matches.length !== 1) throw Error(`Expected one ${name} mark.`);
        return matches[0].ts;
      };
      const start = mark("foreground:pan:continuous"),
        stop = mark("foreground:pan:stop");
      const phase = events.filter((e: any) => e.ts >= start && e.ts < stop);
      const named = (name: string) =>
        phase.filter((e: any) => e.name === name && e.ph === "X");
      const raster = named("RasterTask");
      const ids = [
        ...new Set(raster.map((e: any) => e.args?.tileData?.layerId)),
      ];
      const byLayer = ids
        .map((layerId) => {
          const rows = raster.filter(
            (e: any) => e.args?.tileData?.layerId === layerId,
          );
          return {
            layerId,
            ...stats(rows),
            sourceFrames: new Set(
              rows.map((e: any) => e.args?.tileData?.sourceFrameNumber),
            ).size,
            recordedTileIds: new Set(
              rows.map((e: any) => e.args?.tileData?.tileId?.id_ref),
            ).size,
          };
        })
        .sort((a, b) => b.aggregateMs - a.aggregateMs);
      const paint = named("Paint");
      const clips = [
        ...new Set(paint.map((e: any) => JSON.stringify(e.args?.data?.clip))),
      ];
      const debugNames = [
        ...new Set<string>(phase.map((e: any) => e.name)),
      ].filter((name) => /invalid|damage/i.test(name));
      return {
        variant: run.variant,
        validity: run.validity,
        markedDurationMs: (stop - start) / 1000,
        work: Object.fromEntries(
          [
            "Paint",
            "RasterTask",
            "GpuRasterBuffer::Playback",
            "Layout",
            "UpdateLayoutTree",
          ].map((name) => [name, stats(named(name))]),
        ),
        rasterLayerCount: byLayer.length,
        rasterLayersTop10: byLayer.slice(0, 10),
        gpuPlaybackArgsSample: named("GpuRasterBuffer::Playback")
          .slice(0, 2)
          .map((e: any) => e.args),
        recordedPaintClipCount: clips.length,
        recordedPaintClipsSample: clips.slice(0, 3),
        invalidationAndDamageEvents: Object.fromEntries(
          debugNames.map((name) => [
            name,
            phase.filter((e: any) => e.name === name).length,
          ]),
        ),
      };
    }),
  };
});
process.stdout.write(
  JSON.stringify(
    {
      limits: [
        "Counterfactual ablations intentionally alter appearance and are not production candidates.",
        "Single untraced screening pairs; not stable speedup estimates, physical FPS or input latency.",
        "Rich compositor tracing adds substantial overhead; do not compare traced callback intervals to untraced timings.",
        "Nested paint and parallel raster work overlap; aggregate durations are not exclusive CPU or wall time.",
        "Recorded Paint clips are not raster damage bounds. Layer IDs are local to each trace; tile IDs may be reused.",
        "rasterLayerCount counts IDs referenced by RasterTask, not all layers in a compositor layer tree.",
      ],
      summaries,
    },
    null,
    2,
  ) + "\n",
);
