import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { startNetSuiteRpc } from "./netsuite-rpc.mjs";
import { createNetSuiteReadService } from "./netsuite-read-service.mjs";
import { openRequestJournal } from "./netsuite-request-journal.mjs";
import {
  BROKER_PROTOCOL,
  MAX_BROKER_PENDING,
  brokerError,
} from "./netsuite-broker-protocol.mjs";

if (!process.send)
  throw Error(
    "The NetSuite broker must be started by Desktop using a private IPC channel.",
  );
let rpc,
  journal,
  initialized = false,
  stopping = false,
  desktopPid;
const pending = new Map();
const hostMap = new Map();
const activeRequests = new Set();
const send = (message) => {
  if (process.connected) process.send(message, () => {});
};
function execute(command) {
  if (stopping || !process.connected)
    return Promise.reject(
      brokerError("BROKER_STOPPED", "Desktop executor disconnected."),
    );
  if (pending.size >= MAX_BROKER_PENDING)
    return Promise.reject(
      brokerError(
        "BROKER_BUSY",
        "The Desktop read queue is full. Try again after current reads finish.",
      ),
    );
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        brokerError(
          "EXECUTOR_TIMEOUT",
          "Desktop executor did not finish the read. No mutation was submitted; reads are not automatically replayed.",
        ),
      );
    }, 65000);
    pending.set(id, { resolve, reject, timer });
    send({ type: "execute", version: BROKER_PROTOCOL, id, command });
  });
}
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(initTimer);
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(
      brokerError("BROKER_STOPPED", "The Desktop broker is shutting down."),
    );
  }
  pending.clear();
  const deadline = setTimeout(() => process.exit(1), 1500);
  try {
    await rpc?.close();
    await Promise.allSettled([...activeRequests]);
    journal?.close();
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}
const initTimer = setTimeout(() => {
  void stop();
}, 10000);
process.on("disconnect", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
process.on("message", async (message) => {
  if (!message || message.version !== BROKER_PROTOCOL) return;
  if (message.type === "result") {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.ok === true) item.resolve(message.data);
    else
      item.reject(
        brokerError(
          message.code || "EXECUTOR_ERROR",
          message.error || "Desktop read failed.",
        ),
      );
    return;
  }
  if (message.type === "stop") {
    await stop();
    return;
  }
  if (message.type !== "init" || initialized || stopping) return;
  initialized = true;
  clearTimeout(initTimer);
  try {
    if (
      typeof message.directory !== "string" ||
      !isAbsolute(message.directory) ||
      !/^[a-f\d-]{36}$/i.test(message.instanceId) ||
      !Number.isSafeInteger(message.desktopPid) ||
      message.desktopPid !== process.ppid
    )
      throw brokerError(
        "INVALID_BROKER_INIT",
        "Invalid Desktop broker initialization.",
      );
    desktopPid = message.desktopPid;
    const service = {
      environments: (host) =>
        execute({ kind: "environments", hostId: host.id }),
      run: (host, origin, operation, args, expectedSessionEpoch) =>
        execute({
          kind: "read",
          hostId: host.id,
          origin,
          operation,
          args,
          expectedSessionEpoch,
        }),
    };
    const dispatch = createNetSuiteReadService({
      hosts: () => [...hostMap.values()],
      service,
      instanceId: message.instanceId,
    });
    rpc = await startNetSuiteRpc({
      directory: message.directory,
      instanceId: message.instanceId,
      desktopPid,
      dispatch: async (request) => {
        if (!journal)
          throw brokerError(
            "BROKER_STARTING",
            "The broker journal is initializing.",
          );
        const execution = {
          mode: "broker-worker",
          brokerPid: process.pid,
          desktopPid,
          protocol: BROKER_PROTOCOL,
        };
        if (request?.operation === "status" && request.action === "requests")
          return {
            ...journal.list({
              limit: request.limit,
              beforeSequence: request.beforeSequence,
            }),
            batch: 3,
            execution,
          };
        const tracked = journal.run(request, async () => {
          const hosts = await execute({ kind: "hosts" });
          const active = new Set(hosts.map((host) => host.id));
          for (const id of hostMap.keys())
            if (!active.has(id)) hostMap.delete(id);
          for (const id of active)
            if (!hostMap.has(id))
              hostMap.set(id, { id, isDestroyed: () => !hostMap.has(id) });
          const result = await dispatch(request);
          return {
            ...result,
            capabilities: result.capabilities
              ? [...result.capabilities, "requests.read"]
              : undefined,
            batch: 3,
            execution,
          };
        });
        activeRequests.add(tracked);
        try {
          return await tracked;
        } finally {
          activeRequests.delete(tracked);
        }
      },
    });
    journal = openRequestJournal(message.directory, message.instanceId);
    // A disconnect during asynchronous startup must not leave an orphaned listener.
    if (stopping || !process.connected) {
      await rpc.close();
      process.exit(0);
      return;
    }
    send({
      type: "ready",
      version: BROKER_PROTOCOL,
      brokerPid: process.pid,
      instanceId: message.instanceId,
    });
  } catch (error) {
    send({
      type: "failed",
      version: BROKER_PROTOCOL,
      code: error.code || "BROKER_START_FAILED",
      error: error.message,
    });
    await stop();
  }
});
