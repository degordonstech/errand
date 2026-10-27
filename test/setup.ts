// Fixed fake values so tests never read or need real keys. dotenv does not override these.
Object.assign(process.env, {
  NODE_ENV: "production",
  LOG_LEVEL: "silent",
  META_API_KEY: "test",
  META_API_BASE_URL: "https://api.example.test/v1",
  MUSE_SPARK_MODEL: "test-spark",
  MUSE_TRANSCRIBE_MODEL: "test-transcribe",
  TELEGRAM_BOT_TOKEN: "123456:test-token",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-for-tests-0123456789",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "test",
  CRON_SECRET: "0123456789abcdef0123456789abcdef",
});
