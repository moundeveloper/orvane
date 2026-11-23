// The Browser's Memory section: the user's own view of site memory (see
// site-memory.ts). Local, same-origin only, like the Notes API. Everything
// written here counts as the user's: reviewed, and flows approved.
import type { Connect, Plugin } from "vite";
import { z } from "zod";
import { SiteMemoryStore, siteOf } from "./site-memory.ts";

const kind = z.enum(["route", "note", "flow"]);
const site = z.string().min(1).max(253);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sites") }).strict(),
  z.object({ action: z.literal("read"), site }).strict(),
  z.object({ action: z.literal("site-of"), url: z.string().max(4000) }).strict(),
  z.object({
    action: z.literal("save-route"), site,
    name: z.string().max(60), path: z.string().max(500), description: z.string().max(200).optional(),
    previousName: z.string().max(60).optional(),
  }).strict(),
  z.object({ action: z.literal("save-note"), site, text: z.string().max(300), id: z.string().max(40).optional() }).strict(),
  z.object({
    action: z.literal("save-flow"), site,
    name: z.string().max(60), description: z.string().max(200),
    params: z.array(z.string().max(30)).max(10).default([]),
    steps: z.array(z.record(z.string(), z.unknown())).max(30),
    previousName: z.string().max(60).optional(),
  }).strict(),
  z.object({ action: z.literal("remove"), site, kind, key: z.string().max(60) }).strict(),
  z.object({ action: z.literal("approve"), site, kind, key: z.string().max(60), value: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("disable"), site, kind, key: z.string().max(60), value: z.boolean() }).strict(),
  z.object({ action: z.literal("decide-plan"), site, id: z.string().max(40), value: z.boolean() }).strict(),
  z.object({ action: z.literal("remove-plan"), site, id: z.string().max(40) }).strict(),
  z.object({ action: z.literal("pending") }).strict(),
]);

export function siteMemoryApi(directory: string): Plugin {
  let testing = false;
  const stores = new Map<string, SiteMemoryStore>();
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (req.url?.split("?")[0] !== "/__orvane/site-memory") return next();
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
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      return reply(415, { error: "JSON is required." });
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
        if (length > 200_000) return reply(413, { error: "The request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      let store = stores.get(namespace);
      if (!store) {
        store = new SiteMemoryStore(directory, testing ? `tests/${namespace}.sqlite` : "workspace.sqlite");
        stores.set(namespace, store);
      }
      const r = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      const data =
        r.action === "sites" ? store.sites()
        : r.action === "read" ? store.read(r.site)
        : r.action === "site-of" ? { site: siteOf(r.url) }
        : r.action === "save-route" ? store.saveRoute(r.site, "user", r)
        : r.action === "save-note" ? store.saveNote(r.site, "user", r)
        : r.action === "save-flow" ? store.saveFlow(r.site, "user", r)
        : r.action === "remove" ? store.remove(r.site, r.kind, r.key)
        : r.action === "approve" ? store.approve(r.site, r.kind, r.key, r.value)
        : r.action === "decide-plan" ? store.decidePlan(r.site, r.id, r.value)
        : r.action === "remove-plan" ? store.removePlan(r.site, r.id)
        // Everything waiting for the user, for the header badge.
        : r.action === "pending" ? { count: store.sites().reduce((n, s) => n + s.unreviewed, 0) }
        : store.setDisabled(r.site, r.kind, r.key, r.value);
      reply(200, data);
    } catch (error) {
      reply(400, {
        error: error instanceof z.ZodError ? "Invalid site memory request." : error instanceof Error ? error.message : String(error),
      });
    }
  };
  const close = () => {
    for (const store of stores.values()) store.close();
    stores.clear();
  };
  return {
    name: "orvane-site-memory-api",
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
