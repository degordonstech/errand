import { db, getUserById, saveMessage } from "../db/supabase.js";
import { formatMoney } from "../invoice/pdf.js";
import { logger, maskPhone } from "../log.js";
import { gate } from "../safety/instance.js";
import { normaliseInvoiceNumber, sendPaymentReminder, type InvoiceRow } from "../tools/invoice.js";
import { APPROVAL_PROMPT, sendApproval, sendTemplate } from "../whatsapp/send.js";

const HOUR = 3_600_000;
const TEMPLATE = "invoice_payment_reminder";
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

/** WhatsApp only allows free-form messages within 24 hours of the user's last message. */
async function insideServiceWindow(userId: string, now: Date): Promise<boolean> {
  const { data } = await db
    .from("messages")
    .select("created_at")
    .eq("user_id", userId)
    .eq("direction", "in")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Boolean(data && now.getTime() - new Date(data.created_at).getTime() < 23 * HOUR);
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
      let text: string;
      let outId: string | undefined;
      if (await insideServiceWindow(user.id, now)) {
        const body = `${inv.customer_name} has not paid ${inv.number} (${amount}) yet.\n\n${summary}`;
        text = `${body}\n\n${APPROVAL_PROMPT}`;
        outId = await sendApproval(user.wa_id, body, req.action.id);
      } else {
        text = `Invoice ${inv.number} for ${inv.customer_name} (${amount}) is still unpaid. Reply YES to email ${inv.customer_name} a payment reminder, or NO to skip.`;
        outId = await sendTemplate(user.wa_id, TEMPLATE, "en", [inv.number, inv.customer_name, amount]);
      }
      await saveMessage(user.id, "out", "text", text, outId);
      handledUsers.add(user.id);
      result.asked++;
      logger.info({ user: maskPhone(user.wa_id), invoice: inv.number }, "payment reminder offered");
    } catch (err) {
      result.skipped++;
      logger.error({ err, invoice: inv.number }, "reminder offer failed");
    }
  }
  return result;
}
