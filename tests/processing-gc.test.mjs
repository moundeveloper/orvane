import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

// Regression: processing pages were WebContentsViews whose view object was
// dropped, so garbage collection destroyed the page; a NetSuite call running in
// it never settled and every later call for that account hung until restart.
test("a processing page survives garbage collection and in-flight calls settle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvane-processing-gc-"));
  const out = join(directory, "result.json");
  try {
    await new Promise((resolve, reject) =>
      execFile(
        electron,
        ["--js-flags=--expose-gc", fileURLToPath(new URL("./fixtures/processing-gc", import.meta.url)), `--out=${out}`],
        { timeout: 60000 },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    const result = JSON.parse(await readFile(out, "utf8"));
    assert.equal(result.error, undefined);
    assert.deepEqual(result, { destroyed: false, result: "done" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
