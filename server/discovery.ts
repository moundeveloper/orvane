import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, Connect } from "vite";
import type { IncomingMessage } from "node:http";

export function mcpDiscovery(directory: string): Plugin {
  const middleware: Connect.NextHandleFunction = async (
    request,
    response,
    next,
  ) => {
    if (request.url !== "/__orvane/mcp") return next();
    const req = request as IncomingMessage;
    const host = req.headers.host || "";
    const origin = req.headers.origin;
    // This endpoint contains the local bridge secret. It is same-origin only;
    // never inherit Vite's development CORS policy for discovery responses.
    response.removeHeader("Access-Control-Allow-Origin");
    response.setHeader("Cache-Control", "no-store");
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
      (origin && origin !== `http://${host}` && origin !== `https://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (req.method !== "GET") {
      response.writeHead(405);
      response.end();
      return;
    }
    try {
      const config = JSON.parse(
        await readFile(join(directory, "mcp-bridge.json"), "utf8"),
      );
      const localOrigin = `${req.socket instanceof Object && "encrypted" in req.socket ? "https" : "http"}://${host}`;
      if (
        !Array.isArray(config.origins) ||
        !config.origins.includes(localOrigin)
      ) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ available: false }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ available: true, ...config }));
    } catch {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ available: false }));
    }
  };
  return {
    name: "orvane-mcp-discovery",
    configResolved(config) {
      config.server.fs.deny.push(
        "**/.orvane/**",
        `${directory.replace(/\\/g, "/")}/**`,
      );
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
