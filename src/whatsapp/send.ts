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
