import assert from "node:assert/strict";
import { join, basename, resolve } from "node:path";
import { lstat, readdir, unlink, rmdir } from "node:fs/promises";

// Test-only cleanup: a fixed child of a caller-created, dedicated fixture root.
export async function removeTestArtifactDirectory(root) {
  const owned = resolve(root);
  assert(
    basename(owned).startsWith("orvane-"),
    "Expected a dedicated Orvane fixture root",
  );
  const directory = join(owned, "netsuite-broker", "artifacts");
  const stat = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "Refuse to traverse a linked fixture directory",
  );
  for (const name of await readdir(directory)) {
    assert.match(
      name,
      /^(artifact-[a-f\d-]{36}\.json|blob-[a-f\d]{64}\.txt|tmp-[a-f\d-]{36})$/,
    );
    await unlink(join(directory, name));
  }
  await rmdir(directory);
}
