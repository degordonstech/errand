import OpenAI from "openai";
import { config } from "../config.js";
import { fetchRetry } from "../net.js";

/** Extra headers for every Meta call. The relay key is only sent when a relay is configured. */
export const metaHeaders = (): Record<string, string> => (config.META_RELAY_KEY ? { "x-relay-key": config.META_RELAY_KEY } : {});

/** Meta Model API speaks the OpenAI Chat Completions format; only the base URL and key differ. */
export const meta = new OpenAI({
  baseURL: config.META_API_BASE_URL,
  apiKey: config.META_API_KEY,
  // Spark answers in 10 to 20 seconds. A request that hangs is retried instead of waited on.
  timeout: 40_000,
  maxRetries: 3,
  defaultHeaders: metaHeaders(),
  // DNS blips are retried quickly here, before the SDK's own slower retries.
  fetch: (url, init) => fetchRetry(url as string | URL, init),
});

/**
 * Muse Spark spends part of max_tokens on reasoning before it answers, so a small cap
 * returns an empty message. Keep this generous.
 */
export const SPARK_MAX_TOKENS = 8000;

const isModelNotFound = (err: unknown) => (err as { status?: number; code?: string })?.status === 404 && (err as { code?: string })?.code === "model_not_found";

/**
 * Through the relay, an occasional request is served from a location where the Meta Model API
 * reports no models. Nothing has run when that happens, so it is safe to try again.
 */
export async function retryModelNotFound<T>(fn: () => Promise<T>, attempts = 4, delayMs = 400): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isModelNotFound(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}
