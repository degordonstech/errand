// Fixed fake values so tests never read or need real keys. dotenv does not override these.
Object.assign(process.env, {
  NODE_ENV: "production",
  LOG_LEVEL: "silent",
  META_API_KEY: "test",
  META_API_BASE_URL: "https://api.example.test/v1",
  MUSE_SPARK_MODEL: "test-spark",
  MUSE_TRANSCRIBE_MODEL: "test-transcribe",
  WHATSAPP_TOKEN: "test",
  WHATSAPP_PHONE_NUMBER_ID: "100000000000000",
  WHATSAPP_VERIFY_TOKEN: "verify-token-for-tests",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "test",
  CRON_SECRET: "0123456789abcdef0123456789abcdef",
  ALLOWED_NUMBERS: "2348000000001",
});
