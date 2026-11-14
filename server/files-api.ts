import type { Plugin, Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createFilesService } from "./files.ts";
import { IMAGE_MIME } from "./images.ts";

const MEDIA_MIME: Record<string, string> = {
  ...IMAGE_MIME,
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
  pdf: "application/pdf",
};

function local(req: IncomingMessage) {
  const host = req.headers.host || "",
    protocol = "encrypted" in req.socket ? "https" : "http";
  return (
    /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) &&
    (!req.headers.origin || req.headers.origin === `${protocol}://${host}`) &&
    req.headers["sec-fetch-site"] !== "cross-site" &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")
  );
}
// Streams a file with HTTP Range support, which video seeking needs.
async function send(req: IncomingMessage, res: ServerResponse, path: string, type: string, cache: string) {
  const info = await stat(path);
  if (!info.isFile()) throw Object.assign(new Error("Not a file."), { status: 404 });
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", cache);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // An SVG opened on its own must not run script with this origin's
  // privileges. (PDFs need the browser's viewer, which a sandbox disables.)
  if (type === "image/svg+xml")
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  let start = 0,
    end = info.size - 1;
  if (range && info.size) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else if (range[2]) start = Math.max(0, info.size - Number(range[2]));
    if (start > end || start >= info.size) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${info.size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
  }
  res.setHeader("Content-Length", String(info.size ? end - start + 1 : 0));
  if (req.method === "HEAD" || !info.size) return res.end();
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

// File Explorer HTTP API: /__orvane/files/<operation>, POST JSON only, and
// only from a same-origin page on this machine (like the Projects Hub API).
// GET /__orvane/files/raw?path=…&t=<token> streams a file for peek; GET
// /__orvane/files/image/<id> serves an image widget's stored picture.
export function filesApi(directory: string): Plugin {
  const service = createFilesService(directory);
  const tokenBytes = Buffer.from(service.token);
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith("/__orvane/files/")) return next();
    res.removeHeader("Access-Control-Allow-Origin");
    const reply = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    };
    if (!local(req)) return reply(403, { error: "Local, same-origin access is required." });
    const url = new URL(req.url, "http://localhost");
    const operation = url.pathname.slice("/__orvane/files/".length);
    if (req.method === "GET" || req.method === "HEAD") {
      try {
        if (operation === "raw") {
          const given = Buffer.from(url.searchParams.get("t") ?? "");
          if (given.length !== tokenBytes.length || !timingSafeEqual(given, tokenBytes))
            return reply(403, { error: "A valid token is required." });
          const path = service.resolve(url.searchParams.get("path"));
          const type = MEDIA_MIME[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
          return await send(req, res, path, type, "no-store");
        }
        if (operation.startsWith("image/")) {
          const id = decodeURIComponent(operation.slice("image/".length));
          const file = service.images.file(id);
          if (!file) return reply(404, { error: "Unknown image." });
          // Content-addressed, so it never changes.
          return await send(req, res, file, IMAGE_MIME[extname(id).slice(1)]!, "private, max-age=31536000, immutable");
        }
      } catch (error) {
        if (res.headersSent) return res.destroy();
        const status = (error as { status?: number }).status ?? ((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400);
        return reply(status, { error: error instanceof Error ? error.message : "Read failed." });
      }
      return reply(405, { error: "POST is required." });
    }
    if (req.method !== "POST") return reply(405, { error: "POST is required." });
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      return reply(415, { error: "JSON is required." });
    if (!/^[a-z][a-z-]*$/.test(operation)) return reply(404, { error: "Unknown File Explorer operation." });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        // Room for a dropped image (as a data URL) or a saved text file.
        if (length > 45_000_000) return reply(413, { error: "The request is too large." });
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
