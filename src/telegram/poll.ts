import { logger } from "../log.js";
import { call, TelegramError } from "./api.js";
import { accept, type WebhookDeps } from "./webhook.js";

/**
 * Local development without a public URL: asks Telegram for new updates in a loop.
 * Telegram refuses this while a webhook is set, so it is never used in production.
 */
export function startPolling(deps: WebhookDeps): () => void {
  let stopped = false;
  let offset = 0;

  void (async () => {
    logger.info("polling Telegram for updates");
    while (!stopped) {
      try {
        const updates = await call<{ update_id: number }[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          await accept(u, deps);
        }
      } catch (err) {
        if (err instanceof TelegramError && err.status === 409) {
          logger.error("a webhook is set for this bot, so polling cannot run. Delete the webhook or use webhook mode.");
          return;
        }
        logger.warn({ err }, "polling failed, retrying");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
