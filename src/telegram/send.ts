import { logger, maskId } from "../log.js";
import { call, TelegramError } from "./api.js";

/** Telegram caps a message at 4096 characters. */
const MAX_TEXT = 4096;

export const APPROVAL_PROMPT = "Reply *YES* to go ahead or *NO* to cancel.";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Replies are written with *bold* and _italic_ markers. Telegram's HTML mode is the most
 * forgiving way to show them: everything else is escaped, so stray symbols cannot break a message.
 */
export function toTelegramHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1<i>$2</i>");
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text);

async function sendMessage(chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<string | undefined> {
  try {
    const res = await call<{ message_id: number }>("sendMessage", { chat_id: chatId, text: toTelegramHtml(clip(text)), parse_mode: "HTML", ...extra });
    return String(res.message_id);
  } catch (err) {
    // Formatting the model got wrong should never cost the user their reply.
    if (!(err instanceof TelegramError) || err.status !== 400) throw err;
    logger.warn({ err, to: maskId(chatId) }, "formatted message rejected, sending plain text");
    const res = await call<{ message_id: number }>("sendMessage", { chat_id: chatId, text: clip(text.replace(/[*_]/g, "")), ...extra });
    return String(res.message_id);
  }
}

export function sendText(chatId: string, text: string): Promise<string | undefined> {
  return sendMessage(chatId, text);
}

/** Button data carries the action id, so the gate can tell which request a tap answers. */
export function parseApprovalButton(data: string | undefined): { decision: "YES" | "NO"; actionId: string } | null {
  const m = data?.match(/^(yes|no):(.+)$/);
  return m ? { decision: m[1] === "yes" ? "YES" : "NO", actionId: m[2] } : null;
}

/** Asks for approval with Yes and No buttons under the message. Typing YES or NO works too. */
export function sendApproval(chatId: string, body: string, actionId: string): Promise<string | undefined> {
  return sendMessage(chatId, `${body}\n\n_Tap a button, or reply YES or NO._`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, go ahead", callback_data: `yes:${actionId}` },
          { text: "No, cancel", callback_data: `no:${actionId}` },
        ],
      ],
    },
  });
}

export async function sendDocument(chatId: string, data: Buffer, filename: string, caption?: string): Promise<string | undefined> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", new Blob([new Uint8Array(data)]), filename);
  if (caption) form.append("caption", caption);
  const res = await call<{ message_id: number }>("sendDocument", form);
  return String(res.message_id);
}

export type ReminderTap = "done" | "1h" | "tmr";

export function parseReminderButton(data: string | undefined): { tap: ReminderTap; reminderId: string } | null {
  const m = data?.match(/^rem:(done|1h|tmr):(.+)$/);
  return m ? { tap: m[1] as ReminderTap, reminderId: m[2] } : null;
}

/** A due reminder with Done and snooze buttons. A repeating one cannot move to tomorrow, its next slot is already set. */
export function sendReminder(chatId: string, text: string, reminderId: string, repeating: boolean): Promise<string | undefined> {
  const row = [
    { text: "Done", callback_data: `rem:done:${reminderId}` },
    { text: "In 1 hour", callback_data: `rem:1h:${reminderId}` },
    ...(repeating ? [] : [{ text: "Tomorrow", callback_data: `rem:tmr:${reminderId}` }]),
  ];
  return sendMessage(chatId, text, { reply_markup: { inline_keyboard: [row] } });
}

const RESEND = { photo: ["sendPhoto", "photo"], document: ["sendDocument", "document"], video: ["sendVideo", "video"], voice: ["sendVoice", "voice"] } as const;

/** Sends back a file Telegram already has, by its file id. */
export async function sendStoredFile(chatId: string, kind: keyof typeof RESEND, fileId: string, caption?: string): Promise<string | undefined> {
  const [method, field] = RESEND[kind];
  const res = await call<{ message_id: number }>(method, { chat_id: chatId, [field]: fileId, ...(caption ? { caption } : {}) });
  return String(res.message_id);
}

/** Stops the spinner on a tapped button and leaves the buttons in place. */
export function answerTap(callbackId: string, toast?: string): Promise<unknown> {
  return call("answerCallbackQuery", { callback_query_id: callbackId, ...(toast ? { text: toast } : {}) }).catch(() => undefined);
}

/**
 * Stops the spinner on a tapped button and removes the buttons, so they cannot be tapped again.
 * A toast is a short note Telegram shows on screen without adding a message to the chat.
 */
export async function settleButtons(chatId: string, callback: { id: string; messageId: number }, toast?: string): Promise<void> {
  await Promise.allSettled([
    answerTap(callback.id, toast),
    call("editMessageReplyMarkup", { chat_id: chatId, message_id: callback.messageId, reply_markup: { inline_keyboard: [] } }),
  ]);
}

/**
 * Shows "typing..." until stop() is called. Telegram clears the indicator after about
 * five seconds, so it is renewed while the reply is being worked on.
 */
export function keepTyping(chatId: string): () => void {
  const ping = () => call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  void ping();
  const timer = setInterval(ping, 4500);
  return () => clearInterval(timer);
}

export async function sendPhoto(chatId: string, jpeg: Buffer, caption?: string): Promise<string | undefined> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "photo.jpg");
  if (caption) form.append("caption", caption);
  const res = await call<{ message_id: number }>("sendPhoto", form);
  return String(res.message_id);
}

export function parseFollowUpButton(data: string | undefined): { done: boolean; reminderId: string } | null {
  const m = data?.match(/^fu:(yes|no):(.+)$/);
  return m ? { done: m[1] === "yes", reminderId: m[2] } : null;
}

/** Asks whether a reminded task got done, the way a friend checks in. */
export function sendFollowUp(chatId: string, text: string, reminderId: string): Promise<string | undefined> {
  return sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, done", callback_data: `fu:yes:${reminderId}` },
          { text: "Not yet", callback_data: `fu:no:${reminderId}` },
        ],
      ],
    },
  });
}
