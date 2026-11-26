// Subscription limits for Claude Code and Codex: the 5-hour and weekly
// windows each CLI reports itself. Claude sends a rate_limit_event during a
// run (kept here, since it is written nowhere else); Codex writes rate_limits
// into its rollout files, read from the newest one. Nothing is sent anywhere
// to check usage: these are the last values the CLIs reported.
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { LocalDatabase } from "./database.ts";
import type { AgentUsage, AgentUsageWindow } from "../src/agentSessions.ts";

const KEY = "agent-usage";
const TAIL = 512 * 1024;

const percent = (value: unknown, scale: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value * scale)) : undefined;
const time = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
function windowOf(used: number | undefined, resetsAt: number | undefined): AgentUsageWindow | undefined {
  return used === undefined ? undefined : { used: Math.round(used), ...(resetsAt ? { resetsAt } : {}) };
}

/** Claude Code's stream-json rate_limit_event. */
export function claudeUsage(event: any, at = Date.now()): AgentUsage | undefined {
  const windows = event?.rate_limit_info?.unifiedWindows;
  if (!windows || typeof windows !== "object") return;
  const fiveHour = windowOf(percent(windows.five_hour?.utilization, 100), time(windows.five_hour?.resetsAt));
  const weekly = windowOf(percent(windows.seven_day?.utilization, 100), time(windows.seven_day?.resetsAt));
  if (!fiveHour && !weekly) return;
  return { at, ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}

/** A Codex rollout's rate_limits (primary/secondary by window length). */
export function codexUsage(limits: any, at: number): AgentUsage | undefined {
  if (!limits || typeof limits !== "object") return;
  const usage: AgentUsage = { at };
  for (const slot of [limits.primary, limits.secondary]) {
    const minutes = slot?.window_minutes;
    const entry = windowOf(percent(slot?.used_percent, 1), time(slot?.resets_at));
    if (!entry || typeof minutes !== "number") continue;
    if (minutes <= 24 * 60) usage.fiveHour = entry;
    else usage.weekly = entry;
  }
  return usage.fiveHour || usage.weekly ? usage : undefined;
}

/** The newest `.jsonl` under Codex's sessions folder (YYYY/MM/DD/…). */
async function newestRollout(folder: string, depth = 0): Promise<string | undefined> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  if (depth === 3) {
    const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name);
    if (!files.length) return;
    const times = await Promise.all(files.map(async (name) => [name, (await stat(join(folder, name))).mtimeMs] as const));
    return join(folder, times.sort((a, b) => b[1] - a[1])[0]![0]);
  }
  const dirs = entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name).sort().reverse();
  for (const dir of dirs) {
    const found = await newestRollout(join(folder, dir), depth + 1);
    if (found) return found;
  }
}

export async function readCodexUsage(sessions: string): Promise<AgentUsage | undefined> {
  const file = await newestRollout(sessions);
  if (!file) return;
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"rate_limits"')) continue;
      try {
        const record = JSON.parse(lines[i]!);
        const usage = codexUsage(record?.payload?.rate_limits, Date.parse(record?.timestamp) || Date.now());
        if (usage) return usage;
      } catch {
        // A line cut by the tail window.
      }
    }
  } finally {
    await handle.close();
  }
}

/** One account's last reported limits and the sign-in they were reported for. */
type ProfileUsage = { usage: AgentUsage; fingerprint: string };
type Saved = { claudeProfiles?: Record<string, ProfileUsage>; legacyClaudeUnknown?: boolean; [key: string]: unknown };

export class AgentUsageStore {
  private db?: LocalDatabase;
  constructor(private file: string) {}
  private database() {
    return (this.db ||= new LocalDatabase(this.file));
  }
  /**
   * The old provider-wide entry has no folder or account behind it, so it is
   * never shown as any account's usage: it becomes unknown until a run reports.
   */
  private read(): Saved {
    const saved = (this.database().appData(KEY) as Saved | undefined) ?? {};
    if ("claude" in saved) {
      delete saved.claude;
      saved.legacyClaudeUnknown = true;
      this.database().saveAppData(KEY, saved);
    }
    return saved;
  }
  claude(profileId: string): ProfileUsage | undefined {
    return this.read().claudeProfiles?.[profileId];
  }
  claudeAll(): Record<string, ProfileUsage> {
    return { ...this.read().claudeProfiles };
  }
  saveClaude(profileId: string, fingerprint: string, usage: AgentUsage) {
    const saved = this.read();
    this.database().saveAppData(KEY, { ...saved, claudeProfiles: { ...saved.claudeProfiles, [profileId]: { usage, fingerprint } } });
  }
  /** The account's sign-in or folder changed: its old limits no longer apply. */
  dropClaude(profileId: string) {
    const saved = this.read();
    if (!saved.claudeProfiles?.[profileId]) return;
    const next = { ...saved.claudeProfiles };
    delete next[profileId];
    this.database().saveAppData(KEY, { ...saved, claudeProfiles: next });
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
}
