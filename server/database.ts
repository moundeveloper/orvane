import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseWorkspace } from "../src/validation.ts";
import type { Workspace } from "../src/model.ts";

export class StorageError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const LEASE_MS = 15_000;
export class LocalDatabase {
  private db: Database.Database;
  readonly sqlite: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.sqlite = (
      this.db.prepare("SELECT sqlite_version() AS version").get() as {
        version: string;
      }
    ).version;
    const version = this.sqlite.split(".").map(Number);
    if (
      version[0]! < 3 ||
      (version[0] === 3 &&
        (version[1]! < 53 || (version[1] === 53 && version[2]! < 4)))
    ) {
      this.db.close();
      throw Error(
        "SQLite 3.53.4 or newer is required. Update the embedded driver.",
      );
    }
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("trusted_schema = OFF");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, data TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (id TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS git_workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS app_data (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes_records (collection TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,key));
    `);
    const columns = this.db.pragma("table_info(workspace)") as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "last_writer"))
      this.db.exec(
        "ALTER TABLE workspace ADD COLUMN last_writer TEXT NOT NULL DEFAULT ''",
      );
  }
  revision() {
    return (
      (
        this.db.prepare("SELECT revision FROM workspace WHERE id = 1").get() as
          { revision: number } | undefined
      )?.revision || 0
    );
  }
  appData(key: string): unknown {
    const row = this.db
      .prepare("SELECT data FROM app_data WHERE key = ?")
      .get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  notesData(
    collection: string,
    action: string,
    key?: string,
    rows: Record<string, unknown>[] = [],
    pageId?: string,
  ) {
    const list = () =>
      this.db
        .prepare("SELECT data FROM notes_records WHERE collection=?")
        .all(collection)
        .map((row) => JSON.parse((row as { data: string }).data));
    if (action === "list")
      return pageId ? list().filter((row) => row.pageId === pageId) : list();
    if (action === "get") {
      const row = this.db
        .prepare("SELECT data FROM notes_records WHERE collection=? AND key=?")
        .get(collection, key) as { data: string } | undefined;
      return row ? JSON.parse(row.data) : null;
    }
    return this.db.transaction(() => {
      if (action === "delete")
        this.db
          .prepare("DELETE FROM notes_records WHERE collection=? AND key=?")
          .run(collection, key);
      if (action === "deletePage" || action === "replaceBlocks")
        this.db
          .prepare(
            "DELETE FROM notes_records WHERE collection='blocks' AND json_extract(data,'$.pageId')=?",
          )
          .run(pageId);
      if (
        ["put", "add", "bulkPut", "bulkAdd", "replaceBlocks"].includes(action)
      ) {
        const statement = this.db.prepare(
          `INSERT INTO notes_records(collection,key,data) VALUES(?,?,?) ${["add", "bulkAdd"].includes(action) ? "" : "ON CONFLICT(collection,key) DO UPDATE SET data=excluded.data"}`,
        );
        for (const row of rows) {
          const rowKey = collection === "settings" ? row.key : row.id;
          if (typeof rowKey !== "string" || !rowKey)
            throw Error("A stable note record ID is required.");
          if (action === "replaceBlocks" && row.pageId !== pageId)
            throw Error("Block page IDs must match.");
          statement.run(collection, rowKey, JSON.stringify(row));
        }
      }
      return { saved: true };
    })();
  }
  saveAppData(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO app_data (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data",
      )
      .run(key, JSON.stringify(value));
  }
  editingActive() {
    const row = this.db
      .prepare("SELECT expires FROM lease WHERE id=1")
      .get() as { expires: number } | undefined;
    return !!row && row.expires > Date.now();
  }
  gitWorkspaces() {
    return this.db
      .prepare(
        "SELECT id, name, path FROM git_workspaces ORDER BY name COLLATE NOCASE",
      )
      .all() as { id: string; name: string; path: string }[];
  }
  registerGitWorkspace(id: string, name: string, path: string) {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO git_workspaces (id, name, path, path_key) VALUES (?, ?, ?, ?)",
      )
      .run(id, name, path, key);
    return this.db
      .prepare("SELECT id, name, path FROM git_workspaces WHERE path_key = ?")
      .get(key) as { id: string; name: string; path: string };
  }
  renameGitWorkspace(id: string, name: string) {
    this.db
      .prepare("UPDATE git_workspaces SET name = ? WHERE id = ?")
      .run(name, id);
  }
  removeGitWorkspace(id: string) {
    this.db.prepare("DELETE FROM git_workspaces WHERE id = ?").run(id);
  }
  read() {
    const row = this.db
      .prepare("SELECT data, revision FROM workspace WHERE id = 1")
      .get() as { data: string; revision: number } | undefined;
    return {
      data: row ? parseWorkspace(JSON.parse(row.data)) : null,
      revision: row?.revision || 0,
      sqlite: this.sqlite,
    };
  }
  acquire(owner: string) {
    return this.db
      .transaction(() => {
        const now = Date.now();
        const row = this.db
          .prepare("SELECT owner, expires FROM lease WHERE id = 1")
          .get() as { owner: string; expires: number } | undefined;
        if (row && row.owner !== owner && row.expires > now)
          return { owned: false, expires: row.expires };
        this.db
          .prepare(
            "INSERT INTO lease VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires",
          )
          .run(owner, now + LEASE_MS);
        return { owned: true, expires: now + LEASE_MS };
      })
      .immediate();
  }
  release(owner: string, draft?: unknown, expected?: number) {
    const clean = draft === undefined ? undefined : parseWorkspace(draft);
    this.db
      .transaction(() => {
        const lease = this.db
          .prepare("SELECT owner, expires FROM lease WHERE id = 1")
          .get() as { owner: string; expires: number } | undefined;
        if (lease?.owner !== owner) return;
        if (clean && lease.expires > Date.now()) {
          const row = this.db
            .prepare(
              "SELECT data, revision, last_writer FROM workspace WHERE id = 1",
            )
            .get() as
            { data: string; revision: number; last_writer: string } | undefined;
          // A final beacon may overtake this same client's pending autosaves. It
          // must never overwrite a revision written by a different owner.
          if (
            row &&
            (row.revision === expected || row.last_writer === owner) &&
            row.data !== JSON.stringify(clean)
          )
            this.write(owner, row.revision, clean);
        }
        this.db
          .prepare("DELETE FROM lease WHERE id = 1 AND owner = ?")
          .run(owner);
      })
      .immediate();
  }
  private assertOwner(owner: string) {
    const row = this.db
      .prepare("SELECT owner, expires FROM lease WHERE id = 1")
      .get() as { owner: string; expires: number } | undefined;
    if (!row || row.owner !== owner || row.expires <= Date.now())
      throw new StorageError(
        423,
        "Another browser owns editing, or this editing session expired. Export unsaved work before reloading.",
      );
  }
  write(
    owner: string,
    expected: number,
    input: unknown,
    reason?: string,
    base?: unknown,
  ) {
    const data = parseWorkspace(input);
    const recovery = base === undefined ? undefined : parseWorkspace(base);
    return this.db
      .transaction(() => {
        this.assertOwner(owner);
        const previous = this.read();
        if (previous.revision !== expected)
          throw new StorageError(
            409,
            "The saved workspace changed. Export unsaved work before reloading; it was not overwritten.",
          );
        if (reason)
          this.db
            .prepare(
              "INSERT INTO snapshots (data, reason, at) VALUES (?, ?, ?)",
            )
            .run(
              JSON.stringify(recovery || previous.data || data),
              reason,
              Date.now(),
            );
        const revision = previous.revision + 1;
        this.db
          .prepare(
            "INSERT INTO workspace (id, data, revision, last_writer) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, revision=excluded.revision, last_writer=excluded.last_writer",
          )
          .run(JSON.stringify(data), revision, owner);
        this.db
          .prepare(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 5)",
          )
          .run();
        return { revision };
      })
      .immediate();
  }
  snapshot() {
    const row = this.db
      .prepare(
        "SELECT id, data, reason, at FROM snapshots ORDER BY id DESC LIMIT 1",
      )
      .get() as
      { id: number; data: string; reason: string; at: number } | undefined;
    return row ? { ...row, data: parseWorkspace(JSON.parse(row.data)) } : null;
  }
  learned(id: string) {
    return !!this.db
      .prepare("SELECT value FROM preferences WHERE id = ?")
      .get(id);
  }
  learnedKeys() {
    return (
      this.db.prepare("SELECT id FROM preferences WHERE value = 1").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
  }
  learn(owner: string, id: string) {
    this.db
      .transaction(() => {
        this.assertOwner(owner);
        this.db
          .prepare("INSERT OR REPLACE INTO preferences VALUES (?, 1)")
          .run(id);
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
