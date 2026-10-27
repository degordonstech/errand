import { fetchRetry } from "../net.js";
import { config } from "../config.js";
import { logger, maskPhone } from "../log.js";

const graph = () => `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}`;

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetchRetry(`${graph()}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp ${path} failed: HTTP ${res.status} ${json?.error?.message ?? ""}`.trim());
  }
  return json;
}

const messages = (body: Record<string, unknown>) =>
  post(`${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", ...body });

/** WhatsApp caps a text body at 4096 characters. */
const MAX_TEXT = 4096;

export async function sendText(to: string, text: string): Promise<string | undefined> {
  const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
  const res = await messages({ to, type: "text", text: { body, preview_url: false } });
  logger.debug({ to: maskPhone(to) }, "text sent");
  return res?.messages?.[0]?.id;
}

export async function sendDocument(to: string, mediaId: string, filename: string, caption?: string): Promise<string | undefined> {
  const res = await messages({ to, type: "document", document: { id: mediaId, filename, caption } });
  return res?.messages?.[0]?.id;
}

/** Reply buttons: up to 3, titles up to 20 characters, body up to 1024 characters. */
export const MAX_BUTTON_BODY = 1024;

export async function sendButtons(to: string, body: string, buttons: { id: string; title: string }[], footer?: string): Promise<string | undefined> {
  const res = await messages({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: { buttons: buttons.map((b) => ({ type: "reply", reply: b })) },
    },
  });
  return res?.messages?.[0]?.id;
}

export const APPROVAL_PROMPT = "Reply *YES* to go ahead or *NO* to cancel.";

/** Button ids carry the action id, so the gate can tell which request a tap answers. */
export function parseApprovalButton(id: string | undefined): { decision: "YES" | "NO"; actionId: string } | null {
  const m = id?.match(/^(yes|no):(.+)$/);
  return m ? { decision: m[1] === "yes" ? "YES" : "NO", actionId: m[2] } : null;
}

/**
 * Asks for approval with Yes and No buttons. Long requests go as a text first, since a button
 * message body is capped. Falls back to plain text if the buttons cannot be sent.
 */
export async function sendApproval(to: string, body: string, actionId: string): Promise<string | undefined> {
  const buttons = [
    { id: `yes:${actionId}`, title: "Yes, go ahead" },
    { id: `no:${actionId}`, title: "No, cancel" },
  ];
  const footer = "Or reply YES or NO";
  const short = body.length <= MAX_BUTTON_BODY;
  let textSent = false;
  try {
    if (short) return await sendButtons(to, body, buttons, footer);
    await sendText(to, body);
    textSent = true;
    return await sendButtons(to, "Go ahead with this?", buttons, footer);
  } catch (err) {
    logger.warn({ err, to: maskPhone(to) }, "approval buttons failed, sending text");
    return sendText(to, textSent ? APPROVAL_PROMPT : `${body}\n\n${APPROVAL_PROMPT}`);
  }
}

/** Marks the message read and shows "typing..." until the next reply (or about 25 seconds). */
export async function markReadAndTyping(messageId: string): Promise<void> {
  try {
    await post(`${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (err) {
    logger.debug({ err }, "read receipt failed");
  }
}

/** Sends an approved template. Needed to reach a user more than 24 hours after their last message. */
export async function sendTemplate(to: string, name: string, language: string, bodyParams: string[]): Promise<string | undefined> {
  const res = await messages({
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      components: [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }],
    },
  });
  return res?.messages?.[0]?.id;
}
