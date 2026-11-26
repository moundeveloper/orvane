import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_THEME_MEDIA, THEME_MEDIA_TYPES } from "../src/workspaceTheme.ts";
import type { LocalDatabase } from "./database.ts";

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const supportedTypes: readonly string[] = [...THEME_MEDIA_TYPES.image, ...THEME_MEDIA_TYPES.video];

function matchesFormat(data: Buffer, mime: string) {
  const header = data.subarray(0, 12).toString("latin1");
  switch (mime) {
    case "image/jpeg": return header.startsWith("\xff\xd8\xff");
    case "image/png": return header.startsWith("\x89PNG\r\n\x1a\n");
    case "image/webp": return header.startsWith("RIFF") && header.slice(8) === "WEBP";
    case "image/avif": return header.slice(4, 8) === "ftyp" && /^(avif|avis)$/.test(header.slice(8));
    case "video/mp4": return header.slice(4, 8) === "ftyp";
    case "video/webm": return header.startsWith("\x1a\x45\xdf\xa3");
    default: return false;
  }
}

function mediaRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start < size && end >= start) return { start, end };
}

export async function themeMediaRequest(
  database: LocalDatabase,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  reply: (status: number, body: unknown) => void,
) {
  if (!uuid.test(id)) return reply(400, { error: "Invalid background file ID." });
  if (req.method === "GET") {
    const info = database.themeMediaInfo(id);
    if (!info) return reply(404, { error: "Background file is missing." });
    const range = req.headers.range ? mediaRange(req.headers.range, info.size) : undefined;
    if (req.headers.range && !range) {
      res.setHeader("Content-Range", `bytes */${info.size}`);
      return reply(416, { error: "Background file range is unavailable." });
    }
    const length = range ? range.end - range.start + 1 : info.size;
    const data = database.themeMediaBytes(id, range?.start ?? 0, length);
    res.writeHead(range ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Content-Type": info.mime,
      "Content-Length": length,
      "X-Content-Type-Options": "nosniff",
      ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` } : {}),
    });
    res.end(data);
    return;
  }
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });
  const owner = req.headers["x-orvane-editor"];
  if (typeof owner !== "string" || !uuid.test(owner))
    return reply(400, { error: "An editing session is required." });
  const mime = req.headers["content-type"];
  if (!mime || !supportedTypes.includes(mime))
    return reply(415, { error: "Choose a supported image or video file." });
  if (Number(req.headers["content-length"]) > MAX_THEME_MEDIA)
    return reply(413, { error: "Background files can be up to 30 MB." });
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_THEME_MEDIA) return reply(413, { error: "Background files can be up to 30 MB." });
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks, length);
  if (!matchesFormat(data, mime)) return reply(415, { error: "The file does not match its media format." });
  database.saveThemeMedia(owner, id, mime, data);
  reply(201, { id });
}
