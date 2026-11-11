// Upper bounds on benchmark medians for `pnpm bench -- --check`, on the
// 50-app fixture. They are several times what the reference machine measures
// (i7-1355U, integrated graphics, 60 Hz): loose enough to hold on slower
// hardware, tight enough to catch a whole-document restyle or a blocked
// camera, which cost 700–1400 ms before they were removed.
export const budgets: Record<string, Record<string, number>> = {
  // A press, release or Space must not restyle the workspace.
  clickCanvas: { styleMs: 60, firstFrameMs: 120 },
  clickInApp: { styleMs: 60, firstFrameMs: 120 },
  spaceArm: { styleMs: 30, firstFrameMs: 120 },
  // Motion starts within a few frames of the input.
  panNormal: { styleMs: 80, cameraFirstMs: 120, over34ms: 6 },
  dragApp: { styleMs: 60, firstFrameMs: 120, over34ms: 6 },
  switchFar: { styleMs: 60, cameraFirstMs: 100 },
  switchBack: { styleMs: 60, cameraFirstMs: 100 },
  // An open workspace at rest does next to nothing.
  idle: { taskMs: 150, styleMs: 5 },
};

export function exceeded(
  scenarios: Record<string, Record<string, number | null>>,
) {
  const failures: string[] = [];
  for (const [scenario, limits] of Object.entries(budgets))
    for (const [metric, limit] of Object.entries(limits)) {
      const value = scenarios[scenario]?.[metric];
      if (typeof value !== "number")
        failures.push(`${scenario}.${metric}: not measured`);
      else if (value > limit)
        failures.push(`${scenario}.${metric}: ${value} > ${limit}`);
    }
  return failures;
}
