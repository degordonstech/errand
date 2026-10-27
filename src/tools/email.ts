import { Resend } from "resend";
import { z } from "zod";
import { config } from "../config.js";
import { defineTool } from "./types.js";

const resend = config.RESEND_API_KEY ? new Resend(config.RESEND_API_KEY) : null;

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  /** Shown as the sender name, e.g. "Gold Foods via MyPaddy". */
  senderName?: string;
  attachments?: { filename: string; content: Buffer }[];
}

export interface SendResult {
  id: string;
  /** Set when DEV_EMAIL_TO is configured and the email went to the test inbox instead. */
  redirectedTo?: string;
}

function fromAddress(senderName?: string): string {
  const address = config.EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? config.EMAIL_FROM;
  return `${senderName ? `${senderName} via MyPaddy` : "MyPaddy"} <${address}>`;
}

const isNetworkError = (e: { name?: string; message?: string }) =>
  e.name === "application_error" && /unable to fetch|could not be resolved/i.test(e.message ?? "");

/**
 * Sends one email. Network failures are retried; with an idempotency key Resend
 * delivers at most one email per key, so a retry can never send a duplicate.
 */
export async function sendEmail(email: OutgoingEmail, idempotencyKey?: string): Promise<SendResult> {
  if (!resend || !config.EMAIL_FROM) throw new Error("email is not configured");

  // Until a sending domain is verified, Resend only delivers to the account owner.
  // DEV_EMAIL_TO sends everything there and says who it was meant for.
  const redirect = config.DEV_EMAIL_TO || undefined;
  const to = redirect ?? email.to;
  const text = redirect ? `[Test mode. This email was addressed to ${email.to}]\n\n${email.text}` : email.text;

  const payload = {
    from: fromAddress(email.senderName),
    to: [to],
    subject: email.subject,
    text,
    attachments: email.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
  };

  for (let attempt = 1; ; attempt++) {
    const { data, error } = await resend.emails.send(payload, idempotencyKey ? { idempotencyKey } : undefined);
    if (data && !error) return { id: data.id, redirectedTo: redirect };
    if (!error || !isNetworkError(error) || !idempotencyKey || attempt >= 5) {
      throw new Error(`email failed: ${error?.message ?? "no id returned"}`);
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
  }
}

export const sendEmailTool = defineTool({
  name: "send_email",
  description:
    "Email someone on the user's behalf. Only use an address the user gave or that is saved in memory; never guess one. " +
    "This does not send straight away: the user is asked to approve it first.",
  sensitive: true,
  schema: z.object({
    to: z.email(),
    subject: z.string().min(1).max(150),
    body: z.string().min(1).max(5000),
  }),
  summarize: ({ to, subject, body }) => `*Send email*\nTo: ${to}\nSubject: ${subject}\n\n${body}`,
  async run({ to, subject, body }, { user, actionId }) {
    const res = await sendEmail(
      { to, subject, text: body, senderName: user.business_name ?? user.name ?? undefined },
      actionId ? `mypaddy-${actionId}` : undefined,
    );
    return {
      message: res.redirectedTo ? `Sent (test mode: delivered to your test inbox, addressed to ${to}).` : `Sent to ${to}.`,
      data: { emailId: res.id },
    };
  },
});
