// Sends a signed fake WhatsApp webhook to a running server, for local testing without a phone.
// Usage: npx tsx scripts/simulate.ts "message text" [--from 234...] [--url http://localhost:3000/webhook]
//        npx tsx scripts/simulate.ts "caption" --file letter.pdf   (uploads the file to WhatsApp first, then sends it as a document or image)
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

const url = flag("url") ?? `http://localhost:${process.env.PORT ?? 3000}/webhook`;
const from = flag("from") ?? (process.env.ALLOWED_NUMBERS ?? "").split(",")[0].replace(/\D/g, "");
const file = flag("file");
const text = args.join(" ") || (file ? "" : "hello");

async function upload(path: string) {
  const mime = ({ ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".ogg": "audio/ogg" } as Record<string, string>)[extname(path).toLowerCase()];
  if (!mime) throw new Error("unsupported file type");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([readFileSync(path)], { type: mime }), basename(path));
  const res = await fetch(`https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    body: form,
  });
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error(`upload failed: HTTP ${res.status}`);
  return { id: json.id, mime };
}

const media = file ? await upload(file) : null;
const message = !media
  ? { type: "text", text: { body: text } }
  : media.mime.startsWith("image/")
    ? { type: "image", image: { id: media.id, mime_type: media.mime, caption: text || undefined } }
    : media.mime === "video/mp4"
      ? { type: "video", video: { id: media.id, mime_type: media.mime, caption: text || undefined } }
      : media.mime === "audio/ogg"
        ? { type: "audio", audio: { id: media.id, mime_type: media.mime, voice: true } }
        : { type: "document", document: { id: media.id, mime_type: media.mime, filename: basename(file!), caption: text || undefined } };

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
            messages: [
              { id: `wamid.sim-${randomUUID()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), ...message },
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
