import { db, getUserById, saveMessage } from "../db/supabase.js";
import { logger, maskId } from "../log.js";
import { sendReminder } from "../telegram/send.js";
import { describeWhen, nextOccurrence, type Repeat } from "../time.js";
import type { ReminderRow } from "../tools/reminders.js";

/** A reminder this late gets a note saying when it was due, so a missed one is not confusing. */
const LATE_MS = 30 * 60 * 1000;
const BATCH = 100;

export interface TickResult {
  due: number;
  sent: number;
  failed: number;
}

/** The text shown in the chat, and the version kept in history with the id the model needs to snooze it. */
export function reminderMessage(r: Pick<ReminderRow, "id" | "text" | "due_at" | "repeat">, next: Date | null, now: Date) {
  const due = new Date(r.due_at);
  const late = now.getTime() - due.getTime() > LATE_MS ? `\n_This was due ${describeWhen(due, now)}._` : "";
  const following = r.repeat && next ? `\n_Next one: ${describeWhen(next, now)}._` : "";
  const shown = `*Reminder:* ${r.text}${late}${following}`;
  return { shown, stored: `${shown}\n(reminder id ${r.id})` };
}

/**
 * Sends every reminder that is due. Called every minute by cron-job.org.
 * Each reminder is claimed with a conditional update first, so two overlapping runs
 * can never send the same reminder twice.
 */
export async function runDueReminders(now = new Date()): Promise<TickResult> {
  const { data, error } = await db
    .from("reminders")
    .select("id, user_id, text, due_at, repeat")
    .eq("status", "active")
    .lte("due_at", now.toISOString())
    .order("due_at")
    .limit(BATCH);
  if (error) throw new Error(`runDueReminders: ${error.message}`);

  const result: TickResult = { due: data?.length ?? 0, sent: 0, failed: 0 };
  for (const r of (data ?? []) as Due[]) {
    const next = r.repeat ? nextOccurrence(r.repeat as Repeat, new Date(r.due_at), now) : null;
    const outcome = await deliver(r, next, now);
    if (outcome === "sent") result.sent++;
    if (outcome === "failed") result.failed++;
  }
  return result;
}

type Due = Pick<ReminderRow, "id" | "user_id" | "text" | "due_at" | "repeat">;

/** Claims a reminder, moves it to its next slot (or closes it) and sends it. */
async function deliver(r: Due, next: Date | null, now: Date): Promise<"sent" | "failed" | "skipped"> {
  const update = next ? { due_at: next.toISOString(), last_sent_at: now.toISOString() } : { status: r.repeat ? "done" : "sent", last_sent_at: now.toISOString() };
  const { data: claimed, error } = await db.from("reminders").update(update).eq("id", r.id).eq("status", "active").eq("due_at", r.due_at).select("id");
  if (error || !claimed?.length) return "skipped";
  try {
    const user = await getUserById(r.user_id);
    const { shown, stored } = reminderMessage(r, next, now);
    const outId = await sendReminder(user.chat_id, shown, r.id, Boolean(next));
    await saveMessage(user.id, "out", "text", stored, outId);
    logger.info({ user: maskId(user.chat_id) }, "reminder sent");
    return "sent";
  } catch (err) {
    logger.error({ err, reminder: r.id }, "reminder send failed");
    return "failed";
  }
}

/**
 * Sends a reminder now as if its time had come, for recording a demo. A repeating reminder
 * keeps its real schedule: the next one shown is the slot after the one being skipped to.
 */
export async function fireEarly(reminderId: string, now = new Date()): Promise<boolean> {
  const { data } = await db.from("reminders").select("id, user_id, text, due_at, repeat").eq("id", reminderId).eq("status", "active").maybeSingle();
  if (!data) return false;
  const r = data as Due;
  const slot = new Date(r.due_at);
  const next = r.repeat ? nextOccurrence(r.repeat as Repeat, slot, slot.getTime() > now.getTime() ? slot : now) : null;
  return (await deliver(r, next, now)) === "sent";
}
