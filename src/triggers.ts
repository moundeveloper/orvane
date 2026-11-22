// Scheduled triggers: run an Action-library workflow every N minutes or daily
// at a time. They are checked by the editing window together with calendar
// reminders, so they keep running while Orvane sits in the tray (hidden
// windows check about once a minute) and never run twice for one workspace.
// A run missed while Orvane was closed runs once if it was due in the last
// day; older ones are skipped, like reminders.

export type TriggerSchedule =
  | { kind: "interval"; minutes: number }
  /** time is local "HH:MM"; days are 0 (Sunday) to 6, all days when empty. */
  | { kind: "daily"; time: string; days?: number[] };
export interface Trigger {
  id: string;
  name: string;
  workflowId: string;
  inputs: Record<string, string>;
  enabled: boolean;
  schedule: TriggerSchedule;
  /** When it was created; the first interval counts from here. */
  createdAt: number;
  lastRun?: number;
  lastError?: string;
}

export const MISSED_TRIGGER_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
type TriggerTiming = Pick<Trigger, "schedule" | "createdAt" | "lastRun" | "enabled">;

/** The latest scheduled moment at or before now, or null if none yet. */
export function latestOccurrence(trigger: TriggerTiming, now: number): number | null {
  const s = trigger.schedule;
  if (s.kind === "interval") {
    const every = s.minutes * MINUTE;
    const base = trigger.lastRun ?? trigger.createdAt;
    if (now < base + every) return null;
    return base + Math.floor((now - base) / every) * every;
  }
  const [hours, minutes] = s.time.split(":").map(Number) as [number, number];
  const day = new Date(now);
  for (let back = 0; back < 8; back++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() - back, hours, minutes);
    if (at.getTime() > now) continue;
    if (!s.days?.length || s.days.includes(at.getDay())) return at.getTime();
  }
  return null;
}

/** Whether the trigger should run now, and whether the due run is too old. */
export function triggerDue(trigger: TriggerTiming, now: number) {
  if (!trigger.enabled) return { due: false, stale: false };
  const at = latestOccurrence(trigger, now);
  if (at === null || at <= (trigger.lastRun ?? trigger.createdAt))
    return { due: false, stale: false };
  return { due: true, stale: now - at >= MISSED_TRIGGER_MS };
}

/** The next scheduled moment after now (for display), or null if paused. */
export function nextOccurrence(trigger: TriggerTiming, now: number): number | null {
  if (!trigger.enabled) return null;
  const s = trigger.schedule;
  if (s.kind === "interval") {
    const every = s.minutes * MINUTE;
    const base = trigger.lastRun ?? trigger.createdAt;
    return base + Math.max(1, Math.floor((now - base) / every) + 1) * every;
  }
  const [hours, minutes] = s.time.split(":").map(Number) as [number, number];
  const day = new Date(now);
  for (let ahead = 0; ahead < 8; ahead++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + ahead, hours, minutes);
    if (at.getTime() <= now) continue;
    if (!s.days?.length || s.days.includes(at.getDay())) return at.getTime();
  }
  return null;
}

/** Plain description, e.g. "Every 15 minutes" or "Mon, Wed at 09:00". */
export function describeSchedule(s: TriggerSchedule) {
  if (s.kind === "interval")
    return s.minutes % 60 === 0 && s.minutes >= 60
      ? `Every ${s.minutes / 60 === 1 ? "hour" : `${s.minutes / 60} hours`}`
      : `Every ${s.minutes === 1 ? "minute" : `${s.minutes} minutes`}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = s.days?.length && s.days.length < 7 ? [...s.days].sort().map((d) => names[d]).join(", ") : "Daily";
  return `${days} at ${s.time}`;
}
