import { config } from "../config.js";
import { fetchRetry } from "../net.js";

// The token is part of every Bot API URL, so URLs must never reach a log line or an error message.
const apiUrl = (method: string) => `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed: HTTP ${status} ${description}`.trim());
  }
}

/** Calls a Bot API method with a JSON body, or multipart when a file is attached. */
export async function call<T = any>(method: string, body?: Record<string, unknown> | FormData): Promise<T> {
  const init: RequestInit =
    body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) };
  const res = await fetchRetry(apiUrl(method), init);
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !json.ok) throw new TelegramError(method, res.status, json.description ?? "");
  return json.result as T;
}

/** Downloads a file the user sent. Telegram lets bots fetch files up to 20 MB. */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const file = await call<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram getFile returned no path");
  const res = await fetchRetry(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
