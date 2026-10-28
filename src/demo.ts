import { config } from "./config.js";
import { db, saveMessage, type User } from "./db/supabase.js";
import { eveningBrief, morningBrief, weeklyBrief } from "./jobs/briefs.js";
import { runFollowUps } from "./jobs/followups.js";
import { fireEarly } from "./jobs/tick.js";
import { sendText } from "./telegram/send.js";

// Recording a demo in a few minutes means showing things that normally happen tomorrow or next week.
// These commands make the real feature fire now. Only the owner's chat can use them.

const HELP =
  "Demo commands:\n" +
  "/demo morning: send the morning greeting now\n" +
  "/demo evening: send the evening check-in now\n" +
  "/demo weekly: send the Sunday summary now\n" +
  "/demo next: fire your next reminder now (add a word, for example /demo next study)\n" +
  "/demo birthday: fire the next birthday reminder now\n" +
  "/demo followup: ask about your last reminded task now";

export const isDemoCommand = (text: string) => /^\/demo\b/i.test(text.trim());

export const isOwner = (chatId: string) => Boolean(config.OWNER_CHAT_ID) && chatId === config.OWNER_CHAT_ID;

async function sendBrief(user: User, text: string | null): Promise<string | null> {
  if (!text) return "Nothing to say for that one yet. Add a reminder or a to-do first.";
  const outId = await sendText(user.chat_id, text);
  await saveMessage(user.id, "out", "text", text, outId);
  return null;
}

/** Sends one upcoming reminder now, buttons and all, keeping its real schedule. */
async function fireNow(userId: string, sourceLike?: string, word?: string): Promise<string | null> {
  let q = db.from("reminders").select("id").eq("user_id", userId).eq("status", "active").order("due_at").limit(1);
  if (sourceLike) q = q.like("source", sourceLike);
  if (word) q = q.ilike("text", `%${word.replace(/[%_]/g, "")}%`);
  const { data } = await q;
  if (!data?.length) return sourceLike ? "No birthday saved yet." : "You have no reminders set.";
  return (await fireEarly(data[0].id)) ? null : "Could not send that reminder. Try again.";
}

/**
 * Makes the last reminded task look three hours old, so the follow-up goes out now.
 * A task already tapped Done is asked about again, so a slip during recording does not spoil the take.
 */
async function followUpNow(userId: string): Promise<string | null> {
  const { data } = await db
    .from("reminders")
    .select("id")
    .eq("user_id", userId)
    .in("status", ["sent", "done"])
    .is("repeat", null)
    .in("source", ["user", "casual", "snooze"])
    .order("last_sent_at", { ascending: false })
    .limit(1);
  if (!data?.length) return "No reminded task to follow up on yet. Set a reminder and let it fire first.";
  const now = new Date();
  await db
    .from("reminders")
    .update({ status: "sent", followed_up_at: null, last_sent_at: new Date(now.getTime() - 3 * 3_600_000 - 60_000).toISOString() })
    .eq("id", data[0].id);
  const sent = await runFollowUps(now);
  return sent ? null : "Follow-ups only go out between 9am and 9pm.";
}

/** Runs a demo command. Returns a short note for the owner, or null when the feature itself replied. */
export async function runDemo(user: User, text: string): Promise<string | null> {
  const [, arg, word] = text.trim().toLowerCase().split(/\s+/);
  const now = new Date();
  switch (arg) {
    case "morning":
      return sendBrief(user, await morningBrief(user, now));
    case "evening":
      return sendBrief(user, await eveningBrief(user, now));
    case "weekly":
      return sendBrief(user, await weeklyBrief(user, now));
    case "next":
      return fireNow(user.id, undefined, word);
    case "birthday":
      return fireNow(user.id, "birthday:%");
    case "followup":
      return followUpNow(user.id);
    default:
      return HELP;
  }
}
