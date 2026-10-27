import { z } from "zod";
import { db } from "../db/supabase.js";
import { startOfLagosDay } from "../safety/gate.js";
import { defineTool } from "./types.js";

const DAY = 86_400_000;

const LABELS: Record<string, string> = {
  remember: "Saved a note",
  forget: "Deleted a note",
  explain_document: "Explained a document",
  send_email: "Email",
  create_invoice: "Created an invoice",
  send_invoice: "Emailed an invoice",
  send_payment_reminder: "Payment reminder",
  list_invoices: "Looked up invoices",
  mark_paid: "Marked an invoice paid",
  check_product: "Checked a product",
};

const STATUS: Record<string, string> = {
  asked: "asked you",
  approved: "you approved",
  declined: "you said no",
  expired: "expired without an answer",
  done: "done",
  failed: "failed",
};

export const activityLog = defineTool({
  name: "activity_log",
  description: "List what MyPaddy did for the user: every action, what was asked, approved, declined or sent. Use for 'what did you do today?'.",
  sensitive: false,
  schema: z.object({ period: z.enum(["today", "yesterday", "week"]).default("today") }),
  async run({ period }, { user }) {
    const today = startOfLagosDay(new Date());
    const from = period === "today" ? today : period === "yesterday" ? new Date(today.getTime() - DAY) : new Date(today.getTime() - 6 * DAY);
    const to = period === "yesterday" ? today : new Date();

    const { data, error } = await db
      .from("action_log")
      .select("tool, args, status, created_at")
      .eq("user_id", user.id)
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString())
      .not("tool", "in", "(list_invoices,activity_log)")
      .order("created_at");
    if (error) throw new Error(`activity_log: ${error.message}`);

    const { data: checks } = await db
      .from("product_checks")
      .select("product_name, nafdac_no, verdict, where_bought, created_at")
      .eq("user_id", user.id)
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString());

    const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });
    const target = (a: any) => a?.to ?? a?.invoice_number ?? a?.customer_name ?? a?.key ?? a?.product_name ?? "";
    const entries = (data ?? []).map((r) => `${time(r.created_at)} ${LABELS[r.tool] ?? r.tool}${target(r.args) ? ` (${target(r.args)})` : ""}: ${STATUS[r.status] ?? r.status}`);

    return {
      message: entries.length ? `${entries.length} logged step(s).` : "Nothing logged in that period.",
      data: { period, actions: entries, product_checks: checks ?? [] },
    };
  },
});
