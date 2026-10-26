import "dotenv/config";
import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((n) => n.replace(/\D/g, ""))
      .filter(Boolean),
  );

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default("info"),

  META_API_KEY: z.string().min(1),
  META_API_BASE_URL: z.string().url(),
  MUSE_SPARK_MODEL: z.string().min(1),
  MUSE_TRANSCRIBE_MODEL: z.string().min(1),

  WHATSAPP_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_GRAPH_VERSION: z.string().default("v23.0"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default(""),
  DEV_EMAIL_TO: z.string().default(""),

  CRON_SECRET: z.string().min(32),
  ALLOWED_NUMBERS: csv,
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
