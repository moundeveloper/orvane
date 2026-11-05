import net from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class DesktopNetSuiteError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function desktopNetSuiteRequest(
  directory: string,
  request: object,
): Promise<unknown> {
  const descriptorPath = join(directory, "netsuite-broker", "desktop.json");
  const descriptor = await readFile(descriptorPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (!descriptor)
    throw new DesktopNetSuiteError(
      "DESKTOP_UNAVAILABLE",
      "Start or restart Orvane Desktop to enable the NetSuite MCP service.",
    );
  const { endpoint, token, instanceId } = descriptor;
  const validId =
    typeof instanceId === "string" && /^[a-f\d-]{36}$/i.test(instanceId);
  const expected =
    process.platform === "win32"
      ? String.raw`\\.\pipe\orvane-netsuite-${instanceId}`
      : join(directory, "netsuite-broker", `rpc-${instanceId}.sock`);
  if (
    descriptor.version !== 1 ||
    !validId ||
    endpoint !== expected ||
    typeof token !== "string" ||
    !/^[\w-]{43}$/.test(token)
  )
    throw new DesktopNetSuiteError(
      "PROTOCOL_MISMATCH",
      "Invalid Desktop discovery descriptor. Restart Orvane Desktop.",
    );
  const payload = JSON.stringify({ version: 1, token, request }) + "\n";
  if (Buffer.byteLength(payload) > 64 * 1024)
    throw new DesktopNetSuiteError(
      "REQUEST_TOO_LARGE",
      "Desktop request exceeds 64 KiB.",
    );
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding("utf8");
    let body = "",
      bytes = 0,
      completed = false;
    const finish = (error?: Error, value?: unknown) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          new DesktopNetSuiteError(
            "READ_TIMEOUT",
            "Desktop read timed out. No account write was submitted.",
          ),
        ),
      90000,
    );
    socket.on("connect", () => socket.write(payload));
    socket.on("error", () =>
      finish(
        new DesktopNetSuiteError(
          "DESKTOP_UNAVAILABLE",
          "Desktop is unavailable. Start or restart Orvane Desktop.",
        ),
      ),
    );
    socket.on("close", () => {
      if (!completed)
        finish(
          new DesktopNetSuiteError(
            "DESKTOP_DISCONNECTED",
            "Desktop disconnected before returning the read.",
          ),
        );
    });
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024 + 1)
        return finish(
          new DesktopNetSuiteError(
            "RESULT_TOO_LARGE",
            "Desktop result exceeds 1 MiB.",
          ),
        );
      body += chunk;
      if (!body.includes("\n")) return;
      try {
        const result = JSON.parse(body);
        if (result.ok !== true)
          finish(
            new DesktopNetSuiteError(
              result.code || "NETSUITE_ERROR",
              result.error || "NetSuite read failed.",
            ),
          );
        else finish(undefined, result.data);
      } catch {
        finish(
          new DesktopNetSuiteError(
            "INVALID_RESPONSE",
            "Invalid response from Desktop.",
          ),
        );
      }
    });
  });
}
