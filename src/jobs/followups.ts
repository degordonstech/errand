import { db, getUserById, saveMessage } from "../db/supabase.js";
import { logger, maskId } from "../log.js";
import { sendFollowUp } from "../telegram/send.js";
import { toLagos } from "../time.js";

const HOUR_MS = 60 * 60 * 1000;
/** Wait this long after a task reminder before asking whether it got done. */
const AFTER_MS = 3 * HOUR_MS;
/** Older than this, the moment has passed and asking would be odd. */
const UNTIL_MS = 24 * HOUR_MS;
/** Only ask at sociable hours, Lagos time. */
const FIRST_HOUR = 9;
const LAST_HOUR = 21;

/** Only things the user has to do get a follow-up. Classes, exams and events do not. */
const TASK_SOURCES = ["user", "casual", "snooze"];

export function followUpText(task: string): string {
  const t = task.trim().replace(/[.!]+$/, "");
  return `Quick one: did you get this done?\n\n*${t}*`;
}

export function sociableHour(now: Date): boolean {
  const hour = Number(toLagos(now).slice(11, 13));
  return hour >= FIRST_HOUR && hour < LAST_HOUR;
}

/**
 * Asks about one-off task reminders that went out a few hours ago and were not marked done.
 * Called from the per-minute tick. Each reminder is claimed before the message goes out.
 */
export async function runFollowUps(now = new Date()): Promise<number> {
  if (!sociableHour(now)) return 0;
  const { data, error } = await db
    .from("reminders")
    .select("id, user_id, text, last_sent_at")
    .eq("status", "sent")
    .is("repeat", null)
    .is("followed_up_at", null)
    .in("source", TASK_SOURCES)
    .lte("last_sent_at", new Date(now.getTime() - AFTER_MS).toISOString())
    .gte("last_sent_at", new Date(now.getTime() - UNTIL_MS).toISOString())
    .limit(50);
  if (error) throw new Error(`runFollowUps: ${error.message}`);

  let sent = 0;
  for (const r of data ?? []) {
    const { data: claimed } = await db.from("reminders").update({ followed_up_at: now.toISOString() }).eq("id", r.id).is("followed_up_at", null).select("id");
    if (!claimed?.length) continue;
    try {
      const user = await getUserById(r.user_id);
      const text = followUpText(r.text);
      const outId = await sendFollowUp(user.chat_id, text, r.id);
      await saveMessage(user.id, "out", "text", `${text}\n(reminder id ${r.id})`, outId);
      sent++;
      logger.info({ user: maskId(user.chat_id) }, "follow-up sent");
    } catch (err) {
      logger.error({ err }, "follow-up failed");
    }
  }
  return sent;
}
