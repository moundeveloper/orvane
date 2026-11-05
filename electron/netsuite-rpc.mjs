import net from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const MAX_REQUEST = 64 * 1024,
  MAX_RESPONSE = 1024 * 1024;
/** A first direct, read-only Desktop gateway. Worker/job extraction is a later batch. */
export async function startNetSuiteRpc({
  directory,
  dispatch,
  instanceId = randomUUID(),
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    }).match(/S-1-[\d-]+/)?.[0];
    if (!sid)
      throw Error(
        "Could not determine the current Windows user for NetSuite discovery permissions.",
      );
    execFileSync(
      "icacls",
      [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
      { windowsHide: true, stdio: "pipe" },
    );
  } else await chmod(directory, 0o700);
  const path = join(directory, "desktop.json");
  const previous = await readFile(path, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw Error(
        "Invalid NetSuite Desktop discovery file. Check the stopped Desktop instance before removing it.",
      );
    });
  if (previous) {
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0)
      throw Error("Invalid Desktop owner.");
    let alive = true;
    try {
      process.kill(previous.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") alive = false;
    }
    if (alive)
      throw Error("A NetSuite Desktop gateway already owns this profile.");
    await unlink(path);
  }
  const endpoint =
    process.platform === "win32"
      ? String.raw`\\.\pipe\orvane-netsuite-${instanceId}`
      : join(directory, `rpc-${instanceId}.sock`);
  const token = randomBytes(32).toString("base64url"),
    clients = new Set();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(95000, () => socket.destroy());
    let body = "",
      bytes = 0,
      received = false;
    const authTimer = setTimeout(() => socket.destroy(), 3000);
    socket.on("close", () => clearTimeout(authTimer));
    const reply = (value) => {
      let json = JSON.stringify(value);
      if (Buffer.byteLength(json) > MAX_RESPONSE)
        json = JSON.stringify({
          ok: false,
          code: "RESULT_TOO_LARGE",
          error:
            "Result exceeds the 1 MiB first-batch limit. Select fewer columns/shorter values.",
        });
      socket.end(json + "\n");
    };
    socket.on("data", async (chunk) => {
      if (received) return socket.destroy();
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST) return socket.destroy();
      body += chunk.toString("utf8");
      if (!body.includes("\n")) return;
      received = true;
      clearTimeout(authTimer);
      try {
        if (body.slice(body.indexOf("\n") + 1).trim())
          throw Error("One request per connection is required.");
        const message = JSON.parse(body);
        const supplied = Buffer.from(
            typeof message.token === "string" ? message.token : "",
          ),
          expected = Buffer.from(token);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          reply({
            ok: false,
            code: "UNAUTHORIZED",
            error: "Unauthorized Desktop request.",
          });
          return;
        }
        if (message.version !== 1) {
          reply({
            ok: false,
            code: "PROTOCOL_MISMATCH",
            error: "Unsupported Desktop protocol.",
          });
          return;
        }
        reply({ ok: true, data: await dispatch(message.request) });
      } catch (error) {
        reply({
          ok: false,
          code: error.code || "NETSUITE_ERROR",
          error: error.message || "NetSuite request failed.",
        });
      }
    });
  });
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { path: endpoint, readableAll: false, writableAll: false },
      resolve,
    );
  });
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        instanceId,
        pid: process.pid,
        endpoint,
        token,
      }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    instanceId,
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      const saved = await readFile(path, "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (saved?.instanceId === instanceId) await unlink(path).catch(() => {});
    },
  };
}
