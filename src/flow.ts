import type { ActionGraph, Rule } from "./model";
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// A join runs once, after all its incoming branches settle. Failed inputs block
// dependent work; explicit failure edges carry the error to a fallback instead.
export async function executeGraph(
  rules: Rule[],
  graph: ActionGraph,
  initial: string,
  execute: (rule: Rule, value: string) => Promise<string>,
  recoverFailures = false,
): Promise<string> {
  type Result = { state: "success" | "failure" | "skipped"; value: string };
  const results = new Map<string, Result>([
    ["trigger", { state: "success", value: initial }],
  ]);
  const reachable = new Set<string>(["trigger"]);
  for (let i = 0; i <= rules.length; i++)
    graph.edges.forEach((e) => {
      if (reachable.has(e.source)) reachable.add(e.target);
    });
  const failures: { id: string; message: string }[] = [];
  let last = initial;
  const pending = new Set(
    rules.filter((r) => reachable.has(r.id)).map((r) => r.id),
  );
  while (pending.size) {
    let progressed = false;
    for (const rule of rules) {
      if (!pending.has(rule.id)) continue;
      const inputs = graph.edges.filter(
        (e) => e.target === rule.id && reachable.has(e.source),
      );
      if (inputs.some((e) => !results.has(e.source))) continue;
      pending.delete(rule.id);
      progressed = true;
      const active = inputs.filter(
        (e) =>
          results.get(e.source)!.state ===
          (e.on === "failure" ? "failure" : "success"),
      );
      if (!active.length || active.length !== inputs.length) {
        results.set(rule.id, { state: "skipped", value: "" });
        continue;
      }
      try {
        last = await execute(rule, results.get(active[0]!.source)!.value);
        results.set(rule.id, { state: "success", value: last });
      } catch (error) {
        const message = errorMessage(error);
        results.set(rule.id, { state: "failure", value: message });
        failures.push({ id: rule.id, message: `${rule.action}: ${message}` });
      }
    }
    if (!progressed)
      throw Error("This graph contains a loop. Inspect its connections.");
  }
  const unhandled = recoverFailures
    ? failures.filter(
        (f) =>
          !graph.edges.some(
            (e) =>
              e.source === f.id &&
              e.on === "failure" &&
              results.get(e.target)?.state === "success",
          ),
      )
    : failures;
  if (unhandled.length)
    throw Error(
      `${[...new Set(unhandled.map((f) => f.message))].join(" ")} Completed steps were kept; dependent steps stopped. Inspect connection activity for details.`,
    );
  return last;
}
