import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-hub-signature-256']",
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

/** 2348012345678 -> ***5678. Use whenever a phone number goes near a log line. */
export function maskPhone(waId: string): string {
  return waId.length > 4 ? `***${waId.slice(-4)}` : "***";
}
