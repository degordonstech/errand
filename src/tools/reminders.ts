import { z } from "zod";
import { db } from "../db/supabase.js";
import { describeRepeat, describeWhen, firstOccurrence, fromLagos, occurrences, type Repeat } from "../time.js";
import { defineTool } from "./types.js";

/** Enough for timetables and bills, small enough that a runaway model cannot flood the table. */
const MAX_ACTIVE_PER_USER = 200;

export interface ReminderRow {
  id: string;
  user_id: string;
  text: string;
  due_at: string;
  repeat: Repeat | null;
  source: string;
  status: "active" | "sent" | "done" | "cancelled";
}

const whenSchema = z.string().describe('Lagos local time, "YYYY-MM-DDTHH:MM", for example 2026-10-30T09:00.');

const repeatSchema = z
  .object({
    every: z.enum(["day", "week", "month", "year"]),
    interval: z.number().int().min(1).max(12).optional().describe("Every n days, weeks, months or years. Defaults to 1."),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional().describe("For weekly repeats: 1 = Monday ... 7 = Sunday."),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last date it may fire, YYYY-MM-DD."),
  })
  .describe("Leave out for a one-off reminder.");

function parseWhen(when: string): Date {
  const date = fromLagos(when);
  if (!date) throw new Error(`Could not read the time "${when}". Use YYYY-MM-DDTHH:MM in Lagos time.`);
  return date;
}

async function getReminder(userId: string, id: string): Promise<ReminderRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That is not a reminder id. Use list_reminders to find it.");
  const { data, error } = await db.from("reminders").select().eq("user_id", userId).eq("id", id).maybeSingle();
  if (error) throw new Error(`getReminder: ${error.message}`);
  if (!data) throw new Error("There is no such reminder. Use list_reminders to find it.");
  return data as ReminderRow;
}

export function describeReminder(r: Pick<ReminderRow, "text" | "due_at" | "repeat">, now = new Date()): string {
  const repeat = describeRepeat(r.repeat);
  return `${r.text}: ${describeWhen(new Date(r.due_at), now)}${repeat ? ` (${repeat})` : ""}`;
}

/** Course codes ("csc 201") and longer words, to tell apart two reminders set for the same moment. */
const keyWords = (text: string) => new Set(text.toLowerCase().match(/[a-z]{2,4}\s?\d{3}|[a-z]{4,}/g)?.map((w) => w.replace(/\s/, "")) ?? []);

/**
 * True when an active reminder for the same moment says the same thing, for example
 * "CSC 201 exam in 3 days" against "CSC 201 - Computer Programming I exam in 3 days".
 */
export function isDuplicate(text: string, dueAt: string, existing: Pick<ReminderRow, "text" | "due_at">[]): boolean {
  const mine = keyWords(text);
  const code = [...mine].find((w) => /\d/.test(w));
  return existing.some((r) => {
    if (new Date(r.due_at).getTime() !== new Date(dueAt).getTime()) return false;
    const theirs = keyWords(r.text);
    if (code) return theirs.has(code);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    return shared >= Math.max(1, Math.min(mine.size, theirs.size) / 2);
  });
}

type Fixed = Pick<ReminderRow, "text" | "due_at" | "repeat">;

/** Classes, exams and events that fall within 90 minutes of a new reminder, so MyPaddy can point out a clash. */
export function findClashes(when: Date, fixed: Fixed[]): string[] {
  const window = 90 * 60 * 1000;
  const from = new Date(when.getTime() - window);
  const to = new Date(when.getTime() + window);
  return fixed.flatMap((r) => occurrences(r, from, to).map((o) => `${r.text} (reminder at ${describeWhen(o.at, when)})`));
}

async function activeReminders(userId: string): Promise<(ReminderRow & { source: string })[]> {
  const { data, error } = await db.from("reminders").select().eq("user_id", userId).eq("status", "active").limit(MAX_ACTIVE_PER_USER);
  if (error) throw new Error(`activeReminders: ${error.message}`);
  return (data ?? []) as ReminderRow[];
}

const FIXED_SOURCES = new Set(["timetable", "exams", "event"]);

const clashNote = (clashes: string[]) =>
  clashes.length ? ` It may clash with: ${clashes.slice(0, 3).join("; ")}. Point this out in one line and ask if they still want it at that time.` : "";

export const setReminder = defineTool({
  name: "set_reminder",
  description:
    "Set a reminder for the user, once or repeating. Work out the exact Lagos date and time from today's date. " +
    "Also use it, with picked_up_from_conversation, when the user mentions a plan with a date in passing.",
  sensitive: false,
  schema: z.object({
    text: z.string().min(1).max(300).describe("What to remind them about, in their words, short."),
    when: whenSchema.describe("First time it should fire, Lagos local time, YYYY-MM-DDTHH:MM."),
    repeat: repeatSchema.optional(),
    picked_up_from_conversation: z.boolean().optional().describe("True when the user did not ask for a reminder but mentioned a plan."),
  }),
  async run(args, { user }) {
    const now = new Date();
    const due = firstOccurrence(parseWhen(args.when), args.repeat ?? null, now);
    if (!due) throw new Error("That time has already passed. Ask the user when they want it.");

    const existing = await activeReminders(user.id);
    if (existing.length >= MAX_ACTIVE_PER_USER) throw new Error(`The user already has ${MAX_ACTIVE_PER_USER} active reminders. Ask them to cancel some first.`);
    if (isDuplicate(args.text, due.toISOString(), existing)) return { message: "That reminder is already set. Do not set it again; tell the user it is already there." };
    const clashes = findClashes(due, existing.filter((r) => FIXED_SOURCES.has(r.source)));

    const { data, error } = await db
      .from("reminders")
      .insert({
        user_id: user.id,
        text: args.text.trim(),
        due_at: due.toISOString(),
        repeat: args.repeat ?? null,
        source: args.picked_up_from_conversation ? "casual" : "user",
      })
      .select()
      .single();
    if (error) throw new Error(`set_reminder: ${error.message}`);
    const row = data as ReminderRow;
    return {
      message: `Reminder set: ${describeReminder(row, now)}.${args.picked_up_from_conversation ? " Tell the user in one line, and that they can say cancel." : ""}${clashNote(clashes)}`,
      data: { reminder_id: row.id },
    };
  },
});

export const setReminders = defineTool({
  name: "set_reminders",
  description:
    "Set many reminders in one go, from a timetable, an exam timetable, an invite, a flyer or a list of bills. " +
    "Read every row of the photo first. One item per class slot, exam reminder or event reminder.",
  sensitive: false,
  schema: z.object({
    source: z.enum(["timetable", "exams", "event", "bills", "other"]),
    items: z
      .array(
        z.object({
          text: z.string().min(1).max(300).describe('Short and specific, for example "CSC 201 in LT2 at 10:00".'),
          when: whenSchema,
          repeat: repeatSchema.optional(),
        }),
      )
      .min(1)
      .max(60),
  }),
  async run({ source, items }, { user }) {
    const now = new Date();
    const existing = await activeReminders(user.id);
    if (existing.length + items.length > MAX_ACTIVE_PER_USER) throw new Error(`That would pass the limit of ${MAX_ACTIVE_PER_USER} active reminders.`);

    const rows: { user_id: string; text: string; due_at: string; repeat: Repeat | null; source: string }[] = [];
    const skipped: string[] = [];
    let alreadySet = 0;
    for (const item of items) {
      const due = fromLagos(item.when) && firstOccurrence(fromLagos(item.when)!, item.repeat ?? null, now);
      if (due && isDuplicate(item.text, due.toISOString(), [...existing, ...rows])) alreadySet++;
      else if (due) rows.push({ user_id: user.id, text: item.text.trim(), due_at: due.toISOString(), repeat: item.repeat ?? null, source });
      else skipped.push(item.text);
    }
    if (rows.length) {
      const { error } = await db.from("reminders").insert(rows);
      if (error) throw new Error(`set_reminders: ${error.message}`);
    }
    const lines = rows.map((r) => `- ${describeReminder(r, now)}`).join("\n");
    // An event can clash with classes or exams. Classes against classes are left alone.
    const fixed = existing.filter((r) => FIXED_SOURCES.has(r.source) && r.source !== source);
    const clashes = source === "timetable" ? [] : [...new Set(rows.flatMap((r) => findClashes(new Date(r.due_at), fixed)))];
    return {
      message:
        `Set ${rows.length} reminders:\n${lines}` +
        clashNote(clashes) +
        (skipped.length ? `\nSkipped ${skipped.length} already in the past: ${skipped.join("; ")}.` : "") +
        (alreadySet ? `\n${alreadySet} were already set, so they were not added again.` : "") +
        "\nTell the user briefly what was set (group by day, do not list every line if there are many) and that they can change any of it.",
    };
  },
});

export const listReminders = defineTool({
  name: "list_reminders",
  description: "List the user's upcoming reminders with their ids. Use for 'what are my reminders' or to find one to change or cancel.",
  sensitive: false,
  schema: z.object({}),
  async run(_args, { user }) {
    const { data, error } = await db
      .from("reminders")
      .select("id, text, due_at, repeat")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("due_at")
      .limit(30);
    if (error) throw new Error(`list_reminders: ${error.message}`);
    if (!data?.length) return { message: "The user has no upcoming reminders." };
    const now = new Date();
    return { message: data.map((r) => `- ${describeReminder(r as ReminderRow, now)} [id ${r.id}]`).join("\n") };
  },
});

export const updateReminder = defineTool({
  name: "update_reminder",
  description:
    "Change a reminder's time, text or repeat. Use it when the user replies 'later', 'tomorrow' or 'in 2 hours' to a reminder: " +
    "the reminder id is in that reminder message.",
  sensitive: false,
  schema: z.object({
    reminder_id: z.string(),
    when: whenSchema.optional(),
    text: z.string().min(1).max(300).optional(),
    repeat: repeatSchema.nullable().optional().describe("null turns a repeating reminder into a one-off."),
  }),
  async run(args, { user }) {
    const r = await getReminder(user.id, args.reminder_id);
    const now = new Date();
    const repeat = args.repeat === undefined ? r.repeat : args.repeat;
    const due = args.when ? firstOccurrence(parseWhen(args.when), repeat, now) : new Date(r.due_at);
    if (!due) throw new Error("That time has already passed. Ask the user when they want it.");

    const update = { text: args.text?.trim() ?? r.text, repeat, due_at: due.toISOString(), status: "active" };
    const { error } = await db.from("reminders").update(update).eq("id", r.id).eq("user_id", user.id);
    if (error) throw new Error(`update_reminder: ${error.message}`);
    return { message: `Reminder updated: ${describeReminder(update, now)}.` };
  },
});

export const cancelReminder = defineTool({
  name: "cancel_reminder",
  description: "Cancel a reminder the user no longer wants. Find the id with list_reminders if needed.",
  sensitive: false,
  schema: z.object({ reminder_id: z.string() }),
  async run({ reminder_id }, { user }) {
    const r = await getReminder(user.id, reminder_id);
    const { error } = await db.from("reminders").update({ status: "cancelled" }).eq("id", r.id).eq("user_id", user.id);
    if (error) throw new Error(`cancel_reminder: ${error.message}`);
    return { message: `Cancelled the reminder "${r.text}".` };
  },
});

const HOUR_MS = 60 * 60 * 1000;

/**
 * Applies a tap on a sent reminder's buttons and returns the short note to show.
 * Snoozing a repeating reminder adds a one-off copy, so its regular slot stays as it was.
 */
export async function applyReminderTap(userId: string, tap: "done" | "1h" | "tmr", reminderId: string, now = new Date()): Promise<string> {
  const r = await getReminder(userId, reminderId).catch(() => null);
  if (!r || r.status === "cancelled") return "That reminder is no longer active.";

  if (tap === "done") {
    if (!r.repeat) await db.from("reminders").update({ status: "done" }).eq("id", r.id).eq("user_id", userId);
    return "Nice one. Marked done.";
  }

  const due =
    tap === "1h" ? new Date(now.getTime() + HOUR_MS) : new Date(Math.max(new Date(r.due_at).getTime() + 24 * HOUR_MS, now.getTime() + HOUR_MS));
  if (r.repeat) {
    const { error } = await db.from("reminders").insert({ user_id: userId, text: r.text, due_at: due.toISOString(), source: "snooze" });
    if (error) throw new Error(`applyReminderTap: ${error.message}`);
  } else {
    const { error } = await db.from("reminders").update({ due_at: due.toISOString(), status: "active" }).eq("id", r.id).eq("user_id", userId);
    if (error) throw new Error(`applyReminderTap: ${error.message}`);
  }
  return `I'll remind you again ${describeWhen(due, now)}.`;
}
