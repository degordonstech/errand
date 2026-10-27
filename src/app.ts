import Fastify from "fastify";
import { config } from "./config.js";
import { claimMessage } from "./db/supabase.js";
import { handleMessage } from "./handle.js";
import { enqueueForUser } from "./jobs/queue.js";
import { runReminders } from "./jobs/reminders.js";
import { runBriefs } from "./jobs/briefs.js";
import { runDueReminders } from "./jobs/tick.js";
import { logger, maskId } from "./log.js";
import { registerWebhook, sameSecret, type WebhookDeps } from "./telegram/webhook.js";

/** Where every inbound Telegram update goes, from the webhook or from local polling. */
export const inboundDeps: WebhookDeps = {
  claimMessage,
  enqueue: (msg) =>
    enqueueForUser(msg.from, () => handleMessage(msg).catch((err) => logger.error({ err, from: maskId(msg.from) }, "job failed"))),
};

export function buildApp() {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true, bodyLimit: 2 * 1024 * 1024 });

  // RENDER_GIT_COMMIT is set by Render; it shows which commit is live.
  app.get("/health", async () => ({ ok: true, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null }));

  registerWebhook(app, inboundDeps);

  // Called hourly by cron-job.org. ?key= is required; ?min_age_hours= shortens the wait for demos.
  app.route({
    method: ["GET", "POST"],
    url: "/jobs/reminders",
    handler: async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (!sameSecret(q.key ?? (req.headers["x-cron-key"] as string | undefined), config.CRON_SECRET)) return reply.code(401).send();
      const minAgeHours = q.min_age_hours !== undefined ? Math.max(0, Number(q.min_age_hours) || 0) : undefined;
      const result = await runReminders({ minAgeHours });
      logger.info(result, "reminder run");
      return result;
    },
  });

  // Called every minute by cron-job.org: sends reminders and briefs that are due.
  app.route({
    method: ["GET", "POST"],
    url: "/jobs/tick",
    handler: async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (!sameSecret(q.key ?? (req.headers["x-cron-key"] as string | undefined), config.CRON_SECRET)) return reply.code(401).send();
      const result = { ...(await runDueReminders()), briefs: await runBriefs() };
      if (result.due || result.briefs) logger.info(result, "tick");
      return result;
    },
  });

  return app;
}
