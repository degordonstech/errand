import { db, getUserById, saveMessage } from "../db/supabase.js";
import { formatMoney } from "../invoice/pdf.js";
import { logger, maskId } from "../log.js";
import { gate } from "../safety/instance.js";
import { normaliseInvoiceNumber, sendPaymentReminder, type InvoiceRow } from "../tools/invoice.js";
import { APPROVAL_PROMPT, sendApproval } from "../telegram/send.js";

const HOUR = 3_600_000;
/** Do not ask about the same invoice again within this window, whatever the user answered. */
const ASK_COOLDOWN_HOURS = 24;
/** After a reminder goes out, wait this long before suggesting another. */
const REMIND_AGAIN_HOURS = 72;

export interface ReminderRunResult {
  checked: number;
  asked: number;
  skipped: number;
}

async function askedRecently(userId: string, invoiceNumber: string, since: Date): Promise<boolean> {
  const { data, error } = await db
    .from("pending_actions")
    .select("args")
    .eq("user_id", userId)
    .eq("tool", "send_payment_reminder")
    .gte("created_at", since.toISOString());
  if (error) throw new Error(`askedRecently: ${error.message}`);
  return (data ?? []).some((p) => normaliseInvoiceNumber(String(p.args?.invoice_number ?? "")) === invoiceNumber);
}

/**
 * Finds emailed invoices that are still unpaid and asks each owner whether to send a reminder.
 * Nothing is emailed here: each reminder becomes a pending action that needs the user's YES.
 */
export async function runReminders(opts: { minAgeHours?: number; now?: Date } = {}): Promise<ReminderRunResult> {
  const now = opts.now ?? new Date();
  const minAge = opts.minAgeHours ?? 48;

  const { data, error } = await db
    .from("invoices")
    .select()
    .eq("status", "unpaid")
    .not("sent_at", "is", null)
    .not("customer_email", "is", null)
    .lte("sent_at", new Date(now.getTime() - minAge * HOUR).toISOString())
    .order("sent_at", { ascending: true });
  if (error) throw new Error(`runReminders: ${error.message}`);

  const result: ReminderRunResult = { checked: data?.length ?? 0, asked: 0, skipped: 0 };
  // Only one action can wait per user, so ask about one invoice per user per run (the oldest).
  const handledUsers = new Set<string>();

  for (const raw of data ?? []) {
    const inv = { ...raw, total: Number(raw.total) } as InvoiceRow;
    const remindedRecently = inv.reminded_at && now.getTime() - new Date(inv.reminded_at).getTime() < REMIND_AGAIN_HOURS * HOUR;
    if (handledUsers.has(inv.user_id) || remindedRecently || (await askedRecently(inv.user_id, inv.number, new Date(now.getTime() - ASK_COOLDOWN_HOURS * HOUR)))) {
      result.skipped++;
      continue;
    }

    try {
      const user = await getUserById(inv.user_id);
      const args = { invoice_number: inv.number };
      const summary = await sendPaymentReminder.summarize!(args, { user });
      const req = await gate.request(user.id, sendPaymentReminder.name, args, summary);
      if (!req.ok) {
        result.skipped++;
        continue;
      }

      const amount = formatMoney(inv.total, inv.currency);
      const body = `${inv.customer_name} has not paid ${inv.number} (${amount}) yet.\n\n${summary}`;
      const outId = await sendApproval(user.chat_id, body, req.action.id);
      const text = `${body}\n\n${APPROVAL_PROMPT}`;
      await saveMessage(user.id, "out", "text", text, outId);
      handledUsers.add(user.id);
      result.asked++;
      logger.info({ user: maskId(user.chat_id), invoice: inv.number }, "payment reminder offered");
    } catch (err) {
      result.skipped++;
      logger.error({ err, invoice: inv.number }, "reminder offer failed");
    }
  }
  return result;
}
