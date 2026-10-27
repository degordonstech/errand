import { checkModels } from "./ai/check.js";
import { buildApp, inboundDeps } from "./app.js";
import { config } from "./config.js";
import { logger } from "./log.js";
import { startPolling } from "./telegram/poll.js";

const app = buildApp();

app
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .then(() => {
    if (config.TELEGRAM_MODE === "polling") startPolling(inboundDeps);
    return checkModels();
  })
  .catch((err) => {
    logger.error({ err }, "failed to start");
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
