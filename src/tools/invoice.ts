import { z } from "zod";
import { db, type User } from "../db/supabase.js";
import { formatDate, formatMoney, invoiceTotal, renderInvoicePdf, type InvoiceData, type InvoiceItem } from "../invoice/pdf.js";
import { uploadMedia } from "../whatsapp/media.js";
import { sendDocument } from "../whatsapp/send.js";
import { sendEmail } from "./email.js";
import { loadMemory } from "./memory.js";
import { defineTool } from "./types.js";

export interface InvoiceRow {
  id: string;
  user_id: string;
  number: string;
  customer_name: string;
  customer_email: string | null;
  items: InvoiceItem[];
  total: number;
  currency: string;
  status: "unpaid" | "paid";
  due_date: string | null;
  sent_at: string | null;
  reminded_at: string | null;
  paid_at: string | null;
  created_at: string;
}

/** "inv-7", "7", "0007" and "INV-0007" all mean the same invoice. */
export function normaliseInvoiceNumber(input: string): string {
  const digits = input.match(/\d+/)?.[0];
  return digits ? `INV-${digits.padStart(4, "0")}` : input.trim().toUpperCase();
}

export async function getInvoice(userId: string, number: string): Promise<InvoiceRow> {
  const { data, error } = await db.from("invoices").select().eq("user_id", userId).eq("number", normaliseInvoiceNumber(number)).maybeSingle();
  if (error) throw new Error(`getInvoice: ${error.message}`);
  if (!data) throw new Error(`There is no invoice ${normaliseInvoiceNumber(number)}. Use list_invoices to find the right one.`);
  return { ...data, total: Number(data.total) } as InvoiceRow;
}

async function nextInvoiceNumber(userId: string): Promise<string> {
  const { data, error } = await db.from("invoices").select("number").eq("user_id", userId).order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(`nextInvoiceNumber: ${error.message}`);
  const last = Number(data?.[0]?.number.match(/\d+/)?.[0] ?? 0);
  return `INV-${String(last + 1).padStart(4, "0")}`;
}

/** Seller details come from what the user asked Errand to remember. Keys vary, so match loosely. */
function sellerFrom(memory: Record<string, string>, user: User) {
  const find = (...patterns: RegExp[]) => Object.entries(memory).find(([k]) => patterns.every((p) => p.test(k)))?.[1];
  return {
    seller: {
      name: memory.business_name ?? user.business_name ?? user.name ?? "My Business",
      address: find(/address/, /business|shop|store|office/) ?? memory.address,
      phone: find(/phone/, /business/),
      email: find(/email/, /business/),
    },
    payment: {
      bankName: find(/bank/, /name/) ?? memory.bank,
      accountNumber: find(/account/, /number|no/),
      accountName: find(/account/, /name/),
    },
  };
}

async function invoicePdf(inv: InvoiceRow, user: User): Promise<{ pdf: Buffer; data: InvoiceData }> {
  const { seller, payment } = sellerFrom(await loadMemory(user.id), user);
  const data: InvoiceData = {
    number: inv.number,
    issuedOn: new Date(inv.created_at),
    dueOn: inv.due_date ? new Date(inv.due_date) : null,
    currency: inv.currency,
    seller,
    customer: { name: inv.customer_name, email: inv.customer_email },
    items: inv.items,
    payment,
  };
  return { pdf: await renderInvoicePdf(data), data };
}

const fileName = (inv: InvoiceRow) => `${inv.number}-${inv.customer_name.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;

function paymentLines(data: InvoiceData): string {
  const p = data.payment ?? {};
  const lines = [p.bankName && `Bank: ${p.bankName}`, p.accountNumber && `Account number: ${p.accountNumber}`, p.accountName && `Account name: ${p.accountName}`].filter(Boolean);
  return lines.length ? `\n\nPayment details:\n${lines.join("\n")}` : "";
}

const itemSchema = z.object({
  description: z.string().min(1).max(200),
  quantity: z.number().positive().max(1_000_000),
  unit_price: z.number().nonnegative().max(10_000_000_000).describe("Price for one unit in naira, as a plain number. 75k is 75000."),
});

export const createInvoice = defineTool({
  name: "create_invoice",
  description:
    "Create an invoice PDF and send it to the user in this chat. Totals are calculated for you. " +
    "Afterwards, if the customer's email is known, call send_invoice so the user can approve emailing it.",
  sensitive: false,
  schema: z.object({
    customer_name: z.string().min(1).max(120),
    customer_email: z.email().optional(),
    items: z.array(itemSchema).min(1).max(30),
    due_in_days: z.number().int().min(0).max(365).optional().describe("Defaults to 7."),
    notes: z.string().max(500).optional(),
  }),
  async run(args, { user }) {
    const items: InvoiceItem[] = args.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unit_price }));
    const total = invoiceTotal(items);
    const due = new Date(Date.now() + (args.due_in_days ?? 7) * 86_400_000);

    let row: InvoiceRow | null = null;
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      const { data, error } = await db
        .from("invoices")
        .insert({
          user_id: user.id,
          number: await nextInvoiceNumber(user.id),
          customer_name: args.customer_name,
          customer_email: args.customer_email ?? null,
          items,
          total,
          due_date: due.toISOString().slice(0, 10),
        })
        .select()
        .single();
      if (!error) row = { ...data, total: Number(data.total) } as InvoiceRow;
      else if (error.code !== "23505") throw new Error(`create_invoice: ${error.message}`);
    }
    if (!row) throw new Error("create_invoice: could not allocate an invoice number");

    const { pdf } = await invoicePdf(row, user);
    const mediaId = await uploadMedia(pdf, "application/pdf", fileName(row));
    await sendDocument(user.wa_id, mediaId, fileName(row), `${row.number} for ${row.customer_name}: ${formatMoney(total)}`);

    return {
      message: `Created ${row.number} for ${row.customer_name}, total ${formatMoney(total)}, due ${formatDate(due)}. The PDF has been sent to the user in this chat.`,
      data: { invoice_number: row.number, total, customer_email: row.customer_email },
    };
  },
});

export const sendInvoice = defineTool({
  name: "send_invoice",
  description: "Email an invoice PDF to the customer. Needs the user's approval. If the invoice has no customer email, ask the user for it first.",
  sensitive: true,
  schema: z.object({
    invoice_number: z.string().min(1),
    customer_email: z.email().optional().describe("Only if the user just gave an address that is not on the invoice yet."),
  }),
  async summarize({ invoice_number, customer_email }, { user }) {
    const inv = await getInvoice(user.id, invoice_number);
    const to = customer_email ?? inv.customer_email;
    if (!to) throw new Error(`${inv.number} has no customer email. Ask the user for ${inv.customer_name}'s email address.`);
    return `*Email invoice ${inv.number}*\nTo: ${inv.customer_name} <${to}>\nAmount: ${formatMoney(inv.total, inv.currency)}\nThe PDF is attached.`;
  },
  async run({ invoice_number, customer_email }, { user, actionId }) {
    const inv = await getInvoice(user.id, invoice_number);
    const to = customer_email ?? inv.customer_email;
    if (!to) throw new Error("no customer email");
    const { pdf, data } = await invoicePdf(inv, user);
    const seller = data.seller.name;
    const due = data.dueOn ? `, due by ${formatDate(data.dueOn)}` : "";
    const res = await sendEmail(
      {
        to,
        subject: `Invoice ${inv.number} from ${seller}`,
        text: `Hello ${inv.customer_name},\n\nPlease find attached invoice ${inv.number} for ${formatMoney(inv.total, inv.currency)}${due}.${paymentLines(data)}\n\nThank you,\n${seller}`,
        senderName: seller,
        attachments: [{ filename: fileName(inv), content: pdf }],
      },
      actionId ? `errand-${actionId}` : undefined,
    );
    await db
      .from("invoices")
      .update({ sent_at: new Date().toISOString(), customer_email: to })
      .eq("id", inv.id);
    const where = res.redirectedTo ? `(test mode: delivered to your test inbox, addressed to ${to})` : `to ${to}`;
    return { message: `${inv.number} emailed ${where}. I will remind you if it is still unpaid in a couple of days.` };
  },
});

export const sendPaymentReminder = defineTool({
  name: "send_payment_reminder",
  description: "Email the customer a polite reminder about an unpaid invoice, with the PDF attached again. Needs the user's approval.",
  sensitive: true,
  schema: z.object({ invoice_number: z.string().min(1) }),
  async summarize({ invoice_number }, { user }) {
    const inv = await getInvoice(user.id, invoice_number);
    if (inv.status === "paid") throw new Error(`${inv.number} is already marked as paid.`);
    if (!inv.customer_email) throw new Error(`${inv.number} has no customer email. Ask the user for it.`);
    return `*Email payment reminder*\nTo: ${inv.customer_name} <${inv.customer_email}>\nInvoice: ${inv.number}, ${formatMoney(inv.total, inv.currency)} still unpaid.\nA polite reminder with the invoice attached.`;
  },
  async run({ invoice_number }, { user, actionId }) {
    const inv = await getInvoice(user.id, invoice_number);
    if (inv.status === "paid") return { message: `${inv.number} is already marked as paid, so I did not send a reminder.` };
    if (!inv.customer_email) throw new Error("no customer email");
    const { pdf, data } = await invoicePdf(inv, user);
    const seller = data.seller.name;
    const sent = inv.sent_at ? `, sent on ${formatDate(new Date(inv.sent_at))},` : "";
    const due = data.dueOn ? ` It was due on ${formatDate(data.dueOn)}.` : "";
    const res = await sendEmail(
      {
        to: inv.customer_email,
        subject: `Reminder: invoice ${inv.number} from ${seller}`,
        text:
          `Hello ${inv.customer_name},\n\nThis is a friendly reminder that invoice ${inv.number} for ${formatMoney(inv.total, inv.currency)}${sent} is still outstanding.${due} ` +
          `I have attached it again for convenience.${paymentLines(data)}\n\nIf you have already paid, please ignore this message.\n\nThank you,\n${seller}`,
        senderName: seller,
        attachments: [{ filename: fileName(inv), content: pdf }],
      },
      actionId ? `errand-${actionId}` : undefined,
    );
    await db.from("invoices").update({ reminded_at: new Date().toISOString() }).eq("id", inv.id);
    const where = res.redirectedTo ? `(test mode: delivered to your test inbox, addressed to ${inv.customer_email})` : `to ${inv.customer_email}`;
    return { message: `Reminder for ${inv.number} sent ${where}.` };
  },
});

export const listInvoices = defineTool({
  name: "list_invoices",
  description: "List the user's invoices, newest first. Use it to find an invoice by customer before marking it paid or reminding.",
  sensitive: false,
  schema: z.object({
    status: z.enum(["unpaid", "paid", "all"]).optional(),
    customer: z.string().max(120).optional().describe("Part of the customer's name."),
  }),
  async run({ status, customer }, { user }) {
    let q = db.from("invoices").select("number, customer_name, customer_email, total, currency, status, due_date, sent_at, created_at").eq("user_id", user.id);
    if (status && status !== "all") q = q.eq("status", status);
    if (customer) q = q.ilike("customer_name", `%${customer.replace(/[%_]/g, "")}%`);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(20);
    if (error) throw new Error(`list_invoices: ${error.message}`);
    if (!data?.length) return { message: "No matching invoices." };
    return {
      message: `${data.length} invoice(s).`,
      data: data.map((i) => ({
        number: i.number,
        customer: i.customer_name,
        total: formatMoney(Number(i.total), i.currency),
        status: i.status,
        emailed: Boolean(i.sent_at),
        due: i.due_date,
      })),
    };
  },
});

export const markPaid = defineTool({
  name: "mark_paid",
  description: "Mark an invoice as paid, for example when the user says the customer has paid. Use list_invoices first if the number is not known.",
  sensitive: false,
  schema: z.object({ invoice_number: z.string().min(1) }),
  async run({ invoice_number }, { user }) {
    const inv = await getInvoice(user.id, invoice_number);
    if (inv.status === "paid") return { message: `${inv.number} was already marked as paid.` };
    const { error } = await db.from("invoices").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", inv.id);
    if (error) throw new Error(`mark_paid: ${error.message}`);
    // A reminder that is still waiting for YES no longer makes sense.
    const { data: waiting } = await db.from("pending_actions").select("id, args").eq("user_id", user.id).eq("status", "waiting").eq("tool", "send_payment_reminder");
    const stale = (waiting ?? []).filter((p) => normaliseInvoiceNumber(String(p.args?.invoice_number ?? "")) === inv.number).map((p) => p.id);
    if (stale.length) await db.from("pending_actions").update({ status: "expired" }).in("id", stale);
    return { message: `${inv.number} for ${inv.customer_name} (${formatMoney(inv.total, inv.currency)}) is now marked as paid.` };
  },
});
