import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default("info"),

  META_API_KEY: z.string().min(1),
  META_API_BASE_URL: z.string().url().default("https://api.meta.ai/v1"),
  MUSE_SPARK_MODEL: z.string().min(1).default("muse-spark-1.3"),
  MUSE_TRANSCRIBE_MODEL: z.string().min(1).default("muse-voice-transcribe-1.0"),
  /** Set when META_API_BASE_URL points at the Cloudflare relay (deploy/cloudflare). */
  META_RELAY_KEY: z.string().default(""),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** Telegram sends it back in a header on every webhook call, so forged calls can be rejected. */
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  /** "polling" for local development without a public URL. */
  TELEGRAM_MODE: z.enum(["webhook", "polling"]).default("webhook"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default("MyPaddy <onboarding@resend.dev>"),
  DEV_EMAIL_TO: z.string().default(""),

  CRON_SECRET: z.string().min(32),
  /** Messages a user can send per Lagos day, to keep model costs in check. */
  DAILY_MESSAGE_LIMIT: z.coerce.number().int().positive().default(60),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print variable names only, never values.
  const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
  console.error(`Missing or invalid environment variables: ${names.join(", ")}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
