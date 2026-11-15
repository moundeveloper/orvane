// Calendar app data: dated items, optionally at a time with a reminder.
// Saved as JSON in the calendar block's value, like other built-in apps.
export interface CalendarItem {
  id: string;
  title: string;
  /** Local day, YYYY-MM-DD. */
  date: string;
  /** Local time, HH:MM; items without one are all-day. */
  time?: string;
  /** Notify at `time` (needs a time). */
  remind?: boolean;
  done?: boolean;
  /** The reminder has been shown (or was skipped as too old). */
  notified?: boolean;
}
export interface CalendarData {
  items: CalendarItem[];
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
export function readCalendar(value: string): CalendarData {
  try {
    const data = JSON.parse(value || "{}");
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.filter(
        (item: CalendarItem) =>
          item &&
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          typeof item.date === "string" &&
          DAY.test(item.date) &&
          (item.time === undefined || TIME.test(item.time)),
      ),
    };
  } catch {
    return { items: [] };
  }
}
const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function parseDay(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}
/** When the item's reminder is due (local time), or null without a time. */
export function dueAt(item: CalendarItem) {
  if (!item.time) return null;
  const [h, min] = item.time.split(":").map(Number);
  const day = parseDay(item.date);
  day.setHours(h!, min!, 0, 0);
  return day.getTime();
}
/** Items sorted by day, then all-day first, then by time. */
export function sortItems(items: CalendarItem[]) {
  return [...items].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""),
  );
}
export function formatDay(key: string) {
  return parseDay(key).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** First day of the week for the user's locale (0 = Sunday; Monday when unknown). */
export const firstWeekday = (() => {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    return ((locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
})();
/** One-letter weekday names, starting at the locale's first day. */
export const weekdayLabels = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 7 + ((firstWeekday + i) % 7)).toLocaleDateString(undefined, { weekday: "narrow" }),
);
/** Six weeks of days covering `month` (any date in it). */
export function monthDays(month: Date) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  start.setDate(1 - ((start.getDay() - firstWeekday + 7) % 7));
  return Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return { key: dayKey(day), date: day.getDate(), outside: day.getMonth() !== month.getMonth() };
  });
}
export const monthName = (year: number, month: number, style: "long" | "short" = "long") =>
  new Date(year, month, 1).toLocaleDateString(undefined, { month: style });
