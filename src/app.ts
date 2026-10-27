import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { config } from "./config.js";
import { claimMessage } from "./db/supabase.js";
import { handleMessage } from "./handle.js";
import { enqueueForUser } from "./jobs/queue.js";
import { runReminders } from "./jobs/reminders.js";
import { logger, maskPhone } from "./log.js";
import { registerWebhook } from "./whatsapp/webhook.js";

/** Compares hashes so neither length nor content leaks through timing. */
function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function buildApp() {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true, bodyLimit: 2 * 1024 * 1024 });

  // RENDER_GIT_COMMIT is set by Render; it shows which commit is live.
  app.get("/health", async () => ({ ok: true, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null }));

  registerWebhook(app, {
    claimMessage,
    enqueue: (msg) =>
      enqueueForUser(msg.from, () =>
        handleMessage(msg).catch((err) => logger.error({ err, from: maskPhone(msg.from) }, "job failed")),
      ),
  });

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

  return app;
}
