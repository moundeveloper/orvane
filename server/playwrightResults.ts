import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  PlaywrightRun,
  TestFailure,
  TestOutcome,
  TestSelection,
} from "../src/playwrightReport.ts";

type ReportError = {
  message?: string;
  stack?: string;
  location?: { file: string; line: number };
};
type Report = {
  config: { rootDir: string };
  suites: Suite[];
  errors?: ReportError[];
  stats: {
    expected: number;
    unexpected: number;
    skipped: number;
    flaky: number;
  };
};
type Suite = {
  title: string;
  suites?: Suite[];
  specs?: {
    file: string;
    line: number;
    title: string;
    tests: {
      status: TestOutcome;
      projectName?: string;
      results: { errors?: ReportError[] }[];
    }[];
  }[];
};
const within = (root: string, path: string) => {
  const difference = relative(root, path);
  return (
    !!difference &&
    difference !== ".." &&
    !difference.startsWith(".." + sep) &&
    !isAbsolute(difference)
  );
};
const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripColors = (text: string) => text.replace(/\x1b\[[\d;]*m/g, "");
const running = new Set<string>();
function sourceLocation(root: string, cwd: string, error?: ReportError) {
  if (
    error?.location?.file &&
    Number.isSafeInteger(error.location.line) &&
    error.location.line > 0
  ) {
    const file = resolve(root, error.location.file);
    if (within(cwd, file)) return { file, line: error.location.line };
  }
  for (const entry of error?.stack?.split("\n") ?? []) {
    const match = /(?:\(|\s)((?:[a-z]:[\\/]|\/)[^()]+):(\d+):\d+\)?\s*$/i.exec(
      entry,
    );
    if (!match) continue;
    const file = resolve(root, match[1]!);
    const line = Number(match[2]);
    if (within(cwd, file) && Number.isSafeInteger(line) && line > 0)
      return { file, line };
  }
}

function readFailureReport(
  report: Report,
  cwd: string,
  selection?: TestSelection,
): PlaywrightRun {
  const failures: TestFailure[] = [];
  const matched: TestOutcome[] = [];
  function visit(suite: Suite, parents: string[]) {
    const titles = [...parents, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      const file = resolve(report.config.rootDir, spec.file);
      if (!within(cwd, file)) continue;
      for (const test of spec.tests) {
        if (selection) {
          if (
            relative(file, selection.file) ||
            spec.line !== selection.line ||
            (selection.project !== undefined &&
              selection.project !== test.projectName) ||
            (selection.testTitle !== undefined &&
              selection.testTitle !== spec.title)
          )
            continue;
          matched.push(test.status);
        }
        if (test.status !== "unexpected") continue;
        const error = test.results.at(-1)?.errors?.[0];
        const source = sourceLocation(report.config.rootDir, cwd, error);
        failures.push({
          file,
          line: spec.line,
          project: test.projectName,
          testTitle: spec.title,
          title: [...titles, spec.title].join(" › ").slice(0, 400),
          message: stripColors(
            error?.message || error?.stack || "Test failed.",
          ).slice(0, 2000),
          sourceFile: source?.file ?? file,
          sourceLine: source?.line ?? spec.line,
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  for (const suite of report.suites) visit(suite, []);
  return {
    failures: failures.slice(0, 200),
    stats: report.stats,
    error:
      stripColors(report.errors?.[0]?.message ?? "").slice(0, 2000) ||
      (selection && matched.length !== 1
        ? "The original test could not be identified. Run the suite again."
        : ""),
    selected: matched.length === 1 ? matched[0] : undefined,
  };
}
async function reportFor(path: string, cwd: string, selection?: TestSelection) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 15_000_000)
    throw Error("Choose a Playwright JSON report under 15 MB.");
  const data = JSON.parse(await readFile(path, "utf8")) as Report;
  if (
    !data.config ||
    typeof data.config.rootDir !== "string" ||
    !Array.isArray(data.suites) ||
    !data.stats
  )
    throw Error("Choose a Playwright JSON report.");
  return readFailureReport(data, cwd, selection);
}
export function importPlaywrightReport(cwd: string, path: string) {
  return reportFor(path, cwd);
}
export async function runPlaywright(cwd: string, selection?: TestSelection) {
  if (!(await lstat(cwd)).isDirectory())
    throw Error("Choose the Playwright project folder.");
  if (running.has(cwd))
    throw Error("A Playwright run is already active in this folder.");
  let cli: string;
  try {
    cli = createRequire(join(cwd, "package.json")).resolve(
      "@playwright/test/cli",
    );
  } catch {
    throw Error("Install @playwright/test in the project folder first.");
  }
  const args = [cli, "test", "--reporter=json", "--global-timeout=300000"];
  if (selection) {
    if (
      !within(cwd, selection.file) ||
      !Number.isSafeInteger(selection.line) ||
      selection.line < 1
    )
      throw Error("Choose a test file and line inside the project folder.");
    const file = relative(cwd, selection.file).split(sep).join("/");
    args.push(escapeRegex(file) + "$:" + selection.line);
    if (selection.project) args.push("--project=" + selection.project);
    if (selection.testTitle)
      args.push(
        "--grep=(?:^| )" + escapeRegex(selection.testTitle) + "(?: @\\S+)*$",
      );
  }
  running.add(cwd);
  const tempRoot = resolve(tmpdir());
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(tempRoot, "orvane-playwright-"));
    const report = join(temporary, "results.json");
    args.push("--output", join(temporary, "artifacts"));
    const env = {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: report,
      PLAYWRIGHT_JSON_ONLY_FAILURES: "false",
    };
    let error = "";
    const code = await new Promise<number | null>((done, fail) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill();
        fail(Error("The test run timed out."));
      }, 315000);
      child.stderr.on("data", (chunk: Buffer) => {
        error = (error + chunk.toString("utf8")).slice(-2000);
      });
      child.once("error", (cause) => {
        clearTimeout(timer);
        fail(cause);
      });
      child.once("close", (status) => {
        clearTimeout(timer);
        done(status);
      });
    });
    try {
      const result = await reportFor(report, cwd, selection);
      return {
        ...result,
        error:
          result.error ||
          (code !== 0 &&
          !result.failures.length &&
          result.selected !== "expected" &&
          result.selected !== "flaky"
            ? stripColors(error) ||
              "Playwright exited without any test failures in its report."
            : ""),
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT")
        throw Error(
          stripColors(error) || "Playwright did not produce a test report.",
        );
      throw cause;
    }
  } finally {
    running.delete(cwd);
    if (
      temporary &&
      dirname(resolve(temporary)) === tempRoot &&
      basename(temporary).startsWith("orvane-playwright-")
    )
      await rm(temporary, {
        recursive: true,
        force: true,
        maxRetries: 2,
      }).catch(() => {});
  }
}
