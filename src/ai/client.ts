import OpenAI from "openai";
import { config } from "../config.js";

/** Extra headers for every Meta call. The relay key is only sent when a relay is configured. */
export const metaHeaders = (): Record<string, string> => (config.META_RELAY_KEY ? { "x-relay-key": config.META_RELAY_KEY } : {});

/** Meta Model API speaks the OpenAI Chat Completions format; only the base URL and key differ. */
export const meta = new OpenAI({
  baseURL: config.META_API_BASE_URL,
  apiKey: config.META_API_KEY,
  timeout: 90_000,
  maxRetries: 3,
  defaultHeaders: metaHeaders(),
});

/**
 * Muse Spark spends part of max_tokens on reasoning before it answers, so a small cap
 * returns an empty message. Keep this generous.
 */
export const SPARK_MAX_TOKENS = 8000;
