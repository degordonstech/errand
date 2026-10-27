import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidSignature, parseMessages } from "../src/whatsapp/webhook.js";

const secret = "test-app-secret";
const sign = (body: Buffer) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("isValidSignature", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));

  it("accepts a correct signature", () => {
    expect(isValidSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(isValidSignature(body, undefined, secret)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const wrong = `sha256=${createHmac("sha256", "other").update(body).digest("hex")}`;
    expect(isValidSignature(body, wrong, secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ hello: "w0rld" }));
    expect(isValidSignature(tampered, sign(body), secret)).toBe(false);
  });

  it("rejects malformed hex without throwing", () => {
    expect(isValidSignature(body, "sha256=zz", secret)).toBe(false);
  });
});

describe("parseMessages", () => {
  const wrap = (messages: unknown[], contacts: unknown[] = []) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", contacts, messages } }] }],
  });

  it("parses text with the profile name", () => {
    const out = parseMessages(
      wrap(
        [{ id: "wamid.1", from: "2348000000001", timestamp: "1793043850", type: "text", text: { body: "hi" } }],
        [{ wa_id: "2348000000001", profile: { name: "Ada" } }],
      ),
    );
    expect(out).toEqual([
      { id: "wamid.1", from: "2348000000001", profileName: "Ada", timestamp: 1793043850, kind: "text", text: "hi" },
    ]);
  });

  it("maps audio to voice and keeps the media id", () => {
    const [m] = parseMessages(
      wrap([{ id: "wamid.2", from: "1", timestamp: "1", type: "audio", audio: { id: "media-9", mime_type: "audio/ogg; codecs=opus", voice: true } }]),
    );
    expect(m.kind).toBe("voice");
    expect(m.media).toEqual({ id: "media-9", mimeType: "audio/ogg; codecs=opus" });
  });

  it("keeps captions and filenames on documents", () => {
    const [m] = parseMessages(
      wrap([
        {
          id: "wamid.3",
          from: "1",
          timestamp: "1",
          type: "document",
          document: { id: "media-3", mime_type: "application/pdf", filename: "bill.pdf", caption: "what is this" },
        },
      ]),
    );
    expect(m).toMatchObject({ kind: "doc", text: "what is this", media: { filename: "bill.pdf" } });
  });

  it("turns quick reply buttons into text", () => {
    const [m] = parseMessages(wrap([{ id: "wamid.4", from: "1", timestamp: "1", type: "button", button: { text: "YES", payload: "YES" } }]));
    expect(m).toMatchObject({ kind: "text", text: "YES" });
  });

  it("keeps the id of a tapped reply button", () => {
    const [m] = parseMessages(
      wrap([{ id: "wamid.5", from: "1", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes:abc", title: "Yes, go ahead" } } }]),
    );
    expect(m).toMatchObject({ kind: "text", text: "Yes, go ahead", buttonId: "yes:abc" });
  });

  it("drops emoji reactions", () => {
    const out = parseMessages(wrap([{ id: "wamid.6", from: "1", timestamp: "1", type: "reaction", reaction: { message_id: "wamid.1", emoji: "x" } }]));
    expect(out).toEqual([]);
  });

  it("ignores status updates", () => {
    const payload = { entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.5", status: "delivered" }] } }] }] };
    expect(parseMessages(payload)).toEqual([]);
  });

  it("survives an empty or odd payload", () => {
    expect(parseMessages({})).toEqual([]);
    expect(parseMessages(null)).toEqual([]);
  });
});
