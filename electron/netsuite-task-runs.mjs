import { readFileSync, writeFileSync, renameSync } from "node:fs";

// Map/reduce and scheduled script runs started by Orvane. A run puts its
// deployment in Not Scheduled to start it; when the run ends, the deployment's
// original status is put back. Runs are saved to a file so a restart of
// Orvane still restores them.

const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELED", "CANCELLED"]);
const NOT_SEEN_AFTER_MS = 10 * 60 * 1000;
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const KEEP = 50;

export function createTaskRuns({ file, hosts, syncHosts = async () => {}, service, now = () => Date.now(), interval = 15000 }) {
  let runs = [];
  try {
    runs = JSON.parse(readFileSync(file, "utf8")).runs ?? [];
  } catch {
    runs = [];
  }
  const save = () => {
    runs = runs.slice(-KEEP);
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ runs }, null, 2));
    renameSync(temporary, file);
  };
  const open = (run) => !run.done;
  /** The window currently showing this account, with its session epoch. */
  async function targetFor(origin) {
    for (const host of hosts()) {
      if (host.isDestroyed()) continue;
      const environment = (await service.environments(host)).find((item) => item.id === origin);
      if (environment) return { host, origin, sessionEpoch: environment.sessionEpoch ?? undefined };
    }
    return null;
  }
  async function finish(run, target, state) {
    run.state = state;
    run.done = true;
    run.finishedAt = new Date(now()).toISOString();
    if (run.originalStatus === "NOTSCHEDULED") run.restore = { needed: false };
    else {
      try {
        const current = await service.run(target.host, target.origin, "task-status", { deploymentId: run.deploymentId }, target.sessionEpoch);
        // Someone changed the status meanwhile: leave their choice alone.
        if (current?.deployment?.status !== "NOTSCHEDULED")
          run.restore = { needed: false, note: `The status was already ${current?.deployment?.status ?? "changed"}; left as is.` };
        else {
          await service.write(target.host, target.origin, "set-deployment-status", { deploymentId: run.deploymentId, status: run.originalStatus }, target.sessionEpoch);
          run.restore = { needed: true, restored: true, status: run.originalStatus };
        }
      } catch (error) {
        run.restore = { needed: true, restored: false, error: String(error?.message || error) };
        run.done = false; // try again on the next tick
      }
    }
  }
  /** Reads a run's instances and finishes it when they have ended. */
  async function refresh(run, target) {
    target ??= await targetFor(run.origin);
    if (!target) {
      run.lastError = "The account is not open in Orvane's Browser; waiting.";
      return run;
    }
    if (run.state !== "running" && !run.done) {
      // A finish whose restore failed: retry only the restore.
      await finish(run, target, run.state);
      return run;
    }
    const status = await service.run(target.host, target.origin, "task-status", { deploymentId: run.deploymentId }, target.sessionEpoch);
    const since = Date.parse(run.submittedAt) - 2 * 60 * 1000;
    run.instances = (status?.instances ?? [])
      .filter((item) => !item.created || Date.parse(item.created) >= since)
      .map((item) => ({ ...item, status: String(item.status ?? "").toUpperCase() }));
    run.checkedAt = new Date(now()).toISOString();
    delete run.lastError;
    const age = now() - Date.parse(run.submittedAt);
    if (run.instances.length && run.instances.every((item) => TERMINAL.has(item.status)))
      await finish(run, target, run.instances.some((item) => item.status === "FAILED") ? "failed" : "finished");
    else if (!run.instances.length && age > NOT_SEEN_AFTER_MS) await finish(run, target, "not-seen");
    else if (age > GIVE_UP_AFTER_MS) await finish(run, target, "gave-up");
    return run;
  }
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!runs.some(open)) return;
      await syncHosts().catch(() => {});
      for (const run of runs.filter(open)) {
        try {
          await refresh(run);
        } catch (error) {
          run.lastError = String(error?.message || error);
        }
      }
      save();
    } finally {
      busy = false;
    }
  }
  const timer = interval ? setInterval(() => void tick(), interval) : undefined;
  timer?.unref?.();
  return {
    add(origin, started) {
      const run = { runId: `${started.deploymentId}-${Date.parse(started.submittedAt)}`, origin, ...started, state: "running", done: false, instances: [] };
      runs.push(run);
      save();
      return run;
    },
    get: (runId) => runs.find((run) => run.runId === runId) ?? null,
    list: (origin) => runs.filter((run) => run.origin === origin).slice(-20).reverse(),
    refresh: async (run, target) => {
      const result = await refresh(run, target);
      save();
      return result;
    },
    tick,
    stop: () => clearInterval(timer),
  };
}
