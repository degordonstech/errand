// Points Telegram at the deployed server, or removes the webhook for local polling.
// Usage: npx tsx scripts/set-webhook.ts https://your-app.onrender.com
//        npx tsx scripts/set-webhook.ts --delete
//        npx tsx scripts/set-webhook.ts --info
import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const api = async (method: string, body: Record<string, unknown> = {}) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
};

const arg = process.argv[2];
if (arg === "--delete") {
  console.log(await api("deleteWebhook"));
} else if (arg === "--info") {
  const info = (await api("getWebhookInfo")) as { result?: Record<string, unknown> };
  console.log({ url: info.result?.url, pending: info.result?.pending_update_count, lastError: info.result?.last_error_message });
} else if (arg?.startsWith("https://")) {
  if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is not set");
  const url = `${arg.replace(/\/$/, "")}/telegram/webhook`;
  console.log(await api("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }));
  await api("setMyCommands", { commands: [{ command: "start", description: "Meet MyPaddy" }] });
} else {
  console.log("Usage: set-webhook.ts <https://server> | --delete | --info");
}
