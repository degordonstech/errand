import Fastify from "fastify";
import { claimMessage } from "./db/supabase.js";
import { handleMessage } from "./handle.js";
import { enqueueForUser } from "./jobs/queue.js";
import { logger, maskPhone } from "./log.js";
import { registerWebhook } from "./whatsapp/webhook.js";

export function buildApp() {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true, bodyLimit: 2 * 1024 * 1024 });

  app.get("/health", async () => ({ ok: true }));

  registerWebhook(app, {
    claimMessage,
    enqueue: (msg) =>
      enqueueForUser(msg.from, () =>
        handleMessage(msg).catch((err) => logger.error({ err, from: maskPhone(msg.from) }, "job failed")),
      ),
  });

  return app;
}
