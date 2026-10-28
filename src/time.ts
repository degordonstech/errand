// Lagos is UTC+1 all year (no daylight saving), so local times convert with a fixed offset.
const OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Repeat {
  every: "day" | "week" | "month" | "year";
  /** Every n days, weeks or months. Defaults to 1. */
  interval?: number;
  /** For weekly repeats: ISO weekdays, 1 = Monday ... 7 = Sunday. */
  weekdays?: number[];
  /** Last date (Lagos) the reminder may fire, YYYY-MM-DD. */
  until?: string;
}

/** "2026-10-30T09:00" (Lagos wall clock) to an instant. Returns null when it cannot be read. */
export function fromLagos(local: string): Date | null {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi) - OFFSET_MS;
  const date = new Date(utc);
  // Reject impossible dates such as 31 February, which Date.UTC would quietly roll over.
  return toLagos(date).startsWith(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`) ? date : null;
}

/** An instant as Lagos wall clock, "YYYY-MM-DDTHH:MM". */
export function toLagos(date: Date): string {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 16);
}

/** ISO weekday in Lagos, 1 = Monday ... 7 = Sunday. */
function lagosWeekday(date: Date): number {
  return new Date(date.getTime() + OFFSET_MS).getUTCDay() || 7;
}

function addMonths(date: Date, months: number): Date {
  const local = new Date(date.getTime() + OFFSET_MS);
  const day = local.getUTCDate();
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, 1, local.getUTCHours(), local.getUTCMinutes()));
  // The 31st in a 30-day month becomes the 30th, not the 1st of the next month.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return new Date(target.getTime() - OFFSET_MS);
}

/** The first time after `after` that a repeating reminder first due at `from` fires, or null once it has ended. */
export function nextOccurrence(repeat: Repeat, from: Date, after: Date): Date | null {
  const interval = Math.max(1, repeat.interval ?? 1);
  const end = repeat.until ? fromLagos(`${repeat.until}T23:59`) : null;
  let next = from;
  // A reminder missed for months still lands on the right slot, without looping forever.
  for (let i = 0; i < 2000 && next.getTime() <= after.getTime(); i++) {
    if (repeat.every === "day") next = new Date(next.getTime() + interval * DAY_MS);
    else if (repeat.every === "month") next = addMonths(next, interval);
    else if (repeat.every === "year") next = addMonths(next, 12 * interval);
    else if (repeat.weekdays?.length) {
      do next = new Date(next.getTime() + DAY_MS);
      while (!repeat.weekdays.includes(lagosWeekday(next)));
    } else next = new Date(next.getTime() + interval * 7 * DAY_MS);
  }
  if (next.getTime() <= after.getTime()) return null;
  return end && next.getTime() > end.getTime() ? null : next;
}

/**
 * When a new reminder should first fire. A weekly repeat starts on its first listed weekday,
 * and a repeating reminder whose start has passed moves to its next slot.
 */
export function firstOccurrence(when: Date, repeat: Repeat | null | undefined, now: Date): Date | null {
  if (!repeat) return when.getTime() > now.getTime() ? when : null;
  let t: Date | null = when;
  if (repeat.every === "week" && repeat.weekdays?.length && !repeat.weekdays.includes(lagosWeekday(t))) t = nextOccurrence(repeat, t, t);
  if (t && t.getTime() <= now.getTime()) t = nextOccurrence(repeat, t, now);
  return t;
}

/** "Thu 30 Oct, 9:00am", or "today, 9:00am" and "tomorrow, 9:00am" when close. */
export function describeWhen(date: Date, now = new Date()): string {
  const local = new Date(date.getTime() + OFFSET_MS);
  const h = local.getUTCHours();
  const time = `${h % 12 || 12}:${String(local.getUTCMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  const dayOf = (d: Date) => Math.floor((d.getTime() + OFFSET_MS) / DAY_MS);
  const diff = dayOf(date) - dayOf(now);
  if (diff === 0) return `today, ${time}`;
  if (diff === 1) return `tomorrow, ${time}`;
  const day = local.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return `${day.replace(",", "")}, ${time}`;
}

export function describeRepeat(repeat: Repeat | null | undefined): string {
  if (!repeat) return "";
  const n = Math.max(1, repeat.interval ?? 1);
  const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let s: string;
  if (repeat.every === "week" && repeat.weekdays?.length) {
    const days = [...repeat.weekdays].sort();
    s = days.join(",") === "1,2,3,4,5" ? "every weekday" : `every ${days.map((d) => names[d]).join(", ")}`;
  } else s = n === 1 ? `every ${repeat.every}` : `every ${n} ${repeat.every}s`;
  return repeat.until ? `${s} until ${repeat.until}` : s;
}

/** Every time a reminder fires between two moments, repeats included. */
export function occurrences<R extends { text: string; due_at: string; repeat: Repeat | null }>(r: R, from: Date, to: Date): { text: string; at: Date }[] {
  const out: { text: string; at: Date }[] = [];
  let t: Date | null = new Date(r.due_at);
  for (let i = 0; t && t.getTime() < to.getTime() && i < 100; i++) {
    if (t.getTime() >= from.getTime()) out.push({ text: r.text, at: t });
    t = r.repeat ? nextOccurrence(r.repeat, t, t) : null;
  }
  return out;
}
