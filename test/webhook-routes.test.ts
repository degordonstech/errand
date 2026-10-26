import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/whatsapp/types.js";
import { registerWebhook } from "../src/whatsapp/webhook.js";

const SECRET = "test-app-secret";

function setup() {
  const seen = new Set<string>();
  const enqueued: InboundMessage[] = [];
  const app = Fastify();
  registerWebhook(app, {
    claimMessage: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    enqueue: (m) => enqueued.push(m),
  });
  return { app, enqueued };
}

function textPayload(id: string, from: string) {
  return JSON.stringify({
    entry: [{ changes: [{ field: "messages", value: { messages: [{ id, from, timestamp: "1", type: "text", text: { body: "hi" } }] } }] }],
  });
}

const signed = (body: string) => ({
  "content-type": "application/json",
  "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
});

describe("GET /webhook", () => {
  it("echoes the challenge for the right verify token", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/webhook?hub.mode=subscribe&hub.verify_token=verify-token-for-tests&hub.challenge=12345",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("12345");
  });

  it("refuses a wrong verify token", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /webhook", () => {
  it("rejects an unsigned request and queues nothing", async () => {
    const { app, enqueued } = setup();
    const res = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: textPayload("a", "2348000000001") });
    expect(res.statusCode).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  it("queues a signed message from an allowed number once, even if delivered twice", async () => {
    const { app, enqueued } = setup();
    const body = textPayload("wamid.dup", "2348000000001");
    expect((await app.inject({ method: "POST", url: "/webhook", headers: signed(body), payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/webhook", headers: signed(body), payload: body })).statusCode).toBe(200);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    expect(enqueued[0].id).toBe("wamid.dup");
  });

  it("answers 200 but ignores numbers not on the allowlist", async () => {
    const { app, enqueued } = setup();
    const body = textPayload("wamid.stranger", "2349999999999");
    const res = await app.inject({ method: "POST", url: "/webhook", headers: signed(body), payload: body });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(enqueued).toHaveLength(0);
  });
});
