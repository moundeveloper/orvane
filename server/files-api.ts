import type { Plugin, Connect } from "vite";
import { createFilesService } from "./files.ts";
// File Explorer HTTP API: /__orvane/files/<operation>, POST JSON only, and
// only from a same-origin page on this machine (like the Projects Hub API).
export function filesApi(): Plugin {
  const service = createFilesService();
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith("/__orvane/files/")) return next();
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
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")
    )
      return reply(403, { error: "Local, same-origin access is required." });
    if (req.method !== "POST") return reply(405, { error: "POST is required." });
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      return reply(415, { error: "JSON is required." });
    const operation = req.url.slice("/__orvane/files/".length).split("?")[0]!;
    if (!/^[a-z][a-z-]*$/.test(operation)) return reply(404, { error: "Unknown File Explorer operation." });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        // Room for saving a text file of up to a few megabytes.
        if (length > 8_000_000) return reply(413, { error: "The request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      reply(200, await service.invoke(operation, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : "File Explorer request failed." });
    }
  };
  return {
    name: "orvane-files",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
