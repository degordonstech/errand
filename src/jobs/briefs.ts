import { meta, SPARK_MAX_TOKENS } from "../ai/client.js";
import { config } from "../config.js";
import { db, saveMessage, type User } from "../db/supabase.js";
import { formatMoney } from "../invoice/pdf.js";
import { logger, maskId } from "../log.js";
import { sendText } from "../telegram/send.js";
import { cleanReply } from "../text.js";
import { describeWhen, fromLagos, occurrences, toLagos, type Repeat } from "../time.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A brief can go out up to this long after its time, in case the server was asleep. */
const WINDOW_MS = 3 * HOUR_MS;
const EVENING = "21:00";
const WEEKLY = { weekday: 0, time: "18:00" }; // Sunday evening

type Kind = "morning" | "evening" | "weekly";

type Slot = { text: string; at: Date; source?: string };

interface ReminderLite {
  text: string;
  due_at: string;
  repeat: Repeat | null;
  source?: string;
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
  const { data, error } = await db.from("reminders").select("text, due_at, repeat, source").eq("user_id", userId).eq("status", "active").lt("due_at", to.toISOString());
  if (error) throw new Error(`slotsBetween: ${error.message}`);
  return ((data ?? []) as ReminderLite[])
    .flatMap((r) => occurrences(r, from, to).map((o) => ({ ...o, source: r.source })))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
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

/** Lists MyPaddy keeps that a brief should mention: open to-dos, goals and the study log. */
async function listsFor(userId: string): Promise<{ todo: string[]; logs: { name: string; items: string[] }[] }> {
  const { data } = await db.from("lists").select("name, items").eq("user_id", userId);
  const rows = (data ?? []) as { name: string; items: string[] }[];
  return {
    todo: rows.find((l) => l.name === "to-do")?.items ?? [],
    logs: rows.filter((l) => l.name === "study log" || l.name.startsWith("goal")).map((l) => ({ name: l.name, items: l.items.slice(-7) })),
  };
}

/** Exams and events that happened yesterday, so the greeting can ask how they went. */
async function yesterdayEvents(userId: string, now: Date): Promise<string[]> {
  const today = lagosDayStart(now);
  const { data } = await db
    .from("reminders")
    .select("text, last_sent_at")
    .eq("user_id", userId)
    .in("source", ["exams", "event"])
    .gte("last_sent_at", new Date(today.getTime() - DAY_MS).toISOString())
    .lt("last_sent_at", today.toISOString());
  return [...new Set((data ?? []).map((r) => r.text))].slice(0, 5);
}

/** What the user has said lately, so the brief can match their language and pick up threads. */
async function recentWords(userId: string): Promise<string[]> {
  const { data } = await db.from("messages").select("text").eq("user_id", userId).eq("direction", "in").order("created_at", { ascending: false }).limit(10);
  return (data ?? []).map((m) => String(m.text ?? "").slice(0, 160)).filter((t) => t && !t.startsWith("["));
}

const BRIEF_STYLE: Record<Kind, string> = {
  morning:
    "Write their morning greeting. Greet them by name, then today's things with their times, then what is coming up soon. " +
    "If something happened yesterday (an exam, a test, an event), ask how it went. Mention one or two open to-do items. " +
    "End with one short encouraging line tied to what is ahead of them.",
  evening:
    "Write their evening check-in. Ask briefly how today went, check on one or two open to-do items, then list what is on tomorrow with times. " +
    "End with one short line, warm, like a friend saying goodnight.",
  weekly:
    "Write their Sunday evening summary. Say how their week went from the logs (how many days they studied or kept a goal, honest and kind), " +
    "then the week ahead day by day with times, then any money owed. End with one line of encouragement for the week.",
};

/**
 * Turns the facts into a message that sounds like a friend, in the user's own language.
 * The facts are the only source: if the model fails, the plain version goes out instead.
 */
async function warmly(kind: Kind, user: User, facts: string, plain: string): Promise<string> {
  try {
    const words = await recentWords(user.id);
    const res = await meta.chat.completions.create({
      model: config.MUSE_SPARK_MODEL,
      max_tokens: SPARK_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content:
            "You are MyPaddy, a warm, upbeat friend in the user's Telegram who keeps track of their life. " +
            `${BRIEF_STYLE[kind]} Use only the facts given: never invent a task, time, person or amount. ` +
            "Write in the language they use with you: if their recent messages are in Nigerian Pidgin, write in simple Pidgin; otherwise plain English. " +
            "Each item comes with the time its reminder fires; when the item's own text gives the real time of a class, exam or event, show only that real time, once, in am or pm. " +
            "Short lines, under 140 words. *bold* is fine for one or two headings. No emoji, no long dashes, no # headings.",
        },
        {
          role: "user",
          content:
            `Their name: ${user.preferred_name ?? user.name ?? "friend"}.\nAbout them: ${user.types.join(", ") || "not given"}.\n` +
            `Things they said lately:\n${words.map((w) => `- ${w}`).join("\n") || "- nothing yet"}\n\nFacts:\n${facts}`,
        },
      ],
    });
    const text = cleanReply(res.choices[0]?.message?.content ?? "");
    return text.length >= 40 ? text : plain;
  } catch (err) {
    logger.warn({ err, kind }, "warm brief failed, sending the plain one");
    return plain;
  }
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

/** "Exam in 3 days" and "exam tomorrow" are countdowns: they only make sense on the day they fire. */
const COUNTDOWN = /\b(tomorrow|in \d+ days?|today)\b/i;

/**
 * The exams and events ahead, each on its real date. Only the reminder sent on the day itself
 * ("CSC 201 exam today at 9:00am") carries that date, so those are the ones used.
 */
export function eventsAhead(slots: Slot[], now: Date): string[] {
  return slots
    .filter((s) => (s.source === "exams" || s.source === "event") && /\btoday\b/i.test(s.text))
    .map((s) => `${dayHeading(s.at)}: ${s.text.replace(/\s*\btoday\b\s*/i, " ").replace(/\s+/g, " ").trim()}`)
    .filter((line, i, all) => all.indexOf(line) === i)
    .slice(0, 6);
}

/** Leaves out countdown reminders, which would read wrongly away from the day they fire. */
const notCountdown = (s: Slot) => !((s.source === "exams" || s.source === "event") && COUNTDOWN.test(s.text));
// Each item gives the reminder time and its text. A class or exam text carries its own real time, which is the one to show.
const slotLine = (slots: Slot[], max: number) => (slots.length ? slots.slice(0, max).map((s) => `"${s.text}" (reminder at ${timeOf(s.at)})`).join("; ") : "nothing set");

/** The morning brief: today's reminders, the next few days, open to-dos, yesterday, and money owed. */
export async function morningBrief(user: User, now: Date): Promise<string> {
  const today = lagosDayStart(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const [todayAll, soonAll, money, lists, yesterday] = await Promise.all([
    slotsBetween(user.id, now, tomorrow),
    slotsBetween(user.id, tomorrow, new Date(today.getTime() + 8 * DAY_MS)),
    moneyLine(user.id),
    listsFor(user.id),
    yesterdayEvents(user.id, now),
  ]);
  // Today's countdowns are fine to show ("CSC 201 exam today at 9:00am"); later ones are replaced by real dates.
  const todaySlots = todayAll;
  const ahead = eventsAhead(soonAll, now);
  const soon = soonAll.filter((s) => s.at.getTime() < today.getTime() + 4 * DAY_MS && notCountdown(s));
  const name = user.preferred_name ? `, ${user.preferred_name}` : "";
  const parts = [`Good morning${name}. Here's your ${dayHeading(now)}.`];
  parts.push(todaySlots.length ? `*Today*\n${list(todaySlots, 10)}` : "Nothing on your list for today.");
  if (soon.length) parts.push(`*Coming up*\n${soon.slice(0, 5).map((s) => `- ${describeWhen(s.at, now)}: ${s.text}`).join("\n")}`);
  if (ahead.length) parts.push(`*Exams and events*\n${bullets(ahead)}`);
  if (lists.todo.length) parts.push(`*Still on your to-do list*\n${bullets(lists.todo.slice(0, 5))}`);
  if (money) parts.push(money);
  parts.push("Tell me anything you need to remember today.");

  const facts = [
    `Today is ${dayHeading(now)}.`,
    `Today: ${slotLine(todaySlots, 10)}.`,
    `Next few days: ${soon.length ? soon.slice(0, 5).map((s) => `"${s.text}" (reminder ${describeWhen(s.at, now)})`).join("; ") : "nothing set"}.`,
    `Exams and events ahead, on their real dates: ${ahead.join("; ") || "none set"}.`,
    `Yesterday they had: ${yesterday.join("; ") || "nothing recorded"}.`,
    `Open to-do items: ${lists.todo.slice(0, 5).join("; ") || "none"}.`,
    money ? money.replace(/\*/g, "") : "No money owed to them.",
  ].join("\n");
  return warmly("morning", user, facts, parts.join("\n\n"));
}

/** The evening check: how today went, open to-dos and tomorrow. Nothing is sent when there is nothing to say. */
export async function eveningBrief(user: User, now: Date): Promise<string | null> {
  const tomorrow = new Date(lagosDayStart(now).getTime() + DAY_MS);
  const [slots, lists] = await Promise.all([slotsBetween(user.id, tomorrow, new Date(tomorrow.getTime() + DAY_MS)), listsFor(user.id)]);
  if (!slots.length && !lists.todo.length) return null;
  const plain = [
    "Evening check.",
    lists.todo.length ? `Still on your to-do list:\n${bullets(lists.todo.slice(0, 5))}` : "",
    slots.length ? `Tomorrow, ${dayHeading(tomorrow)}:\n${list(slots, 10)}` : "",
    "Anything else to add for tomorrow? Just tell me.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const facts = [`Tomorrow is ${dayHeading(tomorrow)}: ${slotLine(slots, 10)}.`, `Open to-do items: ${lists.todo.slice(0, 5).join("; ") || "none"}.`].join("\n");
  return warmly("evening", user, facts, plain);
}

/** The weekly summary on Sunday evening: how the week went and the week ahead. Nothing is sent for an empty week. */
export async function weeklyBrief(user: User, now: Date): Promise<string | null> {
  const start = new Date(lagosDayStart(now).getTime() + DAY_MS);
  const [slots, money, lists] = await Promise.all([
    slotsBetween(user.id, start, new Date(start.getTime() + 7 * DAY_MS)),
    moneyLine(user.id),
    listsFor(user.id),
  ]);
  if (!slots.length && !money && !lists.logs.length) return null;
  const days = new Map<string, Slot[]>();
  for (const s of slots) days.set(lagosDate(s.at), [...(days.get(lagosDate(s.at)) ?? []), s]);
  const week = [...days.values()].map((d) => `*${dayHeading(d[0].at)}*\n${list(d, 6)}`);
  const parts = ["Your week ahead.", ...(week.length ? week : ["No reminders set for the week."])];
  if (money) parts.push(money);
  const facts = [
    `Logs from the past week: ${lists.logs.map((l) => `${l.name}: ${l.items.join("; ") || "nothing logged"}`).join(" | ") || "none kept"}.`,
    `Week ahead: ${[...days.values()].map((d) => `${dayHeading(d[0].at)}: ${slotLine(d, 6)}`).join(" | ") || "nothing set"}.`,
    money ? money.replace(/\*/g, "") : "No money owed to them.",
  ].join("\n");
  return warmly("weekly", user, facts, parts.join("\n\n"));
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
      // Someone who sets up at 8am does not want "Good morning" a minute later; the first brief comes tomorrow.
      if (kind === "morning" && user.onboarded_at && new Date(user.onboarded_at) > fromLagos(`${day}T${user.brief_time}`)!) continue;
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
