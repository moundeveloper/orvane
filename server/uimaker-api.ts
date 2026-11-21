import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "node:http";
import { UiMakerService, IMAGE_TYPES } from "./uimaker.ts";

const BASE = "/__orvane/uimaker/";
/** UI Maker editor routes. JSON operations are POST; iteration files,
 * reference images, renders and the live event stream are GET so iframes,
 * images and EventSource can load them. Loopback and same-origin only. */
export function uimakerApi(directory: string): Plugin {
  let testing = false;
  const services = new Map<string, UiMakerService>();
  const streams = new Map<string, { clients: Set<ServerResponse>; stop: () => void }>();
  const service = (namespace: string) => {
    let s = services.get(namespace);
    if (!s) {
      s = new UiMakerService(directory, testing ? `tests/${namespace}.sqlite` : "workspace.sqlite");
      services.set(namespace, s);
    }
    return s;
  };
  // One file watcher per workspace, shared by every open editor.
  const subscribe = (namespace: string, res: ServerResponse) => {
    let stream = streams.get(namespace);
    if (!stream) {
      const clients = new Set<ServerResponse>();
      const stop = service(namespace).watch(() => {
        for (const client of clients) client.write(`data: {"type":"fs"}\n\n`);
      });
      stream = { clients, stop };
      streams.set(namespace, stream);
    }
    stream.clients.add(res);
    return () => {
      stream.clients.delete(res);
      if (!stream.clients.size) {
        stream.stop();
        streams.delete(namespace);
      }
    };
  };
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith(BASE)) return next();
    res.removeHeader("Access-Control-Allow-Origin");
    res.setHeader("Cache-Control", "no-store");
    const reply = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
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
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("orvane-test-workspace="))
      ?.slice("orvane-test-workspace=".length);
    const namespace = testing ? req.headers["x-orvane-test-workspace"] || cookie : "workspace";
    if (typeof namespace !== "string" || !/^[\w-]{1,80}$/.test(namespace))
      return reply(400, { error: "An isolated test workspace is required." });
    const url = new URL(req.url, "http://x");
    const operation = decodeURIComponent(url.pathname.slice(BASE.length));
    const s = service(namespace);
    try {
      if (req.method === "GET") {
        if (operation === "events") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          res.write("retry: 2000\n\n");
          const leave = subscribe(namespace, res);
          req.on("close", leave);
          return;
        }
        if (operation === "shot") {
          const c = url.searchParams.get("c") || "";
          s.component(c);
          const png = await s.shot(c, Number(url.searchParams.get("v")), { annot: url.searchParams.get("annot") === "1" });
          res.setHeader("Content-Type", "image/png");
          return res.end(png);
        }
        const m = /^files\/(c|refs)\/(.+)$/.exec(operation);
        const file = m && s.resolve(m[1] as "c" | "refs", m[2]!);
        if (!file) return reply(404, { error: "Not found." });
        // Reference uploads get unique names and never change.
        if (m[1] === "refs") res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        const { readFile } = await import("node:fs/promises");
        const body = await readFile(file).catch(() => undefined);
        if (!body) return reply(404, { error: "Not found." });
        res.setHeader("Content-Type", s.mime(file));
        return res.end(body);
      }
      if (req.method !== "POST") return reply(405, { error: "GET or POST is required." });
      const type = req.headers["content-type"]?.split(";")[0] || "";
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 30_000_000) return reply(413, { error: "The UI Maker request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks);
      if (operation === "ref") {
        if (!IMAGE_TYPES[type]) return reply(415, { error: "Only PNG, JPEG, WebP and GIF images can be references." });
        return reply(200, await s.saveRef(type, raw));
      }
      if (type !== "application/json") return reply(415, { error: "JSON is required." });
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      if (operation === "state") return reply(200, await s.snapshot());
      if (operation === "versions") return reply(200, { versions: await s.allVersions() });
      if (operation === "save") {
        s.saveState(body.state);
        return reply(200, { ok: true });
      }
      if (operation === "component") return reply(200, await s.createFolder(String(body.name || "component")));
      if (operation === "brief") {
        const out = await s.brief(String(body.c), Number(body.v));
        return reply(200, { dir: out.dir, brief: out.brief, next: out.next, warnings: out.warnings });
      }
      // Lab: the editor picks; starting rounds and writing variants
      // are here too so tests and other local tools can drive the same service.
      if (operation === "lab-pick") return reply(200, await s.labPick(String(body.c), String(body.variant), body.round ? String(body.round) : undefined));
      if (operation === "lab-start")
        return reply(200, await s.labStart(String(body.c), String(body.title || ""), body.kind === "new" ? "new" : "redesign"));
      if (operation === "lab-write") return reply(200, await s.labWrite(String(body.c), body));
      if (operation === "size")
        return reply(200, await s.setSize(String(body.c), { width: body.width, height: body.height === "auto" ? null : body.height }));
      return reply(404, { error: "Unknown UI Maker operation." });
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : "UI Maker could not complete that." });
    }
  };
  const close = () => {
    for (const stream of streams.values()) stream.stop();
    streams.clear();
    for (const s of services.values()) void s.close();
    services.clear();
  };
  return {
    name: "orvane-local-uimaker",
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
