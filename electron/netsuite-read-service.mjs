import { createHmac, randomBytes } from "node:crypto";

export class NetSuiteReadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const reject = (code, message) => {
  throw new NetSuiteReadError(code, message);
};
const originPattern = /^https:\/\/[a-z0-9-]+\.app\.netsuite\.com$/i;

/** No renderer callbacks: the host supplies Electron-owned windows and service. */
export function createNetSuiteReadService({ hosts, service, instanceId }) {
  const secret = randomBytes(32);
  const targets = new Map();
  const token = (value) =>
    createHmac("sha256", secret)
      .update(JSON.stringify(value))
      .digest("base64url");
  function resolve(targetId) {
    const target = targets.get(targetId);
    if (!target || target.host.isDestroyed() || !hosts().includes(target.host))
      reject(
        "TARGET_UNAVAILABLE",
        "List environments again and select an available target.",
      );
    return target;
  }
  async function identity(target) {
    const user = await service.run(
      target.host,
      target.origin,
      "user",
      {},
      target.sessionEpoch ?? undefined,
    );
    if (!user?.account || user.id == null || user.role == null)
      reject(
        "IDENTITY_UNAVAILABLE",
        "NetSuite did not return the current account, user and role.",
      );
    const account = String(user.account),
      userId = String(user.id),
      roleId = String(user.role);
    if (
      account.toLowerCase().replaceAll("_", "-") !==
      new URL(target.origin).hostname.split(".")[0].toLowerCase()
    )
      reject(
        "ACCOUNT_MISMATCH",
        "NetSuite runtime account does not match the selected environment.",
      );
    return {
      accountId: account,
      userId,
      roleId,
      identityToken: token([
        instanceId,
        target.host.id,
        target.origin,
        account,
        userId,
        roleId,
        target.sessionEpoch ?? null,
      ]),
      source: "client-runtime",
      serverRuntimeVerified: false,
      sessionEpoch: target.sessionEpoch ?? null,
      sessionEpochSupported: target.sessionEpoch != null,
    };
  }
  return async function dispatch(request) {
    if (!request || typeof request !== "object")
      reject("INVALID_REQUEST", "A request is required.");
    if (request.operation === "status") {
      if (request.action === "inspect") {
        const target = resolve(request.targetId);
        return {
          desktopId: instanceId,
          targetId: request.targetId,
          origin: target.origin,
          identity: await identity(target),
        };
      }
      if (request.action !== undefined && request.action !== "list")
        reject("INVALID_REQUEST", "Unknown status action.");
      const environments = [],
        active = new Set();
      for (const host of hosts()) {
        if (host.isDestroyed()) continue;
        for (const environment of await service.environments(host)) {
          if (!originPattern.test(environment.id)) continue;
          const sessionEpoch = environment.sessionEpoch ?? null;
          const targetId = token([
            instanceId,
            host.id,
            environment.id,
            sessionEpoch,
          ]);
          targets.set(targetId, { host, origin: environment.id, sessionEpoch });
          active.add(targetId);
          environments.push({
            targetId,
            origin: environment.id,
            label: environment.label,
            status: environment.status,
            windowId: host.id,
            sessionEpoch,
          });
        }
      }
      for (const id of targets.keys()) if (!active.has(id)) targets.delete(id);
      return {
        available: true,
        desktopId: instanceId,
        batch: 1,
        readOnly: true,
        capabilities: ["environments.list", "identity.inspect", "query.select"],
        environments,
      };
    }
    if (request.operation !== "query")
      reject(
        "UNKNOWN_OPERATION",
        "This batch supports only status and SELECT reads.",
      );
    if (
      typeof request.sql !== "string" ||
      request.sql.length > 20000 ||
      !/^\s*select\b/i.test(request.sql) ||
      request.sql.includes(";")
    )
      reject(
        "INVALID_QUERY",
        "Use one SELECT statement without a semicolon, up to 20,000 characters.",
      );
    if (
      !Number.isSafeInteger(request.offset ?? 0) ||
      (request.offset ?? 0) < 0 ||
      (request.offset ?? 0) > 1000000
    )
      reject("INVALID_QUERY", "Invalid query offset.");
    const target = resolve(request.targetId);
    const before = await identity(target);
    if (
      typeof request.identityToken !== "string" ||
      request.identityToken !== before.identityToken
    )
      reject(
        "IDENTITY_CHANGED",
        "Inspect this target again; its account, user or role changed, or the identity token is missing.",
      );
    const result = await service.run(
      target.host,
      target.origin,
      "query",
      {
        sql: request.sql,
        offset: request.offset ?? 0,
      },
      target.sessionEpoch ?? undefined,
    );
    if (!Array.isArray(result?.rows) || result.rows.length > 100)
      reject(
        "INVALID_QUERY_RESULT",
        "The query adapter did not return a bounded page of up to 100 rows.",
      );
    const after = await identity(target);
    if (before.identityToken !== after.identityToken)
      reject(
        "IDENTITY_CHANGED",
        "Identity changed while reading. Results were discarded; inspect the target again.",
      );
    return {
      desktopId: instanceId,
      targetId: request.targetId,
      origin: target.origin,
      identity: after,
      data: result,
      observedAt: new Date().toISOString(),
    };
  };
}
