import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readdir,
  readFile,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACT_LIMITS,
  artifactMetadataSchema,
} from "../server/netsuite-artifact-protocol.ts";
import { brokerError } from "./netsuite-broker-protocol.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sameOwner = (a, b) =>
  ["origin", "accountId", "userId", "roleId"].every((key) => a[key] === b[key]);
const blobName = (hash) => `blob-${hash}.txt`;
const metaName = (id) => `artifact-${id}.json`;
/** One worker owns this bounded directory. IDs never resolve arbitrary local paths. */
export async function openNetSuiteArtifactStore(
  directory,
  { limits = ARTIFACT_LIMITS, now = Date.now } = {},
) {
  for (const [name, maximum] of Object.entries(ARTIFACT_LIMITS))
    if (
      !Number.isSafeInteger(limits[name]) ||
      limits[name] < 1 ||
      limits[name] > maximum
    )
      throw brokerError(
        "ARTIFACT_STORE_INVALID",
        "Invalid artifact resource budget.",
      );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink())
    throw brokerError(
      "ARTIFACT_STORE_INVALID",
      "Artifact directory is not a regular owned directory.",
    );
  const records = new Map();
  let queue = Promise.resolve(),
    closed = false;
  const serial = (work) => {
    if (closed)
      return Promise.reject(
        brokerError("ARTIFACT_STORE_CLOSED", "Artifact store closed."),
      );
    const result = queue.then(work).catch((error) => {
      if (/^(ARTIFACT_|INVALID_ARTIFACT_)/.test(error?.code || "")) throw error;
      throw brokerError(
        "ARTIFACT_IO_ERROR",
        "Local artifact storage could not complete the request.",
      );
    });
    queue = result.catch(() => {});
    return result;
  };
  const regular = async (path, maxBytes) => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
      throw brokerError("ARTIFACT_CORRUPT", "Artifact data failed validation.");
    return stat;
  };
  const atomic = async (name, bytes) => {
    const temporary = join(directory, `tmp-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, join(directory, name));
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  const erase = async (name) => {
    await unlink(join(directory, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
  const sweep = async () => {
    for (const [id, meta] of records)
      if (meta.expiresAt <= now()) {
        await erase(metaName(id));
        records.delete(id);
      }
    const names = await readdir(directory);
    const hashes = new Set([...records.values()].map((meta) => meta.hash));
    for (const name of names)
      if (
        /^blob-[a-f\d]{64}\.txt$/.test(name) &&
        !hashes.has(name.slice(5, -4))
      )
        await erase(name);
  };
  const names = await readdir(directory);
  if (names.length > 4096)
    throw brokerError(
      "ARTIFACT_STORE_INVALID",
      "Artifact directory exceeds its startup file budget.",
    );
  for (const name of names) {
    if (/^tmp-[a-f\d-]{36}$/.test(name)) {
      await erase(name);
      continue;
    }
    if (/^blob-[a-f\d]{64}\.txt$/.test(name)) continue;
    if (!/^artifact-[a-f\d-]{36}\.json$/.test(name))
      throw brokerError(
        "ARTIFACT_STORE_INVALID",
        "Unexpected file in the artifact directory; no unknown file was removed.",
      );
    await regular(join(directory, name), 8192);
    const meta = artifactMetadataSchema.parse(
      JSON.parse(await readFile(join(directory, name), "utf8")),
    );
    if (name !== metaName(meta.artifactId) || meta.expiresAt < meta.createdAt)
      throw brokerError(
        "ARTIFACT_CORRUPT",
        "Artifact metadata failed validation.",
      );
    records.set(meta.artifactId, meta);
  }
  await sweep();
  const quota = () => {
    const unique = new Map(
      [...records.values()].map((meta) => [meta.hash, meta.sizeBytes]),
    );
    return [...unique.values()].reduce((sum, bytes) => sum + bytes, 0);
  };
  const bytesFor = async (meta) => {
    const path = join(directory, blobName(meta.hash));
    await regular(path, limits.maxBytes);
    const bytes = await readFile(path);
    if (bytes.length !== meta.sizeBytes || digest(bytes) !== meta.hash)
      throw brokerError(
        "ARTIFACT_CORRUPT",
        "Artifact checksum/size changed; data was discarded.",
      );
    return bytes;
  };
  const enforce = async (protectedId) => {
    while (records.size > limits.maxArtifacts || quota() > limits.quotaBytes) {
      const oldest = [...records.values()]
        .filter((item) => item.artifactId !== protectedId)
        .sort(
          (a, b) =>
            a.createdAt - b.createdAt ||
            a.artifactId.localeCompare(b.artifactId),
        )[0];
      if (!oldest)
        throw brokerError(
          "ARTIFACT_TOO_LARGE",
          "Artifact quota cannot retain this export.",
        );
      await erase(metaName(oldest.artifactId));
      records.delete(oldest.artifactId);
    }
    await sweep();
  };
  await enforce();
  const lookup = (id, owner) => {
    const meta = records.get(id);
    if (!meta || meta.expiresAt <= now() || !sameOwner(meta.owner, owner))
      throw brokerError(
        "ARTIFACT_UNAVAILABLE",
        "Artifact expired, was evicted, or is unavailable for this identity.",
      );
    return meta;
  };
  return {
    put(text, { format, owner, source }) {
      return serial(async () => {
        const bytes = Buffer.from(text, "utf8");
        if (bytes.length > limits.maxBytes || bytes.length > limits.quotaBytes)
          throw brokerError(
            "ARTIFACT_TOO_LARGE",
            "Export exceeds the artifact byte budget.",
          );
        const hash = digest(bytes),
          createdAt = now();
        const meta = artifactMetadataSchema.parse({
          version: 1,
          artifactId: randomUUID(),
          hash,
          sizeBytes: bytes.length,
          format,
          createdAt,
          expiresAt: createdAt + limits.ttlMs,
          owner,
          source,
        });
        await sweep();
        const existing = [...records.values()].find(
          (item) => item.hash === hash,
        );
        if (existing) await bytesFor(existing);
        else await atomic(blobName(hash), bytes);
        await atomic(metaName(meta.artifactId), JSON.stringify(meta));
        records.set(meta.artifactId, meta);
        await enforce(meta.artifactId);
        return structuredClone(meta);
      });
    },
    inspect(id, owner) {
      return serial(async () => structuredClone(lookup(id, owner)));
    },
    read(id, owner, { offset = 0, length = 8000 } = {}) {
      return serial(async () => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > limits.maxReadCharacters
        )
          throw brokerError(
            "INVALID_ARTIFACT_RANGE",
            "Invalid bounded text range.",
          );
        const meta = lookup(id, owner),
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            await bytesFor(meta),
          );
        if (
          offset > text.length ||
          (offset > 0 &&
            /[\uDC00-\uDFFF]/.test(text[offset] || "") &&
            /[\uD800-\uDBFF]/.test(text[offset - 1]))
        )
          throw brokerError(
            "INVALID_ARTIFACT_RANGE",
            "Range starts outside the text or inside a Unicode pair.",
          );
        let end = Math.min(text.length, offset + length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] || ""))
          end--;
        if (end === offset && end < text.length)
          throw brokerError(
            "INVALID_ARTIFACT_RANGE",
            "Increase length to include the complete Unicode pair.",
          );
        return {
          metadata: structuredClone(meta),
          content: text.slice(offset, end),
          offset,
          nextOffset: end < text.length ? end : null,
          totalCharacters: text.length,
          offsetUnit: "UTF-16-code-units",
        };
      });
    },
    async close() {
      closed = true;
      await queue;
    },
  };
}
