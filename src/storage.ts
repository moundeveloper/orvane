import Dexie from "dexie";
import { parseWorkspace } from "./validation";
import { emptyWorkspace, type Workspace } from "./model";
export const LEGACY_STORAGE = "orvane.workspace.v1";
interface Snapshot {
  id?: number;
  data: Workspace;
  reason: string;
  at: number;
}
class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const clone = (value: Workspace): Workspace =>
  JSON.parse(JSON.stringify(value));

// Browser storage is read only for migration and recovery, never dual-written.
async function browserData(): Promise<{
  data?: Workspace;
  preferences: string[];
}> {
  const db = new Dexie("orvane");
  db.version(1).stores({
    workspace: "id",
    snapshots: "++id,at",
    preferences: "id",
  });
  try {
    const previous = await db.table("workspace").get("current");
    const raw = localStorage.getItem(LEGACY_STORAGE);
    const data = previous?.data ?? (raw ? JSON.parse(raw) : undefined);
    const preferences = (await db.table("preferences").toArray())
      .filter((p) => p.value)
      .map((p) => String(p.id));
    return {
      data: data === undefined ? undefined : parseWorkspace(data),
      preferences,
    };
  } finally {
    db.close();
  }
}

export class WorkspaceStorage {
  writer = false;
  conflicted = false;
  private client = crypto.randomUUID();
  private revision = 0;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closingData?: Workspace;
  private owned?: () => Promise<void>;
  private preferences = new Set<string>();
  constructor(private changed: () => void | Promise<void>) {}
  private async request<T>(
    route: string,
    method = "GET",
    body?: object,
  ): Promise<T> {
    const json =
      body === undefined
        ? undefined
        : JSON.stringify({ ...body, client: this.client });
    const response = await fetch(`/__orvane/storage/${route}`, {
      method,
      cache: "no-store",
      headers: json ? { "Content-Type": "application/json" } : undefined,
      body: json,
      keepalive:
        json !== undefined && new TextEncoder().encode(json).length < 60_000,
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new RequestError(
        503,
        "The local SQLite backend is unavailable. Start Orvane with pnpm dev or pnpm preview.",
      );
    }
    if (!response.ok)
      throw new RequestError(
        response.status,
        result.error || "The local database request failed.",
      );
    return result as T;
  }
  private async tick() {
    if (this.closed || this.ticking || this.conflicted) return;
    this.ticking = true;
    try {
      const lease = await this.request<{ owned: boolean }>("lease", "POST", {});
      if (this.closed) {
        if (lease.owned) this.release();
        return;
      }
      if (this.writer && !lease.owned) {
        this.writer = false;
        this.conflicted = true;
        await this.changed();
        return;
      }
      if (!this.writer && lease.owned) {
        this.writer = true;
        this.preferences = new Set(
          (await this.request<{ keys: string[] }>("preferences")).keys,
        );
        await this.owned?.();
      } else if (!this.writer) {
        const { revision } = await this.request<{ revision: number }>(
          "revision",
        );
        if (revision !== this.revision) await this.changed();
      }
    } finally {
      this.ticking = false;
    }
  }
  async start(owned: () => Promise<void>) {
    this.owned = owned;
    await this.tick();
    this.timer = setInterval(
      () =>
        void this.tick().catch(() => {
          /* Retain unsaved in-memory work; writes report failures. */
        }),
      1000,
    );
  }
  async read() {
    const result = await this.request<{
      data: Workspace | null;
      revision: number;
    }>("state");
    this.revision = Math.max(this.revision, result.revision);
    return result.data === null ? undefined : parseWorkspace(result.data);
  }
  async browserWorkspace() {
    return (await browserData()).data;
  }
  async initialize(): Promise<Workspace> {
    this.assertWriter();
    const current = await this.read();
    if (current) return current;
    const legacy = await browserData();
    const data = legacy.data || emptyWorkspace();
    await this.write(
      data,
      legacy.data ? "Before browser storage migration" : undefined,
    );
    for (const id of legacy.preferences) await this.learn(id);
    return data;
  }
  assertWriter() {
    if (!this.writer || this.conflicted || this.closed)
      throw Error(
        "This browser is read-only. Editing is active in another browser or tab.",
      );
  }
  write(data: Workspace, reason?: string, snapshotBase?: Workspace) {
    const clean = parseWorkspace(clone(data));
    this.closingData = reason ? undefined : clean;
    const base = snapshotBase ? parseWorkspace(clone(snapshotBase)) : undefined;
    const operation = this.queue.then(async () => {
      this.assertWriter();
      try {
        const result = await this.request<{ revision: number }>(
          "state",
          "PUT",
          {
            data: clean,
            expectedRevision: this.revision,
            reason,
            snapshotBase: base,
          },
        );
        this.revision = result.revision;
      } catch (error) {
        if (
          error instanceof RequestError &&
          [409, 423].includes(error.status)
        ) {
          this.writer = false;
          this.conflicted = true;
          await this.changed();
        }
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async latestSnapshot() {
    return (await this.request<Snapshot | null>("snapshot")) || undefined;
  }
  async learned(id: string) {
    return this.preferences.has(id);
  }
  async learn(id: string) {
    this.assertWriter();
    await this.request(`preference/${encodeURIComponent(id)}`, "POST", {});
    this.preferences.add(id);
  }
  private release() {
    const payload = {
      client: this.client,
      data: this.conflicted ? undefined : this.closingData,
      expectedRevision: this.revision,
    };
    const body = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });
    // Browsers cap keepalive payloads. Large workspaces still release their lease;
    // ordinary autosaving handles their data before a tab is closed.
    const release =
      body.size < 60_000
        ? body
        : new Blob([JSON.stringify({ client: this.client })], {
            type: "application/json",
          });
    if (!navigator.sendBeacon("/__orvane/storage/release", release))
      void this.request("release", "POST", {}).catch(() => {});
  }
  async close() {
    if (this.closed) return;
    clearInterval(this.timer);
    this.closed = true;
    if (this.writer) this.release();
    this.writer = false;
  }
}
