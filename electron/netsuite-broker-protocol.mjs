export const BROKER_PROTOCOL = 1;
export const MAX_BROKER_REQUEST_BYTES = 64 * 1024;
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
    throw brokerError("REQUEST_TOO_LARGE", "Executor command exceeds 64 KiB.");
  if (command.kind === "hosts") return;
  if (!Number.isSafeInteger(command.hostId) || command.hostId <= 0)
    throw brokerError(
      "INVALID_EXECUTOR_REQUEST",
      "A Desktop-owned window ID is required.",
    );
  if (command.kind === "environments") return;
  if (command.kind !== "read" || !["user", "query"].includes(command.operation))
    throw brokerError(
      "READ_ONLY_EXECUTOR",
      "The broker executor supports only identity and SELECT reads.",
    );
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
    if (command.kind === "environments") return service.environments(host);
    // Never forward arbitrary args/operations from the worker to the privileged service.
    const args =
      command.operation === "user"
        ? {}
        : { sql: command.args.sql, offset: command.args.offset ?? 0 };
    return service.run(host, command.origin, command.operation, args);
  };
}
