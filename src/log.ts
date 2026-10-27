import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-telegram-bot-api-secret-token']",
      "*.token",
      "*.apiKey",
      "*.email",
      "*.to",
      "*.phone",
    ],
    censor: "[redacted]",
  },
  transport:
    process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
});

/** 7012345678 -> ***5678. Use whenever a chat id or phone number goes near a log line. */
export function maskId(id: string): string {
  return id.length > 4 ? `***${id.slice(-4)}` : "***";
}
