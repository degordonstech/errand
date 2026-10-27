import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { logger } from "../log.js";
import type { InboundMessage } from "./types.js";

/** Compares hashes so neither length nor content leaks through timing. */
export function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const fullName = (u: any) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || undefined;

/** Turns a Telegram update into a message for MyPaddy, or null when there is nothing to answer. */
export function parseUpdate(update: any): InboundMessage | null {
  const cb = update?.callback_query;
  if (cb) {
    const chat = cb.message?.chat;
    if (!chat || chat.type !== "private") return null;
    return {
      id: `cb:${cb.id}`,
      from: String(chat.id),
      profileName: fullName(cb.from),
      timestamp: Math.floor(Date.now() / 1000),
      kind: "text",
      text: "",
      buttonId: cb.data,
      callback: { id: cb.id, messageId: cb.message.message_id },
    };
  }

  const m = update?.message;
  // Groups come later. For now MyPaddy only talks one to one.
  if (!m || m.chat?.type !== "private") return null;

  const base = { id: `${m.chat.id}:${m.message_id}`, from: String(m.chat.id), profileName: fullName(m.from), timestamp: m.date, text: m.text ?? m.caption };
  const media = (f: any, mimeType: string, filename?: string) => ({ id: f.file_id, mimeType: f.mime_type ?? mimeType, filename: f.file_name ?? filename, size: f.file_size });

  if (m.text !== undefined) return { ...base, kind: "text" };
  if (m.voice) return { ...base, kind: "voice", media: media(m.voice, "audio/ogg") };
  if (m.audio) return { ...base, kind: "voice", media: media(m.audio, "audio/mpeg") };
  if (m.photo?.length) {
    // Telegram sends several sizes; the last is the largest.
    return { ...base, kind: "image", media: media(m.photo[m.photo.length - 1], "image/jpeg") };
  }
  if (m.video) return { ...base, kind: "video", media: media(m.video, "video/mp4") };
  if (m.video_note) return { ...base, kind: "video", media: media(m.video_note, "video/mp4") };
  if (m.document) return { ...base, kind: "doc", media: media(m.document, "application/octet-stream") };

  const rawType = ["sticker", "location", "contact", "poll", "animation", "dice", "venue"].find((k) => k in m) ?? "unknown";
  return { ...base, kind: "other", rawType };
}

export interface WebhookDeps {
  /** Returns false if this message was already handled. */
  claimMessage(id: string): Promise<boolean>;
  enqueue(message: InboundMessage): void;
}

/** Shared by the webhook and by polling: skips duplicates, then queues the message. */
export async function accept(update: unknown, deps: WebhookDeps): Promise<void> {
  const msg = parseUpdate(update);
  if (!msg) return;
  let fresh = true;
  try {
    fresh = await deps.claimMessage(msg.id);
  } catch (err) {
    // Better to risk a rare duplicate reply than to drop the message.
    logger.error({ err }, "dedupe check failed, handling anyway");
  }
  if (!fresh) {
    logger.debug("duplicate delivery skipped");
    return;
  }
  deps.enqueue(msg);
}

export function registerWebhook(app: FastifyInstance<any, any, any, any>, deps: WebhookDeps) {
  app.post("/telegram/webhook", async (req, reply) => {
    if (!sameSecret(req.headers["x-telegram-bot-api-secret-token"] as string | undefined, config.TELEGRAM_WEBHOOK_SECRET)) {
      logger.warn("webhook rejected: bad secret");
      return reply.code(401).send();
    }
    // Answer first. Telegram retries anything that is slow to get a 200.
    void accept(req.body, deps);
    return reply.code(200).send();
  });
}
