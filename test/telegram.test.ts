import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { toTelegramHtml } from "../src/telegram/send.js";
import type { InboundMessage } from "../src/telegram/types.js";
import { parseUpdate, registerWebhook } from "../src/telegram/webhook.js";

const SECRET = "webhook-secret-for-tests-0123456789";
const chat = { id: 7012345678, type: "private" };
const from = { id: 7012345678, first_name: "Ada", last_name: "Obi" };
const msg = (extra: Record<string, unknown>) => ({ update_id: 1, message: { message_id: 5, date: 1761600000, chat, from, ...extra } });

describe("parseUpdate", () => {
  it("reads a text message", () => {
    expect(parseUpdate(msg({ text: "hello" }))).toMatchObject({ id: "7012345678:5", from: "7012345678", profileName: "Ada Obi", kind: "text", text: "hello" });
  });

  it("reads a voice note", () => {
    expect(parseUpdate(msg({ voice: { file_id: "v1", mime_type: "audio/ogg", file_size: 900 } }))).toMatchObject({
      kind: "voice",
      media: { id: "v1", mimeType: "audio/ogg", size: 900 },
    });
  });

  it("takes the largest photo size and keeps the caption", () => {
    const m = parseUpdate(msg({ caption: "is this real?", photo: [{ file_id: "small" }, { file_id: "large" }] }));
    expect(m).toMatchObject({ kind: "image", text: "is this real?", media: { id: "large", mimeType: "image/jpeg" } });
  });

  it("reads videos, video notes and documents", () => {
    expect(parseUpdate(msg({ video: { file_id: "vid" } }))?.kind).toBe("video");
    expect(parseUpdate(msg({ video_note: { file_id: "round" } }))?.kind).toBe("video");
    expect(parseUpdate(msg({ document: { file_id: "d", mime_type: "application/pdf", file_name: "letter.pdf" } }))).toMatchObject({
      kind: "doc",
      media: { mimeType: "application/pdf", filename: "letter.pdf" },
    });
  });

  it("marks anything else as other", () => {
    expect(parseUpdate(msg({ sticker: { file_id: "s" } }))).toMatchObject({ kind: "other", rawType: "sticker" });
  });

  it("reads a tapped button with what is needed to settle it", () => {
    const m = parseUpdate({ update_id: 2, callback_query: { id: "cb1", from, data: "yes:abc", message: { message_id: 9, chat } } });
    expect(m).toMatchObject({ id: "cb:cb1", from: "7012345678", buttonId: "yes:abc", callback: { id: "cb1", messageId: 9 } });
  });

  it("ignores group chats and updates without a message", () => {
    expect(parseUpdate({ update_id: 3, message: { message_id: 1, date: 1, chat: { id: -100, type: "group" }, text: "hi" } })).toBeNull();
    expect(parseUpdate({ update_id: 4, edited_message: {} })).toBeNull();
    expect(parseUpdate(null)).toBeNull();
  });
});

describe("toTelegramHtml", () => {
  it("turns markers into tags and escapes everything else", () => {
    expect(toTelegramHtml("*Total:* N5,000 <due> & _soon_")).toBe("<b>Total:</b> N5,000 &lt;due&gt; &amp; <i>soon</i>");
  });
  it("leaves underscores inside words and emails alone", () => {
    expect(toTelegramHtml("Send to ada_obi_x@example.com")).toBe("Send to ada_obi_x@example.com");
  });
});

describe("POST /telegram/webhook", () => {
  function setup() {
    const seen = new Set<string>();
    const enqueued: InboundMessage[] = [];
    const app = Fastify();
    registerWebhook(app, { claimMessage: async (id) => (seen.has(id) ? false : (seen.add(id), true)), enqueue: (m) => enqueued.push(m) });
    return { app, enqueued };
  }
  const post = (app: ReturnType<typeof Fastify>, body: unknown, secret?: string) =>
    app.inject({ method: "POST", url: "/telegram/webhook", headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {}, payload: body as object });
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("rejects calls without the right secret", async () => {
    const { app, enqueued } = setup();
    expect((await post(app, msg({ text: "hi" }))).statusCode).toBe(401);
    expect((await post(app, msg({ text: "hi" }), "wrong-secret-wrong-secret-wrong-secret")).statusCode).toBe(401);
    await settle();
    expect(enqueued).toHaveLength(0);
  });

  it("queues a message once, even when Telegram delivers it twice", async () => {
    const { app, enqueued } = setup();
    expect((await post(app, msg({ text: "hi" }), SECRET)).statusCode).toBe(200);
    await post(app, msg({ text: "hi" }), SECRET);
    await settle();
    expect(enqueued.map((m) => m.text)).toEqual(["hi"]);
  });
});
