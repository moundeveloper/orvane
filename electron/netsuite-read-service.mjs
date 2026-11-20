import { createHmac, randomBytes } from "node:crypto";
import { createSharedNetSuiteReads } from "./netsuite-shared-reads.mjs";
import {
  compileNetSuiteRead,
  netSuiteReadOperations,
  NETSUITE_FILTER_CAPABILITY,
} from "../server/netsuite-read-operations.ts";
import {
  NETSUITE_METADATA_TOOLS,
  NETSUITE_PAGE_READS,
  parseNetSuiteMetadata,
  runNetSuiteMetadata,
} from "../server/netsuite-metadata-operations.ts";
import {
  FILE_WRITE_MAX_BYTES,
  NETSUITE_WRITE_TOOLS,
  parseNetSuiteWrite,
  shapeScriptResult,
} from "../server/netsuite-write-operations.ts";

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
export function createNetSuiteReadService({ hosts, service, instanceId, taskRuns }) {
  const secret = randomBytes(32);
  const targets = new Map();
  const share = createSharedNetSuiteReads();
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
  /** Ported metadata tools: fixed SELECTs or allowlisted page reads, identity checked around the whole tool. */
  async function metadata(request) {
    const parsed = parseNetSuiteMetadata(request);
    const target = resolve(request.targetId);
    const before = await identity(target);
    if (request.identityToken !== before.identityToken)
      reject(
        "IDENTITY_CHANGED",
        "Inspect this target again; its account, user or role changed, or the identity token is missing.",
      );
    let calls = 0;
    const budget = () => {
      if (++calls > 10)
        reject("METADATA_BUDGET", "Metadata read exceeded its step budget.");
    };
    const runner = {
      query: async (sql, offset = 0) => {
        budget();
        if (!/^\s*select\b/i.test(sql) || sql.includes(";") || sql.length > 20000)
          reject("INVALID_QUERY", "Metadata reads use one bounded SELECT.");
        const result = await service.run(
          target.host,
          target.origin,
          "query",
          { sql, offset },
          target.sessionEpoch ?? undefined,
        );
        if (!Array.isArray(result?.rows) || result.rows.length > 100)
          reject(
            "INVALID_QUERY_RESULT",
            "The query adapter did not return a bounded page of up to 100 rows.",
          );
        return result;
      },
      page: async (operation, args) => {
        budget();
        if (!NETSUITE_PAGE_READS.includes(operation))
          reject("READ_ONLY_EXECUTOR", "Unknown metadata page read.");
        return service.run(
          target.host,
          target.origin,
          operation,
          args,
          target.sessionEpoch ?? undefined,
        );
      },
    };
    const data = await runNetSuiteMetadata(parsed, runner);
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
      metadata: { tool: parsed.tool, capability: parsed.capability },
      data,
      observedAt: new Date().toISOString(),
    };
  }
  /** Script runs and File Cabinet writes: identity checked first, never retried, reported even if identity changes after. */
  async function write(request) {
    const parsed = parseNetSuiteWrite(request);
    if (typeof service.write !== "function")
      reject("UPGRADE_PENDING", "This Desktop broker cannot run writes. Restart Orvane Desktop.");
    const target = resolve(request.targetId);
    const before = await identity(target);
    if (request.identityToken !== before.identityToken)
      reject(
        "IDENTITY_CHANGED",
        "Inspect this target again; its account, user or role changed, or the identity token is missing. Nothing was written.",
      );
    const epoch = target.sessionEpoch ?? undefined;
    const exec = (operation, args) => service.write(target.host, target.origin, operation, args, epoch);
    const query = async (sql) => {
      const result = await service.run(target.host, target.origin, "query", { sql, offset: 0 }, epoch);
      return Array.isArray(result?.rows) ? result.rows : [];
    };
    const args = parsed.args;
    let data;
    if (parsed.tool === "task") {
      if (!taskRuns) reject("UPGRADE_PENDING", "This Desktop broker cannot run tasks. Restart Orvane Desktop.");
      const live = { host: target.host, origin: target.origin, sessionEpoch: epoch };
      if (args.action === "list") data = { runs: taskRuns.list(target.origin) };
      else {
        let run;
        if (args.action === "run") run = taskRuns.add(target.origin, await exec("run-task", { deploymentId: args.deploymentId }));
        else {
          run = taskRuns.get(args.runId);
          if (!run || run.origin !== target.origin) reject("UNKNOWN_RUN", "No run with this ID for this account.");
        }
        const until = Date.now() + args.waitSeconds * 1000;
        for (;;) {
          await taskRuns.refresh(run, live).catch((error) => {
            run.lastError = String(error?.message || error);
          });
          if (run.done || Date.now() + 3000 > until) break;
          await new Promise((done) => setTimeout(done, 3000));
        }
        data = run;
      }
    } else if (parsed.tool === "run-suitescript") {
      const raw = await exec("run-script", { code: args.code, timeoutMs: args.timeoutSeconds * 1000 });
      data = shapeScriptResult(raw, args.maxResultChars);
    } else if (args.action === "upload") {
      const base64 = args.base64 ?? Buffer.from(args.content, "utf8").toString("base64");
      if (Buffer.byteLength(base64, "base64") > FILE_WRITE_MAX_BYTES)
        reject("INVALID_WRITE", "Files are limited to 5 MB.");
      data = await exec("upload-file", { folderId: args.folderId, name: args.name, base64, overwrite: args.overwrite });
    } else if (args.action === "update") {
      data = await exec("save-file", { id: args.fileId, content: args.content, ...(args.original !== undefined ? { original: args.original } : {}) });
      data = { id: args.fileId, saved: true, verified: true, conflictChecked: args.original !== undefined };
    } else if (args.action === "create-folder") {
      data = await exec("create-folder", { folderId: args.folderId, name: args.name });
    } else {
      // NetSuite deletes per parent folder; group the items by where they live.
      const groups = new Map();
      const add = (parent, kind, id) => {
        const group = groups.get(parent) ?? { fileIds: [], folderIds: [] };
        group[kind].push(id);
        groups.set(parent, group);
      };
      const missing = [];
      if (args.fileIds?.length) {
        const rows = await query(`SELECT id, folder FROM file WHERE id IN (${args.fileIds.join(",")})`);
        for (const id of args.fileIds) {
          const row = rows.find((r) => Number(r.id) === id);
          row ? add(Number(row.folder), "fileIds", id) : missing.push(`File ${id}`);
        }
      }
      if (args.folderIds?.length) {
        const rows = await query(`SELECT id, parent FROM MediaItemFolder WHERE id IN (${args.folderIds.join(",")})`);
        for (const id of args.folderIds) {
          const row = rows.find((r) => Number(r.id) === id);
          row ? add(Number(row.parent ?? -15), "folderIds", id) : missing.push(`Folder ${id}`);
        }
      }
      let deleted = 0;
      const remaining = [],
        errors = [];
      for (const [folderId, group] of groups) {
        const result = await exec("delete-items", { folderId: Number.isSafeInteger(folderId) && folderId !== 0 ? folderId : -15, ...group });
        deleted += result?.deleted ?? 0;
        remaining.push(...(result?.remaining ?? []));
        errors.push(...(result?.errors ?? []));
      }
      data = { deleted, remaining, errors, notFound: missing };
    }
    const after = await identity(target).catch(() => null);
    return {
      desktopId: instanceId,
      targetId: request.targetId,
      origin: target.origin,
      identity: after ?? before,
      write: { tool: parsed.tool, action: args.action ?? null },
      ...(after && after.identityToken !== before.identityToken
        ? { warning: "The account, user or role changed while writing. The write was submitted with the identity checked before it." }
        : {}),
      data,
      observedAt: new Date().toISOString(),
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
        readOnly: typeof service.write !== "function",
        readSharingBudget: share.budget(),
        capabilities: [
          "environments.list",
          "identity.inspect",
          "query.select",
          "query.share-in-flight",
          NETSUITE_FILTER_CAPABILITY,
          ...Object.values(netSuiteReadOperations).map(
            (policy) => policy.capability,
          ),
          ...Object.values(NETSUITE_METADATA_TOOLS),
          ...(typeof service.write === "function"
            ? Object.values(NETSUITE_WRITE_TOOLS).filter(
                (capability) => capability !== NETSUITE_WRITE_TOOLS.task || taskRuns,
              )
            : []),
        ],
        environments,
      };
    }
    if (request.operation === "metadata") return metadata(request);
    if (request.operation === "write") return write(request);
    const typed =
      request.operation === "read" ? compileNetSuiteRead(request) : null;
    if (request.operation !== "query" && !typed)
      reject(
        "UNKNOWN_OPERATION",
        "This broker supports status, SELECT queries and registered typed reads.",
      );
    const sql = typed ? typed.sql : request.sql;
    const offset = typed ? typed.offset : (request.offset ?? 0);
    if (
      typeof sql !== "string" ||
      sql.length > 20000 ||
      !/^\s*select\b/i.test(sql) ||
      sql.includes(";")
    )
      reject(
        "INVALID_QUERY",
        "Use one SELECT statement without a semicolon, up to 20,000 characters.",
      );
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      reject("INVALID_QUERY", "Invalid query offset.");
    const target = resolve(request.targetId);
    if (
      request.shareInFlight !== undefined &&
      typeof request.shareInFlight !== "boolean"
    )
      reject("INVALID_QUERY", "shareInFlight must be a boolean.");
    const read = async () => {
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
          sql,
          offset,
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
    const result = await (request.shareInFlight === true
      ? share([request.targetId, request.identityToken, sql, offset], read)
      : read());
    return typed ? { ...result, read: typed.descriptor } : result;
  };
}
