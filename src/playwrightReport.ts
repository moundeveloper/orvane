export type TestOutcome = "expected" | "unexpected" | "flaky" | "skipped";
export type TestSelection = {
  file: string;
  line: number;
  project?: string;
  testTitle?: string;
};
export type TestFailure = TestSelection & {
  title: string;
  message: string;
  sourceFile: string;
  sourceLine: number;
};
export type PlaywrightRun = {
  failures: TestFailure[];
  stats: Record<TestOutcome, number>;
  error: string;
  selected?: TestOutcome;
};
