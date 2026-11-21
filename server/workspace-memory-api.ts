// The Memory panel: the owner's view of Orvane memory (see
// workspace-memory.ts). Local, same-origin only, like the site memory API.
// Everything written here counts as the owner's, so it is reviewed.
import type { Connect, Plugin } from "vite";
import { z } from "zod";
import { WorkspaceMemoryStore } from "./workspace-memory.ts";

const kind = z.enum(["note", "procedure"]);
const key = z.string().min(1).max(60);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("count") }).strict(),
  z.object({ action: z.literal("save-note"), text: z.string().max(300), id: z.string().max(40).optional() }).strict(),
  z.object({
    action: z.literal("save-procedure"),
    name: z.string().max(60), description: z.string().max(200),
    steps: z.array(z.string().max(200)).max(20),
    previousName: z.string().max(60).optional(),
  }).strict(),
  z.object({ action: z.literal("remove"), kind, key }).strict(),
  z.object({ action: z.literal("approve"), kind, key, value: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("disable"), kind, key, value: z.boolean() }).strict(),
]);

export function workspaceMemoryApi(directory: string): Plugin {
  let testing = false;
  const stores = new Map<string, WorkspaceMemoryStore>();
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (req.url?.split("?")[0] !== "/__orvane/workspace-memory") return next();
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
      req.headers["sec-fetch-site"] === "same-site" ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")
    )
      return reply(403, { error: "Local, same-origin access is required." });
    if (req.method !== "POST") return reply(405, { error: "POST is required." });
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") return reply(415, { error: "JSON is required." });
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("orvane-test-workspace="))
      ?.slice("orvane-test-workspace=".length);
    const namespace = testing ? req.headers["x-orvane-test-workspace"] || cookie : "workspace";
    if (typeof namespace !== "string" || !/^[\w-]{1,80}$/.test(namespace))
      return reply(400, { error: "An isolated test workspace is required." });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 100_000) return reply(413, { error: "The request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      let store = stores.get(namespace);
      if (!store) {
        store = new WorkspaceMemoryStore(directory, testing ? `tests/${namespace}.sqlite` : "workspace.sqlite");
        stores.set(namespace, store);
      }
      const r = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      if (r.action === "count") return reply(200, { unreviewed: store.unreviewed() });
      if (r.action === "save-note") store.saveNote("user", r);
      else if (r.action === "save-procedure") store.saveProcedure("user", r);
      else if (r.action === "remove") store.remove(r.kind, r.key);
      else if (r.action === "approve") store.approve(r.kind, r.key, r.value);
      else if (r.action === "disable") store.setDisabled(r.kind, r.key, r.value);
      reply(200, store.read());
    } catch (error) {
      reply(400, {
        error: error instanceof z.ZodError ? "Invalid memory request." : error instanceof Error ? error.message : String(error),
      });
    }
  };
  const close = () => {
    for (const store of stores.values()) store.close();
    stores.clear();
  };
  return {
    name: "orvane-workspace-memory-api",
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
