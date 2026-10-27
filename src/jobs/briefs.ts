import { db, saveMessage, type User } from "../db/supabase.js";
import { formatMoney } from "../invoice/pdf.js";
import { logger, maskId } from "../log.js";
import { sendText } from "../telegram/send.js";
import { describeWhen, fromLagos, nextOccurrence, toLagos, type Repeat } from "../time.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A brief can go out up to this long after its time, in case the server was asleep. */
const WINDOW_MS = 3 * HOUR_MS;
const EVENING = "21:00";
const WEEKLY = { weekday: 0, time: "18:00" }; // Sunday evening

type Kind = "morning" | "evening" | "weekly";

interface Slot {
  text: string;
  at: Date;
}

interface ReminderLite {
  text: string;
  due_at: string;
  repeat: Repeat | null;
}

/** Every time a reminder fires between two moments, repeats included. */
export function occurrences(r: ReminderLite, from: Date, to: Date): Slot[] {
  const out: Slot[] = [];
  let t: Date | null = new Date(r.due_at);
  for (let i = 0; t && t.getTime() < to.getTime() && i < 100; i++) {
    if (t.getTime() >= from.getTime()) out.push({ text: r.text, at: t });
    t = r.repeat ? nextOccurrence(r.repeat, t, t) : null;
  }
  return out;
}

/** Start of the Lagos day that contains `date`. */
const lagosDayStart = (date: Date) => fromLagos(`${toLagos(date).slice(0, 10)}T00:00`)!;
const lagosDate = (date: Date) => toLagos(date).slice(0, 10);
const timeOf = (date: Date) => describeWhen(date, date).replace(/^today, /, "");

function dayHeading(date: Date): string {
  const local = new Date(date.getTime() + HOUR_MS);
  return local.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}

async function slotsBetween(userId: string, from: Date, to: Date): Promise<Slot[]> {
  const { data, error } = await db.from("reminders").select("text, due_at, repeat").eq("user_id", userId).eq("status", "active").lt("due_at", to.toISOString());
  if (error) throw new Error(`slotsBetween: ${error.message}`);
  return ((data ?? []) as ReminderLite[]).flatMap((r) => occurrences(r, from, to)).sort((a, b) => a.at.getTime() - b.at.getTime());
}

async function moneyLine(userId: string): Promise<string> {
  const { data } = await db.from("invoices").select("total, currency").eq("user_id", userId).eq("status", "unpaid").not("sent_at", "is", null);
  if (!data?.length) return "";
  const total = data.reduce((sum, i) => sum + Number(i.total), 0);
  return `*Money:* ${data.length} unpaid invoice${data.length > 1 ? "s" : ""}, ${formatMoney(total, data[0].currency)} owed to you.`;
}

const list = (slots: Slot[], max: number) =>
  slots
    .slice(0, max)
    .map((s) => `- ${timeOf(s.at)} ${s.text}`)
    .join("\n") + (slots.length > max ? `\n- and ${slots.length - max} more` : "");

/** The morning brief: today's reminders, the next few days, and money owed. */
export async function morningBrief(user: User, now: Date): Promise<string> {
  const today = lagosDayStart(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const [todaySlots, soon, money] = await Promise.all([
    slotsBetween(user.id, now, tomorrow),
    slotsBetween(user.id, tomorrow, new Date(today.getTime() + 4 * DAY_MS)),
    moneyLine(user.id),
  ]);
  const name = user.preferred_name ? `, ${user.preferred_name}` : "";
  const parts = [`Good morning${name}. Here's your ${dayHeading(now)}.`];
  parts.push(todaySlots.length ? `*Today*\n${list(todaySlots, 10)}` : "Nothing on your list for today.");
  if (soon.length) parts.push(`*Coming up*\n${soon.slice(0, 5).map((s) => `- ${describeWhen(s.at, now)}: ${s.text}`).join("\n")}`);
  if (money) parts.push(money);
  parts.push("Tell me anything you need to remember today.");
  return parts.join("\n\n");
}

/** The evening check: what is on tomorrow. Nothing is sent when tomorrow is empty. */
export async function eveningBrief(user: User, now: Date): Promise<string | null> {
  const tomorrow = new Date(lagosDayStart(now).getTime() + DAY_MS);
  const slots = await slotsBetween(user.id, tomorrow, new Date(tomorrow.getTime() + DAY_MS));
  if (!slots.length) return null;
  return `Evening check. Tomorrow, ${dayHeading(tomorrow)}:\n${list(slots, 10)}\n\nAnything else to add for tomorrow? Just tell me.`;
}

/** The weekly summary on Sunday evening: the week ahead, day by day. Nothing is sent for an empty week. */
export async function weeklyBrief(user: User, now: Date): Promise<string | null> {
  const start = new Date(lagosDayStart(now).getTime() + DAY_MS);
  const [slots, money] = await Promise.all([slotsBetween(user.id, start, new Date(start.getTime() + 7 * DAY_MS)), moneyLine(user.id)]);
  if (!slots.length && !money) return null;
  const days = new Map<string, Slot[]>();
  for (const s of slots) days.set(lagosDate(s.at), [...(days.get(lagosDate(s.at)) ?? []), s]);
  const week = [...days.values()].map((d) => `*${dayHeading(d[0].at)}*\n${list(d, 6)}`);
  const parts = ["Your week ahead.", ...(week.length ? week : ["No reminders set for the week."])];
  if (money) parts.push(money);
  return parts.join("\n\n");
}

/** Which brief, if any, is due for this user right now. */
export function dueBriefs(briefTime: string, now: Date): { kind: Kind; day: string }[] {
  const day = lagosDate(now);
  const due: { kind: Kind; day: string }[] = [];
  const inWindow = (hhmm: string) => {
    const at = fromLagos(`${day}T${hhmm}`)!;
    return now.getTime() >= at.getTime() && now.getTime() < at.getTime() + WINDOW_MS;
  };
  if (inWindow(briefTime)) due.push({ kind: "morning", day });
  if (inWindow(EVENING)) due.push({ kind: "evening", day });
  const weekday = new Date(now.getTime() + HOUR_MS).getUTCDay();
  if (weekday === WEEKLY.weekday && inWindow(WEEKLY.time)) due.push({ kind: "weekly", day });
  return due;
}

const BUILDERS: Record<Kind, (user: User, now: Date) => Promise<string | null>> = {
  morning: morningBrief,
  evening: eveningBrief,
  weekly: weeklyBrief,
};

/** Sends briefs that are due. Called from the per-minute tick. Each brief is claimed before it is built. */
export async function runBriefs(now = new Date()): Promise<number> {
  const { data: users, error } = await db
    .from("users")
    .select("id, chat_id, name, business_name, preferred_name, types, features, brief_time, onboarding_step, onboarded_at")
    .not("brief_time", "is", null)
    .limit(5000);
  if (error) throw new Error(`runBriefs: ${error.message}`);

  const { data: already } = await db.from("briefs_sent").select("user_id, kind").eq("day", lagosDate(now));
  const done = new Set((already ?? []).map((b) => `${b.user_id}:${b.kind}`));

  let sent = 0;
  for (const user of (users ?? []) as User[]) {
    for (const { kind, day } of dueBriefs(user.brief_time!, now)) {
      if (done.has(`${user.id}:${kind}`)) continue;
      // The primary key makes this insert fail when the brief already went out today.
      const { error: claimError } = await db.from("briefs_sent").insert({ user_id: user.id, kind, day });
      if (claimError) continue;
      try {
        const text = await BUILDERS[kind](user, now);
        if (!text) continue;
        const outId = await sendText(user.chat_id, text);
        await saveMessage(user.id, "out", "text", text, outId);
        sent++;
        logger.info({ user: maskId(user.chat_id), kind }, "brief sent");
      } catch (err) {
        logger.error({ err, kind }, "brief failed");
      }
    }
  }
  return sent;
}
