// Scheduled prompts: agent prompts that start a new session on a schedule.
// Kept in the workspace database (covered by backups) and run by the local
// server, so they fire while Orvane is open or in the tray even when no
// Agent sessions app is on the canvas. Schedules use src/triggers.ts.
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { LocalDatabase } from "./database.ts";
import {
  agentBusy,
  type AgentRun,
  type AgentSchedule,
} from "../src/agentSessions.ts";
import {
  latestOccurrence,
  triggerDue,
  type TriggerSchedule,
} from "../src/triggers.ts";

const KEY = "agent-schedules";
const LIMIT = 100;

export const scheduleInput = z.object({
  id: z.uuid().optional(),
  prompt: z
    .string()
    .max(12_000)
    .refine((text) => !!text.trim(), "Write the prompt."),
  provider: z.enum(["claude", "codex"]),
  /** The Claude account the prompt runs on; the API fills in the New chats account. */
  profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/).optional(),
  folder: z
    .string()
    .min(1, "Choose a project folder.")
    .max(2000)
    .refine((path) => isAbsolute(path), "Choose an absolute project folder."),
  model: z
    .string()
    .max(150)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
    .optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  mode: z.enum(["ask", "auto", "plan", "full"]).optional(),
  schedule: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("interval"),
      minutes: z.number().int().min(1).max(10080),
    }),
    z.object({
      kind: z.literal("daily"),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    }),
  ]),
  enabled: z.boolean().optional(),
});

type Start = (
  target: {
    provider: "claude" | "codex";
    /** Pinned account; a removed or unknown one fails the run, never falls back. */
    profileId?: string;
    folder: string;
    model?: string;
    effort?: AgentSchedule["effort"];
    mode?: AgentSchedule["mode"];
  },
  message: string,
) => Promise<AgentRun>;

export class AgentSchedules {
  private db?: LocalDatabase;
  private running = new Set<string>();
  constructor(
    private file: string,
    private start: Start,
    private inspect: (id: string) => AgentRun | null,
  ) {}
  private database() {
    return (this.db ||= new LocalDatabase(this.file));
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
  private read(): AgentSchedule[] {
    const saved = this.database().appData(KEY) as
      { schedules?: AgentSchedule[] } | undefined;
    const schedules = saved?.schedules ?? [];
    // Claude schedules saved before accounts existed ran on the inherited
    // setup, which is the Default account: pin them to it (stored migration).
    let migrated = false;
    for (const item of schedules)
      if (item.provider === "claude" && !item.profileId) {
        item.profileId = "default";
        migrated = true;
      }
    if (migrated) this.write(schedules);
    return schedules;
  }
  /** Names of the prompts pinned to one Claude account. */
  usingProfile(profileId: string) {
    return this.read()
      .filter((item) => item.provider === "claude" && item.profileId === profileId)
      .map((item) => item.prompt.replace(/\s+/g, " ").slice(0, 40));
  }
  private write(schedules: AgentSchedule[]) {
    this.database().saveAppData(KEY, { schedules });
    return schedules;
  }
  /** The list, with the outcome of runs that ended since the last look. */
  list() {
    const schedules = this.read();
    let changed = false;
    for (const item of schedules) {
      if (!item.lastRunId || item.lastStatus) continue;
      const run = this.inspect(item.lastRunId);
      if (run && agentBusy(run)) continue;
      changed = true;
      if (!run) {
        // Orvane restarted while it ran: the outcome is in its session.
        item.lastStatus = "stopped";
        continue;
      }
      item.lastStatus = run.status;
      if (run.sessionId) {
        item.lastSessionId = run.sessionId;
        item.lastSessionProvider = run.provider;
        if (run.provider === "claude") item.lastSessionProfileId = run.profileId ?? "default";
        else delete item.lastSessionProfileId;
      }
      if (run.error) item.lastError = run.error.slice(0, 2000);
      else delete item.lastError;
    }
    return changed ? this.write(schedules) : schedules;
  }
  save(raw: unknown) {
    const input = scheduleInput.parse(raw);
    const schedules = this.list();
    const existing = input.id
      ? schedules.find((item) => item.id === input.id)
      : undefined;
    if (input.id && !existing)
      throw Error("That scheduled prompt no longer exists.");
    if (!existing && schedules.length >= LIMIT)
      throw Error(`Orvane keeps at most ${LIMIT} scheduled prompts.`);
    const schedule: TriggerSchedule =
      input.schedule.kind === "daily" &&
      input.schedule.days?.length &&
      input.schedule.days.length < 7
        ? { ...input.schedule, days: [...new Set(input.schedule.days)].sort() }
        : input.schedule.kind === "daily"
          ? { kind: "daily", time: input.schedule.time }
          : input.schedule;
    if (input.provider === "claude" && !input.profileId) throw Error("Choose a Claude account for this prompt.");
    const fields = {
      prompt: input.prompt.trim(),
      provider: input.provider,
      ...(input.provider === "claude" ? { profileId: input.profileId } : {}),
      folder: input.folder,
      schedule,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.mode && (input.provider === "claude" || input.mode !== "ask")
        ? { mode: input.mode }
        : {}),
    };
    if (existing) {
      // A new schedule counts again from now, as triggers do.
      if (JSON.stringify(existing.schedule) !== JSON.stringify(schedule)) {
        existing.createdAt = Date.now();
        delete existing.lastOccurrence;
      }
      for (const key of ["model", "effort", "mode", "profileId"] as const)
        delete existing[key];
      Object.assign(existing, fields);
      if (input.enabled !== undefined) existing.enabled = input.enabled;
    } else
      schedules.push({
        id: randomUUID(),
        ...fields,
        enabled: input.enabled ?? true,
        createdAt: Date.now(),
      });
    return this.write(schedules);
  }
  remove(id: string) {
    return this.write(this.list().filter((item) => item.id !== id));
  }
  setEnabled(id: string, enabled: boolean) {
    const schedules = this.list();
    const item = schedules.find((entry) => entry.id === id);
    if (!item) throw Error("That scheduled prompt no longer exists.");
    item.enabled = enabled;
    return this.write(schedules);
  }
  /** Run now, or as scheduled at `at`. Returns the new run. */
  async run(id: string, at = Date.now(), occurrence = at) {
    if (this.running.has(id)) throw Error("This prompt is already starting.");
    const item = this.list().find((entry) => entry.id === id);
    if (!item) throw Error("That scheduled prompt no longer exists.");
    const previous = item.lastRunId ? this.inspect(item.lastRunId) : null;
    if (previous && agentBusy(previous))
      throw Error("The last run of this prompt is still working.");
    this.running.add(id);
    const record = (
      patch: Partial<AgentSchedule>,
      clear: (keyof AgentSchedule)[],
    ) => {
      const schedules = this.read();
      const entry = schedules.find((candidate) => candidate.id === id);
      if (!entry) return;
      for (const key of clear) delete entry[key];
      Object.assign(entry, patch);
      this.write(schedules);
    };
    try {
      const run = await this.start(
        {
          provider: item.provider,
          ...(item.profileId ? { profileId: item.profileId } : {}),
          folder: item.folder,
          ...(item.model ? { model: item.model } : {}),
          ...(item.effort ? { effort: item.effort } : {}),
          ...(item.mode ? { mode: item.mode } : {}),
        },
        item.prompt,
      );
      record({ lastOccurrence: occurrence, lastRun: at, lastRunId: run.id }, [
        "lastStatus",
        "lastSessionId",
        "lastSessionProvider",
        "lastSessionProfileId",
        "lastError",
      ]);
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(
        {
          lastOccurrence: occurrence,
          lastRun: at,
          lastStatus: "failed",
          lastError: message.slice(0, 2000),
        },
        ["lastRunId", "lastSessionId", "lastSessionProvider"],
      );
      throw error;
    } finally {
      this.running.delete(id);
    }
  }
  /** Start what is due. Runs missed by more than a day are skipped quietly. */
  tick(now = Date.now()) {
    for (const item of this.list()) {
      if (this.running.has(item.id)) continue;
      const timing = { ...item, lastRun: item.lastOccurrence };
      const { due, stale } = triggerDue(timing, now);
      if (!due) continue;
      const at = latestOccurrence(timing, now)!;
      if (stale) {
        const schedules = this.read();
        const entry = schedules.find((candidate) => candidate.id === item.id);
        if (entry) entry.lastOccurrence = at;
        this.write(schedules);
      } else void this.run(item.id, now, at).catch(() => undefined);
    }
  }
}
