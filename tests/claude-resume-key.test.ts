import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { ClaudeTranscriptSet } from "../server/claude-transcripts.ts";

test("resume follows the selected transcript key when a UUID was copied between project folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "orvane-resume-key-"));
  const config = join(root, "account");
  const projects = join(config, "projects");
  const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const transcripts = new ClaudeTranscriptSet(join(root, "data"), () => [
    { id: "work-one", root: projects, configDir: config },
  ]);
  try {
    for (const project of ["first", "second"]) {
      const folder = join(projects, project);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, `${uuid}.jsonl`), JSON.stringify({
        uuid: "prompt", sessionId: uuid, cwd: join(root, project),
        type: "user", timestamp: new Date().toISOString(), message: { content: project },
      }) + "\n");
    }
    const sessions = await transcripts.all();
    assert.equal(sessions.length, 2);
    const selected = sessions[1]!;
    const expected = await transcripts.forKey(selected.key).file(selected.key);
    assert.equal(await transcripts.resumePath("work-one", uuid, "Work", selected.key), expected);
    await assert.rejects(transcripts.resumePath("work-one", uuid, "Work"), /several|ambiguous|exact/i);
  } finally {
    transcripts.close();
    const rel = relative(tmpdir(), root);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  }
});
