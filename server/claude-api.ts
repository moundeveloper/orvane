import type { Plugin, Connect } from "vite";
import { join } from "node:path";
import { ClaudeSessions } from "./claude-sessions.ts";

export function claudeApi(directory: string): Plugin {
  const services = new Map<string, ClaudeSessions>();
  let testing = false;
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith("/__orvane/claude/")) return next();
    res.removeHeader("Access-Control-Allow-Origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, value: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    const host = req.headers.host || "",
      protocol = "encrypted" in req.socket ? "https" : "http";
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `${protocol}://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress || "",
      )
    )
      return reply(403, { error: "Local, same-origin access is required." });
    if (
      req.method !== "POST" ||
      req.headers["content-type"]?.split(";")[0] !== "application/json"
    )
      return reply(415, { error: "POST application/json is required." });
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("orvane-test-workspace="))
      ?.slice("orvane-test-workspace=".length);
    const namespace = testing
      ? req.headers["x-orvane-test-workspace"] || cookie
      : "workspace";
    if (typeof namespace !== "string" || !/^[-\w]{1,80}$/.test(namespace))
      return reply(400, { error: "An isolated test workspace is required." });
    try {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 16_000)
          return reply(413, { error: "Request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      const args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      let service = services.get(namespace);
      if (!service) {
        service = new ClaudeSessions(
          testing ? join(directory, "tests", namespace) : directory,
          testing
            ? join(directory, "tests", namespace, "claude-projects")
            : undefined,
        );
        services.set(namespace, service);
      }
      const op = req.url.slice("/__orvane/claude/".length).split("?")[0];
      if (op === "sessions")
        return reply(200, { sessions: await service.list() });
      if (op === "read") return reply(200, await service.read(args));
      return reply(404, { error: "Unknown session operation." });
    } catch (error) {
      reply(400, {
        error:
          error instanceof Error ? error.message : "Session could not be read.",
      });
    }
  };
  const close = () => {
    for (const service of services.values()) service.close();
    services.clear();
  };
  return {
    name: "orvane-claude-sessions",
    configResolved(c) {
      testing = c.mode === "test-storage";
    },
    configureServer(s) {
      s.middlewares.use(middleware);
      s.httpServer?.once("close", close);
    },
    configurePreviewServer(s) {
      s.middlewares.use(middleware);
      s.httpServer.once("close", close);
    },
  };
}
