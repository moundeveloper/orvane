export const BROKER_PROTOCOL = 1;
// Runs in Electron main, which does not load .ts: keep in sync with
// NETSUITE_PAGE_READS in server/netsuite-metadata-operations.ts (tested).
export const EXECUTOR_PAGE_READS = Object.freeze([
  "bundles",
  "bundle-contents",
  "file-content",
  "catalog-tables",
  "catalog-table",
  "log-search",
  "task-status",
]);
// Writes the MCP tools may run (kind "write" only; a "read" command never reaches them).
export const EXECUTOR_WRITES = Object.freeze([
  "run-script",
  "upload-file",
  "save-file",
  "create-folder",
  "delete-items",
  "run-task",
  "set-deployment-status",
]);
// Room for a 5 MB upload as base64 plus the envelope.
export const MAX_BROKER_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_BROKER_RESULT_BYTES = 1024 * 1024;
export const MAX_BROKER_PENDING = 32;

export function brokerError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Validate at the Electron boundary, even though the caller is our worker. */
export function validateExecutorCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command))
    throw brokerError(
      "INVALID_EXECUTOR_REQUEST",
      "An executor command is required.",
    );
  if (Buffer.byteLength(JSON.stringify(command)) > MAX_BROKER_REQUEST_BYTES)
    throw brokerError("REQUEST_TOO_LARGE", "Executor command exceeds 8 MiB.");
  if (command.kind === "hosts") return;
  if (!Number.isSafeInteger(command.hostId) || command.hostId <= 0)
    throw brokerError(
      "INVALID_EXECUTOR_REQUEST",
      "A Desktop-owned window ID is required.",
    );
  if (command.kind === "environments") return;
  if (
    !(
      (command.kind === "read" &&
        ["user", "query", ...EXECUTOR_PAGE_READS].includes(command.operation)) ||
      (command.kind === "write" && EXECUTOR_WRITES.includes(command.operation))
    )
  )
    throw brokerError(
      "READ_ONLY_EXECUTOR",
      "The broker executor supports only identity, SELECT and allowlisted metadata reads.",
    );
  if (
    command.expectedSessionEpoch !== undefined &&
    (!Number.isSafeInteger(command.expectedSessionEpoch) ||
      command.expectedSessionEpoch < 1)
  )
    throw brokerError("INVALID_EXECUTOR_REQUEST", "Invalid session epoch.");
  if (
    typeof command.origin !== "string" ||
    !/^https:\/\/[a-z0-9-]+\.app\.netsuite\.com$/i.test(command.origin)
  )
    throw brokerError(
      "INVALID_EXECUTOR_REQUEST",
      "A NetSuite environment origin is required.",
    );
  if (command.operation === "query") {
    const args = command.args;
    if (
      !args ||
      typeof args.sql !== "string" ||
      args.sql.length > 20000 ||
      !/^\s*select\b/i.test(args.sql) ||
      args.sql.includes(";") ||
      !Number.isSafeInteger(args.offset ?? 0) ||
      (args.offset ?? 0) < 0 ||
      (args.offset ?? 0) > 1000000
    )
      throw brokerError(
        "INVALID_QUERY",
        "Use one bounded SELECT with a valid offset and no semicolon.",
      );
  }
}

const positiveIds = (value) =>
  Array.isArray(value) &&
  value.length <= 50 &&
  value.every((id) => Number.isSafeInteger(id) && id > 0);
const isoText = (value) =>
  typeof value === "string" &&
  value.length <= 40 &&
  !Number.isNaN(Date.parse(value));
/** Rebuild metadata page-read args from known fields only. */
export function pageReadArgs(operation, args = {}) {
  const fail = () => {
    throw brokerError("INVALID_EXECUTOR_REQUEST", "Invalid metadata read.");
  };
  if (!args || typeof args !== "object" || Array.isArray(args)) fail();
  switch (operation) {
    case "catalog-tables":
      return {};
    case "bundles":
      if (!["I", "S"].includes(args.bundleType)) fail();
      return { bundleType: args.bundleType };
    case "bundle-contents":
      if (!Number.isSafeInteger(args.bundleId) || args.bundleId <= 0) fail();
      return { bundleId: args.bundleId };
    case "file-content":
      if (!Number.isSafeInteger(args.id) || args.id <= 0) fail();
      return { id: args.id };
    case "task-status":
      if (!Number.isSafeInteger(args.deploymentId) || args.deploymentId <= 0) fail();
      return { deploymentId: args.deploymentId };
    case "catalog-table":
      if (
        typeof args.table !== "string" ||
        !/^[a-z][a-z0-9_]{0,199}$/i.test(args.table)
      )
        fail();
      return { table: args.table };
    case "log-search": {
      const levels = ["DEBUG", "AUDIT", "ERROR", "EMERGENCY", "SYSTEM"];
      if (
        !isoText(args.from) ||
        !isoText(args.to) ||
        !Array.isArray(args.levels) ||
        !args.levels.every((level) => levels.includes(level)) ||
        !positiveIds(args.scriptIds) ||
        !positiveIds(args.deploymentIds)
      )
        fail();
      return {
        from: args.from,
        to: args.to,
        levels: [...args.levels],
        scriptIds: [...args.scriptIds],
        deploymentIds: [...args.deploymentIds],
      };
    }
  }
  return fail();
}

const fileName = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 200 &&
  !/[\\/\u0000-\u001f]/.test(value);
const folderId = (value) => Number.isSafeInteger(value) && value !== 0;
const ids = (value) =>
  Array.isArray(value) &&
  value.length <= 200 &&
  value.every((id) => Number.isSafeInteger(id) && id > 0);
/** Rebuild write args from known fields only. */
export function writeArgs(operation, args = {}) {
  const fail = () => {
    throw brokerError("INVALID_EXECUTOR_REQUEST", "Invalid write request.");
  };
  if (!args || typeof args !== "object" || Array.isArray(args)) fail();
  switch (operation) {
    case "run-script":
      if (
        typeof args.code !== "string" ||
        !args.code.trim() ||
        args.code.length > 100000 ||
        !Number.isSafeInteger(args.timeoutMs) ||
        args.timeoutMs < 1000 ||
        args.timeoutMs > 60000
      )
        fail();
      return { code: args.code, timeoutMs: args.timeoutMs };
    case "upload-file":
      if (
        !folderId(args.folderId) ||
        !fileName(args.name) ||
        typeof args.base64 !== "string" ||
        args.base64.length > 7000000 ||
        !/^[a-z0-9+/]*={0,2}$/i.test(args.base64) ||
        typeof args.overwrite !== "boolean"
      )
        fail();
      return {
        folderId: args.folderId,
        name: args.name,
        base64: args.base64,
        overwrite: args.overwrite,
      };
    case "save-file":
      if (
        !Number.isSafeInteger(args.id) ||
        args.id <= 0 ||
        typeof args.content !== "string" ||
        args.content.length > 2000000 ||
        (args.original !== undefined &&
          (typeof args.original !== "string" || args.original.length > 2000000))
      )
        fail();
      return {
        id: args.id,
        content: args.content,
        ...(args.original !== undefined ? { original: args.original } : {}),
      };
    case "run-task":
      if (!Number.isSafeInteger(args.deploymentId) || args.deploymentId <= 0) fail();
      return { deploymentId: args.deploymentId };
    case "set-deployment-status":
      if (
        !Number.isSafeInteger(args.deploymentId) ||
        args.deploymentId <= 0 ||
        !["NOTSCHEDULED", "SCHEDULED", "TESTING", "RELEASED"].includes(args.status)
      )
        fail();
      return { deploymentId: args.deploymentId, status: args.status };
    case "create-folder":
      if (!folderId(args.folderId) || !fileName(args.name)) fail();
      return { folderId: args.folderId, name: args.name };
    case "delete-items":
      if (
        !folderId(args.folderId) ||
        !ids(args.fileIds) ||
        !ids(args.folderIds) ||
        !(args.fileIds.length + args.folderIds.length)
      )
        fail();
      return {
        folderId: args.folderId,
        fileIds: [...args.fileIds],
        folderIds: [...args.folderIds],
      };
  }
  return fail();
}

export function createExecutorGateway({ hosts, service }) {
  return async (command) => {
    validateExecutorCommand(command);
    const owned = hosts().filter((host) => !host.isDestroyed());
    if (command.kind === "hosts") return owned.map((host) => ({ id: host.id }));
    const host = owned.find((host) => host.id === command.hostId);
    if (!host)
      throw brokerError(
        "TARGET_UNAVAILABLE",
        "The selected Desktop window is no longer available.",
      );
    if (command.kind === "environments") {
      const environments = await service.environments(host);
      return environments.map((environment) => ({
        ...environment,
        sessionEpoch: service.sessionEpoch?.(host, environment.id) ?? null,
      }));
    }
    const epoch = service.sessionEpoch?.(host, command.origin);
    if (epoch !== undefined && command.expectedSessionEpoch === undefined)
      throw brokerError(
        "SESSION_CHANGED",
        "List and inspect the environment with its current session epoch.",
      );
    if (
      command.expectedSessionEpoch !== undefined &&
      command.expectedSessionEpoch !== epoch
    )
      throw brokerError(
        "SESSION_CHANGED",
        "The observed browser session changed. List and inspect a fresh target.",
      );
    // Never forward arbitrary args/operations from the worker to the privileged service.
    const args =
      command.operation === "user"
        ? {}
        : command.operation === "query"
          ? { sql: command.args.sql, offset: command.args.offset ?? 0 }
          : command.kind === "write"
            ? writeArgs(command.operation, command.args)
            : pageReadArgs(command.operation, command.args);
    const result = await service.run(
      host,
      command.origin,
      command.operation,
      args,
      command.expectedSessionEpoch,
    );
    if (
      command.expectedSessionEpoch !== undefined &&
      service.sessionEpoch?.(host, command.origin) !==
        command.expectedSessionEpoch
    )
      throw brokerError(
        "SESSION_CHANGED",
        command.kind === "write"
          ? "The observed session changed while writing. The write may have completed; check NetSuite before retrying."
          : "The observed session changed during the read. Results were discarded.",
      );
    return result;
  };
}
