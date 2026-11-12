import { readdir, open, stat, realpath } from "node:fs/promises";
import { createReadStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import Database from "better-sqlite3";
import {
  expositionSchema,
  expositionPartSchema,
  type ClaudeSession,
  type ClaudeMessage,
  type VisualRecord,
} from "../src/exposition.ts";
import { z } from "zod";

const keySchema = z.string().min(1).max(1000);
const readSchema = z.object({
  key: keySchema,
  before: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(60),
});
export const visualTargetSchema = z.object({
  sessionId: z.string().min(1).max(200),
  projectPath: z.string().min(1).max(2000),
});
export const visualShowSchema = visualTargetSchema.extend({
  anchorId: z.string().min(1).max(300).optional(),
  expectedRevision: z.number().int().nonnegative().default(0),
  view: expositionSchema,
});
export const visualUpdateSchema = visualTargetSchema.extend({
  id: z.string().min(1).max(200),
  expectedRevision: z.number().int().positive(),
  title: z.string().min(1).max(2000).optional(),
  summary: z.string().max(2000).optional(),
  parts: z.array(expositionPartSchema).min(1).max(12).optional(),
});
type Cache = {
  offset: number;
  size: number;
  mtime: number;
  ino: number;
  messages: ClaudeMessage[];
  ids: Set<string>;
  warnings: Set<string>;
  pending?: Promise<void>;
};
const canonical = (p: string) =>
  process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
export class ClaudeSessions {
  private files = new Map<string, { path: string; info: ClaudeSession }>();
  private cache = new Map<string, Cache>();
  private indexedAt = 0;
  private indexing?: Promise<void>;
  private db: Database.Database;
  readonly root: string;
  constructor(
    directory: string,
    root = process.env.ORVANE_CLAUDE_PROJECTS_DIR ||
      join(
        process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
        "projects",
      ),
    database = "claude-visuals.sqlite",
  ) {
    this.root = resolve(root);
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, database));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS claude_visuals (session_key TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, anchor_id TEXT, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(session_key,id))",
    );
  }
  private async allowed(path: string) {
    const [root, target] = await Promise.all([
      realpath(this.root),
      realpath(path),
    ]);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw Error("Session path is outside the Claude transcript directory.");
    return target;
  }
  async list() {
    if (!this.indexedAt || Date.now() - this.indexedAt > 3000) {
      this.indexing ||= this.index().finally(() => {
        this.indexing = undefined;
      });
      await this.indexing;
    }
    return [...this.files.values()]
      .map((f) => f.info)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private async index() {
    const next = new Map<string, { path: string; info: ClaudeSession }>();
    let folders;
    try {
      folders = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.files.clear();
        this.indexedAt = Date.now();
        return;
      }
      throw error;
    }
    for (const folder of folders) {
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
      const path = join(this.root, folder.name);
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (
          !entry.isFile() ||
          !entry.name.endsWith(".jsonl") ||
          entry.isSymbolicLink()
        )
          continue;
        const file = join(path, entry.name),
          key = Buffer.from(`${folder.name}/${entry.name}`).toString(
            "base64url",
          );
        try {
          await this.allowed(file);
          const info = await stat(file),
            existing = this.files.get(key);
          if (
            existing?.info.bytes === info.size &&
            existing.info.updatedAt === info.mtimeMs
          ) {
            next.set(key, existing);
            continue;
          }
          const handle = await open(file, "r");
          let head: string, tail: string;
          try {
            const length = Math.min(info.size, 96 * 1024),
              a = Buffer.alloc(length),
              b = Buffer.alloc(Math.min(info.size, 32 * 1024));
            await handle.read(a, 0, a.length, 0);
            await handle.read(
              b,
              0,
              b.length,
              Math.max(0, info.size - b.length),
            );
            head = a.toString("utf8");
            tail = b.toString("utf8");
          } finally {
            await handle.close();
          }
          let title = existing?.info.title || "",
            project = existing?.info.project || folder.name,
            sessionId = entry.name.slice(0, -6);
          for (const line of head.split("\n")) {
            try {
              const d = JSON.parse(line);
              if (typeof d.sessionId === "string") sessionId = d.sessionId;
              if (typeof d.cwd === "string") project = d.cwd;
              if (!title && d.type === "user") {
                const t = this.text(d.message?.content);
                if (t && !t.startsWith("<"))
                  title = t.replace(/\s+/g, " ").slice(0, 140);
              }
            } catch {}
          }
          for (const line of tail.split("\n")) {
            try {
              const d = JSON.parse(line);
              if (
                d.type === "custom-title" &&
                typeof d.customTitle === "string"
              )
                title = d.customTitle.slice(0, 140);
            } catch {}
          }
          next.set(key, {
            path: file,
            info: {
              key,
              sessionId,
              title: title || "Untitled Claude session",
              project,
              updatedAt: info.mtimeMs,
              bytes: info.size,
            },
          });
        } catch {
          /* A rotating/deleted/unreadable session does not hide the others. */
        }
      }
    }
    this.files = next;
    this.indexedAt = Date.now();
    for (const key of this.cache.keys())
      if (!next.has(key)) this.cache.delete(key);
  }
  private text(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  private record(line: string, offset: number, cache: Cache) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      cache.warnings.add(
        "An incomplete or malformed transcript record was skipped.",
      );
      return;
    }
    if (
      !d ||
      typeof d !== "object" ||
      !["user", "assistant"].includes(d.type) ||
      !d.message ||
      d.isSidechain
    )
      return;
    const content = d.message.content,
      text = this.text(content),
      tools: ClaudeMessage["tools"] = [];
    if (Array.isArray(content))
      for (const b of content)
        if (
          b?.type === "tool_use" &&
          typeof b.id === "string" &&
          typeof b.name === "string"
        )
          tools.push({
            id: b.id,
            name: b.name,
            ...(b.name.endsWith("exposition_show") &&
            typeof b.input?.view?.id === "string"
              ? { visualId: b.input.view.id }
              : {}),
          });
    if (!text && !tools.length) return;
    const id = typeof d.uuid === "string" ? d.uuid : `record-${offset}`;
    if (cache.ids.has(id)) return;
    cache.ids.add(id);
    cache.messages.push({
      id,
      role: d.type,
      text: text.slice(0, 30000),
      at: typeof d.timestamp === "string" ? d.timestamp : "",
      tools,
      truncated: text.length > 30000,
    });
    if (cache.messages.length > 2000) {
      const old = cache.messages.shift()!;
      cache.ids.delete(old.id);
      cache.warnings.add(
        "Showing the latest 2,000 transcript messages. The original file is unchanged.",
      );
    }
  }
  private async refresh(key: string) {
    await this.list();
    const file = this.files.get(key);
    if (!file) throw Error("Session not found. Refresh the session list.");
    const path = await this.allowed(file.path),
      info = await stat(path);
    let c = this.cache.get(key);
    if (
      !c ||
      info.ino !== c.ino ||
      info.size < c.offset ||
      (info.size === c.size && info.mtimeMs !== c.mtime)
    ) {
      c = {
        offset: 0,
        size: 0,
        mtime: 0,
        ino: info.ino,
        messages: [],
        ids: new Set(),
        warnings: new Set(),
      };
      this.cache.set(key, c);
    }
    if (c.pending) {
      await c.pending;
      return c;
    }
    const cache = c;
    // Bounded read caches; selecting many sessions must not retain every chat.
    this.cache.delete(key);
    this.cache.set(key, cache);
    if (this.cache.size > 8)
      for (const [older, entry] of this.cache) {
        if (older !== key && !entry.pending) {
          this.cache.delete(older);
          break;
        }
      }
    cache.pending = (async () => {
      let pending = Buffer.alloc(0),
        dropping = false,
        position = cache.offset;
      // Read a snapshot, and only commit complete newline-terminated records.
      if (info.size > cache.offset)
        for await (const raw of createReadStream(path, {
          start: cache.offset,
          end: info.size - 1,
          highWaterMark: 64 * 1024,
        })) {
          const chunk = Buffer.from(raw);
          let from = 0;
          for (let i = 0; i < chunk.length; i++)
            if (chunk[i] === 10) {
              const segment = chunk.subarray(from, i);
              if (!dropping) {
                if (pending.length + segment.length <= 1_048_576)
                  this.record(
                    Buffer.concat([pending, segment]).toString("utf8"),
                    position,
                    cache,
                  );
                else
                  cache.warnings.add(
                    "Oversized transcript records were skipped; tool output and embedded images are not imported.",
                  );
              }
              position += pending.length + segment.length + 1;
              pending = Buffer.alloc(0);
              dropping = false;
              from = i + 1;
              cache.offset = position;
            }
          const rest = chunk.subarray(from);
          if (!dropping && pending.length + rest.length <= 1_048_576)
            pending = Buffer.concat([pending, rest]);
          else {
            position += pending.length + rest.length;
            pending = Buffer.alloc(0);
            dropping = true;
            cache.warnings.add(
              "Oversized transcript records were skipped; tool output and embedded images are not imported.",
            );
          }
        }
      cache.size = info.size;
      cache.mtime = info.mtimeMs;
    })().finally(() => {
      cache.pending = undefined;
    });
    await cache.pending;
    return cache;
  }
  async read(args: unknown) {
    const { key, before, limit } = readSchema.parse(args),
      cache = await this.refresh(key);
    const end = before
      ? cache.messages.findIndex((m) => m.id === before)
      : cache.messages.length;
    if (end < 0)
      throw Error("Older messages are no longer cached. Reopen the session.");
    const start = Math.max(0, end - limit);
    return {
      session: this.files.get(key)!.info,
      messages: cache.messages.slice(start, end),
      before: start ? cache.messages[start]!.id : null,
      warnings: [...cache.warnings],
      visuals: this.visuals(key),
    };
  }
  visuals(key: string): VisualRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM claude_visuals WHERE session_key = ? ORDER BY updated_at",
        )
        .all(key) as {
        session_key: string;
        data: string;
        anchor_id: string | null;
        revision: number;
        updated_at: number;
      }[]
    ).map((r) => ({
      view: expositionSchema.parse(JSON.parse(r.data)),
      sessionKey: r.session_key,
      anchorId: r.anchor_id,
      revision: r.revision,
      updatedAt: r.updated_at,
    }));
  }
  private async target(args: z.infer<typeof visualTargetSchema>) {
    const matches = (await this.list()).filter(
      (s) =>
        s.sessionId === args.sessionId &&
        canonical(s.project) === canonical(args.projectPath),
    );
    if (matches.length !== 1)
      throw Error(
        "Provide the exact Claude session ID and project path from the Orvane session context. Never guess the most recent session.",
      );
    return matches[0]!;
  }
  async show(raw: unknown) {
    const args = visualShowSchema.parse(raw),
      session = await this.target(args),
      cache = await this.refresh(session.key);
    if (
      args.anchorId &&
      !cache.ids.has(args.anchorId) &&
      !cache.messages.some((m) => m.tools.some((t) => t.id === args.anchorId))
    )
      throw Error(
        "Anchor does not belong to the selected session’s cached messages.",
      );
    return this.write(
      session.key,
      args.view,
      args.expectedRevision,
      args.anchorId,
    );
  }
  async update(raw: unknown) {
    const args = visualUpdateSchema.parse(raw),
      session = await this.target(args),
      old = this.visuals(session.key).find((v) => v.view.id === args.id);
    if (!old) throw Error("Explanation not found in this session.");
    const view = expositionSchema.parse({
      ...old.view,
      ...(args.title ? { title: args.title } : {}),
      ...(args.summary !== undefined ? { summary: args.summary } : {}),
      parts: args.parts
        ? old.view.parts
            .map((p) => args.parts!.find((n) => n.id === p.id) || p)
            .concat(
              args.parts.filter(
                (p) => !old.view.parts.some((o) => o.id === p.id),
              ),
            )
        : old.view.parts,
    });
    return this.write(
      session.key,
      view,
      args.expectedRevision,
      old.anchorId || undefined,
    );
  }
  private write(
    sessionKey: string,
    view: z.infer<typeof expositionSchema>,
    expected: number,
    anchorId?: string,
  ) {
    if (Buffer.byteLength(JSON.stringify(view)) > 100_000)
      throw Error("Keep an explanation below 100 KB.");
    return this.db
      .transaction(() => {
        const old = this.db
          .prepare(
            "SELECT revision,anchor_id FROM claude_visuals WHERE session_key=? AND id=?",
          )
          .get(sessionKey, view.id) as
          { revision: number; anchor_id: string | null } | undefined;
        if ((old?.revision || 0) !== expected)
          throw Error(
            `Explanation changed. Current revision: ${old?.revision || 0}. Read it before updating.`,
          );
        const revision = expected + 1,
          updatedAt = Date.now(),
          anchor = anchorId || old?.anchor_id || null;
        this.db
          .prepare(
            "INSERT INTO claude_visuals VALUES (?,?,?,?,?,?) ON CONFLICT(session_key,id) DO UPDATE SET data=excluded.data,anchor_id=excluded.anchor_id,revision=excluded.revision,updated_at=excluded.updated_at",
          )
          .run(
            sessionKey,
            view.id,
            JSON.stringify(view),
            anchor,
            revision,
            updatedAt,
          );
        return { id: view.id, sessionKey, revision, updatedAt };
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
