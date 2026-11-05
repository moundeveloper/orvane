import { join } from "node:path";
import { openNetSuiteArtifactStore } from "./netsuite-artifact-store.mjs";
import {
  ARTIFACT_LIMITS,
  validateNetSuiteArtifact,
} from "../server/netsuite-artifact-protocol.ts";
import { brokerError } from "./netsuite-broker-protocol.mjs";

const csvText = (value, protectFormula = false) => {
  let text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (
    protectFormula &&
    (/^\s*[=+\-@＝＋－＠]/.test(text) || /^[\u0000-\u001f\u007f]/.test(text))
  )
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export function serializeNetSuitePage(rows, format) {
  if (
    !Array.isArray(rows) ||
    rows.length > 100 ||
    rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  )
    throw brokerError(
      "INVALID_QUERY_RESULT",
      "Export requires a bounded page of row objects.",
    );
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length > 256)
    throw brokerError(
      "ARTIFACT_TOO_LARGE",
      "Export supports at most 256 columns.",
    );
  if (format === "ndjson")
    return rows.map((row) => JSON.stringify(row) + "\n").join("");
  if (format !== "csv")
    throw brokerError("INVALID_ARTIFACT_REQUEST", "Unknown export format.");
  if (!columns.length) return "";
  return (
    [
      columns.map((key) => csvText(key, true)).join(","),
      ...rows.map((row) =>
        columns
          .map((key) => {
            const value = Object.hasOwn(row, key) ? row[key] : null;
            return csvText(value, typeof value === "string");
          })
          .join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}
const publicMetadata = (meta) => ({
  artifactId: meta.artifactId,
  sha256: meta.hash,
  sizeBytes: meta.sizeBytes,
  format: meta.format,
  mimeType:
    meta.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
  createdAt: new Date(meta.createdAt).toISOString(),
  expiresAt: new Date(meta.expiresAt).toISOString(),
  source: { ...meta.source, scope: "one-page", isLive: false },
  csvFormulaEscaping: meta.format === "csv",
  limits: ARTIFACT_LIMITS,
});
export function createNetSuiteArtifactService({ directory, dispatch }) {
  let opening;
  const store = () =>
    (opening ??= openNetSuiteArtifactStore(join(directory, "artifacts")).catch(
      (error) => {
        if (/^ARTIFACT_/.test(error?.code || "")) throw error;
        throw brokerError(
          "ARTIFACT_STORE_INVALID",
          "Local artifact storage could not be initialized.",
        );
      },
    ));
  const authorize = async (request) => {
    const inspected = await dispatch({
      operation: "status",
      action: "inspect",
      targetId: request.targetId,
    });
    if (inspected.identity.identityToken !== request.identityToken)
      throw brokerError(
        "IDENTITY_CHANGED",
        "Inspect this target again before accessing saved page data.",
      );
    return inspected;
  };
  const owner = (inspected) => ({
    origin: inspected.origin,
    accountId: inspected.identity.accountId,
    userId: inspected.identity.userId,
    roleId: inspected.identity.roleId,
  });
  return {
    async dispatch(request) {
      const args = validateNetSuiteArtifact(request);
      const before = await authorize(args);
      const local = await store();
      let meta, range;
      if (args.action === "export") {
        const { kind, ...source } = args.source;
        const result = await dispatch({
          ...source,
          operation: kind,
          targetId: args.targetId,
          identityToken: args.identityToken,
        });
        const format = args.format ?? "ndjson";
        const text = serializeNetSuitePage(result.data.rows, format);
        meta = await local.put(text, {
          format,
          owner: owner(before),
          source: {
            kind,
            action: kind === "read" ? source.action : null,
            offset: result.data.offset ?? 0,
            rowCount: result.data.rows.length,
            observedAt: result.observedAt,
            sessionEpoch: result.identity.sessionEpoch ?? null,
          },
        });
      } else if (args.action === "inspect")
        meta = await local.inspect(args.artifactId, owner(before));
      else {
        range = await local.read(args.artifactId, owner(before), {
          offset: args.offset ?? 0,
          length: args.length ?? 8000,
        });
        meta = range.metadata;
      }
      const after = await authorize(args);
      return {
        desktopId: after.desktopId,
        targetId: args.targetId,
        origin: after.origin,
        identity: after.identity,
        artifact: publicMetadata(meta),
        ...(range
          ? {
              data: {
                content: range.content,
                offset: range.offset,
                nextOffset: range.nextOffset,
                totalCharacters: range.totalCharacters,
                offsetUnit: range.offsetUnit,
              },
            }
          : {}),
      };
    },
    async close() {
      if (opening) await (await opening.catch(() => null))?.close();
    },
  };
}
