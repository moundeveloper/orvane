import type { Plugin, Connect } from "vite";
import { GitService, gitSchemas, type GitOperation } from "./git.ts";
export function gitApi(directory: string): Plugin {
  let testing = false;
  const services = new Map<string, GitService>();
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith("/__orvane/git/")) return next();
    res.removeHeader("Access-Control-Allow-Origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, data: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
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
    if (req.method !== "POST")
      return reply(405, { error: "POST is required." });
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      return reply(415, { error: "JSON is required." });
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("orvane-test-workspace="))
      ?.slice("orvane-test-workspace=".length);
    const namespace = testing
      ? req.headers["x-orvane-test-workspace"] || cookie
      : "workspace";
    if (typeof namespace !== "string" || !/^[\w-]{1,80}$/.test(namespace))
      return reply(400, { error: "An isolated test workspace is required." });
    const operation = req.url
      .slice("/__orvane/git/".length)
      .split("?")[0] as GitOperation;
    if (!Object.hasOwn(gitSchemas, operation))
      return reply(404, { error: "Unknown Git operation." });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 64_000)
          return reply(413, { error: "The Git request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      let service = services.get(namespace);
      if (!service) {
        service = new GitService(
          directory,
          testing ? `tests/${namespace}.sqlite` : "workspace.sqlite",
        );
        services.set(namespace, service);
      }
      reply(
        200,
        await service.invoke(
          operation,
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        ),
      );
    } catch (error) {
      reply(400, {
        error:
          error instanceof Error
            ? error.message
            : "The Git workspace could not be read.",
      });
    }
  };
  const close = () => {
    for (const service of services.values()) service.close();
    services.clear();
  };
  return {
    name: "orvane-local-git",
    configResolved(config) {
      testing = config.mode === "test-storage";
    },
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", close);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer.once("close", close);
    },
  };
}
