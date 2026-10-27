// Sends a fake Telegram update to a running server, for testing without typing on a phone.
// Usage: npx tsx scripts/simulate.ts "message text" --chat <your chat id> [--url http://localhost:3000/telegram/webhook]
//        npx tsx scripts/simulate.ts "caption" --chat <id> --file letter.pdf
// With --file, the bot first sends the file into your chat to get a Telegram file id, then
// sends the server an update as if you had sent that file yourself.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

const url = flag("url") ?? `http://localhost:${process.env.PORT ?? 3000}/telegram/webhook`;
const chatId = flag("chat");
const file = flag("file");
const text = args.join(" ") || (file ? "" : "hello");
if (!chatId) throw new Error("--chat is required: your Telegram chat id with the bot");

const KINDS: Record<string, { method: string; field: string; mime: string }> = {
  ".jpg": { method: "sendPhoto", field: "photo", mime: "image/jpeg" },
  ".jpeg": { method: "sendPhoto", field: "photo", mime: "image/jpeg" },
  ".png": { method: "sendPhoto", field: "photo", mime: "image/png" },
  ".mp4": { method: "sendVideo", field: "video", mime: "video/mp4" },
  ".ogg": { method: "sendVoice", field: "voice", mime: "audio/ogg" },
  ".pdf": { method: "sendDocument", field: "document", mime: "application/pdf" },
};

async function upload(path: string) {
  const kind = KINDS[extname(path).toLowerCase()];
  if (!kind) throw new Error("unsupported file type");
  const form = new FormData();
  form.append("chat_id", chatId!);
  form.append(kind.field, new Blob([readFileSync(path)], { type: kind.mime }), basename(path));
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${kind.method}`, { method: "POST", body: form });
  const json = (await res.json()) as { ok: boolean; result?: Record<string, any> };
  if (!json.ok || !json.result) throw new Error(`upload failed: HTTP ${res.status}`);
  // The bot's own message carries the file; reuse its file object as if the user sent it.
  return { field: kind.field, value: json.result[kind.field] };
}

const media = file ? await upload(file) : null;
const message: Record<string, unknown> = {
  message_id: Math.floor(Math.random() * 1e9),
  date: Math.floor(Date.now() / 1000),
  chat: { id: Number(chatId), type: "private" },
  from: { id: Number(chatId), first_name: "Simulator" },
};
if (!media) message.text = text;
else {
  message[media.field] = media.value;
  if (text) message.caption = text;
}

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": process.env.TELEGRAM_WEBHOOK_SECRET ?? "" },
  body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message }),
});
console.log(`POST ${url} -> HTTP ${res.status}`);
