import { config } from "../config.js";
import { logger } from "../log.js";
import { meta } from "./client.js";

/**
 * Logs at startup whether the configured models are available to this API key.
 * A wrong model id or a key from another account otherwise only shows up as a 404 on the first message.
 */
export async function checkModels(): Promise<void> {
  const wanted = [config.MUSE_SPARK_MODEL, config.MUSE_TRANSCRIBE_MODEL];
  try {
    const available: string[] = [];
    for await (const m of meta.models.list()) available.push(m.id);
    const missing = wanted.filter((id) => !available.includes(id));
    if (missing.length) logger.error({ missing, available, baseUrl: config.META_API_BASE_URL }, "configured models are not available to this API key");
    else logger.info({ models: wanted }, "Meta models available");
  } catch (err) {
    logger.error({ err, baseUrl: config.META_API_BASE_URL }, "could not list Meta models; check META_API_KEY and META_API_BASE_URL");
  }
}
