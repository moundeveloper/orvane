// Where test runs live: <data>/flow-tests/runs.json (newest 30), live.json
// (the run in progress) and <runId>/ pictures. Shared by the flow_tests MCP
// tool and the Test runs app's API (server/flow-tests-api.ts).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveRun, TestRun } from "../src/flowRunner.ts";

const KEEP_RUNS = 30;

export class FlowTestStore {
  readonly root: string;
  constructor(dataDirectory: string) {
    this.root = join(dataDirectory, "flow-tests");
  }
  runs(): TestRun[] {
    try {
      return JSON.parse(readFileSync(join(this.root, "runs.json"), "utf8")) as TestRun[];
    } catch {
      return [];
    }
  }
  saveRun(run: TestRun) {
    mkdirSync(this.root, { recursive: true });
    const runs = [run, ...this.runs().filter((r) => r.runId !== run.runId)];
    for (const old of runs.slice(KEEP_RUNS)) rmSync(join(this.root, old.runId), { recursive: true, force: true });
    writeFileSync(join(this.root, "runs.json"), JSON.stringify(runs.slice(0, KEEP_RUNS), null, 2));
  }
  find(runId?: string) {
    const runs = this.runs();
    const run = runId ? runs.find((r) => r.runId === runId) : runs[0];
    if (!run) throw Error(runId ? `No test run ${runId} (flow_tests history lists them).` : "No test runs yet. Start one with flow_tests run.");
    return run;
  }
  live(): (LiveRun & { updatedAt?: number }) | null {
    try {
      return JSON.parse(readFileSync(join(this.root, "live.json"), "utf8")) as LiveRun;
    } catch {
      return null;
    }
  }
  writeLive(live: LiveRun) {
    try {
      mkdirSync(this.root, { recursive: true });
      writeFileSync(join(this.root, "live.json"), JSON.stringify({ ...live, updatedAt: Date.now() }));
    } catch {}
  }
  /** Saves a run picture (base64 JPEG); the file name is ours, never a path from outside. */
  saveImage(runId: string, file: string, data: string) {
    if (!/^[\w-]{1,60}$/.test(runId) || !/^\d{2}-(failure|keyframes)\.jpg$/.test(file)) throw Error("Bad picture name.");
    const folder = join(this.root, runId);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, file), Buffer.from(data, "base64"));
    return join(folder, file);
  }
}
