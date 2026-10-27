import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { logger, maskPhone } from "../log.js";
import type { InboundMessage } from "./types.js";

export function isValidSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Pulls user messages out of a webhook payload. Status updates and anything unrecognised are skipped. */
export function parseMessages(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const value = change.value ?? {};
      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        const base = { id: m.id, from: m.from, profileName: names.get(m.from), timestamp: Number(m.timestamp) };
        switch (m.type) {
          case "text":
            out.push({ ...base, kind: "text", text: m.text?.body });
            break;
          case "audio":
            out.push({ ...base, kind: "voice", media: { id: m.audio.id, mimeType: m.audio.mime_type } });
            break;
          case "image":
            out.push({ ...base, kind: "image", text: m.image.caption, media: { id: m.image.id, mimeType: m.image.mime_type } });
            break;
          case "video":
            out.push({ ...base, kind: "video", text: m.video.caption, media: { id: m.video.id, mimeType: m.video.mime_type } });
            break;
          case "document":
            out.push({
              ...base,
              kind: "doc",
              text: m.document.caption,
              media: { id: m.document.id, mimeType: m.document.mime_type, filename: m.document.filename },
            });
            break;
          case "button":
            out.push({ ...base, kind: "text", text: m.button?.text });
            break;
          case "reaction":
            // Emoji reactions to earlier messages need no reply.
            break;
          case "interactive":
            out.push({ ...base, kind: "text", text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title });
            break;
          default:
            out.push({ ...base, kind: "other", rawType: m.type });
        }
      }
    }
  }
  return out;
}

export interface WebhookDeps {
  /** Returns false if this message id was already handled. */
  claimMessage(id: string): Promise<boolean>;
  enqueue(message: InboundMessage): void;
}

export function registerWebhook(app: FastifyInstance<any, any, any, any>, deps: WebhookDeps) {
  // Keep the raw bytes: the signature is computed over them, not over re-serialised JSON.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.WHATSAPP_VERIFY_TOKEN) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send();
  });

  app.post("/webhook", async (req, reply) => {
    const raw: Buffer | undefined = (req as any).rawBody;
    if (!raw || !isValidSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, config.WHATSAPP_APP_SECRET)) {
      logger.warn("webhook rejected: bad signature");
      return reply.code(401).send();
    }

    // Answer first. WhatsApp retries anything that is slow to get a 200.
    void accept(parseMessages(req.body), deps);
    return reply.code(200).send();
  });
}

async function accept(messages: InboundMessage[], deps: WebhookDeps) {
  for (const msg of messages) {
    if (!config.ALLOWED_NUMBERS.includes(msg.from)) {
      logger.info({ from: maskPhone(msg.from) }, "ignored message from number not on allowlist");
      continue;
    }
    let fresh = true;
    try {
      fresh = await deps.claimMessage(msg.id);
    } catch (err) {
      // Better to risk a rare duplicate reply than to drop the message.
      logger.error({ err, id: msg.id }, "dedupe check failed, handling anyway");
    }
    if (!fresh) {
      logger.debug({ id: msg.id }, "duplicate delivery skipped");
      continue;
    }
    deps.enqueue(msg);
  }
}
