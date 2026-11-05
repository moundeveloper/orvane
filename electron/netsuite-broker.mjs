import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  BROKER_PROTOCOL,
  MAX_BROKER_PENDING,
  MAX_BROKER_RESULT_BYTES,
  brokerError,
  createExecutorGateway,
} from "./netsuite-broker-protocol.mjs";

/** Desktop owns this worker; MCP clients never start an execution engine. */
export async function startNetSuiteBroker({
  directory,
  hosts,
  service,
  instanceId = randomUUID(),
  execPath = process.env.ORVANE_NODE || "node",
  onExit = () => {},
}) {
  const child = fork(
    fileURLToPath(new URL("./netsuite-broker-worker.mjs", import.meta.url)),
    [],
    {
      execPath,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  child.stderr.resume();
  const dispatch = createExecutorGateway({ hosts, service });
  let closed = false,
    ready = false,
    closing,
    inFlight = 0;
  let resolveReady, rejectReady, resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const started = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const send = (message) => {
    if (child.connected) child.send(message, () => {});
  };
  const timer = setTimeout(
    () =>
      rejectReady(
        brokerError(
          "BROKER_START_TIMEOUT",
          "NetSuite broker did not start within 10 seconds.",
        ),
      ),
    10000,
  );
  const finishExit = (code, signal) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    resolveExit({ code, signal });
    rejectReady(
      brokerError(
        "BROKER_EXITED",
        "The NetSuite broker stopped before becoming ready.",
      ),
    );
    onExit({ code, signal, expected: Boolean(closing), wasReady: ready });
  };
  child.on("error", (error) => {
    rejectReady(error);
    if (!child.pid) finishExit(null, null);
  });
  child.on("exit", finishExit);
  child.on("close", finishExit);
  child.on("message", async (message) => {
    if (!message || message.version !== BROKER_PROTOCOL) return;
    if (
      message.type === "ready" &&
      message.instanceId === instanceId &&
      message.brokerPid === child.pid
    ) {
      ready = true;
      clearTimeout(timer);
      resolveReady();
      return;
    }
    if (message.type === "failed") {
      rejectReady(
        brokerError(
          message.code || "BROKER_START_FAILED",
          message.error || "NetSuite broker could not start.",
        ),
      );
      return;
    }
    if (
      message.type !== "execute" ||
      typeof message.id !== "string" ||
      message.id.length > 80 ||
      closed ||
      closing
    )
      return;
    const reply = (value) =>
      send({
        type: "result",
        version: BROKER_PROTOCOL,
        id: message.id,
        ...value,
      });
    if (inFlight >= MAX_BROKER_PENDING) {
      reply({
        ok: false,
        code: "BROKER_BUSY",
        error: "The Desktop executor queue is full.",
      });
      return;
    }
    inFlight++;
    try {
      const data = await dispatch(message.command);
      if (
        Buffer.byteLength(JSON.stringify(data ?? null)) >
        MAX_BROKER_RESULT_BYTES
      )
        throw brokerError(
          "RESULT_TOO_LARGE",
          "Read result exceeds 1 MiB. Select fewer columns or shorter values.",
        );
      reply({ ok: true, data });
    } catch (error) {
      reply({
        ok: false,
        code: error.code || "EXECUTOR_ERROR",
        error: error.message || "Desktop read failed.",
      });
    } finally {
      inFlight--;
    }
  });
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      if (closed) return;
      send({ type: "stop", version: BROKER_PROTOCOL });
      const kill = setTimeout(() => {
        if (child.connected) child.disconnect();
        child.kill();
      }, 2000);
      let deadline;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  brokerError(
                    "BROKER_STOP_TIMEOUT",
                    "The broker did not stop; Desktop will close its private channel.",
                  ),
                ),
              3500,
            );
          }),
        ]);
      } finally {
        clearTimeout(kill);
        clearTimeout(deadline);
      }
    })();
    return closing;
  }
  send({
    type: "init",
    version: BROKER_PROTOCOL,
    directory,
    instanceId,
    desktopPid: process.pid,
  });
  try {
    await started;
  } catch (error) {
    await close();
    throw error;
  }
  return { pid: child.pid, desktopPid: process.pid, instanceId, close, exited };
}
