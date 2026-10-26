// Sends a signed fake WhatsApp webhook to a running server, for local testing without a phone.
// Usage: npx tsx scripts/simulate.ts "message text" [--from 234...] [--url http://localhost:3000/webhook]
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

const url = flag("url") ?? `http://localhost:${process.env.PORT ?? 3000}/webhook`;
const from = flag("from") ?? (process.env.ALLOWED_NUMBERS ?? "").split(",")[0].replace(/\D/g, "");
const text = args.join(" ") || "hello";

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "0",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID },
            contacts: [{ wa_id: from, profile: { name: "Simulator" } }],
            messages: [
              { id: `wamid.sim-${randomUUID()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } },
            ],
          },
        },
      ],
    },
  ],
};

const body = JSON.stringify(payload);
const signature = `sha256=${createHmac("sha256", process.env.WHATSAPP_APP_SECRET ?? "").update(body).digest("hex")}`;
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature }, body });
console.log(`POST ${url} -> HTTP ${res.status}`);
