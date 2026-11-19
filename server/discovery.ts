import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, Connect } from "vite";
import type { IncomingMessage } from "node:http";

type BridgeConfig = {
  instanceId?: string;
  url?: string;
  token?: string;
  origins?: unknown;
  pid?: number;
};
const alive = (pid: unknown) => {
  if (typeof pid !== "number") return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
/** Every running MCP server's bridge; files left by crashed servers are removed. */
async function runningBridges(directory: string) {
  const folder = join(directory, "mcp-bridges");
  const bridges: BridgeConfig[] = [];
  let names: string[] = [];
  try {
    names = await readdir(folder);
  } catch {
    /* No server has started yet. */
  }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      const config = JSON.parse(
        await readFile(join(folder, name), "utf8"),
      ) as BridgeConfig;
      if (alive(config.pid)) bridges.push(config);
      else await rm(join(folder, name), { force: true });
    } catch {
      /* Skip a file that is being written. */
    }
  }
  // Servers from before per-instance discovery only wrote the single file.
  if (!bridges.length)
    try {
      bridges.push(
        JSON.parse(await readFile(join(directory, "mcp-bridge.json"), "utf8")),
      );
    } catch {
      /* None running. */
    }
  return bridges;
}
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
      const localOrigin = `${req.socket instanceof Object && "encrypted" in req.socket ? "https" : "http"}://${host}`;
      const bridges = (await runningBridges(directory))
        .filter(
          (config) =>
            Array.isArray(config.origins) &&
            config.origins.includes(localOrigin),
        )
        .map(({ instanceId, url, token }) => ({ instanceId, url, token }));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          bridges.length
            ? { available: true, ...bridges[0], bridges }
            : { available: false },
        ),
      );
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
