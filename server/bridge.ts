import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

export const sessionSchema = z
  .object({
    id: z.string().min(1).max(200),
    origin: z.string().url(),
    title: z.string().max(300),
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;
export class BrowserBridge {
  private http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  private sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 26_000_000,
    handleProtocols: () => "orvane",
  });
  private sessions = new Map<string, { info: Session; socket: WebSocket }>();
  private pending = new Map<
    string,
    {
      socket: WebSocket;
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private token = randomBytes(32).toString("base64url");
  private instanceId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private directory: string,
    private origins: string[],
  ) {
    this.http.on("upgrade", (request, socket, head) => {
      const host = request.headers.host;
      const origin = request.headers.origin;
      const protocols = (request.headers["sec-websocket-protocol"] || "")
        .split(",")
        .map((p) => p.trim());
      const provided = protocols.find((p) => p !== "orvane") || "";
      const suppliedBytes = Buffer.from(provided),
        expectedBytes = Buffer.from(this.token);
      const valid =
        suppliedBytes.length === expectedBytes.length &&
        timingSafeEqual(suppliedBytes, expectedBytes);
      if (
        !host ||
        !/^127\.0\.0\.1:\d+$/.test(host) ||
        !origin ||
        !this.origins.includes(origin) ||
        !valid ||
        request.url !== "/workspace"
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        this.sockets.emit("connection", ws, request);
        let sessionId: string | undefined;
        const helloTimer = setTimeout(
          () => ws.close(1008, "Session registration required"),
          5000,
        );
        ws.on("message", (bytes) => {
          try {
            const message = JSON.parse(bytes.toString()) as Record<
              string,
              unknown
            >;
            if (message.type === "hello") {
              if (sessionId) throw Error("Already registered");
              const info = sessionSchema.parse(message.session);
              if (info.origin !== origin || this.sessions.has(info.id))
                throw Error("Invalid browser session");
              sessionId = info.id;
              clearTimeout(helloTimer);
              this.sessions.set(info.id, { info, socket: ws });
              return;
            }
            if (
              message.type !== "result" ||
              !sessionId ||
              typeof message.id !== "string"
            )
              throw Error("Invalid bridge message");
            const pending = this.pending.get(message.id);
            if (!pending || pending.socket !== ws) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.ok === true) pending.resolve(message.data);
            else
              pending.reject(
                Error(
                  typeof message.error === "string"
                    ? message.error
                    : "The browser could not complete this request.",
                ),
              );
          } catch {
            ws.close(1008, "Invalid bridge message");
          }
        });
        ws.on("error", () => {});
        ws.on("close", () => {
          clearTimeout(helloTimer);
          if (sessionId) this.sessions.delete(sessionId);
          for (const [id, p] of this.pending)
            if (p.socket === ws) {
              clearTimeout(p.timer);
              this.pending.delete(id);
              p.reject(
                Error(
                  "The editing tab disconnected. A submitted edit may have committed. Inspect the workspace before retrying; writes are never retried automatically.",
                ),
              );
            }
        });
      });
    });
  }
  async listen(port: number) {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, "127.0.0.1", () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    const address = this.http.address();
    if (!address || typeof address === "string")
      throw Error("Bridge did not bind a local TCP port.");
    const config = {
      instanceId: this.instanceId,
      url: `ws://127.0.0.1:${address.port}/workspace`,
      token: this.token,
      origins: this.origins,
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `bridge-${this.instanceId}.tmp`);
    await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
    await rename(temporary, join(this.directory, "mcp-bridge.json"));
    // Detect stale browser processes without keeping silent dead sessions forever.
    const alive = new WeakSet<WebSocket>();
    this.sockets.on("connection", (socket) => {
      alive.add(socket);
      socket.on("pong", () => alive.add(socket));
    });
    this.timer = setInterval(() => {
      for (const socket of this.sockets.clients) {
        if (!alive.has(socket)) socket.terminate();
        else {
          alive.delete(socket);
          socket.ping();
        }
      }
    }, 15000);
    this.timer.unref();
    return address.port;
  }
  list() {
    return [...this.sessions.values()].map(({ info }) => info);
  }
  async request(
    command: unknown,
    sessionId?: string,
    expectedRevision?: string,
  ) {
    const sessions = [...this.sessions.values()];
    const selected = sessionId
      ? this.sessions.get(sessionId)
      : sessions.length === 1
        ? sessions[0]
        : undefined;
    if (!selected)
      throw Error(
        sessionId
          ? "That browser session is no longer connected. Call workspace_status again."
          : sessions.length
            ? "More than one workspace is connected. Call workspace_status and specify sessionId."
            : "No editing tab is connected. Start pnpm dev (or pnpm preview) in Orvane and keep the workspace open.",
      );
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Error(
            "The browser did not respond within 15 seconds. An edit may still commit. Inspect the workspace before retrying; this server never retries writes.",
          ),
        );
      }, 15000);
      this.pending.set(id, { socket: selected.socket, resolve, reject, timer });
      selected.socket.send(
        JSON.stringify({ type: "command", id, command, expectedRevision }),
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(Error("Could not deliver the request to the editing tab."));
          }
        },
      );
    });
  }
  async close() {
    clearInterval(this.timer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("MCP bridge closed."));
    }
    this.pending.clear();
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    try {
      const file = join(this.directory, "mcp-bridge.json");
      const current = JSON.parse(await readFile(file, "utf8"));
      if (current.instanceId === this.instanceId) await rm(file);
    } catch {
      /* Another server may own discovery now. */
    }
  }
}
