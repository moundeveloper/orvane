import { join, resolve } from "node:path";
import type { Plugin, Connect } from "vite";
import { LocalDatabase, StorageError } from "./database.ts";

// Only fixed application operations are exposed. No SQL, filenames, or arbitrary
// filesystem access comes from the browser. Test namespaces are disabled normally.
export function localStorageApi(directory: string): Plugin {
  const databases = new Map<string, LocalDatabase>();
  let testing = false;
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    const path = req.url?.split("?")[0] || "";
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (
      /\.sqlite(?:-wal|-shm)?$/i.test(decodedPath) ||
      decodedPath.includes("/.orvane/")
    ) {
      res.statusCode = 403;
      res.end("Database files are private.");
      return;
    }
    if (!path.startsWith("/__orvane/storage/")) return next();
    res.removeHeader("Access-Control-Allow-Origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    const host = req.headers.host || "",
      origin = req.headers.origin;
    const protocol = "encrypted" in req.socket ? "https" : "http";
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
      (origin && origin !== `${protocol}://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress || "",
      )
    )
      return reply(403, { error: "Local, same-origin access is required." });
    if (!["GET", "POST", "PUT"].includes(req.method || ""))
      return reply(405, { error: "Method not allowed." });
    const testCookie = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("orvane-test-workspace="))
      ?.slice("orvane-test-workspace=".length);
    const namespace = testing
      ? req.headers["x-orvane-test-workspace"] || testCookie
      : "workspace";
    if (
      typeof namespace !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(namespace)
    )
      return reply(400, {
        error: "A valid isolated test workspace is required.",
      });
    try {
      let database = databases.get(namespace);
      if (!database) {
        database = new LocalDatabase(
          join(
            directory,
            testing ? `tests/${namespace}.sqlite` : "workspace.sqlite",
          ),
        );
        databases.set(namespace, database);
      }
      const route = path.slice("/__orvane/storage/".length);
      if (req.method === "GET") {
        if (route === "preferences")
          return reply(200, { keys: database.learnedKeys() });
        if (route === "state") return reply(200, database.read());
        if (route === "revision")
          return reply(200, { revision: database.revision() });
        if (route === "snapshot") return reply(200, database.snapshot());
        if (route.startsWith("preference/"))
          return reply(200, {
            value: database.learned(decodeURIComponent(route.slice(11))),
          });
        return reply(404, { error: "Unknown storage operation." });
      }
      if (req.headers["content-type"]?.split(";")[0] !== "application/json")
        return reply(415, { error: "JSON is required." });
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 52_000_000)
          return reply(413, { error: "The storage request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body.client !== "string" ||
        !/^[\da-f-]{36}$/i.test(body.client)
      )
        return reply(400, { error: "An editing session is required." });
      if (route === "lease" && req.method === "POST")
        return reply(200, database.acquire(body.client));
      if (route === "release" && req.method === "POST") {
        database.release(
          body.client,
          body.data,
          Number.isSafeInteger(body.expectedRevision)
            ? body.expectedRevision
            : undefined,
        );
        return reply(200, { released: true });
      }
      if (route === "state" && req.method === "PUT") {
        if (
          !Number.isSafeInteger(body.expectedRevision) ||
          body.expectedRevision < 0 ||
          (body.reason !== undefined &&
            (typeof body.reason !== "string" || body.reason.length > 200))
        )
          return reply(400, {
            error: "A revision and valid snapshot reason are required.",
          });
        return reply(
          200,
          database.write(
            body.client,
            body.expectedRevision,
            body.data,
            body.reason,
            body.snapshotBase,
          ),
        );
      }
      if (route.startsWith("preference/") && req.method === "POST") {
        database.learn(body.client, decodeURIComponent(route.slice(11)));
        return reply(200, { saved: true });
      }
      reply(404, { error: "Unknown storage operation." });
    } catch (error) {
      const status =
        error instanceof StorageError
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : error instanceof Error && error.message.includes("workspace")
              ? 400
              : 503;
      reply(status, {
        error:
          error instanceof Error
            ? error.message
            : "The local database is unavailable. Existing files have been preserved.",
      });
    }
  };
  const close = () => {
    for (const db of databases.values()) db.close();
    databases.clear();
  };
  return {
    name: "orvane-local-sqlite",
    configResolved(config) {
      testing = config.mode === "test-storage";
      config.server.fs.deny.push(
        `${resolve(directory).replace(/\\/g, "/")}/**`,
        "**/*.sqlite",
        "**/*.sqlite-wal",
        "**/*.sqlite-shm",
      );
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
